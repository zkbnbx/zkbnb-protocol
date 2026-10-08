import { describe, it, expect, vi } from "vitest";
import type { Address } from "viem";
import { checkpointDecision, maybeCheckpoint, CHECKPOINT_PERIOD } from "../src/checkpoint.js";
import type { Ctx } from "../src/chain.js";

const POOL = "0x00000000000000000000000000000000000000a1" as Address;

describe("checkpointDecision", () => {
  const P = CHECKPOINT_PERIOD;
  it("not due inside the period of the last checkpoint (an insert this period already checkpointed)", () => {
    expect(checkpointDecision({ now: 10n * P + 599n, lastCheckpointPeriod: 10n, lastRootKnown: false })).toEqual({
      due: false,
      reason: "same-period",
      period: 10n,
    });
  });
  it("not due in a later period when the current root is already known (nothing inserted since)", () => {
    expect(checkpointDecision({ now: 12n * P, lastCheckpointPeriod: 10n, lastRootKnown: true }).due).toBe(false);
  });
  it("due in a later period when the current root is unknown", () => {
    expect(checkpointDecision({ now: 11n * P, lastCheckpointPeriod: 10n, lastRootKnown: false })).toEqual({ due: true, period: 11n });
  });
});

function mockCtx(state: { ts: bigint; lastPeriod: bigint; known: boolean }, dryRun = true) {
  const writeContract = vi.fn();
  const simulateContract = vi.fn(async () => ({ result: undefined, request: {} }));
  const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
    if (functionName === "lastCheckpointPeriod") return state.lastPeriod;
    if (functionName === "getLastRoot") return 777n;
    if (functionName === "isKnownRoot") return state.known;
    throw new Error(functionName);
  });
  const ctx = {
    cfg: { dryRun },
    pub: { getBlock: vi.fn(async () => ({ timestamp: state.ts })), readContract, simulateContract },
    wallet: { writeContract },
    account: { address: "0x00000000000000000000000000000000000000b2" },
    txLock: Promise.resolve(),
  } as unknown as Ctx;
  return { ctx, simulateContract, writeContract, readContract };
}

describe("maybeCheckpoint", () => {
  it("is inert without a GrovePool address (no RPC call at all)", async () => {
    const { ctx, readContract } = mockCtx({ ts: 0n, lastPeriod: 0n, known: false });
    expect(await maybeCheckpoint(ctx, undefined)).toEqual({ sent: false, skipped: "no grovePool in deployments" });
    expect(readContract).not.toHaveBeenCalled();
  });

  it("does not send when not due", async () => {
    const { ctx, simulateContract } = mockCtx({ ts: 5n * CHECKPOINT_PERIOD + 1n, lastPeriod: 5n, known: false });
    const r = await maybeCheckpoint(ctx, POOL);
    expect(r.sent).toBe(false);
    expect(simulateContract).not.toHaveBeenCalled();
  });

  it("simulates checkpoint() when due and stops there under DRY_RUN", async () => {
    const { ctx, simulateContract, writeContract } = mockCtx({ ts: 6n * CHECKPOINT_PERIOD, lastPeriod: 5n, known: false });
    const r = await maybeCheckpoint(ctx, POOL);
    expect(r.decision).toEqual({ due: true, period: 6n });
    expect(r.sent).toBe(false);
    expect(simulateContract).toHaveBeenCalledOnce();
    expect((simulateContract.mock.calls[0] as unknown as [{ functionName: string; address: string }])[0]).toMatchObject({
      functionName: "checkpoint",
      address: POOL,
    });
    expect(writeContract).not.toHaveBeenCalled();
  });

  it("a reverting simulation (lost race) is logged, not thrown", async () => {
    const { ctx, simulateContract } = mockCtx({ ts: 6n * CHECKPOINT_PERIOD, lastPeriod: 5n, known: false });
    simulateContract.mockRejectedValueOnce(new Error("execution reverted"));
    const r = await maybeCheckpoint(ctx, POOL);
    expect(r).toMatchObject({ sent: false, skipped: "send failed" });
  });
});
