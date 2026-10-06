import { describe, it, expect } from "vitest";
import { parseEther, getAddress, type Address } from "viem";
import { applyTransfers, deserializeBalances, eligibleHolders, serializeBalances, type BalanceMap } from "../src/balances.js";

// balance map keys are checksummed, so the fixtures are too
const ZERO = getAddress("0x0000000000000000000000000000000000000000");
const DEAD = getAddress("0x000000000000000000000000000000000000dEaD");
const LAUNCHPAD = getAddress("0x1000000000000000000000000000000000000001");
const COIN = getAddress("0x2000000000000000000000000000000000000002");
const PAIR = getAddress("0x3000000000000000000000000000000000000003");
const ROOTS = getAddress("0x4000000000000000000000000000000000000004");
const ALICE = getAddress("0xa00000000000000000000000000000000000000a");
const BOB = getAddress("0xb00000000000000000000000000000000000000b");
const CAROL = getAddress("0xc00000000000000000000000000000000000000c");

const TOTAL = parseEther("1000000000");

/** A synthetic life of a coin: mint → curve buys/sells → graduation → pair trades with tax → burns. */
function syntheticLog() {
  return [
    { from: ZERO, to: LAUNCHPAD, value: TOTAL }, // mint to launchpad
    { from: LAUNCHPAD, to: ALICE, value: parseEther("100") }, // curve buy
    { from: LAUNCHPAD, to: BOB, value: parseEther("50") },
    { from: BOB, to: LAUNCHPAD, value: parseEther("10") }, // curve sell
    { from: LAUNCHPAD, to: PAIR, value: parseEther("206900000") }, // graduation liquidity
    { from: LAUNCHPAD, to: ZERO, value: parseEther("5") }, // dust burn
    // pair buy by carol: 2% tax goes to the coin contract
    { from: PAIR, to: COIN, value: parseEther("0.2") },
    { from: PAIR, to: CAROL, value: parseEther("9.8") },
    // alice harvests (burnFrom via Roots)
    { from: ALICE, to: ZERO, value: parseEther("40") },
    // bob sends to dead on purpose
    { from: BOB, to: DEAD, value: parseEther("1") },
    // zero-value transfer is a no-op
    { from: ALICE, to: BOB, value: 0n },
  ];
}

describe("balance reconstruction", () => {
  it("rebuilds balances from a Transfer log set", () => {
    const b = applyTransfers(new Map(), syntheticLog());
    expect(b.get(ALICE)).toBe(parseEther("60"));
    expect(b.get(BOB)).toBe(parseEther("39"));
    expect(b.get(CAROL)).toBe(parseEther("9.8"));
    expect(b.get(COIN)).toBe(parseEther("0.2"));
    expect(b.get(PAIR)).toBe(parseEther("206900000") - parseEther("10"));
    expect(b.get(DEAD)).toBe(parseEther("1"));
    expect(b.has(ZERO)).toBe(false);
    const launchpad = TOTAL - parseEther("100") - parseEther("50") + parseEther("10") - parseEther("206900000") - parseEther("5");
    expect(b.get(LAUNCHPAD)).toBe(launchpad);
    // conservation: sum of balances == minted - burned
    const total = [...b.values()].reduce((s, v) => s + v, 0n);
    expect(total).toBe(TOTAL - parseEther("5") - parseEther("40"));
  });

  it("is incremental: applying logs in two batches equals one batch", () => {
    const logs = syntheticLog();
    const one = applyTransfers(new Map(), logs);
    const two = applyTransfers(applyTransfers(new Map(), logs.slice(0, 5)), logs.slice(5));
    expect(serializeBalances(two)).toEqual(serializeBalances(one));
  });

  it("round-trips through the cache serialisation with checksummed keys", () => {
    const b = applyTransfers(new Map(), syntheticLog());
    const s = serializeBalances(b);
    for (const k of Object.keys(s)) expect(k).toMatch(/^0x[0-9a-fA-F]{40}$/);
    const back = deserializeBalances(s);
    expect(serializeBalances(back)).toEqual(s);
    expect(back.get(ALICE)).toBe(parseEther("60"));
  });

  it("throws on an underflow (missing logs)", () => {
    expect(() => applyTransfers(new Map(), [{ from: ALICE, to: BOB, value: 1n }])).toThrow(/underflow/);
  });

  it("eligibleHolders excludes system addresses and applies the threshold", () => {
    const b: BalanceMap = applyTransfers(new Map(), syntheticLog());
    const holders = eligibleHolders(b, [PAIR, LAUNCHPAD, ROOTS, COIN, ZERO, DEAD], parseEther("10"));
    expect(holders.map((h) => h.account)).toEqual([ALICE, BOB]); // carol has 9.8 < 10
    expect(holders[0].balance).toBe(parseEther("60"));
    const all = eligibleHolders(b, [PAIR, LAUNCHPAD, COIN, DEAD], 0n);
    expect(all.map((h) => h.account)).toEqual([ALICE, BOB, CAROL]);
    // exclusion is case-insensitive
    const ex = eligibleHolders(b, [PAIR, LAUNCHPAD, COIN, DEAD, ALICE.toUpperCase().replace("0X", "0x") as Address], 0n);
    expect(ex.map((h) => h.account)).toEqual([BOB, CAROL]);
  });
});
