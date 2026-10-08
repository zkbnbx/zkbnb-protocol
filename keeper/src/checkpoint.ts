/**
 * GrovePool root checkpoints — privacy/PRIVACY-SPEC.md §2.1, §4.1, §5.2.
 *
 * MerkleTreeWithHistoryV2 records a root as known only at a checkpoint: the first insert after each
 * CHECKPOINT_PERIOD (600 s) boundary checkpoints automatically; in a period with no insert someone must call
 * `checkpoint()` or notes inserted at the end of the previous period stay unspendable. The coordinator and the
 * relayer call `maybeCheckpoint` on their loops; it sends at most one transaction per period and only when the
 * current root is not yet known (a checkpoint of an already-known root would be a wasted transaction).
 *
 * Inert without a pool address: callers pass `undefined` while `grovePool` is absent from the deployment file.
 */
import type { Address, Hex } from "viem";
import { sendTx, type Ctx } from "./chain.js";
import { logger } from "./log.js";

const log = logger("checkpoint");

export const CHECKPOINT_PERIOD = 600n;

/** Minimal GrovePool fragment (MerkleTreeWithHistoryV2 surface). */
export const checkpointAbi = [
  { type: "function", name: "checkpoint", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "lastCheckpointPeriod", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
  { type: "function", name: "getLastRoot", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "isKnownRoot", stateMutability: "view", inputs: [{ name: "root", type: "uint256" }], outputs: [{ type: "bool" }] },
  {
    type: "event",
    name: "Checkpoint",
    inputs: [
      { name: "root", type: "uint256", indexed: false },
      { name: "indexAfter", type: "uint32", indexed: false },
      { name: "period", type: "uint64", indexed: false },
    ],
  },
] as const;

export interface CheckpointState {
  /** chain time (latest block timestamp), seconds */
  now: bigint;
  lastCheckpointPeriod: bigint;
  /** isKnownRoot(getLastRoot()) */
  lastRootKnown: boolean;
}

export type CheckpointDecision =
  | { due: true; period: bigint }
  | { due: false; reason: "same-period" | "root-already-known"; period: bigint };

/**
 * Pure rule: due iff the chain is in a later period than the last checkpoint AND the current root is not yet known.
 * An insert in the current period has already checkpointed (the contract checkpoints before inserting), which shows
 * as lastCheckpointPeriod == the current period.
 */
export function checkpointDecision(s: CheckpointState, period = CHECKPOINT_PERIOD): CheckpointDecision {
  const cur = s.now / period;
  if (cur <= s.lastCheckpointPeriod) return { due: false, reason: "same-period", period: cur };
  if (s.lastRootKnown) return { due: false, reason: "root-already-known", period: cur };
  return { due: true, period: cur };
}

export async function readCheckpointState(ctx: Pick<Ctx, "pub">, pool: Address): Promise<CheckpointState> {
  const [block, lastCheckpointPeriod, lastRoot] = await Promise.all([
    ctx.pub.getBlock({ blockTag: "latest" }),
    ctx.pub.readContract({ address: pool, abi: checkpointAbi, functionName: "lastCheckpointPeriod" }),
    ctx.pub.readContract({ address: pool, abi: checkpointAbi, functionName: "getLastRoot" }),
  ]);
  const lastRootKnown = await ctx.pub.readContract({ address: pool, abi: checkpointAbi, functionName: "isKnownRoot", args: [lastRoot] });
  return { now: block.timestamp, lastCheckpointPeriod: BigInt(lastCheckpointPeriod), lastRootKnown };
}

export interface CheckpointResult {
  sent: boolean;
  hash?: Hex;
  decision?: CheckpointDecision;
  skipped?: string;
}

/** Calls `pool.checkpoint()` when due. Honours DRY_RUN through sendTx. Never throws on a lost race (logs it). */
export async function maybeCheckpoint(ctx: Ctx, pool: Address | undefined): Promise<CheckpointResult> {
  if (!pool) return { sent: false, skipped: "no grovePool in deployments" };
  const state = await readCheckpointState(ctx, pool);
  const decision = checkpointDecision(state);
  if (!decision.due) return { sent: false, decision };
  try {
    const r = await sendTx(ctx, { address: pool, abi: checkpointAbi, functionName: "checkpoint", args: [], label: "pool.checkpoint" });
    return { sent: !r.dryRun, hash: r.hash, decision };
  } catch (e) {
    // another caller (relayer / coordinator / an insert) may have checkpointed first; the next loop re-reads
    log.warn("pool.checkpoint failed", { error: (e as Error).message.split("\n")[0] });
    return { sent: false, decision, skipped: "send failed" };
  }
}
