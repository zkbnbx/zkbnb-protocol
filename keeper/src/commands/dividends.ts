/**
 * Holder rewards into the shielded pool — privacy/PRIVACY-SPEC.md section 2.5 and 5.2; workplan section 4.1.
 *
 * GrovePool is an ordinary holder in every Holders-mode snapshot (rewards.ts keeps it eligible). After a run is
 * posted, this command finds the pool's leaf in the run's snapshot (local file, or the run's public uri), checks
 * it against the posted root, and calls GrovePool.pullRewards(coin, runId, amount, proof), which claims the
 * share and raises accRpt[coin]. Idempotent: a run the pool already claimed (HolderRewards.isClaimed) is skipped.
 * Inert while the deployment file has no grovePool.
 */
import { getAddress, type Address, type Hex } from "viem";
import { feeRouterAbi, groveCoinAbi, grovePoolAbi, holderRewardsAbi, launchpadAbi } from "../abis.js";
import { errorText, sameAddr, sendTx, type Ctx } from "../chain.js";
import { loadPrivacyConfig, privacyAddresses } from "../config.js";
import { leafHash, verifyProof } from "../merkle.js";
import { snapshotPath, type SnapshotJson } from "../snapshot.js";
import { readJson } from "../state.js";
import { PAYOUT_HOLDERS } from "./rewards.js";
import { logger } from "../log.js";

const log = logger("dividends");

/** GroveConstants.MIN_REWARD_SUPPLY: pullRewards refuses a pool coin balance below one token (review R5). */
export const MIN_REWARD_SUPPLY = 10n ** 18n;

export interface PoolLeaf {
  amount: bigint;
  proof: Hex[];
  /** keccak256(abi.encode(coin, runId, pool, amount)) == HolderRewards.leaf */
  leaf: Hex;
}

/** The pool's leaf of a snapshot, verified against the snapshot root and (when given) the posted root. Pure. */
export function poolLeafFromSnapshot(s: SnapshotJson, pool: Address, postedRoot?: Hex): PoolLeaf | undefined {
  const row = s.leaves.find((l) => sameAddr(l.account, pool));
  if (!row) return undefined;
  const amount = BigInt(row.amount);
  const leaf = leafHash(getAddress(s.coin), BigInt(s.runId), getAddress(pool), amount);
  if (!verifyProof(row.proof, s.root, leaf)) throw new Error("pool leaf does not verify against the snapshot root");
  if (postedRoot && postedRoot.toLowerCase() !== s.root.toLowerCase()) throw new Error("snapshot root differs from the posted run root");
  return { amount, proof: row.proof, leaf };
}

async function loadSnapshot(ctx: Ctx, coin: Address, runId: bigint, uri: string, fetchImpl: typeof fetch): Promise<SnapshotJson | undefined> {
  const local = readJson<SnapshotJson>(snapshotPath(ctx.cfg.snapshotDir, coin, runId));
  if (local) return local;
  if (!/^https?:\/\//.test(uri)) return undefined;
  const res = await fetchImpl(uri, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`snapshot http ${res.status}`);
  return (await res.json()) as SnapshotJson;
}

export interface DividendsResult {
  inert?: boolean;
  pulled: { coin: Address; runId: bigint; hash?: string }[];
  skipped: { coin: Address; runId: bigint; reason: string }[];
}

export async function dividends(ctx: Ctx, env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<DividendsResult> {
  const out: DividendsResult = { pulled: [], skipped: [] };
  const pa = privacyAddresses(ctx.dep);
  if (!pa) {
    log.debug("no grovePool in the deployment file: dividends is inert");
    return { ...out, inert: true };
  }
  const pool = pa.grovePool;
  const { pub, dep } = ctx;
  const lookback = BigInt(loadPrivacyConfig(env, ctx.cfg.snapshotDir).dividendsLookback);
  const coins = (await pub.readContract({ address: dep.launchpad, abi: launchpadAbi, functionName: "allCoins" })).map((c) => getAddress(c));

  for (const coin of coins) {
    try {
      const conf = await pub.readContract({ address: dep.feeRouter, abi: feeRouterAbi, functionName: "configOf", args: [coin] });
      if (conf[1] !== PAYOUT_HOLDERS) continue;
      const runCount = await pub.readContract({ address: dep.holderRewards, abi: holderRewardsAbi, functionName: "runCount", args: [coin] });
      for (let runId = runCount > lookback ? runCount - lookback : 0n; runId < runCount; runId++) {
        const claimed = await pub.readContract({ address: dep.holderRewards, abi: holderRewardsAbi, functionName: "isClaimed", args: [coin, runId, pool] });
        if (claimed) continue;
        const run = await pub.readContract({ address: dep.holderRewards, abi: holderRewardsAbi, functionName: "getRun", args: [coin, runId] });
        const snap = await loadSnapshot(ctx, coin, runId, run.uri, fetchImpl);
        if (!snap) {
          out.skipped.push({ coin, runId, reason: "snapshot unavailable" });
          log.warn("run snapshot unavailable; cannot pull the pool's share", { coin, runId });
          continue;
        }
        const leaf = poolLeafFromSnapshot(snap, pool, run.root);
        if (!leaf) {
          out.skipped.push({ coin, runId, reason: "pool not in run" });
          continue;
        }
        const onchainLeaf = await pub.readContract({ address: dep.holderRewards, abi: holderRewardsAbi, functionName: "leaf", args: [coin, runId, pool, leaf.amount] });
        if (onchainLeaf.toLowerCase() !== leaf.leaf.toLowerCase()) throw new Error("leaf differs from HolderRewards.leaf");
        const supply = await pub.readContract({ address: coin, abi: groveCoinAbi, functionName: "balanceOf", args: [pool] });
        if (supply < MIN_REWARD_SUPPLY) {
          out.skipped.push({ coin, runId, reason: "pool coin balance below MIN_REWARD_SUPPLY" });
          log.info("pool holds less than one token of the coin; run left in HolderRewards", { coin, runId });
          continue;
        }
        const r = await sendTx(ctx, {
          address: pool,
          abi: grovePoolAbi,
          functionName: "pullRewards",
          args: [coin, runId, leaf.amount, leaf.proof],
          label: `pullRewards(${coin}, run ${runId})`,
        } as never);
        out.pulled.push({ coin, runId, hash: r.hash });
        log.info(r.dryRun ? "DRY_RUN pullRewards simulated ok" : "rewards pulled into the pool", { coin, runId, hash: r.hash });
      }
    } catch (e) {
      log.error("dividends failed for coin", { coin, err: errorText(e).split("\n")[0] });
    }
  }
  return out;
}
