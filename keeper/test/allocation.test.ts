import { describe, it, expect } from "vitest";
import { parseEther, type Address } from "viem";
import { allocate, DUST_WEI, minHoldingWei } from "../src/allocation.js";

const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Address;
const C = "0xcccccccccccccccccccccccccccccccccccccccc" as Address;
const D = "0xdddddddddddddddddddddddddddddddddddddddd" as Address;

const sum = (xs: { amount: bigint }[]) => xs.reduce((s, x) => s + x.amount, 0n);

describe("allocation", () => {
  it("splits pro-rata and sums exactly to the pot", () => {
    const pot = parseEther("1");
    const shares = allocate(pot, [
      { account: A, balance: 500n },
      { account: B, balance: 300n },
      { account: C, balance: 200n },
    ]);
    expect(sum(shares)).toBe(pot);
    const by = Object.fromEntries(shares.map((s) => [s.account, s.amount]));
    expect(by[A]).toBe(parseEther("0.5"));
    expect(by[B]).toBe(parseEther("0.3"));
    expect(by[C]).toBe(parseEther("0.2"));
  });

  it("gives the integer-division remainder to the largest holder", () => {
    const pot = 100n * DUST_WEI + 7n; // not divisible by 3
    const shares = allocate(pot, [
      { account: A, balance: 1n },
      { account: B, balance: 1n },
      { account: C, balance: 2n }, // largest
    ]);
    expect(sum(shares)).toBe(pot);
    const by = Object.fromEntries(shares.map((s) => [s.account, s.amount]));
    const base = pot / 4n;
    expect(by[A]).toBe(base);
    expect(by[B]).toBe(base);
    expect(by[C]).toBe(pot - 2n * base); // 2*base + remainder
    expect(by[C] - 2n * base).toBe(pot - 4n * base);
  });

  it("drops dust shares (< 1e12 wei) and rolls them into the remainder", () => {
    const pot = parseEther("0.1");
    const shares = allocate(pot, [
      { account: A, balance: parseEther("1000000") },
      { account: B, balance: 1n }, // share would be ~1e-19 BNB → dust
      { account: C, balance: parseEther("1") }, // 1e17 * 1e18 / (1e24+1e18+1) ≈ 1e11 → dust
    ]);
    expect(shares.map((s) => s.account)).toEqual([A]);
    expect(shares[0].amount).toBe(pot);
  });

  it("keeps shares at or above the dust threshold", () => {
    const pot = 10n * DUST_WEI;
    const shares = allocate(pot, [
      { account: A, balance: 9n },
      { account: B, balance: 1n }, // exactly 1e12
    ]);
    expect(shares.length).toBe(2);
    expect(sum(shares)).toBe(pot);
  });

  it("returns nothing for an empty pot, no holders or zero balances", () => {
    expect(allocate(0n, [{ account: A, balance: 1n }])).toEqual([]);
    expect(allocate(1n, [])).toEqual([]);
    expect(allocate(1n, [{ account: A, balance: 0n }])).toEqual([]);
  });

  it("the largest holder keeps the whole pot when it is the only one above dust", () => {
    const pot = DUST_WEI; // tiny pot
    const shares = allocate(pot, [
      { account: A, balance: 10n },
      { account: B, balance: 10n },
      { account: D, balance: 11n },
    ]);
    expect(shares).toEqual([{ account: D, amount: pot }]);
  });

  it("is deterministic: equal balances tie-break by address", () => {
    const pot = parseEther("1");
    const s1 = allocate(pot, [
      { account: B, balance: 5n },
      { account: A, balance: 5n },
    ]);
    const s2 = allocate(pot, [
      { account: A, balance: 5n },
      { account: B, balance: 5n },
    ]);
    expect(s1).toEqual(s2);
    expect(sum(s1)).toBe(pot);
  });

  it("minHoldingWei converts USD → BNB → tokens, rounding up", () => {
    // 1 token = 0.001 BNB, BNB = $500 → $20 = 0.04 BNB = 40 tokens
    const price = parseEther("0.001");
    expect(minHoldingWei(20, 500, price)).toBe(parseEther("40"));
    // rounding up: price 3 wei per token, threshold 1e18 wei → ceil(1e36/3)
    const t = minHoldingWei(1, 1, 3n);
    expect(t * 3n >= 10n ** 36n).toBe(true);
    expect((t - 1n) * 3n < 10n ** 36n).toBe(true);
    expect(() => minHoldingWei(20, 500, 0n)).toThrow();
    expect(() => minHoldingWei(20, 0, price)).toThrow();
  });
});
