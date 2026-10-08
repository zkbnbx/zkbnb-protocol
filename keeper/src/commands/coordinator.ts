/**
 * Epoch Coordinator — privacy/PRIVACY-SPEC.md section 2.6.3, 2.7 and 5.2; workplan section 4.1.
 *
 * One pass:
 *   1. pool.checkpoint() when a period passed with no insert (checkpoint.ts);
 *   2. read every coin's current epoch per direction (DarkCurve.epochsOf) and the on-chain epoch params;
 *   3. per (coin, dir): openable (age >= tMin and count >= K, or age >= tMax) and voidable (age > tMax + grace);
 *   4. for each openable direction whose key this host holds: take the epoch's ON-CHAIN SUM (C1, C2), decrypt the
 *      sum only (elgamal.decrypt on a SummedCiphertext; individual ciphertexts are never read, so there is nothing
 *      to decrypt one with), solve the sum with BSGS, quote minOut from current reserves less SLIPPAGE_BPS, prove;
 *   5. openEpoch(coin, dirMask, ...) for every openable direction of the coin at once, through PRIVATE_TX_RPC; a
 *      band-blocked (BandExceeded(dir)) or otherwise reverting direction is dropped from the mask and the rest
 *      retried; a direction failing MAX_OPEN_ATTEMPTS passes in a row stays out until it is voidable;
 *   6. voidEpoch for every voidable direction that was not opened in this pass.
 *
 * Logs carry only aggregates (coin, dir, seq, count, u magnitude) and tx hashes: never a key, never an individual
 * ciphertext, never an exact sum before it is public. `--dry-run` prints the would-be openEpoch arguments with u
 * redacted to its magnitude. Inert (one log line) while the deployment file has no grovePool / darkCurve. Never
 * part of `all`: it runs as its own pm2 app, on a different host from the relayer.
 */
import { createWalletClient, getAddress, http, type Address } from "viem";
import { darkCurveAbi, launchpadAbi, launchpadQuoteAbi, rootsQuoteAbi, routerAbi } from "../abis.js";
import { errorText, sendTx, type Ctx, type TxResult } from "../chain.js";
import { loadPrivacyConfig, privacyAddresses, type PrivacyConfig } from "../config.js";
import { maybeCheckpoint } from "../checkpoint.js";
import { elgamal, type SummedCiphertext } from "../elgamal.js";
import { loadOrBuildTable, solve as bsgsSolve, type BsgsTable } from "../bsgs.js";
import { proveOpen, type SolidityProof } from "../zkprove.js";
import type { ContractPoint, Point } from "../babyjub.js";
import { loadCoordinatorKeys, pkId, pkLabel, type CoordinatorKey } from "../coordinatorKeys.js";
import { logger } from "../log.js";

const log = logger("coordinator");

export const UNIT_BNB = 10_000_000_000_000n; // 1e13
export const UNIT_TOKEN = 1_000_000_000_000_000_000n; // 1e18
export const MAX_U_SUM = 1n << 40n;
/** GroveCoin pair tax (FEE_BPS) on graduated-coin transfers to and from the pair */
export const PAIR_TAX_BPS = 200;
export const DIRS = [0, 1, 2] as const;
export const DIR_NAME = ["BUY", "SELL", "HARVEST"] as const;
export type Dir = 0 | 1 | 2;

// ------------------------------------------------------------------------------------------------ pure rules

export interface EpochParams {
  tMin: number;
  tMax: number;
  k: number;
  grace: number;
}

/** DarkCurve.Epoch as viem decodes it. */
export interface EpochView {
  startedAt: bigint;
  status: number;
  keyId: number;
  count: number;
  refPrice: bigint;
  refVb: bigint;
  c1: ContractPoint;
  c2: ContractPoint;
}

export type DirState = "idle" | "collecting" | "openable" | "voidable";

/** Mirrors DarkCurve.isOpenable / isVoidable (a voidable direction is still openable on-chain). */
export function directionState(ep: Pick<EpochView, "status" | "count" | "startedAt">, p: EpochParams, now: bigint): DirState {
  if (ep.status !== 1 || ep.count === 0) return "idle";
  const age = now - ep.startedAt;
  if (now > ep.startedAt + BigInt(p.tMax) + BigInt(p.grace)) return "voidable";
  if ((age >= BigInt(p.tMin) && ep.count >= p.k) || age >= BigInt(p.tMax)) return "openable";
  return "collecting";
}

export const maskOf = (dirs: Iterable<number>): number => [...dirs].reduce((m, d) => m | (1 << d), 0);
export const dirsOf = (mask: number): Dir[] => DIRS.filter((d) => (mask & (1 << d)) !== 0);

/** quote * (1 - bps/1e4), rounded down. */
export function applySlippage(quote: bigint, bps: number): bigint {
  return (quote * BigInt(10_000 - bps)) / 10_000n;
}

/** u as a magnitude only, e.g. "2^16..2^17": what logs and --dry-run show instead of the sum. */
export function redactU(u: bigint): string {
  if (u <= 0n) return "0";
  const bits = u.toString(2).length;
  return `2^${bits - 1}..2^${bits}`;
}

type RevertData = { data?: { errorName?: string; args?: readonly unknown[] } };

/** The revert reason of a failed openEpoch simulation; a band block names its direction. */
export function decodeOpenRevert(e: unknown): { kind: "band"; dir: Dir } | { kind: "other"; reason: string } {
  let found: RevertData | undefined;
  const walk = (e as { walk?: (fn: (x: unknown) => boolean) => unknown } | undefined)?.walk;
  if (typeof walk === "function") found = walk.call(e, (x: unknown) => !!(x as RevertData)?.data?.errorName) as RevertData | undefined;
  if (!found && (e as RevertData)?.data?.errorName) found = e as RevertData;
  if (found?.data?.errorName === "BandExceeded") {
    const d = Number(found.data.args?.[0]);
    if (d === 0 || d === 1 || d === 2) return { kind: "band", dir: d };
  }
  const text = errorText(e);
  const m = /BandExceeded\(uint8 dir\)\s*\(\s*([012])\s*\)/.exec(text) ?? /BandExceeded\(\s*([012])\s*\)/.exec(text);
  if (m) return { kind: "band", dir: Number(m[1]) as Dir };
  const reason = found?.data?.errorName ?? /reverted with the following (?:signature|reason):\s*\n?\s*(.*)/.exec(text)?.[1] ?? "revert";
  return { kind: "other", reason: String(reason).slice(0, 120) };
}

/** Plan for one coin: which directions to try to open (key held, not failing persistently), which to void. Pure. */
export function planCoin(
  epochs: readonly EpochView[],
  p: EpochParams,
  now: bigint,
  hasKey: (keyId: number) => boolean,
  failures: (dir: Dir) => number,
  maxAttempts: number,
): { open: Dir[]; void: Dir[]; states: DirState[] } {
  const states = DIRS.map((d) => directionState(epochs[d], p, now));
  const open: Dir[] = [];
  const voids: Dir[] = [];
  for (const d of DIRS) {
    const s = states[d];
    if (s !== "openable" && s !== "voidable") continue;
    if (hasKey(epochs[d].keyId) && failures(d) < maxAttempts) open.push(d);
    else if (s === "voidable") voids.push(d);
  }
  return { open, void: voids, states };
}

// ------------------------------------------------------------------------------------------------ effects

export interface Quoter {
  /** expected output of executing `amountIn` (wei for BUY, token units for SELL / HARVEST) in direction `dir` */
  quote(coin: Address, dir: Dir, amountIn: bigint): Promise<bigint>;
}

export type SendFn = (ctx: Ctx, p: Parameters<typeof sendTx>[1]) => Promise<TxResult>;

export interface CoordinatorDeps {
  keys: Map<string, CoordinatorKey>;
  /** the sum from M = sum * B8, or null */
  solve: (m: Point) => bigint | null;
  prove: (args: { ecSk: bigint; sum: SummedCiphertext; u: bigint }) => Promise<SolidityProof>;
  quoter: Quoter;
  send: SendFn;
  /** per-(coin, dir, seq) consecutive failures, kept across passes by the caller */
  failures: Map<string, number>;
  pcfg: Pick<PrivacyConfig, "slippageBps" | "maxOpenAttempts">;
  /** context used for openEpoch / voidEpoch sends (the PRIVATE_TX_RPC wallet); defaults to ctx */
  sendCtx?: Ctx;
}

export interface OpenArgs {
  coin: Address;
  dirMask: number;
  seq: [number, number, number];
  u: [bigint, bigint, bigint];
  proofs: [SolidityProof, SolidityProof, SolidityProof];
  minOut: [bigint, bigint, bigint];
}

export const ZERO_PROOF: SolidityProof = Object.freeze({ a: [0n, 0n], b: [[0n, 0n], [0n, 0n]], c: [0n, 0n] }) as SolidityProof;

/** The openEpoch arguments as --dry-run prints them: u only as a magnitude, proofs only as present / absent. */
export function redactPlan(a: OpenArgs) {
  const inMask = (d: number) => ((a.dirMask >> d) & 1) === 1;
  return {
    coin: a.coin,
    dirMask: a.dirMask,
    dirs: dirsOf(a.dirMask).map((d) => DIR_NAME[d]),
    seq: a.seq,
    u: a.u.map((x, d) => (inMask(d) ? redactU(x) : "-")),
    minOut: a.minOut.map((x, d) => (inMask(d) ? x.toString() : "0")),
    proofs: a.proofs.map((p, d) => (inMask(d) ? (p === ZERO_PROOF ? "missing" : "groth16") : "-")),
  };
}

export type RedactedPlan = ReturnType<typeof redactPlan>;

export interface CoordinatorResult {
  inert?: boolean;
  coins: number;
  active: number;
  opened: { coin: Address; dirMask: number; hash?: string }[];
  voided: { coin: Address; dir: Dir; seq: number; hash?: string }[];
  dropped: { coin: Address; dir: Dir; reason: string }[];
  /** --dry-run: the would-be openEpoch calls, u redacted */
  plans: RedactedPlan[];
}

const failKey = (coin: Address, d: Dir, seq: number) => `${coin.toLowerCase()}:${d}:${seq}`;

export function withMask(a: OpenArgs, dirMask: number): OpenArgs {
  return { ...a, dirMask };
}

export function openTx(darkCurve: Address, a: OpenArgs): Parameters<typeof sendTx>[1] {
  return {
    address: darkCurve,
    abi: darkCurveAbi,
    functionName: "openEpoch",
    args: [a.coin, a.dirMask, a.seq, a.u, a.proofs, a.minOut],
    label: `openEpoch(${a.coin}, mask ${a.dirMask})`,
  } as never;
}

/** Curve quotes from the Launchpad; after graduation from the pair with the GroveCoin tax; harvests from Roots. */
export function chainQuoter(ctx: Ctx): Quoter {
  const { pub, dep } = ctx;
  let weth: Address | undefined;
  return {
    async quote(coin, dir, amountIn) {
      if (dir === 2) return pub.readContract({ address: dep.roots, abi: rootsQuoteAbi, functionName: "harvestValue", args: [coin, amountIn] });
      const graduated = await pub.readContract({ address: dep.launchpad, abi: launchpadQuoteAbi, functionName: "isGraduated", args: [coin] });
      if (!graduated) {
        if (dir === 0) return (await pub.readContract({ address: dep.launchpad, abi: launchpadQuoteAbi, functionName: "quoteBuy", args: [coin, amountIn] }))[0];
        return (await pub.readContract({ address: dep.launchpad, abi: launchpadQuoteAbi, functionName: "quoteSell", args: [coin, amountIn] }))[0];
      }
      weth ??= await pub.readContract({ address: dep.router, abi: routerAbi, functionName: "WETH" });
      if (dir === 0) {
        const out = await pub.readContract({ address: dep.router, abi: routerAbi, functionName: "getAmountsOut", args: [amountIn, [weth, coin]] });
        return applySlippage(out[1], PAIR_TAX_BPS); // taxed on the pair -> DarkCurve transfer
      }
      const out = await pub.readContract({ address: dep.router, abi: routerAbi, functionName: "getAmountsOut", args: [applySlippage(amountIn, PAIR_TAX_BPS), [coin, weth]] });
      return out[1];
    },
  };
}

async function readParams(ctx: Ctx, darkCurve: Address): Promise<EpochParams> {
  const r = (await ctx.pub.readContract({ address: darkCurve, abi: darkCurveAbi, functionName: "params" })) as unknown as readonly unknown[];
  return { tMin: Number(r[0]), tMax: Number(r[1]), k: Number(r[2]), grace: Number(r[3]) };
}

/** epochsOf in batches (one eth_call per batch). */
export async function readEpochs(ctx: Ctx, darkCurve: Address, coins: readonly Address[], batch = 100): Promise<EpochView[][]> {
  const out: EpochView[][] = [];
  for (let i = 0; i < coins.length; i += batch) {
    const part = coins.slice(i, i + batch);
    const r = (await ctx.pub.readContract({ address: darkCurve, abi: darkCurveAbi, functionName: "epochsOf", args: [part] })) as unknown as EpochView[][];
    for (const row of r) {
      out.push(row.map((e) => ({ ...e, status: Number(e.status), keyId: Number(e.keyId), count: Number(e.count), startedAt: BigInt(e.startedAt) })));
    }
  }
  return out;
}

export async function readSeqs(ctx: Ctx, darkCurve: Address, coin: Address): Promise<[number, number, number]> {
  const r = await Promise.all(DIRS.map((d) => ctx.pub.readContract({ address: darkCurve, abi: darkCurveAbi, functionName: "cur", args: [coin, BigInt(d)] })));
  return r.map(Number) as [number, number, number];
}

export async function readKeyByGen(ctx: Ctx, darkCurve: Address, gen: number): Promise<[bigint, bigint]> {
  const [x, y] = await Promise.all([0n, 1n].map((i) => ctx.pub.readContract({ address: darkCurve, abi: darkCurveAbi, functionName: "keyByGen", args: [BigInt(gen), i] })));
  return [BigInt(x as bigint), BigInt(y as bigint)];
}

export async function coordinator(ctx: Ctx, deps: CoordinatorDeps): Promise<CoordinatorResult> {
  const res: CoordinatorResult = { coins: 0, active: 0, opened: [], voided: [], dropped: [], plans: [] };
  const pa = privacyAddresses(ctx.dep);
  if (!pa) {
    log.info("no grovePool/darkCurve in the deployment file: coordinator is inert");
    return { ...res, inert: true };
  }
  const { darkCurve, grovePool } = pa;
  const sendCtx = deps.sendCtx ?? ctx;
  const dry = ctx.cfg.dryRun;

  if (ctx.account) {
    const cp = await maybeCheckpoint(ctx, grovePool);
    if (cp.hash) log.info("checkpoint sent", { hash: cp.hash });
  }

  const coins = (await ctx.pub.readContract({ address: ctx.dep.launchpad, abi: launchpadAbi, functionName: "allCoins" })).map((c) => getAddress(c));
  res.coins = coins.length;
  if (coins.length === 0) {
    log.info("pass done", { coins: 0, active: 0 });
    return res;
  }
  const [params, block, epochs] = await Promise.all([readParams(ctx, darkCurve), ctx.pub.getBlock({ blockTag: "latest" }), readEpochs(ctx, darkCurve, coins)]);
  const now = BigInt(block.timestamp);

  // key generation -> local key (or null), only for generations that appear in active epochs
  const keyCache = new Map<number, CoordinatorKey | null>();
  const keyFor = async (gen: number) => {
    if (!keyCache.has(gen)) {
      const pk = await readKeyByGen(ctx, darkCurve, gen);
      const k = deps.keys.get(pkId(pk)) ?? null;
      keyCache.set(gen, k);
      if (!k) log.warn("no local key for an epoch key generation; its epochs can only be voided", { gen, pk: pkLabel(pk) });
    }
    return keyCache.get(gen) ?? null;
  };

  for (let ci = 0; ci < coins.length; ci++) {
    const coin = coins[ci];
    const eps = epochs[ci];
    if (!eps.some((e) => e.status === 1 && e.count > 0)) continue;
    res.active++;
    try {
      for (const g of new Set(eps.filter((e) => e.status === 1 && e.count > 0).map((e) => e.keyId))) await keyFor(g);
      const seq = await readSeqs(ctx, darkCurve, coin);
      const plan = planCoin(eps, params, now, (g) => !!keyCache.get(g), (d) => deps.failures.get(failKey(coin, d, seq[d])) ?? 0, deps.pcfg.maxOpenAttempts);
      log.debug("coin state", { coin, states: plan.states, counts: eps.map((e) => e.count), seq });

      const opened = new Set<Dir>();
      if (plan.open.length > 0) {
        const args: OpenArgs = { coin, dirMask: 0, seq, u: [0n, 0n, 0n], proofs: [ZERO_PROOF, ZERO_PROOF, ZERO_PROOF], minOut: [0n, 0n, 0n] };
        const ready: Dir[] = [];
        for (const d of plan.open) {
          const ep = eps[d];
          const key = keyCache.get(ep.keyId)!;
          // SUM ONLY: the epoch's running sum as stored on-chain, never an individual ciphertext
          const sum = elgamal.onChainSum(ep.c1, ep.c2, ep.count);
          const u = deps.solve(elgamal.decrypt(sum, key.sk));
          if (u === null || u <= 0n || u >= MAX_U_SUM) {
            log.error("epoch sum not solvable in range; leaving it to void", { coin, dir: DIR_NAME[d], seq: seq[d], count: ep.count });
            res.dropped.push({ coin, dir: d, reason: "unsolvable" });
            deps.failures.set(failKey(coin, d, seq[d]), deps.pcfg.maxOpenAttempts);
            continue;
          }
          let quote: bigint;
          try {
            quote = await deps.quoter.quote(coin, d, d === 0 ? u * UNIT_BNB : u * UNIT_TOKEN);
          } catch (e) {
            log.warn("quote failed; direction left out of this pass", { coin, dir: DIR_NAME[d], err: errorText(e).split("\n")[0] });
            res.dropped.push({ coin, dir: d, reason: "quote" });
            bump(deps.failures, failKey(coin, d, seq[d]));
            continue;
          }
          args.u[d] = u;
          args.minOut[d] = applySlippage(quote, deps.pcfg.slippageBps);
          args.proofs[d] = await deps.prove({ ecSk: key.sk, sum, u });
          ready.push(d);
          log.info("direction ready", { coin, dir: DIR_NAME[d], seq: seq[d], count: ep.count, u: redactU(u) });
        }

        let mask = maskOf(ready);
        for (let attempt = 0; mask !== 0 && attempt < 4; attempt++) {
          const a = withMask(args, mask);
          if (dry) res.plans.push(redactPlan(a));
          if (dry && !ctx.account) {
            log.info("DRY_RUN openEpoch (no KEEPER_PRIVATE_KEY: not simulated)", { plan: redactPlan(a) });
            break;
          }
          try {
            const r = await deps.send(sendCtx, openTx(darkCurve, a));
            if (!r.dryRun && r.status !== "success") throw new Error(`openEpoch reverted on-chain (${r.hash})`);
            for (const d of dirsOf(mask)) {
              opened.add(d);
              deps.failures.delete(failKey(coin, d, seq[d]));
            }
            res.opened.push({ coin, dirMask: mask, hash: r.hash });
            if (dry) log.info("DRY_RUN openEpoch simulated ok", { plan: redactPlan(a) });
            else log.info("epochs opened", { coin, dirs: dirsOf(mask).map((d) => DIR_NAME[d]), hash: r.hash });
            break;
          } catch (e) {
            const why = decodeOpenRevert(e);
            if (why.kind === "band" && (mask & (1 << why.dir)) !== 0) {
              log.warn("direction band-blocked; retrying without it", { coin, dir: DIR_NAME[why.dir], seq: seq[why.dir] });
              res.dropped.push({ coin, dir: why.dir, reason: "band" });
              bump(deps.failures, failKey(coin, why.dir, seq[why.dir]));
              mask &= ~(1 << why.dir);
              continue;
            }
            const dirs = dirsOf(mask);
            if (dirs.length === 1) {
              const reason = why.kind === "other" ? why.reason : "band";
              log.warn("open failed; retried with fresh quotes next pass", { coin, dir: DIR_NAME[dirs[0]], reason });
              res.dropped.push({ coin, dir: dirs[0], reason });
              bump(deps.failures, failKey(coin, dirs[0], seq[dirs[0]]));
              break;
            }
            // find the failing direction(s): simulate each included direction alone and keep the ones that pass
            let keep = 0;
            for (const d of dirs) {
              try {
                await ctx.pub.simulateContract({ ...(openTx(darkCurve, withMask(args, 1 << d)) as object), account: ctx.account } as never);
                keep |= 1 << d;
              } catch (e2) {
                const w = decodeOpenRevert(e2);
                const reason = w.kind === "band" ? "band" : w.reason;
                log.warn("direction fails alone; dropped from the mask", { coin, dir: DIR_NAME[d], reason });
                res.dropped.push({ coin, dir: d, reason });
                bump(deps.failures, failKey(coin, d, seq[d]));
              }
            }
            if (keep === mask) break; // each passes alone but not together: next pass, fresh quotes
            mask = keep;
          }
        }
      }

      // voids: voidable directions not opened in this pass (no key, unsolvable, or failing persistently)
      for (const d of DIRS.filter((x) => plan.states[x] === "voidable" && !opened.has(x))) {
        if (!ctx.account) {
          log.info("DRY_RUN voidEpoch (no KEEPER_PRIVATE_KEY: not simulated)", { coin, dir: DIR_NAME[d], seq: seq[d] });
          res.voided.push({ coin, dir: d, seq: seq[d] });
          continue;
        }
        try {
          const r = await deps.send(sendCtx, {
            address: darkCurve,
            abi: darkCurveAbi,
            functionName: "voidEpoch",
            args: [coin, d, seq[d]],
            label: `voidEpoch(${coin}, ${DIR_NAME[d]}, ${seq[d]})`,
          } as never);
          res.voided.push({ coin, dir: d, seq: seq[d], hash: r.hash });
          deps.failures.delete(failKey(coin, d, seq[d]));
          log.info(r.dryRun ? "DRY_RUN voidEpoch simulated ok" : "epoch voided", { coin, dir: DIR_NAME[d], seq: seq[d], hash: r.hash });
        } catch (e) {
          log.warn("voidEpoch failed", { coin, dir: DIR_NAME[d], seq: seq[d], err: errorText(e).split("\n")[0] });
        }
      }
    } catch (e) {
      log.error("coordinator failed for coin", { coin, err: errorText(e).split("\n")[0] });
    }
  }
  log.info("pass done", { coins: res.coins, active: res.active, opened: res.opened.length, voided: res.voided.length, dropped: res.dropped.length });
  return res;
}

function bump(m: Map<string, number>, k: string) {
  m.set(k, (m.get(k) ?? 0) + 1);
}

// ------------------------------------------------------------------------------------------------ wiring

/** Long-lived state of the coordinator process (BSGS table, failure counters, private-RPC context). */
export interface CoordinatorRuntime {
  table?: BsgsTable;
  failures: Map<string, number>;
  sendCtx?: Ctx;
}

export function newCoordinatorRuntime(): CoordinatorRuntime {
  return { failures: new Map() };
}

/** The `coordinator` command: real keys, the BSGS table (loaded only when a sum must be solved), snarkjs. */
export async function runCoordinator(ctx: Ctx, rt: CoordinatorRuntime, env: NodeJS.ProcessEnv = process.env): Promise<CoordinatorResult> {
  const pcfg = loadPrivacyConfig(env, ctx.cfg.snapshotDir);
  const noKeys = { keys: new Map<string, CoordinatorKey>(), solve: () => null, prove: async () => ZERO_PROOF, quoter: chainQuoter(ctx), send: sendTx, failures: rt.failures, pcfg };
  if (!privacyAddresses(ctx.dep)) return coordinator(ctx, noKeys);

  const keys = loadCoordinatorKeys(pcfg.coordinatorKeyDir, env, (file, reason) => log.warn("key file skipped", { file, reason }));
  if (keys.size === 0) log.warn("no Coordinator key (COORDINATOR_SK or COORDINATOR_KEY_DIR): epochs can only be voided");
  else log.info("coordinator keys loaded", { count: keys.size, pks: [...keys.values()].map((k) => pkLabel(k.pk)) });

  if (!rt.sendCtx) {
    if (pcfg.privateTxRpc && ctx.account) {
      const wallet = createWalletClient({ chain: ctx.chain, transport: http(pcfg.privateTxRpc, { retryCount: 1, timeout: 30_000 }), account: ctx.account });
      rt.sendCtx = { ...ctx, wallet };
      log.info("openEpoch / voidEpoch are sent through PRIVATE_TX_RPC");
    } else {
      rt.sendCtx = ctx;
      if (ctx.account && !ctx.cfg.dryRun) log.warn("PRIVATE_TX_RPC unset: opens go through the public RPC and are visible in the mempool (spec section 2.6.6)");
    }
  }
  const solve = (m: Point) => {
    if (!rt.table) rt.table = loadOrBuildTable(pcfg.bsgsPath, pcfg.bsgsBits, { log: (msg, meta) => log.info(msg, meta) });
    return bsgsSolve(m, rt.table);
  };
  const prove = async (a: { ecSk: bigint; sum: SummedCiphertext; u: bigint }) => (await proveOpen(a)).proof;
  return coordinator(ctx, { keys, solve, prove, quoter: chainQuoter(ctx), send: sendTx, failures: rt.failures, pcfg, sendCtx: rt.sendCtx });
}
