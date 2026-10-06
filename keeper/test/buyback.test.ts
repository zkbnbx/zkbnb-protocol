import { describe, it, expect, vi } from "vitest";
import { getAddress, parseEther, type Address } from "viem";
import { buyback } from "../src/commands/buyback.js";
import { parseDeployments, type Deployments, type KeeperConfig } from "../src/config.js";
import type { Ctx } from "../src/chain.js";

const ZERO = getAddress("0x0000000000000000000000000000000000000000");
const FEE_ROUTER = getAddress("0x5000000000000000000000000000000000000005");
const LAUNCHPAD = getAddress("0x9000000000000000000000000000000000000009");
const ROUTER = getAddress("0xd000000000000000000000000000000000000001");
const WBNB = getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c");
const TOKEN = getAddress("0x1234567890123456789012345678901234567777");
const ADAPTER = getAddress("0xf1a9000000000000000000000000000000000001");
const KEEPER = getAddress("0xcee9000000000000000000000000000000000001");

type Reads = Record<string, unknown | ((args?: readonly unknown[]) => unknown)>;

/** A public client whose readContract answers from `reads` (by function name) and whose simulateContract is `sim`. */
function makeCtx(opts: { reads: Reads; sim?: (p: { args: readonly unknown[]; account: unknown }) => unknown; dep?: Partial<Deployments>; withKey?: boolean }) {
  const readContract = vi.fn(async (p: { functionName: string; args?: readonly unknown[] }) => {
    if (!(p.functionName in opts.reads)) throw new Error(`execution reverted: unexpected read ${p.functionName}`);
    const v = opts.reads[p.functionName];
    if (v instanceof Error) throw v;
    return typeof v === "function" ? (v as (a?: readonly unknown[]) => unknown)(p.args) : v;
  });
  const simulateContract = vi.fn(async (p: { args: readonly unknown[]; account: unknown }) => ({ result: opts.sim!(p), request: {} }));
  const dep = {
    feeRouter: FEE_ROUTER,
    launchpad: LAUNCHPAD,
    router: ROUTER,
    grove: TOKEN,
    ...opts.dep,
  } as Deployments;
  const cfg = { minBuybackWei: parseEther("0.05"), dryRun: true } as KeeperConfig;
  const account = opts.withKey === false ? undefined : ({ address: KEEPER } as Ctx["account"]);
  const ctx = { cfg, dep, pub: { readContract, simulateContract }, account, txLock: Promise.resolve() } as unknown as Ctx;
  return { ctx, readContract, simulateContract };
}

/** viem surfaces a require() reason in the error message like this */
const revert = (reason: string) => new Error(`The contract function "buybackAndBurn" reverted with the following reason:\n${reason}`);

describe("buyback, rootstock on Flap", () => {
  it("quotes by simulating buybackAndBurn(0) from the keeper and sends minOut = 97%", async () => {
    const quote = parseEther("12345");
    const { ctx, simulateContract } = makeCtx({
      reads: { rootstockPot: parseEther("1"), rootstockCoin: TOKEN, rootstockBuyback: ADAPTER },
      sim: () => quote,
    });
    const res = await buyback(ctx);
    expect(res).toEqual({ done: true, potWei: parseEther("1") });
    expect(simulateContract).toHaveBeenCalledTimes(2);
    const [q, send] = simulateContract.mock.calls.map((c) => c[0] as { args: readonly unknown[]; account: unknown; functionName: string; address: Address });
    expect(q.functionName).toBe("buybackAndBurn");
    expect(q.address).toBe(FEE_ROUTER);
    expect(q.args).toEqual([0n]);
    expect(q.account).toBe(KEEPER);
    expect(send.args).toEqual([(quote * 97n) / 100n]);
  });

  it("uses the deployments json adapter without the on-chain getter, and FeeRouter.keeper() when there is no key", async () => {
    const { ctx, readContract, simulateContract } = makeCtx({
      reads: { rootstockPot: parseEther("1"), rootstockCoin: TOKEN, keeper: KEEPER },
      sim: () => 1000n,
      dep: { rootstockBuyback: ADAPTER, rootstockExternal: true },
      withKey: false,
    });
    // no key: the quote still runs, the send needs a key (or DRY_RUN with a key)
    await expect(buyback(ctx)).rejects.toThrow(/KEEPER_PRIVATE_KEY/);
    expect(readContract.mock.calls.map((c) => c[0].functionName)).not.toContain("rootstockBuyback");
    expect((simulateContract.mock.calls[0][0] as { account: unknown }).account).toBe(KEEPER);
    // the in-house quote path is never touched
    expect(readContract.mock.calls.map((c) => c[0].functionName)).not.toContain("isGraduated");
  });

  it("skips (no throw) when the adapter says the token is not tradable", async () => {
    const { ctx, simulateContract } = makeCtx({
      reads: { rootstockPot: parseEther("1"), rootstockCoin: TOKEN, rootstockBuyback: ADAPTER },
      sim: () => {
        throw revert("not tradable");
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await buyback(ctx);
    expect(res.done).toBe(false);
    expect(simulateContract).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.some((c) => /not tradable/.test(String(c[0])))).toBe(true);
    warn.mockRestore();
  });

  it("skips when the status flips to not tradable between the quote and the send", async () => {
    let n = 0;
    const { ctx } = makeCtx({
      reads: { rootstockPot: parseEther("1"), rootstockCoin: TOKEN, rootstockBuyback: ADAPTER },
      sim: () => {
        if (n++ === 0) return 500n;
        throw revert("not tradable");
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await buyback(ctx)).done).toBe(false);
    warn.mockRestore();
  });

  it("rethrows other simulation reverts", async () => {
    const { ctx } = makeCtx({
      reads: { rootstockPot: parseEther("1"), rootstockCoin: TOKEN, rootstockBuyback: ADAPTER },
      sim: () => {
        throw revert("slippage");
      },
    });
    await expect(buyback(ctx)).rejects.toThrow(/slippage/);
  });

  it("skips a zero quote", async () => {
    const { ctx, simulateContract } = makeCtx({
      reads: { rootstockPot: parseEther("1"), rootstockCoin: TOKEN, rootstockBuyback: ADAPTER },
      sim: () => 0n,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await buyback(ctx)).done).toBe(false);
    expect(simulateContract).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("does nothing below MIN_BUYBACK_BNB", async () => {
    const { ctx, simulateContract } = makeCtx({ reads: { rootstockPot: parseEther("0.01") }, sim: () => 1n });
    expect((await buyback(ctx)).done).toBe(false);
    expect(simulateContract).not.toHaveBeenCalled();
  });

  it("fails loudly when deployments say external but the FeeRouter has no adapter", async () => {
    const { ctx } = makeCtx({
      reads: { rootstockPot: parseEther("1"), rootstockCoin: TOKEN, rootstockBuyback: ZERO },
      sim: () => 1n,
      dep: { rootstockExternal: true },
    });
    await expect(buyback(ctx)).rejects.toThrow(/rootstockExternal/);
  });
});

describe("buyback, in-house rootstock (testnet)", () => {
  it("an older FeeRouter without rootstockBuyback() keeps the curve quote path", async () => {
    const { ctx, simulateContract } = makeCtx({
      // rootstockBuyback is missing from reads, so the mock reverts like an old FeeRouter would
      reads: { rootstockPot: parseEther("1"), rootstockCoin: TOKEN, isGraduated: false, quoteBuy: [1000n, parseEther("1"), 0n] },
      sim: () => 970n,
    });
    expect((await buyback(ctx)).done).toBe(true);
    expect(simulateContract).toHaveBeenCalledTimes(1);
    expect((simulateContract.mock.calls[0][0] as { args: readonly unknown[] }).args).toEqual([970n]);
  });

  it("a zero adapter keeps the router quote after graduation (2% pair tax haircut, then 97%)", async () => {
    const { ctx, simulateContract } = makeCtx({
      reads: { rootstockPot: parseEther("1"), rootstockCoin: TOKEN, rootstockBuyback: ZERO, isGraduated: true, WETH: WBNB, getAmountsOut: [parseEther("1"), 10000n] },
      sim: () => 1n,
    });
    expect((await buyback(ctx)).done).toBe(true);
    expect((simulateContract.mock.calls[0][0] as { args: readonly unknown[] }).args).toEqual([(9800n * 97n) / 100n]);
  });
});

describe("deployments: Flap rootstock keys", () => {
  const base = {
    chainId: 56,
    poseidonT3: "0x0000000000000000000000000000000000000001",
    poseidonT4: "0x0000000000000000000000000000000000000002",
    verifier: "0x0000000000000000000000000000000000000003",
    shieldedPool: "0x0000000000000000000000000000000000000004",
    feeRouter: FEE_ROUTER,
    roots: "0x0000000000000000000000000000000000000006",
    holderRewards: "0x0000000000000000000000000000000000000007",
    donationRotator: "0x0000000000000000000000000000000000000008",
    launchpad: LAUNCHPAD,
    grove: TOKEN,
    router: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
    treasury: "0x000000000000000000000000000000000000000b",
    startBlock: 1,
  };

  it("parses rootstockBuyback and rootstockExternal when present", () => {
    const d = parseDeployments({ ...base, rootstockBuyback: ADAPTER.toLowerCase(), rootstockExternal: true }, 56);
    expect(d.rootstockBuyback).toBe(ADAPTER);
    expect(d.rootstockExternal).toBe(true);
  });

  it("leaves them unset for the in-house rootstock", () => {
    const d = parseDeployments(base, 56);
    expect(d.rootstockBuyback).toBeUndefined();
    expect(d.rootstockExternal).toBeUndefined();
  });

  it("rejects a malformed adapter address", () => {
    expect(() => parseDeployments({ ...base, rootstockBuyback: "0x1234" }, 56)).toThrow(/rootstockBuyback/);
  });
});
