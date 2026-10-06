import type { Address } from "viem";

/** Shares below this are not worth a claim transaction; they roll back into the remainder. */
export const DUST_WEI = 1_000_000_000_000n; // 1e12

export interface Holder {
  account: Address;
  balance: bigint;
}

export interface Share {
  account: Address;
  amount: bigint;
}

/**
 * Pro-rata allocation of `pot` across `holders` by balance, integer math only.
 *  - share_i = floor(pot * balance_i / totalBalance)
 *  - shares < DUST_WEI are dropped and their value joins the remainder
 *  - the whole remainder (rounding + dust) goes to the largest holder
 * The returned shares always sum to exactly `pot` (or to 0 when nobody qualifies).
 */
export function allocate(pot: bigint, holders: readonly Holder[]): Share[] {
  if (pot <= 0n || holders.length === 0) return [];
  const eligible = holders.filter((h) => h.balance > 0n);
  if (eligible.length === 0) return [];
  const total = eligible.reduce((s, h) => s + h.balance, 0n);
  if (total === 0n) return [];

  let largest = eligible[0];
  for (const h of eligible) {
    if (h.balance > largest.balance || (h.balance === largest.balance && h.account.toLowerCase() < largest.account.toLowerCase())) {
      largest = h;
    }
  }

  const shares: Share[] = [];
  let distributed = 0n;
  for (const h of eligible) {
    const amt = (pot * h.balance) / total;
    if (amt < DUST_WEI && h !== largest) continue; // dust rolls into the remainder
    shares.push({ account: h.account, amount: amt });
    distributed += amt;
  }
  const remainder = pot - distributed;
  const top = shares.find((s) => s.account === largest.account);
  if (top) {
    top.amount += remainder;
  } else {
    shares.push({ account: largest.account, amount: remainder });
  }
  const out = shares.filter((s) => s.amount > 0n);
  // deterministic order: largest first, then address
  out.sort((a, b) => (a.amount === b.amount ? (a.account.toLowerCase() < b.account.toLowerCase() ? -1 : 1) : a.amount > b.amount ? -1 : 1));
  return out;
}

/** Threshold in token wei for `minHoldingUsd` given `bnbUsd` and `priceWeiPerToken` (wei of BNB per 1e18 tokens). */
export function minHoldingWei(minHoldingUsd: number, bnbUsd: number, priceWeiPerToken: bigint): bigint {
  if (priceWeiPerToken <= 0n) throw new Error("price is zero");
  if (!(bnbUsd > 0)) throw new Error("bnbUsd must be > 0");
  // value threshold in wei of BNB, with 1e6 fixed-point on the USD side to keep fractions
  const usdFp = BigInt(Math.round(minHoldingUsd * 1e6));
  const bnbUsdFp = BigInt(Math.round(bnbUsd * 1e6));
  const thresholdWei = (usdFp * 10n ** 18n) / bnbUsdFp;
  // tokens = thresholdWei * 1e18 / price, rounded up
  return (thresholdWei * 10n ** 18n + priceWeiPerToken - 1n) / priceWeiPerToken;
}
