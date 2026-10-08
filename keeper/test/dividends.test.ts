import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { encodeAbiParameters, encodeEventTopics, getAddress, numberToHex, parseEther, type Address } from "viem";
import { dividends, MIN_REWARD_SUPPLY, poolLeafFromSnapshot } from "../src/commands/dividends.js";
import { flush, shouldFlush } from "../src/commands/flush.js";
import { buildSnapshot, writeSnapshot } from "../src/snapshot.js";
import { planterAbi } from "../src/abis.js";
import type { Ctx } from "../src/chain.js";
import type { Deployments, KeeperConfig } from "../src/config.js";

const COIN = getAddress("0x1234567890123456789012345678901234567777");
const POOL = getAddress("0x00000000000000000000000000000000000000AA");
const ALICE = getAddress("0x00000000000000000000000000000000000000a1");
const BOB = getAddress("0x00000000000000000000000000000000000000b0");
const KEEPER = getAddress("0xcee9000000000000000000000000000000000001");
const PLANTER = getAddress("0x91a0000000000000000000000000000000000001");
const STUB = getAddress("0x5700000000000000000000000000000000000001");

/** `cast keccak $(cast abi-encode "f(address,uint256,address,uint256)" <COIN> 7 <POOL> 123456789000000000000)`,
 *  i.e. HolderRewards.leaf(coin, 7, pool, 123456789000000000000) = keccak256(abi.encode(coin, runId, account, amount)). */
const CAST_LEAF = "0xe722f79595e5b4ef48f7d8a30e0cdb02c8e3c8ae6b4a4342a5c03043d9bf220a";

function snapshot(runId: bigint, poolAmount: bigint) {
  return buildSnapshot({
    coin: COIN,
    runId,
    shares: [
      { account: ALICE, amount: parseEther("1") },
      { account: POOL, amount: poolAmount },
      { account: BOB, amount: parseEther("0.5") },
    ],
    snapshotBlock: 100n,
    takenAt: 1,
    minHoldingWei: 1n,
    excluded: [],
  });
}

describe("pool leaf", () => {
  it("equals HolderRewards.leaf (vector from cast) and verifies against the posted root", () => {
    const s = snapshot(7n, 123456789000000000000n);
    const l = poolLeafFromSnapshot(s.json, POOL, s.root)!;
    expect(l.leaf).toBe(CAST_LEAF);
    expect(l.amount).toBe(123456789000000000000n);
    expect(() => poolLeafFromSnapshot(s.json, POOL, "0x" + "11".repeat(32) as `0x${string}`)).toThrow(/posted run root/);
    expect(poolLeafFromSnapshot(s.json, getAddress("0x00000000000000000000000000000000000000cc"))).toBeUndefined();
  });
});

describe("dividends", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "div-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function makeCtx(opts: { claimed: Record<string, boolean>; poolBalance: bigint; runs: Record<string, ReturnType<typeof snapshot>> }) {
    const readContract = vi.fn(async (p: { functionName: string; args?: readonly unknown[] }) => {
      const a = p.args ?? [];
      switch (p.functionName) {
        case "allCoins":
          return [COIN];
        case "configOf":
          return [ALICE, 2, ALICE, 0n, false, true, false, false];
        case "runCount":
          return BigInt(Object.keys(opts.runs).length);
        case "isClaimed":
          return opts.claimed[String(a[1])] ?? false;
        case "getRun": {
          const s = opts.runs[String(a[1])];
          return { root: s.root, amount: s.amount, claimed: 0n, holders: 3n, postedAt: 1n, uri: "dry-run://x" };
        }
        case "leaf": {
          const { leafHash } = await import("../src/merkle.js");
          return leafHash(a[0] as Address, a[1] as bigint, a[2] as Address, a[3] as bigint);
        }
        case "balanceOf":
          return opts.poolBalance;
        default:
          throw new Error(`unexpected read ${p.functionName}`);
      }
    });
    const simulateContract = vi.fn(async () => ({ result: undefined, request: {} }));
    const dep = { launchpad: KEEPER, feeRouter: KEEPER, holderRewards: KEEPER, grovePool: POOL, darkCurve: KEEPER, startBlock: 1 } as unknown as Deployments;
    const cfg = { chainId: 97, snapshotDir: dir, dryRun: true } as KeeperConfig;
    return { ctx: { cfg, dep, pub: { readContract, simulateContract }, account: { address: KEEPER }, txLock: Promise.resolve() } as unknown as Ctx, simulateContract };
  }

  it("pulls every unclaimed run that lists the pool, and skips claimed ones (idempotent)", async () => {
    const runs = { "0": snapshot(0n, parseEther("0.2")), "1": snapshot(1n, parseEther("0.3")) };
    for (const r of Object.values(runs)) writeSnapshot(dir, r.json);
    const { ctx, simulateContract } = makeCtx({ claimed: { "0": true }, poolBalance: MIN_REWARD_SUPPLY, runs });
    const res = await dividends(ctx, {});
    expect(res.pulled.map((p) => p.runId)).toEqual([1n]);
    const call = simulateContract.mock.calls[0] as unknown as [{ functionName: string; address: Address; args: unknown[] }];
    expect(call[0].functionName).toBe("pullRewards");
    expect(call[0].address).toBe(POOL);
    expect(call[0].args.slice(0, 3)).toEqual([COIN, 1n, parseEther("0.3")]);
    expect(call[0].args[3]).toEqual(runs["1"].json.leaves[1].proof);
  });

  it("leaves a run in HolderRewards while the pool holds less than one token (MIN_REWARD_SUPPLY)", async () => {
    const runs = { "0": snapshot(0n, parseEther("0.2")) };
    writeSnapshot(dir, runs["0"].json);
    const { ctx, simulateContract } = makeCtx({ claimed: {}, poolBalance: MIN_REWARD_SUPPLY - 1n, runs });
    const res = await dividends(ctx, {});
    expect(res.pulled).toEqual([]);
    expect(res.skipped[0].reason).toMatch(/MIN_REWARD_SUPPLY/);
    expect(simulateContract).not.toHaveBeenCalled();
  });

  it("is inert without grovePool", async () => {
    const readContract = vi.fn();
    const ctx = { dep: { startBlock: 1 }, cfg: {}, pub: { readContract } } as unknown as Ctx;
    expect(await dividends(ctx, {})).toMatchObject({ inert: true });
    expect(readContract).not.toHaveBeenCalled();
  });
});

describe("flush", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "flush-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("threshold on balance + FeeRouter.pending", () => {
    const min = parseEther("0.01");
    expect(shouldFlush(parseEther("0.006"), parseEther("0.004"), min)).toBe(true);
    expect(shouldFlush(parseEther("0.009"), 0n, min)).toBe(false);
    expect(shouldFlush(0n, 0n, 0n)).toBe(false);
  });

  it("enumerates PlantedPrivately stubs and flushes those above MIN_FLUSH_BNB", async () => {
    const STUB2 = getAddress("0x5700000000000000000000000000000000000002");
    const log = (coin: Address, stub: Address, handle: bigint, block: number) => ({
      address: PLANTER,
      topics: encodeEventTopics({ abi: planterAbi, eventName: "PlantedPrivately", args: { coin } }),
      data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [stub, handle]),
      blockNumber: numberToHex(block),
      transactionHash: numberToHex(block, { size: 32 }),
      logIndex: "0x0",
      blockHash: numberToHex(block, { size: 32 }),
      transactionIndex: "0x0",
      removed: false,
    });
    const request = vi.fn(async () => [log(COIN, STUB, 5n, 10), log(ALICE, STUB2, 6n, 11)]);
    const simulateContract = vi.fn(async () => ({ result: undefined, request: {} }));
    const ctx = {
      cfg: { chainId: 97, snapshotDir: dir, dryRun: true, logChunk: 1000n, confirmations: 3 } as KeeperConfig,
      dep: { planter: PLANTER, feeRouter: KEEPER, startBlock: 1, privacyStartBlock: 5 } as unknown as Deployments,
      pub: {
        request,
        simulateContract,
        getBlockNumber: async () => 20n,
        getBalance: async ({ address }: { address: Address }) => (address === STUB ? parseEther("0.02") : 0n),
        readContract: async () => parseEther("0.001"),
      },
      account: { address: KEEPER },
      txLock: Promise.resolve(),
    } as unknown as Ctx;
    const res = await flush(ctx, {});
    expect(res.stubs).toBe(2);
    expect(res.flushed.map((f) => f.stub)).toEqual([STUB]);
    expect((simulateContract.mock.calls[0] as unknown as [{ functionName: string; address: Address }])[0]).toMatchObject({ functionName: "flush", address: STUB });
  });

  it("is inert without planter", async () => {
    const ctx = { dep: { startBlock: 1 }, cfg: {}, pub: {} } as unknown as Ctx;
    expect(await flush(ctx, {})).toEqual({ inert: true, stubs: 0, flushed: [] });
  });
});
