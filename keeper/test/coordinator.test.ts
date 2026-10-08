import { afterEach, describe, expect, it, vi } from "vitest";
import { getAddress, type Address } from "viem";
import {
  applySlippage,
  chainQuoter,
  coordinator,
  decodeOpenRevert,
  directionState,
  dirsOf,
  maskOf,
  planCoin,
  redactU,
  UNIT_BNB,
  UNIT_TOKEN,
  type CoordinatorDeps,
  type EpochView,
  type OpenArgs,
} from "../src/commands/coordinator.js";
import { elgamal, encrypt, sumCiphertexts, isSummed, type Ciphertext } from "../src/elgamal.js";
import { buildTable, solve } from "../src/bsgs.js";
import { mod, type ContractPoint, type Point } from "../src/babyjub.js";
import { pkId } from "../src/coordinatorKeys.js";
import type { Ctx, TxResult } from "../src/chain.js";
import type { Deployments, KeeperConfig } from "../src/config.js";

const COIN_A = getAddress("0xa000000000000000000000000000000000000001");
const COIN_B = getAddress("0xb000000000000000000000000000000000000002");
const COIN_C = getAddress("0xc000000000000000000000000000000000000003");
const DARK = getAddress("0xdc00000000000000000000000000000000000001");
const POOL = getAddress("0x9001000000000000000000000000000000000001");
const LAUNCHPAD = getAddress("0x1a00000000000000000000000000000000000001");
const ROUTER = getAddress("0x1b00000000000000000000000000000000000001");
const ROOTS = getAddress("0x1c00000000000000000000000000000000000001");
const WBNB = getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c");
const KEEPER = getAddress("0xcee9000000000000000000000000000000000001");

const PARAMS = { tMin: 60, tMax: 300, k: 5, grace: 1800 };
const NOW = 1_800_000_000n;
const SK = 123_456_789_987_654_321n;
const SK_OTHER = 555_555_555_555n; // key generation 1: not held by this coordinator
const PK = elgamal.publicKey(SK);
const PK_OTHER = elgamal.publicKey(SK_OTHER);

/** The contract keeps the running sum in extended coordinates; scale by 7 so Z != 1 is exercised. */
function extended(p: Point, l = 7n): ContractPoint {
  return { x: mod(p[0] * l), y: mod(p[1] * l), t: mod(p[0] * p[1] * l), z: l };
}

let kSeed = 1000n;
function intents(us: bigint[], pk: Point): Ciphertext[] {
  return us.map((u) => encrypt(u, pk, (kSeed += 7919n)));
}

function epoch(cts: Ciphertext[], startedAt: bigint, keyId = 0): EpochView {
  if (cts.length === 0) return { startedAt: 0n, status: 0, keyId: 0, count: 0, refPrice: 0n, refVb: 0n, c1: extended([0n, 1n]), c2: extended([0n, 1n]) };
  const s = sumCiphertexts(cts); // test-side only: the contract's running sum
  return { startedAt, status: 1, keyId, count: cts.length, refPrice: 10n ** 12n, refVb: 4n * 10n ** 18n, c1: extended(s.c1), c2: extended(s.c2) };
}

const table = buildTable(12);
const smallSolve = (m: Point) => solve(m, table, 24);

interface World {
  coins: Address[];
  epochs: Record<string, EpochView[]>;
  seqs: Record<string, [number, number, number]>;
  keyByGen: Record<number, Point>;
}

function makeCtx(world: World, opts: { dep?: Partial<Deployments>; dryRun?: boolean; withKey?: boolean } = {}) {
  const readContract = vi.fn(async (p: { functionName: string; args?: readonly unknown[] }) => {
    switch (p.functionName) {
      case "allCoins":
        return world.coins;
      case "params":
        return [PARAMS.tMin, PARAMS.tMax, PARAMS.k, PARAMS.grace, 1000, 256, 5n * 10n ** 17n, 1_475_000];
      case "epochsOf":
        return (p.args![0] as Address[]).map((c) => world.epochs[c]);
      case "cur":
        return world.seqs[p.args![0] as string][Number(p.args![1])];
      case "keyByGen":
        return world.keyByGen[Number(p.args![0])][Number(p.args![1])];
      case "lastCheckpointPeriod":
        return NOW / 600n;
      case "getLastRoot":
        return 1n;
      case "isKnownRoot":
        return true;
      default:
        throw new Error(`unexpected read ${p.functionName}`);
    }
  });
  const simulateContract = vi.fn(async () => ({ result: undefined, request: {} }));
  const dep = { launchpad: LAUNCHPAD, router: ROUTER, roots: ROOTS, startBlock: 1, grovePool: POOL, darkCurve: DARK, ...opts.dep } as Deployments;
  const cfg = { dryRun: opts.dryRun ?? false, chainId: 97, snapshotDir: "unused" } as KeeperConfig;
  const account = opts.withKey === false ? undefined : ({ address: KEEPER } as Ctx["account"]);
  const ctx = { cfg, dep, pub: { readContract, simulateContract, getBlock: async () => ({ timestamp: NOW }) }, account, txLock: Promise.resolve() } as unknown as Ctx;
  return { ctx, readContract, simulateContract };
}

type SendCall = { functionName: string; args: readonly unknown[] };

function makeDeps(over: Partial<CoordinatorDeps> & { sendImpl?: (c: SendCall) => TxResult | Promise<TxResult> } = {}) {
  const calls: SendCall[] = [];
  const send = vi.fn(async (_ctx: Ctx, p: unknown) => {
    const c = p as SendCall;
    calls.push(c);
    if (over.sendImpl) return over.sendImpl(c);
    return { dryRun: false, status: "success", hash: `0xhash${calls.length}`, result: undefined } as TxResult;
  });
  const prove = vi.fn(async () => ({ a: [1n, 2n], b: [[3n, 4n], [5n, 6n]], c: [7n, 8n] }) as never);
  const quotes: { coin: Address; dir: number; amountIn: bigint }[] = [];
  const deps: CoordinatorDeps = {
    keys: new Map([[pkId(PK), { sk: SK, pk: PK }]]),
    solve: smallSolve,
    prove,
    quoter: {
      async quote(coin, dir, amountIn) {
        quotes.push({ coin, dir, amountIn });
        return amountIn * 2n; // deterministic stand-in; chainQuoter is tested separately
      },
    },
    send: send as never,
    failures: new Map(),
    pcfg: { slippageBps: 300, maxOpenAttempts: 3 },
    ...over,
  };
  return { deps, calls, send, prove, quotes };
}

afterEach(() => vi.restoreAllMocks());

describe("openability per direction", () => {
  const ep = (count: number, age: number) => ({ status: 1, count, startedAt: NOW - BigInt(age) });
  it("K intents in one direction open it at T_MIN, fewer wait for T_MAX", () => {
    expect(directionState(ep(5, 59), PARAMS, NOW)).toBe("collecting");
    expect(directionState(ep(5, 60), PARAMS, NOW)).toBe("openable");
    expect(directionState(ep(4, 299), PARAMS, NOW)).toBe("collecting");
    expect(directionState(ep(1, 300), PARAMS, NOW)).toBe("openable");
    expect(directionState({ status: 0, count: 0, startedAt: 0n }, PARAMS, NOW)).toBe("idle");
    expect(directionState({ status: 2, count: 9, startedAt: NOW - 1000n }, PARAMS, NOW)).toBe("idle");
  });
  it("voidable strictly after T_MAX + GRACE, per direction", () => {
    expect(directionState(ep(1, 2100), PARAMS, NOW)).toBe("openable");
    expect(directionState(ep(1, 2101), PARAMS, NOW)).toBe("voidable");
  });
  it("planCoin: opens directions whose key is held, voids voidable ones it cannot open", () => {
    const e = (count: number, age: number, keyId: number) => ({ ...epoch([], 0n), status: 1, count, startedAt: NOW - BigInt(age), keyId });
    const plan = planCoin([e(6, 100, 0), e(2, 2500, 1), e(3, 2500, 0)], PARAMS, NOW, (g) => g === 0, () => 0, 3);
    expect(plan.open).toEqual([0, 2]);
    expect(plan.void).toEqual([1]);
    // a direction that kept failing is left to the void once voidable
    const failing = planCoin([e(6, 100, 0), e(2, 2500, 0), e(0, 0, 0)], PARAMS, NOW, () => true, (d) => (d === 1 ? 3 : 0), 3);
    expect(failing.open).toEqual([0]);
    expect(failing.void).toEqual([1]);
  });
  it("dirMask composition", () => {
    expect(maskOf([0, 1, 2])).toBe(7);
    expect(maskOf([1])).toBe(2);
    expect(dirsOf(5)).toEqual([0, 2]);
  });
});

describe("coordinator pass", () => {
  it("opens every openable direction of a coin in one call, decrypting sums only", async () => {
    const buys = intents([5_000n, 7_000n, 123_456n, 9_999n, 50_000n, 6_000n], PK); // 6 >= K
    const sells = intents([60_000n, 75_000n], PK); // 2 < K but past T_MAX
    const world: World = {
      coins: [COIN_A],
      epochs: { [COIN_A]: [epoch(buys, NOW - 120n), epoch(sells, NOW - 400n), epoch([], 0n)] },
      seqs: { [COIN_A]: [3, 8, 0] },
      keyByGen: { 0: PK },
    };
    const { ctx } = makeCtx(world);
    const spy = vi.spyOn(elgamal, "decrypt");
    const { deps, calls, prove, quotes } = makeDeps();
    const res = await coordinator(ctx, deps);

    // one openEpoch with BUY | SELL
    expect(calls.map((c) => c.functionName)).toEqual(["openEpoch"]);
    const [coin, mask, seq, u, , minOut] = calls[0].args as [Address, number, number[], bigint[], unknown, bigint[]];
    expect(coin).toBe(COIN_A);
    expect(mask).toBe(0b011);
    expect(seq).toEqual([3, 8, 0]);
    const sumBuy = 5_000n + 7_000n + 123_456n + 9_999n + 50_000n + 6_000n;
    const sumSell = 135_000n;
    expect(u).toEqual([sumBuy, sumSell, 0n]);
    // minOut from the quote of the exact batch amount, less SLIPPAGE_BPS
    expect(quotes).toEqual([
      { coin: COIN_A, dir: 0, amountIn: sumBuy * UNIT_BNB },
      { coin: COIN_A, dir: 1, amountIn: sumSell * UNIT_TOKEN },
    ]);
    expect(minOut).toEqual([applySlippage(sumBuy * UNIT_BNB * 2n, 300), applySlippage(sumSell * UNIT_TOKEN * 2n, 300), 0n]);
    expect(prove).toHaveBeenCalledTimes(2);
    // review N2: each direction's proof is made for exactly the minOut the open is sent with
    expect((prove.mock.calls as unknown as [{ minOut: bigint }][]).map(([a]) => a.minOut)).toEqual([minOut[0], minOut[1]]);
    expect(res.opened).toEqual([{ coin: COIN_A, dirMask: 3, hash: "0xhash1" }]);

    // NO PER-INTENT DECRYPTION: decrypt ran exactly once per opened direction, on the summed ciphertext, and
    // never on any individual intent's ciphertext
    expect(spy).toHaveBeenCalledTimes(2);
    const individual = [...buys, ...sells].map((c) => `${c.c1[0]},${c.c1[1]}`);
    for (const [arg] of spy.mock.calls) {
      expect(isSummed(arg)).toBe(true);
      expect(individual).not.toContain(`${arg.c1[0]},${arg.c1[1]}`);
    }
    expect(spy.mock.calls.map(([a]) => a.count)).toEqual([6, 2]);
  });

  it("is given the individual ciphertexts and still never decrypts one", async () => {
    // the module reads only the epoch sum; even a single-intent epoch is decrypted as a branded sum of count 1
    const lone = intents([77_777n], PK);
    const world: World = { coins: [COIN_A], epochs: { [COIN_A]: [epoch([], 0n), epoch(lone, NOW - 301n), epoch([], 0n)] }, seqs: { [COIN_A]: [0, 0, 0] }, keyByGen: { 0: PK } };
    const { ctx } = makeCtx(world);
    const spy = vi.spyOn(elgamal, "decrypt");
    // a stray individual ciphertext handed to decrypt must be refused by elgamal itself
    expect(() => elgamal.decrypt(lone[0] as never, SK)).toThrow(/summed ciphertext only/);
    spy.mockClear();
    const { deps, calls } = makeDeps();
    await coordinator(ctx, deps);
    expect(calls[0].functionName).toBe("openEpoch");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(isSummed(spy.mock.calls[0][0])).toBe(true);
  });

  it("drops a band-blocked direction from the mask and retries the rest", async () => {
    const world: World = {
      coins: [COIN_A],
      epochs: { [COIN_A]: [epoch(intents([5_000n, 6_000n, 7_000n, 8_000n, 9_000n], PK), NOW - 90n), epoch(intents([50_000n], PK), NOW - 350n), epoch([], 0n)] },
      seqs: { [COIN_A]: [1, 2, 0] },
      keyByGen: { 0: PK },
    };
    const { ctx } = makeCtx(world);
    const band = Object.assign(new Error("The contract function \"openEpoch\" reverted.\n\nError: BandExceeded(uint8 dir)\n                    (0)"), { data: { errorName: "BandExceeded", args: [0] } });
    const { deps, calls } = makeDeps({
      sendImpl: (c) => {
        if ((c.args[1] as number) & 1) throw band;
        return { dryRun: false, status: "success", hash: "0xsell", result: undefined };
      },
    });
    const res = await coordinator(ctx, deps);
    expect(calls.map((c) => c.args[1])).toEqual([0b011, 0b010]);
    expect(res.dropped).toEqual([{ coin: COIN_A, dir: 0, reason: "band" }]);
    expect(res.opened).toEqual([{ coin: COIN_A, dirMask: 0b010, hash: "0xsell" }]);
    expect(deps.failures.get(`${COIN_A.toLowerCase()}:0:1`)).toBe(1);
  });

  it("isolates a reverting direction by simulating each alone", async () => {
    const world: World = {
      coins: [COIN_A],
      epochs: { [COIN_A]: [epoch(intents([5_000n], PK), NOW - 301n), epoch(intents([50_000n], PK), NOW - 301n), epoch(intents([60_000n], PK), NOW - 301n)] },
      seqs: { [COIN_A]: [0, 0, 0] },
      keyByGen: { 0: PK },
    };
    const { ctx, simulateContract } = makeCtx(world);
    simulateContract.mockImplementation((async (p: { args: readonly unknown[] }) => {
      if ((p.args[1] as number) === 0b100) throw new Error('reverted with the following reason:\nDust');
      return { result: undefined, request: {} };
    }) as never);
    const { deps, calls } = makeDeps({
      sendImpl: (c) => {
        if ((c.args[1] as number) & 0b100) throw new Error("execution reverted: Dust");
        return { dryRun: false, status: "success", hash: "0xok", result: undefined };
      },
    });
    const res = await coordinator(ctx, deps);
    expect(calls.map((c) => c.args[1])).toEqual([0b111, 0b011]);
    expect(res.dropped.map((d) => d.dir)).toEqual([2]);
    expect(res.opened[0].dirMask).toBe(0b011);
  });

  it("voids, per direction, only after T_MAX + GRACE, and only what it did not open", async () => {
    const world: World = {
      coins: [COIN_A, COIN_B, COIN_C],
      epochs: {
        // A: SELL voidable under a key this host does not hold -> void; BUY openable but not voidable -> wait
        [COIN_A]: [epoch(intents([5_000n], PK_OTHER), NOW - 400n, 1), epoch(intents([50_000n], PK_OTHER), NOW - 2101n, 1), epoch([], 0n)],
        // B: exactly at T_MAX + GRACE: not voidable yet
        [COIN_B]: [epoch(intents([5_000n], PK_OTHER), NOW - 2100n, 1), epoch([], 0n), epoch([], 0n)],
        // C: nothing
        [COIN_C]: [epoch([], 0n), epoch([], 0n), epoch([], 0n)],
      },
      seqs: { [COIN_A]: [4, 9, 0], [COIN_B]: [0, 0, 0], [COIN_C]: [0, 0, 0] },
      keyByGen: { 0: PK, 1: PK_OTHER },
    };
    const { ctx } = makeCtx(world);
    const { deps, calls } = makeDeps();
    const res = await coordinator(ctx, deps);
    expect(calls.map((c) => [c.functionName, ...c.args])).toEqual([["voidEpoch", COIN_A, 1, 9]]);
    expect(res.voided).toEqual([{ coin: COIN_A, dir: 1, seq: 9, hash: "0xhash1" }]);
    expect(res.active).toBe(2);
  });

  it("--dry-run prints the openEpoch args with u redacted to its magnitude; nothing secret is logged", async () => {
    const us = [5_017n, 6_001n, 7_002n, 8_003n, 9_004n];
    const world: World = { coins: [COIN_A], epochs: { [COIN_A]: [epoch(intents(us, PK), NOW - 61n), epoch([], 0n), epoch([], 0n)] }, seqs: { [COIN_A]: [2, 0, 0] }, keyByGen: { 0: PK } };
    const { ctx } = makeCtx(world, { dryRun: true });
    const lines: string[] = [];
    for (const m of ["log", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
    const { deps } = makeDeps({ sendImpl: () => ({ dryRun: true, result: undefined }) });
    const res = await coordinator(ctx, deps);
    const sum = us.reduce((a, b) => a + b, 0n);
    expect(res.plans).toHaveLength(1);
    expect(res.plans[0]).toMatchObject({ coin: COIN_A, dirMask: 1, dirs: ["BUY"], seq: [2, 0, 0], u: [redactU(sum), "-", "-"], proofs: ["groth16", "-", "-"] });
    expect(redactU(sum)).toBe("2^15..2^16");
    const out = lines.join("\n");
    expect(out).toContain("DRY_RUN openEpoch simulated ok");
    expect(out).toContain("2^15..2^16");
    // no exact sum, no individual amount, no key, no wei amount derived from the sum
    for (const secret of [sum, ...us, SK, sum * UNIT_BNB]) expect(out).not.toContain(secret.toString());
  });

  it("is inert without stage-2 addresses (no RPC call at all)", async () => {
    const { ctx, readContract } = makeCtx({ coins: [], epochs: {}, seqs: {}, keyByGen: {} }, { dep: { grovePool: undefined, darkCurve: undefined } });
    const { deps, send } = makeDeps();
    const res = await coordinator(ctx, deps);
    expect(res.inert).toBe(true);
    expect(readContract).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});

describe("minOut quoting", () => {
  function quoteCtx(reads: Record<string, (args: readonly unknown[]) => unknown>) {
    const readContract = vi.fn(async (p: { functionName: string; args?: readonly unknown[] }) => reads[p.functionName](p.args ?? []));
    return { ctx: { dep: { launchpad: LAUNCHPAD, router: ROUTER, roots: ROOTS }, pub: { readContract } } as unknown as Ctx, readContract };
  }
  const reserves = { bnb: 30n * 10n ** 18n, token: 600_000_000n * 10n ** 18n };
  const v2 = (amountIn: bigint, rin: bigint, rout: bigint) => (amountIn * 9975n * rout) / (rin * 10_000n + amountIn * 9975n);

  it("graduated: from the pair reserves, net of the 2 % GroveCoin pair tax", async () => {
    const { ctx } = quoteCtx({
      isGraduated: () => true,
      WETH: () => WBNB,
      getAmountsOut: ([amountIn, path]) => {
        const p = path as Address[];
        const out = p[0] === WBNB ? v2(amountIn as bigint, reserves.bnb, reserves.token) : v2(amountIn as bigint, reserves.token, reserves.bnb);
        return [amountIn, out];
      },
    });
    const q = chainQuoter(ctx);
    const bnbIn = 10n ** 18n;
    const buy = await q.quote(COIN_A, 0, bnbIn);
    expect(buy).toBe((v2(bnbIn, reserves.bnb, reserves.token) * 9800n) / 10_000n);
    const tokens = 1_000_000n * 10n ** 18n;
    const sell = await q.quote(COIN_A, 1, tokens);
    expect(sell).toBe(v2((tokens * 9800n) / 10_000n, reserves.token, reserves.bnb));
    expect(applySlippage(buy, 300)).toBe((buy * 9700n) / 10_000n);
  });

  it("curve: Launchpad quoteBuy / quoteSell; harvest: Roots.harvestValue", async () => {
    const { ctx, readContract } = quoteCtx({
      isGraduated: () => false,
      quoteBuy: ([, b]) => [(b as bigint) * 1000n, b, 0n],
      quoteSell: ([, t]) => [(t as bigint) / 1000n, 0n, 0n],
      harvestValue: ([, t]) => (t as bigint) / 7n,
    });
    const q = chainQuoter(ctx);
    expect(await q.quote(COIN_A, 0, 5n)).toBe(5000n);
    expect(await q.quote(COIN_A, 1, 5000n)).toBe(5n);
    expect(await q.quote(COIN_A, 2, 70n)).toBe(10n);
    expect(readContract.mock.calls.map((c) => c[0].functionName)).toEqual(["isGraduated", "quoteBuy", "isGraduated", "quoteSell", "harvestValue"]);
  });
});

describe("revert decoding", () => {
  it("reads BandExceeded(dir) from viem's decoded error and from the message", () => {
    expect(decodeOpenRevert({ data: { errorName: "BandExceeded", args: [1] } })).toEqual({ kind: "band", dir: 1 });
    expect(decodeOpenRevert(new Error("Error: BandExceeded(uint8 dir)\n    (2)"))).toEqual({ kind: "band", dir: 2 });
    expect(decodeOpenRevert(new Error("execution reverted"))).toMatchObject({ kind: "other" });
  });
  it("redactU gives only the power-of-two bracket", () => {
    expect(redactU(0n)).toBe("0");
    expect(redactU(1n)).toBe("2^0..2^1");
    expect(redactU((1n << 39n) + 5n)).toBe("2^39..2^40");
  });
  it("OpenArgs type stays aligned with openEpoch", () => {
    const a: OpenArgs = { coin: COIN_A, dirMask: 1, seq: [0, 0, 0], u: [1n, 0n, 0n], proofs: [] as never, minOut: [0n, 0n, 0n] };
    expect(a.dirMask).toBe(1);
  });
});
