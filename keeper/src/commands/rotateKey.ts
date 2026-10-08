/**
 * Daily Coordinator key rotation — privacy/PRIVACY-SPEC.md section 2.7 ("Key rotation and destruction"), 5.2;
 * the operator procedure is keeper/README.md "Coordinator key rotation".
 *
 * One pass (run daily by cron with `--once`, or looped; it never proposes more often than ROTATE_EVERY_SEC):
 *   1. propose: when no key is pending on-chain or locally and the last proposal is ROTATE_EVERY_SEC old, generate
 *      the next ecSk (key file, mode 0600) and propose DarkCurve.setCoordinatorKey(pk, now + ROTATE_LEAD_SEC):
 *      sent directly when this keeper key owns DarkCurve and the chain is not 56 (testnet / local), otherwise
 *      written as a Safe Transaction Builder batch file for the Safe owners to import and sign;
 *   2. stale proposal: a locally pending key whose switchAt can no longer be accepted (the contract needs
 *      switchAt >= now + OVERLAP) and that never reached the chain is destroyed and re-proposed next pass;
 *   3. destroy: a key whose generation is below the active one and that no collecting epoch (status 1, count > 0)
 *      still uses is overwritten and unlinked, and `KeyDestroyed` is logged with its public point. The
 *      COORDINATOR_SK environment key cannot be overwritten from here: the pass logs that it must be removed.
 * Inert while the deployment file has no darkCurve.
 */
import path from "node:path";
import { encodeFunctionData, getAddress, type Address } from "viem";
import { darkCurveAbi, launchpadAbi } from "../abis.js";
import { sameAddr, sendTx, type Ctx } from "../chain.js";
import { loadPrivacyConfig, privacyAddresses, type PrivacyConfig } from "../config.js";
import { destroyKeyFile, loadCoordinatorKeys, pkId, pkLabel, randomScalar, writeKeyFile, type CoordinatorKey } from "../coordinatorKeys.js";
import { readEpochs, readKeyByGen, type EpochView } from "./coordinator.js";
import { readJson, writeJsonAtomic } from "../state.js";
import { logger } from "../log.js";

const log = logger("rotate-key");

/** DarkCurve / GroveConstants OVERLAP: the pending key is accepted from switchAt - OVERLAP. */
export const OVERLAP = 600;

export interface RotationState {
  version: 1;
  /** unix seconds of the last proposal (direct send or Safe file) */
  lastProposedAt: number;
  pending?: { pk: [string, string]; switchAt: number; proposedAt: number; via: "direct" | "safe"; proposalFile?: string };
  destroyed: { pk: [string, string]; at: number }[];
}

export function rotationStatePath(keyDir: string): string {
  return path.join(keyDir, "rotation.json");
}

export function loadRotationState(keyDir: string): RotationState {
  const s = readJson<RotationState>(rotationStatePath(keyDir));
  return s && s.version === 1 ? { ...s, destroyed: s.destroyed ?? [] } : { version: 1, lastProposedAt: 0, destroyed: [] };
}

// ------------------------------------------------------------------------------------------------ pure rules

export interface ChainKeyState {
  now: number;
  /** DarkCurve.keySwitchAt (0 = no pending key on-chain) */
  keySwitchAt: number;
  /** pk of keyByGen[keyGen + 1] when keySwitchAt != 0 */
  pendingPk?: string;
}

export type ProposalDecision =
  | { action: "propose"; switchAt: number }
  | { action: "wait"; reason: "pending-on-chain" | "awaiting-safe" | "not-due" }
  | { action: "discard-stale" };

/**
 * When to propose the next key. Pure. `st.pending` is a local proposal that has NOT reached the chain (the caller
 * clears it once keyByGen shows it pending or active).
 */
export function proposalDecision(chain: ChainKeyState, st: Pick<RotationState, "lastProposedAt" | "pending">, cfg: Pick<PrivacyConfig, "rotateEverySec" | "rotateLeadSec">): ProposalDecision {
  if (chain.keySwitchAt !== 0 && chain.now < chain.keySwitchAt) return { action: "wait", reason: "pending-on-chain" };
  if (st.pending) {
    // setCoordinatorKey requires switchAt >= now + OVERLAP: past that the Safe can no longer execute the proposal
    if (chain.now + OVERLAP > st.pending.switchAt) return { action: "discard-stale" };
    return { action: "wait", reason: "awaiting-safe" };
  }
  if (chain.now - st.lastProposedAt < cfg.rotateEverySec) return { action: "wait", reason: "not-due" };
  return { action: "propose", switchAt: chain.now + cfg.rotateLeadSec };
}

/**
 * Generations whose key may be destroyed: below the active generation, and not the key of any collecting epoch
 * (status 1, count > 0). An epoch under an old key can still be opened (or voided) after the switch; its key is
 * kept until then. Pure.
 */
export function destroyableGens(activeGen: number, keyGens: readonly number[], epochs: readonly Pick<EpochView, "status" | "count" | "keyId">[]): number[] {
  const inUse = new Set(epochs.filter((e) => e.status === 1 && e.count > 0).map((e) => e.keyId));
  return keyGens.filter((g) => g < activeGen && !inUse.has(g));
}

/** Safe Transaction Builder batch (import in the Safe app: Apps -> Transaction Builder -> drag the file in). */
export function safeBatch(chainId: number, darkCurve: Address, pk: readonly [bigint, bigint], switchAt: number, now: number) {
  const data = encodeFunctionData({ abi: darkCurveAbi, functionName: "setCoordinatorKey", args: [[pk[0], pk[1]], BigInt(switchAt)] });
  return {
    version: "1.0",
    chainId: String(chainId),
    createdAt: now * 1000,
    meta: {
      name: `zkBNB Coordinator key rotation ${new Date(switchAt * 1000).toISOString()}`,
      description: `DarkCurve.setCoordinatorKey(pk ${pkLabel(pk)}, switchAt ${switchAt}). Must execute before ${switchAt - OVERLAP} (switchAt - OVERLAP).`,
    },
    transactions: [{ to: getAddress(darkCurve), value: "0", data, contractMethod: null, contractInputsValues: null }],
  };
}

// ------------------------------------------------------------------------------------------------ effects

export interface RotateResult {
  inert?: boolean;
  decision?: ProposalDecision["action"];
  proposed?: { pk: string; switchAt: number; via: "direct" | "safe"; file?: string; hash?: string };
  destroyed: string[];
  /** generations still kept because an epoch under them is collecting */
  kept: number[];
}

export interface RotateDeps {
  /** defaults to randomScalar() */
  newSecret?: () => bigint;
  send?: typeof sendTx;
}

export async function rotateKey(ctx: Ctx, env: NodeJS.ProcessEnv = process.env, deps: RotateDeps = {}): Promise<RotateResult> {
  const out: RotateResult = { destroyed: [], kept: [] };
  const pa = privacyAddresses(ctx.dep);
  if (!pa) {
    log.info("no darkCurve in the deployment file: rotate-key is inert");
    return { ...out, inert: true };
  }
  const { darkCurve } = pa;
  const pcfg = loadPrivacyConfig(env, ctx.cfg.snapshotDir);
  const dir = pcfg.coordinatorKeyDir;
  const st = loadRotationState(dir);
  const send = deps.send ?? sendTx;

  const [block, keySwitchAt, keyGen, active] = await Promise.all([
    ctx.pub.getBlock({ blockTag: "latest" }),
    ctx.pub.readContract({ address: darkCurve, abi: darkCurveAbi, functionName: "keySwitchAt" }),
    ctx.pub.readContract({ address: darkCurve, abi: darkCurveAbi, functionName: "keyGen" }),
    ctx.pub.readContract({ address: darkCurve, abi: darkCurveAbi, functionName: "activeCoordinatorKey" }),
  ]);
  const now = Number(block.timestamp);
  const activeGen = Number((active as readonly unknown[])[1]);
  const storedGen = Number(keyGen);
  const pendingPk = Number(keySwitchAt) !== 0 ? pkId(await readKeyByGen(ctx, darkCurve, storedGen + 1)) : undefined;

  // a local proposal that reached the chain (pending, or already promoted to the active key) is done
  if (st.pending) {
    const id = pkId(st.pending.pk);
    const activeId = pkId(await readKeyByGen(ctx, darkCurve, activeGen));
    if (pendingPk === id || activeId === id) {
      log.info("proposed key is on-chain", { pk: pkLabel(st.pending.pk), switchAt: st.pending.switchAt });
      delete st.pending;
    }
  }

  // 1 / 2: proposal
  const decision = proposalDecision({ now, keySwitchAt: Number(keySwitchAt), pendingPk }, st, pcfg);
  out.decision = decision.action;
  if (decision.action === "discard-stale" && st.pending) {
    const keys = loadCoordinatorKeys(dir, {});
    const k = keys.get(pkId(st.pending.pk));
    if (k?.file) destroyKeyFile(k.file);
    log.warn("proposal expired before it reached the chain; its key was destroyed and a new one is proposed next pass", { pk: pkLabel(st.pending.pk) });
    delete st.pending;
    st.lastProposedAt = 0;
  } else if (decision.action === "propose") {
    const sk = (deps.newSecret ?? randomScalar)();
    const { file, pk } = writeKeyFile(dir, sk, now);
    const owner = await ctx.pub.readContract({ address: darkCurve, abi: darkCurveAbi, functionName: "owner" });
    const direct = ctx.cfg.chainId !== 56 && !!ctx.account && sameAddr(owner, ctx.account.address);
    const pkStr: [string, string] = [pk[0].toString(), pk[1].toString()];
    if (direct) {
      const r = await send(ctx, {
        address: darkCurve,
        abi: darkCurveAbi,
        functionName: "setCoordinatorKey",
        args: [[pk[0], pk[1]], BigInt(decision.switchAt)],
        label: `setCoordinatorKey(${pkLabel(pk)}, ${decision.switchAt})`,
      } as never);
      out.proposed = { pk: pkLabel(pk), switchAt: decision.switchAt, via: "direct", hash: r.hash };
      if (r.dryRun) {
        destroyKeyFile(file); // a simulated proposal must not leave a usable key behind
        log.info("DRY_RUN setCoordinatorKey simulated ok; the generated key was discarded", { pk: pkLabel(pk), switchAt: decision.switchAt });
      } else {
        st.pending = { pk: pkStr, switchAt: decision.switchAt, proposedAt: now, via: "direct" };
        st.lastProposedAt = now;
        log.info("next Coordinator key proposed", { pk: pkLabel(pk), switchAt: decision.switchAt, hash: r.hash });
      }
    } else {
      const proposalFile = path.join(dir, "proposals", `setCoordinatorKey-${decision.switchAt}.json`);
      writeJsonAtomic(proposalFile, safeBatch(ctx.cfg.chainId, darkCurve, pk, decision.switchAt, now));
      st.pending = { pk: pkStr, switchAt: decision.switchAt, proposedAt: now, via: "safe", proposalFile };
      st.lastProposedAt = now;
      out.proposed = { pk: pkLabel(pk), switchAt: decision.switchAt, via: "safe", file: proposalFile };
      log.info("next Coordinator key: Safe proposal written (import it in the Safe Transaction Builder and execute before switchAt - 10 min)", {
        pk: pkLabel(pk),
        switchAt: decision.switchAt,
        file: proposalFile,
        owner,
      });
    }
  } else {
    log.info("no proposal this pass", { reason: decision.action === "wait" ? decision.reason : decision.action });
  }

  // 3: destruction
  const keys = loadCoordinatorKeys(dir, env, (file, reason) => log.warn("key file skipped", { file, reason }));
  if (keys.size > 0) {
    // generation of each local key: scan keyByGen over [0, activeGen] from the top (rotation keeps few keys)
    const genOf = new Map<string, number>();
    for (let g = activeGen; g >= 0 && genOf.size < keys.size && activeGen - g <= 64; g--) {
      const id = pkId(await readKeyByGen(ctx, darkCurve, g));
      if (keys.has(id) && !genOf.has(id)) genOf.set(id, g);
    }
    const old = [...genOf.entries()].filter(([, g]) => g < activeGen);
    if (old.length > 0) {
      const coins = (await ctx.pub.readContract({ address: ctx.dep.launchpad, abi: launchpadAbi, functionName: "allCoins" })).map((c) => getAddress(c));
      const epochs = coins.length ? (await readEpochs(ctx, darkCurve, coins)).flat() : [];
      const ok = new Set(destroyableGens(activeGen, old.map(([, g]) => g), epochs));
      for (const [id, g] of old) {
        const k = keys.get(id) as CoordinatorKey;
        if (!ok.has(g)) {
          out.kept.push(g);
          log.info("old key kept: an epoch under it is still collecting", { gen: g, pk: pkLabel(k.pk) });
          continue;
        }
        if (!k.file) {
          log.warn("COORDINATOR_SK holds a retired key; remove it from the environment now", { gen: g, pk: pkLabel(k.pk) });
          continue;
        }
        if (ctx.cfg.dryRun) {
          log.info("DRY_RUN would destroy key", { gen: g, pk: pkLabel(k.pk) });
          continue;
        }
        destroyKeyFile(k.file);
        st.destroyed.push({ pk: [k.pk[0].toString(), k.pk[1].toString()], at: now });
        out.destroyed.push(pkLabel(k.pk));
        log.info("KeyDestroyed", { gen: g, pk: [k.pk[0].toString(), k.pk[1].toString()] });
      }
    }
  }
  if (!ctx.cfg.dryRun) writeJsonAtomic(rotationStatePath(dir), st);
  return out;
}
