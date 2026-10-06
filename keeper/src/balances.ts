import { getAddress, type Address } from "viem";

export interface TransferLike {
  from: Address;
  to: Address;
  value: bigint;
}

export type BalanceMap = Map<Address, bigint>;

/** Apply ERC-20 Transfer events in order to a balance map (checksummed keys, negative balances rejected). */
export function applyTransfers(balances: BalanceMap, transfers: Iterable<TransferLike>): BalanceMap {
  for (const t of transfers) {
    const from = getAddress(t.from);
    const to = getAddress(t.to);
    const v = BigInt(t.value);
    if (v === 0n) continue;
    if (from !== "0x0000000000000000000000000000000000000000") {
      const nb = (balances.get(from) ?? 0n) - v;
      if (nb < 0n) throw new Error(`balance reconstruction underflow for ${from}: missing logs?`);
      if (nb === 0n) balances.delete(from);
      else balances.set(from, nb);
    }
    if (to !== "0x0000000000000000000000000000000000000000") {
      balances.set(to, (balances.get(to) ?? 0n) + v);
    }
  }
  return balances;
}

export function serializeBalances(b: BalanceMap): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of [...b.entries()].sort((x, y) => (x[0].toLowerCase() < y[0].toLowerCase() ? -1 : 1))) {
    if (v > 0n) out[k] = v.toString();
  }
  return out;
}

export function deserializeBalances(o: Record<string, string>): BalanceMap {
  const m: BalanceMap = new Map();
  for (const [k, v] of Object.entries(o)) m.set(getAddress(k), BigInt(v));
  return m;
}

/**
 * Filter holders: drop excluded addresses and anyone below `minWei`.
 */
export function eligibleHolders(balances: BalanceMap, excluded: Iterable<Address>, minWei: bigint): { account: Address; balance: bigint }[] {
  const ex = new Set([...excluded].map((a) => a.toLowerCase()));
  const out: { account: Address; balance: bigint }[] = [];
  for (const [account, balance] of balances) {
    if (balance <= 0n) continue;
    if (ex.has(account.toLowerCase())) continue;
    if (balance < minWei) continue;
    out.push({ account, balance });
  }
  out.sort((a, b) => (a.balance === b.balance ? (a.account.toLowerCase() < b.account.toLowerCase() ? -1 : 1) : a.balance > b.balance ? -1 : 1));
  return out;
}
