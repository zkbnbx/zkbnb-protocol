/**
 * CreatorStubs of privately planted coins (privacy stage 2, spec section 2.8 / 5.2), from `Planter.PlantedPrivately`.
 * Used by `flush` (which stubs to flush) and `rewards` (stubs are excluded from holder snapshots).
 *
 * Inert without a planter: returns [] without a single RPC call, so the live keeper (no stage-2 addresses in
 * its deployment file) behaves exactly as before.
 */
import path from "node:path";
import { getAddress, parseEventLogs, toEventSelector, type Address } from "viem";
import { planterAbi } from "./abis.js";
import type { Ctx } from "./chain.js";
import { getLogsChunked } from "./logs.js";
import { readJson, writeJsonAtomic } from "./state.js";

export interface StubRecord {
  coin: Address;
  stub: Address;
  /** decimal; a one-coin handle, public by design (spec section 2.8) */
  handle: string;
  block: number;
}

interface StubCache {
  chainId: number;
  planter: Address;
  /** last block scanned; the next scan restarts `confirmations` blocks before it */
  lastBlock: number;
  stubs: StubRecord[];
}

export function stubCachePath(snapshotDir: string, chainId: number): string {
  return path.join(snapshotDir, `stubs-${chainId}.json`);
}

const PLANTED_PRIVATELY = toEventSelector("PlantedPrivately(address,address,uint256)");

export async function knownStubs(ctx: Ctx): Promise<StubRecord[]> {
  const { dep, cfg, pub } = ctx;
  if (!dep.planter) return [];
  const file = stubCachePath(cfg.snapshotDir, cfg.chainId);
  const cached = readJson<StubCache>(file);
  const fresh = cached && cached.chainId === cfg.chainId && cached.planter.toLowerCase() === dep.planter.toLowerCase();
  const stubs = new Map<string, StubRecord>((fresh ? cached!.stubs : []).map((s) => [s.stub.toLowerCase(), s]));
  const start = BigInt(dep.privacyStartBlock ?? dep.startBlock);
  let from = fresh ? BigInt(cached!.lastBlock) + 1n - BigInt(cfg.confirmations) : start;
  if (from < start) from = start;
  const head = await pub.getBlockNumber();
  if (from <= head) {
    const raw = await getLogsChunked(ctx, { address: dep.planter, fromBlock: from, toBlock: head, topics: [PLANTED_PRIVATELY] });
    const ev = parseEventLogs({ abi: planterAbi, eventName: "PlantedPrivately", logs: raw as never, strict: true });
    for (const e of ev) {
      const stub = getAddress(e.args.stub);
      stubs.set(stub.toLowerCase(), { coin: getAddress(e.args.coin), stub, handle: e.args.handle.toString(), block: Number(e.blockNumber) });
    }
  }
  const out = [...stubs.values()].sort((a, b) => a.block - b.block || (a.stub < b.stub ? -1 : 1));
  writeJsonAtomic(file, { chainId: cfg.chainId, planter: getAddress(dep.planter), lastBlock: Number(head), stubs: out } satisfies StubCache);
  return out;
}

/** True when the deployment file carries any stage-2 module the snapshot rule must know about. */
export function hasPrivacyModules(dep: { grovePool?: Address; darkCurve?: Address; planter?: Address }): boolean {
  return !!(dep.grovePool || dep.darkCurve || dep.planter);
}

/**
 * Holder-snapshot exclusions with the stage-2 rule of spec section 2.5 / 5.2: GrovePool is an ordinary holder (removed
 * from the list even when EXCLUDE_ADDRESSES names it), DarkCurve, Planter and every CreatorStub are excluded. With
 * no stage-2 module in `dep` the input list is returned unchanged.
 */
export function applyPrivacyExclusions(
  excluded: readonly Address[],
  dep: { grovePool?: Address; darkCurve?: Address; planter?: Address },
  stubs: readonly Pick<StubRecord, "stub">[],
): { excluded: Address[]; poolWasListed: boolean } {
  if (!hasPrivacyModules(dep)) return { excluded: [...excluded], poolWasListed: false };
  const pool = dep.grovePool?.toLowerCase();
  const poolWasListed = !!pool && excluded.some((a) => a.toLowerCase() === pool);
  const out = excluded.filter((a) => a.toLowerCase() !== pool);
  for (const a of [dep.darkCurve, dep.planter, ...stubs.map((s) => s.stub)]) {
    if (a && !out.some((x) => x.toLowerCase() === a.toLowerCase())) out.push(getAddress(a));
  }
  return { excluded: out, poolWasListed };
}
