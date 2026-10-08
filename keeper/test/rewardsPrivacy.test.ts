import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeAbiParameters, encodeEventTopics, getAddress, numberToHex, parseEther, type Address } from "viem";

vi.mock("../src/logs.js", async (orig) => ({ ...(await orig<typeof import("../src/logs.js")>()), balancesAt: vi.fn() }));
vi.mock("../src/price.js", () => ({ bnbUsd: async () => 600 }));

import { balancesAt } from "../src/logs.js";
import { takeSnapshotAndPost } from "../src/commands/rewards.js";
import { applyPrivacyExclusions, hasPrivacyModules } from "../src/stubs.js";
import { parseDeployments, type Deployments, type KeeperConfig } from "../src/config.js";
import { planterAbi } from "../src/abis.js";
import type { SnapshotJson } from "../src/snapshot.js";
import type { Ctx } from "../src/chain.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const live56 = path.resolve(here, "..", "..", "contracts", "deployments", "56.json");

const COIN = getAddress("0xa000000000000000000000000000000000000001");
const ALICE = getAddress("0x00000000000000000000000000000000000000a1");
const GROVE_POOL = getAddress("0x9001000000000000000000000000000000000001");
const DARK = getAddress("0xdc00000000000000000000000000000000000001");
const PLANTER = getAddress("0x91a0000000000000000000000000000000000001");
const STUB = getAddress("0x5700000000000000000000000000000000000001");
const KEEPER = getAddress("0xcee9000000000000000000000000000000000001");
const ZERO = getAddress("0x0000000000000000000000000000000000000000");
const DEAD = getAddress("0x000000000000000000000000000000000000dEaD");

/** A stand-in for the live deployment file when contracts/deployments/56.json is not in the checkout. */
const liveLike = (): Deployments => {
  if (fs.existsSync(live56)) return parseDeployments(JSON.parse(fs.readFileSync(live56, "utf8")), 56);
  const a = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
  return { chainId: 56, poseidonT3: a(1), poseidonT4: a(2), verifier: a(3), shieldedPool: a(4), feeRouter: a(5), roots: a(6), holderRewards: a(7), donationRotator: a(8), launchpad: a(9), grove: a(10), router: a(11), treasury: a(12), startBlock: 1 };
};

describe("rewards: privacy stage 2 inclusion rule", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "rewards-"));
    vi.mocked(balancesAt).mockResolvedValue(
      new Map<Address, bigint>([
        [ALICE, parseEther("1000")],
        [GROVE_POOL, parseEther("500")],
        [DARK, parseEther("300")],
        [PLANTER, parseEther("200")],
        [STUB, parseEther("100")],
      ]),
    );
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  function makeCtx(dep: Deployments, excludeAddresses: Address[] = []) {
    const readContract = vi.fn(async (p: { functionName: string }) => {
      switch (p.functionName) {
        case "pairOf":
          return ZERO;
        case "price":
          return 10n ** 9n;
        case "runCount":
          return 3n;
        default:
          throw new Error(`unexpected read ${p.functionName}`);
      }
    });
    const request = vi.fn(async () => [
      {
        address: PLANTER,
        topics: encodeEventTopics({ abi: planterAbi, eventName: "PlantedPrivately", args: { coin: COIN } }),
        data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [STUB, 77n]),
        blockNumber: numberToHex(12),
        transactionHash: numberToHex(12, { size: 32 }),
        logIndex: "0x0",
        blockHash: numberToHex(12, { size: 32 }),
        transactionIndex: "0x0",
        removed: false,
      },
    ]);
    const simulateContract = vi.fn(async () => ({ result: 3n, request: {} }));
    const getBlockNumber = vi.fn(async () => 1000n);
    const cfg = { chainId: dep.chainId, snapshotDir: dir, dryRun: true, minHoldingUsd: 0, excludeAddresses, logChunk: 1000n, confirmations: 3, snapshotBaseUrl: "" } as unknown as KeeperConfig;
    const ctx = { cfg, dep, pub: { readContract, request, simulateContract, getBlockNumber }, account: { address: KEEPER }, txLock: Promise.resolve() } as unknown as Ctx;
    return { ctx, readContract, request, getBlockNumber };
  }

  const snap = (chainDir: string) => JSON.parse(fs.readFileSync(path.join(chainDir, COIN, "3.json"), "utf8")) as SnapshotJson;

  it("live deployment file (no stage-2 keys): exclusions, reads and output exactly as before", async () => {
    const dep = liveLike();
    expect(dep.grovePool ?? dep.darkCurve ?? dep.planter).toBeUndefined();
    expect(hasPrivacyModules(dep)).toBe(false);
    const { ctx, readContract, request, getBlockNumber } = makeCtx(dep);
    expect(await takeSnapshotAndPost(ctx, COIN, parseEther("1"))).toBe(true);
    const s = snap(dir);
    const legacy = [dep.launchpad, dep.roots, dep.feeRouter, dep.holderRewards, COIN, ZERO, DEAD].map((a) => getAddress(a)).sort();
    expect(s.rule.excluded).toEqual([...new Set(legacy)].sort());
    // every account that is not excluded is a holder, exactly as today (no stage-2 address is special)
    expect(s.leaves.map((l) => l.account).sort()).toEqual([ALICE, GROVE_POOL, DARK, PLANTER, STUB].sort());
    // no stage-2 RPC: no log scan for stubs, no extra reads, no stub cache written
    expect(request).not.toHaveBeenCalled();
    expect(readContract.mock.calls.map((c) => c[0].functionName)).toEqual(["pairOf", "price", "runCount"]);
    expect(getBlockNumber).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(dir).filter((f) => f.startsWith("stubs-"))).toEqual([]);
    expect(applyPrivacyExclusions([ALICE], dep, [{ stub: STUB }])).toEqual({ excluded: [ALICE], poolWasListed: false });
  });

  it("with stage-2 addresses: GrovePool is a holder (even if EXCLUDE_ADDRESSES names it); DarkCurve, Planter, stubs excluded", async () => {
    const dep = { ...liveLike(), chainId: 97, grovePool: GROVE_POOL, darkCurve: DARK, planter: PLANTER, privacyStartBlock: 5 } as Deployments;
    const { ctx } = makeCtx(dep, [GROVE_POOL]);
    expect(await takeSnapshotAndPost(ctx, COIN, parseEther("1"))).toBe(true);
    const s = snap(dir);
    expect(s.leaves.map((l) => l.account).sort()).toEqual([ALICE, GROVE_POOL].sort());
    const pool = s.leaves.find((l) => l.account === GROVE_POOL)!;
    expect(BigInt(pool.amount)).toBe((parseEther("1") * 500n) / 1500n); // pro rata 500 / 1500 (rounding dust goes to the largest)
    for (const a of [DARK, PLANTER, STUB]) expect(s.rule.excluded).toContain(a);
    expect(s.rule.excluded).not.toContain(GROVE_POOL);
  });

  it("review N1: with a RewardPoster the run is posted through it, carrying the pool's leaf and proof", async () => {
    const POSTER = getAddress("0x9057000000000000000000000000000000000001");
    const dep = { ...liveLike(), chainId: 97, grovePool: GROVE_POOL, darkCurve: DARK, planter: PLANTER, rewardPoster: POSTER, privacyStartBlock: 5 } as Deployments;
    const { ctx } = makeCtx(dep);
    expect(await takeSnapshotAndPost(ctx, COIN, parseEther("1"))).toBe(true);
    const s = snap(dir);
    const pool = s.leaves.find((l) => l.account === GROVE_POOL)!;
    const sim = vi.mocked((ctx.pub as unknown as { simulateContract: ReturnType<typeof vi.fn> }).simulateContract);
    expect(sim).toHaveBeenCalledTimes(1);
    const call = sim.mock.calls[0][0] as { address: Address; functionName: string; args: unknown[] };
    expect(call.address).toBe(POSTER);
    expect(call.functionName).toBe("post");
    expect(call.args).toEqual([COIN, s.root, parseEther("1"), BigInt(s.holders), expect.any(String), BigInt(pool.amount), pool.proof]);
  });

  it("review N1: a pool holding less than one token is left out of a RewardPoster run (its pull would revert the post)", async () => {
    const POSTER = getAddress("0x9057000000000000000000000000000000000001");
    vi.mocked(balancesAt).mockResolvedValue(new Map<Address, bigint>([[ALICE, parseEther("1000")], [GROVE_POOL, parseEther("0.5")]]));
    const dep = { ...liveLike(), chainId: 97, grovePool: GROVE_POOL, darkCurve: DARK, planter: PLANTER, rewardPoster: POSTER, privacyStartBlock: 5 } as Deployments;
    const { ctx } = makeCtx(dep);
    expect(await takeSnapshotAndPost(ctx, COIN, parseEther("1"))).toBe(true);
    const s = snap(dir);
    expect(s.leaves.map((l) => l.account)).toEqual([ALICE]);
    const sim = vi.mocked((ctx.pub as unknown as { simulateContract: ReturnType<typeof vi.fn> }).simulateContract);
    expect((sim.mock.calls[0][0] as { args: unknown[] }).args.slice(5)).toEqual([0n, []]);
  });
});

describe("deployment file: stage-2 keys are optional", () => {
  it("parses grovePool / darkCurve / planter / privacyStartBlock when present, ignores them when absent", () => {
    const base = JSON.parse(JSON.stringify(liveLike())) as Record<string, unknown>;
    const plain = parseDeployments(base);
    expect(plain.grovePool).toBeUndefined();
    const d = parseDeployments({ ...base, grovePool: GROVE_POOL.toLowerCase(), darkCurve: DARK, planter: PLANTER, privacyStartBlock: 42 });
    expect(d).toMatchObject({ grovePool: GROVE_POOL, darkCurve: DARK, planter: PLANTER, privacyStartBlock: 42 });
    expect(() => parseDeployments({ ...base, grovePool: "0x123" })).toThrow(/grovePool/);
    expect(() => parseDeployments({ ...base, privacyStartBlock: -1 })).toThrow(/privacyStartBlock/);
  });
});
