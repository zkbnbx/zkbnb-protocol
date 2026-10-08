import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { encodeAbiParameters, encodeEventTopics, getAddress, hexToBigInt, numberToHex, type Abi, type Address, type Hex } from "viem";
import { CHUNK_SIZE, epochRow, poolFeed, verifyBundle, type ChunkJson, type EpochsJson, type ManifestJson } from "../src/commands/poolFeed.js";
import { darkCurveAbi, grovePoolAbi } from "../src/abis.js";
import { epochKey, resultLeaf, ZERO_LEAF } from "../src/grove2.js";
import type { Ctx } from "../src/chain.js";
import type { Deployments, KeeperConfig } from "../src/config.js";

const POOL = getAddress("0x9001000000000000000000000000000000000001");
const DARK = getAddress("0xdc00000000000000000000000000000000000001");
const LAUNCHPAD = getAddress("0x1a00000000000000000000000000000000000001");
const COIN = getAddress("0xa000000000000000000000000000000000000001");

interface RpcLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex;
  transactionHash: Hex;
  logIndex: Hex;
  blockHash: Hex;
  transactionIndex: Hex;
  removed: boolean;
}

type Ev = { abi: Abi; address: Address; name: string; args: Record<string, unknown> };
const pool = (name: string, args: Record<string, unknown>): Ev => ({ abi: grovePoolAbi as unknown as Abi, address: POOL, name, args });
const dark = (name: string, args: Record<string, unknown>): Ev => ({ abi: darkCurveAbi as unknown as Abi, address: DARK, name, args });

/** Encodes events as eth_getLogs returns them; each inner array is one transaction. */
class Chain {
  logs: RpcLog[] = [];
  head = 0n;
  private tx = 0;
  add(block: bigint, txs: Ev[][]) {
    let li = 0;
    for (const evs of txs) {
      const hash = numberToHex(++this.tx, { size: 32 });
      for (const e of evs) {
        const item = (e.abi as readonly { type: string; name?: string; inputs?: { name: string; type: string; indexed?: boolean }[] }[]).find((x) => x.type === "event" && x.name === e.name)!;
        const indexed = Object.fromEntries(item.inputs!.filter((i) => i.indexed).map((i) => [i.name, e.args[i.name]]));
        const plain = item.inputs!.filter((i) => !i.indexed);
        const topics = encodeEventTopics({ abi: e.abi, eventName: e.name, args: indexed } as never) as Hex[];
        const data = encodeAbiParameters(plain as never, plain.map((i) => e.args[i.name]) as never);
        this.logs.push({ address: e.address, topics, data, blockNumber: numberToHex(block), transactionHash: hash, logIndex: numberToHex(li++), blockHash: numberToHex(block, { size: 32 }), transactionIndex: "0x0", removed: false });
      }
    }
    if (block > this.head) this.head = block;
  }
}

function makeCtx(chain: Chain, snapshotDir: string, epochs?: unknown) {
  const request = vi.fn(async ({ method, params }: { method: string; params: [{ fromBlock: Hex; toBlock: Hex; address: Address[] }] }) => {
    if (method !== "eth_getLogs") throw new Error(method);
    const from = hexToBigInt(params[0].fromBlock);
    const to = hexToBigInt(params[0].toBlock);
    const addrs = params[0].address.map((a) => a.toLowerCase());
    return chain.logs.filter((l) => hexToBigInt(l.blockNumber) >= from && hexToBigInt(l.blockNumber) <= to && addrs.includes(l.address.toLowerCase()));
  });
  const readContract = vi.fn(async (p: { functionName: string; args?: readonly unknown[] }) => {
    switch (p.functionName) {
      case "allCoins":
        return [COIN];
      case "params":
        return [60, 300, 5, 1800, 1000, 256, 5n * 10n ** 17n, 1_475_000];
      case "epochsOf":
        return [epochs];
      case "cur":
        return [4, 7, 0][Number(p.args![1])];
      default:
        throw new Error(`unexpected read ${p.functionName}`);
    }
  });
  const dep = { launchpad: LAUNCHPAD, grovePool: POOL, darkCurve: DARK, startBlock: 1, privacyStartBlock: 5 } as Deployments;
  const cfg = { chainId: 97, snapshotDir, logChunk: 1000n, dryRun: false } as KeeperConfig;
  return { ctx: { cfg, dep, pub: { request, readContract, getBlockNumber: async () => chain.head + 3n } } as unknown as Ctx, request };
}

const empty = { startedAt: 0n, status: 0, keyId: 0, count: 0, refPrice: 0n, refVb: 0n, c1: { x: 0n, y: 1n, t: 0n, z: 1n }, c2: { x: 0n, y: 1n, t: 0n, z: 1n } };

describe("pool-feed bundle", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "poolfeed-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const intentLeaf = 111n;
  const resOpen = resultLeaf(epochKey(COIN, 0, 0), { totalIn: 10n ** 17n, totalOut: 5n * 10n ** 21n, totalRefund: 3n, rptAtSettle: 0n });
  const accRpt = 5n * 10n ** 17n;
  const resVoid = resultLeaf(epochKey(COIN, 0, 1), { totalIn: 1n, totalOut: 0n, totalRefund: 1n, rptAtSettle: accRpt });

  function seed(chain: Chain) {
    chain.add(10n, [
      [
        pool("NewNullifier", { nullifier: 901n }),
        pool("NewNullifier", { nullifier: 902n }),
        pool("NewCommitment", { commitment: intentLeaf, index: 0, encryptedOutput: "0xaa" }),
        pool("NewCommitment", { commitment: 112n, index: 1, encryptedOutput: "0xbb" }),
        pool("NewCommitment", { commitment: 113n, index: 2, encryptedOutput: "0xcc" }),
        dark("IntentSubmitted", { coin: COIN, dir: 0, seq: 0, count: 1, intentLeaf }),
      ],
    ]);
    chain.add(11n, [[pool("Checkpoint", { root: 7777n, indexAfter: 4, period: 3_000_000n })]]);
    chain.add(12n, [
      [
        pool("NewCommitment", { commitment: resOpen, index: 4, encryptedOutput: "0x" }),
        dark("EpochOpened", { coin: COIN, dir: 0, seq: 0, u: 10_000n, totalIn: 10n ** 17n, totalOut: 5n * 10n ** 21n, refund: 3n, spotAfter: 1n, rptAtSettle: 0n }),
      ],
    ]);
    chain.add(13n, [[pool("RewardsPulled", { coin: COIN, runId: 0n, amount: 10n ** 16n, accRpt })]]);
    chain.add(14n, [[pool("NewCommitment", { commitment: resVoid, index: 8, encryptedOutput: "0x" }), dark("EpochVoided", { coin: COIN, dir: 1, seq: 0 })]]);
    chain.add(15n, [[pool("Credited", { handle: 4242n, amount: 10n ** 17n })], [pool("HandleClaimed", { handle: 4242n, claimAmount: 10n ** 17n })]]);
  }

  function transfers(chain: Chain, block: bigint, firstIndex: number, n: number) {
    const txs: Ev[][] = [];
    for (let t = 0; t < n; t++) {
      const i = firstIndex + 4 * t;
      txs.push([pool("NewNullifier", { nullifier: BigInt(10_000 + i) }), ...[0, 1, 2, 3].map((k) => pool("NewCommitment", { commitment: BigInt(1_000_000 + i + k), index: i + k, encryptedOutput: "0x01" }))]);
    }
    chain.add(block, txs);
  }

  const read = <T>(f: string) => JSON.parse(fs.readFileSync(path.join(dir, "97", f), "utf8")) as T;

  it("classifies leaves, fills zero slots, records epochs/credits/accRpt, checkpoints in the manifest", async () => {
    const chain = new Chain();
    seed(chain);
    const { ctx } = makeCtx(chain, dir, [empty, empty, empty]);
    const r = await poolFeed(ctx, { lastBundleAt: 0 }, { out: dir, forceBundle: true }, {});
    expect(r.bundle).toMatchObject({ fromBlock: 5, toBlock: 15, nextIndex: 12, chunksWritten: 1, mismatches: 0 });
    const m = read<ManifestJson>("manifest.json");
    expect(m).toMatchObject({ chainId: 97, grovePool: POOL, darkCurve: DARK, fromBlock: 5, toBlock: 15, nextIndex: 12, chunkSize: 4096 });
    expect(m.checkpoints).toEqual([{ root: "7777", indexAfter: 4, period: 3_000_000 }]);
    expect(m.chunks).toHaveLength(1);
    expect(m.chunks[0]).toMatchObject({ file: "chunk-0.json", fromIndex: 0, toIndex: 12 });
    expect(verifyBundle(path.join(dir, "97"))).toEqual({ ok: true, errors: [] });

    const c = read<ChunkJson>("chunk-0.json");
    expect(c.leaves.map((l) => l.kind)).toEqual(["intent", "note", "note", "zero", "result", "zero", "zero", "zero", "result", "zero", "zero", "zero"]);
    expect(c.leaves[3]).toEqual({ i: 3, leaf: ZERO_LEAF.toString(), enc: "", kind: "zero" });
    expect(c.leaves[0].enc).toBe("0xaa");
    expect(c.leaves[4].enc).toBe("");
    expect(c.nullifiers).toEqual(["901", "902"]);
    expect(c.intents).toEqual([{ leaf: "111", coin: COIN, dir: 0, seq: 0 }]);
    expect(c.epochs).toEqual([
      { coin: COIN, dir: 0, seq: 0, status: "opened", totalIn: "100000000000000000", totalOut: "5000000000000000000000", refund: "3", rptAtSettle: "0", resultLeaf: resOpen.toString() },
      { coin: COIN, dir: 1, seq: 0, status: "voided", totalIn: "1", totalOut: "0", refund: "1", rptAtSettle: accRpt.toString(), resultLeaf: resVoid.toString() },
    ]);
    expect(c.credits).toEqual([
      { handle: "4242", amount: "100000000000000000", block: 15, claimedAmount: "0" },
      { handle: "4242", amount: "0", block: 15, claimedAmount: "100000000000000000" },
    ]);
    expect(c.accRpt).toEqual([{ coin: COIN, values: [accRpt.toString()] }]);
  });

  it("chunks at 4096 leaves and appends incrementally; a full chunk is never rewritten", async () => {
    const chain = new Chain();
    seed(chain);
    const { ctx } = makeCtx(chain, dir, [empty, empty, empty]);
    const rt = { lastBundleAt: 0 };
    await poolFeed(ctx, rt, { out: dir, forceBundle: true }, {});

    transfers(chain, 20n, 12, 1030); // leaves 12 .. 4131
    const r2 = await poolFeed(ctx, rt, { out: dir, forceBundle: true }, {});
    expect(r2.bundle).toMatchObject({ fromBlock: 16, toBlock: 20, nextIndex: 4132, chunksWritten: 2 });
    let m = read<ManifestJson>("manifest.json");
    expect(m.chunks.map((c) => [c.file, c.fromIndex, c.toIndex])).toEqual([
      ["chunk-0.json", 0, CHUNK_SIZE],
      ["chunk-1.json", CHUNK_SIZE, 4132],
    ]);
    expect(verifyBundle(path.join(dir, "97")).ok).toBe(true);
    const c0 = read<ChunkJson>("chunk-0.json");
    expect(c0.leaves).toHaveLength(CHUNK_SIZE);
    expect(c0.leaves.every((l, k) => l.i === k)).toBe(true);
    // the nullifier logged once the tree was at 4096 lives in chunk 1
    const c1 = read<ChunkJson>("chunk-1.json");
    expect(c1.nullifiers[0]).toBe(String(10_000 + 4096));
    const sha0 = m.chunks[0].sha256;
    const mtime0 = fs.statSync(path.join(dir, "97", "chunk-0.json")).mtimeMs;

    // nothing new: no chunk written, the manifest only advances toBlock
    chain.head = 30n;
    const r3 = await poolFeed(ctx, rt, { out: dir, forceBundle: true }, {});
    expect(r3.bundle).toMatchObject({ fromBlock: 21, toBlock: 30, chunksWritten: 0, logs: 0 });

    // more leaves: only the open chunk is rewritten
    transfers(chain, 31n, 4132, 2);
    const r4 = await poolFeed(ctx, rt, { out: dir, forceBundle: true }, {});
    expect(r4.bundle).toMatchObject({ nextIndex: 4140, chunksWritten: 1 });
    m = read<ManifestJson>("manifest.json");
    expect(m.chunks[0].sha256).toBe(sha0);
    expect(fs.statSync(path.join(dir, "97", "chunk-0.json")).mtimeMs).toBe(mtime0);
    expect(m.chunks[1].toIndex).toBe(4140);
    expect(verifyBundle(path.join(dir, "97")).ok).toBe(true);

    // tampering is detected
    fs.appendFileSync(path.join(dir, "97", "chunk-1.json"), " ");
    expect(verifyBundle(path.join(dir, "97")).errors).toContain("chunk-1.json sha256 mismatch");
  });

  it("epochs.json: every coin, three directions, openableAt per the K / T_MAX rule", async () => {
    const chain = new Chain();
    const buy = { ...empty, status: 1, count: 5, startedAt: 1000n, refPrice: 123n };
    const sell = { ...empty, status: 1, count: 2, startedAt: 2000n, refPrice: 456n };
    const { ctx } = makeCtx(chain, dir, [buy, sell, empty]);
    const r = await poolFeed(ctx, { lastBundleAt: Date.now() }, { out: dir }, {});
    expect(r.bundle).toBeUndefined(); // bundle not due; epochs.json written every pass
    const e = read<EpochsJson>("epochs.json");
    expect(e.chainId).toBe(97);
    expect(Object.keys(e)).toEqual(["chainId", "coins", "updatedAt"]);
    expect(e.coins[COIN]).toEqual([
      { seq: 4, startedAt: 1000, count: 5, openableAt: 1060, refPrice: "123" },
      { seq: 7, startedAt: 2000, count: 2, openableAt: 2300, refPrice: "456" },
      { seq: 0, startedAt: 0, count: 0, openableAt: 0, refPrice: "0" },
    ]);
    expect(epochRow({ ...empty, status: 2, count: 3, startedAt: 5n, refPrice: 1n }, 9, { tMin: 60, tMax: 300, k: 5 })).toEqual({ seq: 9, startedAt: 0, count: 0, openableAt: 0, refPrice: "0" });
  });

  it("is inert without stage-2 addresses", async () => {
    const ctx = { dep: { startBlock: 1 }, cfg: { chainId: 56 }, pub: { readContract: vi.fn(), request: vi.fn() } } as unknown as Ctx;
    expect(await poolFeed(ctx, { lastBundleAt: 0 }, { out: dir })).toEqual({ inert: true });
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

// Integration regression (chain step 8, local anvil end-to-end): DarkCurve.openEpoch emits EpochOpened for every
// opened direction BEFORE pool.insertChunk emits the result leaves' NewCommitment. The bundle must still carry each
// epoch's result leaf (the web's claim prover finds the leaf by it), and a leaf the transaction did not insert must
// still count as a mismatch.
describe("pool-feed result leaves in contract event order", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "poolfeed-order-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("matches EpochOpened rows to result leaves inserted later in the same transaction", async () => {
    const buy = { totalIn: 3n * 10n ** 17n, totalOut: 7n * 10n ** 25n, totalRefund: 0n, rptAtSettle: 0n };
    const sell = { totalIn: 5n * 10n ** 22n, totalOut: 4n * 10n ** 16n, totalRefund: 0n, rptAtSettle: 0n };
    const resBuy = resultLeaf(epochKey(COIN, 0, 0), buy);
    const resSell = resultLeaf(epochKey(COIN, 0, 1), sell);
    const chain = new Chain();
    chain.add(10n, [
      [
        // contract order: one EpochOpened per opened direction, then one chunk of result leaves (slots in direction order)
        dark("EpochOpened", { coin: COIN, dir: 0, seq: 0, u: 30_000n, totalIn: buy.totalIn, totalOut: buy.totalOut, refund: 0n, spotAfter: 1n, rptAtSettle: 0n }),
        dark("EpochOpened", { coin: COIN, dir: 1, seq: 0, u: 50_000n, totalIn: sell.totalIn, totalOut: sell.totalOut, refund: 0n, spotAfter: 1n, rptAtSettle: 0n }),
        pool("NewCommitment", { commitment: resBuy, index: 0, encryptedOutput: "0x" }),
        pool("NewCommitment", { commitment: resSell, index: 1, encryptedOutput: "0x" }),
      ],
    ]);
    chain.add(11n, [
      [
        // a row whose leaf is not in its transaction: still a mismatch
        dark("EpochOpened", { coin: COIN, dir: 2, seq: 0, u: 50_000n, totalIn: 1n, totalOut: 1n, refund: 0n, spotAfter: 1n, rptAtSettle: 0n }),
        pool("NewCommitment", { commitment: 999n, index: 4, encryptedOutput: "0x" }),
      ],
    ]);
    const { ctx } = makeCtx(chain, dir, [empty, empty, empty]);
    const r = await poolFeed(ctx, { lastBundleAt: 0 }, { out: dir, forceBundle: true }, {});
    expect(r.bundle).toMatchObject({ nextIndex: 8, mismatches: 1 });
    const c = JSON.parse(fs.readFileSync(path.join(dir, "97", "chunk-0.json"), "utf8")) as ChunkJson;
    expect(c.leaves.map((l) => l.kind)).toEqual(["result", "result", "zero", "zero", "result", "zero", "zero", "zero"]);
    expect(c.epochs.map((e) => [e.dir, e.resultLeaf])).toEqual([
      [0, resBuy.toString()],
      [1, resSell.toString()],
      [2, null],
    ]);
  });
});
