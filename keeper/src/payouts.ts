/**
 * Donation payouts: one record per BNB amount that left DonationRotator for a cause.
 *
 * SAME FILE in keeper/src/payouts.ts and web/src/lib/payouts.ts (a test checks they are identical). Pure, no imports,
 * so the keeper's rings.json and the web's live scan derive payouts the same way.
 *
 * How money reaches a cause (DonationRotator._payCause):
 *   - Settled(ringId, epoch, causeId, amount, shielded, leafIndex)        rotation payout
 *   - DirectDonation(causeId, amount, from, shielded, leafIndex)          direct payout
 *   - PayoutDeferred(causeId, to, amount, poolFailed)                     emitted in the SAME tx, before the payout
 *                                                                          event, when the 50k-gas push failed
 *   - PendingWithdrawn(to, amount)                                        `to` pulled everything pending for it
 *
 * Rules: shielded=true -> "shielded". Else a PayoutDeferred with the same causeId and amount in the same tx (the
 * nearest one before the payout log, each used once) -> "deferred" (to, poolFailed). Else -> "wallet", `to` = the
 * cause's current fallbackWallet or owner (from `payeeOf`, may be unknown).
 * Deferred payouts are marked `withdrawn` FIFO per address: deferral i is withdrawn when the running total of that
 * address's deferrals up to and including i is <= the address's total PendingWithdrawn.
 * Amounts are decimal wei strings; block / ts / logIndex are numbers.
 */

export type PayoutKind = "rotation" | "direct";
export type PayoutDelivery = "shielded" | "wallet" | "deferred";

export interface Payout {
  kind: PayoutKind;
  causeId: string;
  ringId?: string;
  epoch?: string;
  /** direct only */
  donor?: string;
  amount: string;
  delivery: PayoutDelivery;
  /** shielded only */
  leafIndex?: string;
  /** wallet / deferred recipient (wallet: the cause's current payee) */
  to?: string;
  /** deferred only: the cause has a shielded key but the pool refused the note */
  poolFailed?: boolean;
  /** deferred only: covered by a later PendingWithdrawn of `to` */
  withdrawn?: boolean;
  block: number;
  ts: number;
  tx: string;
  logIndex: number;
}

export interface PendingRow {
  address: string;
  deferred: string;
  withdrawn: string;
  outstanding: string;
}

export interface Withdrawal {
  to: string;
  amount: string;
  block: number;
  ts: number;
  tx: string;
  logIndex: number;
}

/** A decoded DonationRotator log. `args` values may be bigint (viem), decimal strings (keeper cache) or booleans. */
export interface PayoutLog {
  name: string;
  args: Record<string, unknown>;
  block: number | bigint;
  ts: number;
  tx: string;
  logIndex: number;
}

export const PAYOUT_EVENTS = ["Settled", "DirectDonation", "PayoutDeferred", "PendingWithdrawn"] as const;

const s = (v: unknown): string => (typeof v === "bigint" ? v.toString() : v === undefined || v === null ? "0" : String(v));
const b = (v: unknown): boolean => v === true || v === "true";
const lc = (a: string) => a.toLowerCase();
const big = (v: string | undefined) => BigInt(v || "0");

export const payoutKey = (p: { tx: string; logIndex: number }) => `${lc(p.tx)}:${p.logIndex}`;

/** Newest first: block desc, then logIndex desc. */
export function sortNewestFirst<T extends { block: number; logIndex: number }>(xs: T[]): T[] {
  return xs.sort((x, y) => y.block - x.block || y.logIndex - x.logIndex);
}

/** Payout records from logs (withdrawn left false for deferred ones; see `settleWithdrawals`). Newest first. */
export function payoutsFromLogs(logs: PayoutLog[], payeeOf?: (causeId: string) => string | undefined): Payout[] {
  const deferredByTx = new Map<string, { causeId: string; to: string; amount: string; poolFailed: boolean; logIndex: number; used: boolean }[]>();
  for (const l of logs) {
    if (l.name !== "PayoutDeferred") continue;
    const k = lc(l.tx);
    const list = deferredByTx.get(k) ?? [];
    list.push({ causeId: s(l.args.causeId), to: String(l.args.to ?? ""), amount: s(l.args.amount), poolFailed: b(l.args.poolFailed), logIndex: l.logIndex, used: false });
    deferredByTx.set(k, list);
  }
  const ordered = [...logs].sort((x, y) => Number(x.block) - Number(y.block) || x.logIndex - y.logIndex);
  const out: Payout[] = [];
  const unmatched: Payout[] = [];
  const defer = (p: Payout, d: { to: string; poolFailed: boolean; used: boolean }) => {
    d.used = true;
    p.delivery = "deferred";
    p.to = d.to;
    p.poolFailed = d.poolFailed;
    p.withdrawn = false;
  };
  for (const l of ordered) {
    if (l.name !== "Settled" && l.name !== "DirectDonation") continue;
    const a = l.args;
    const causeId = s(a.causeId);
    const amount = s(a.amount);
    const p: Payout = {
      kind: l.name === "Settled" ? "rotation" : "direct",
      causeId,
      amount,
      delivery: "wallet",
      block: Number(l.block),
      ts: l.ts,
      tx: l.tx,
      logIndex: l.logIndex,
    };
    if (p.kind === "rotation") {
      p.ringId = s(a.ringId);
      p.epoch = s(a.epoch);
    } else p.donor = String(a.from ?? "");
    if (b(a.shielded)) {
      p.delivery = "shielded";
      p.leafIndex = s(a.leafIndex);
    } else {
      // the deferral is emitted just before its payout event: take the nearest unused one before it
      const before = (deferredByTx.get(lc(l.tx)) ?? []).filter((d) => !d.used && d.causeId === causeId && d.amount === amount && d.logIndex < l.logIndex).sort((x, y) => y.logIndex - x.logIndex);
      if (before[0]) defer(p, before[0]);
      else unmatched.push(p);
    }
    out.push(p);
  }
  // second pass: a deferral left over in the same tx (logs without a usable order) still belongs to a payout
  for (const p of unmatched) {
    const d = (deferredByTx.get(lc(p.tx)) ?? []).find((x) => !x.used && x.causeId === p.causeId && x.amount === p.amount);
    if (d) defer(p, d);
    else {
      const to = payeeOf?.(p.causeId);
      if (to) p.to = to;
    }
  }
  return sortNewestFirst(out);
}

export function withdrawalsFromLogs(logs: PayoutLog[]): Withdrawal[] {
  return logs
    .filter((l) => l.name === "PendingWithdrawn")
    .map((l) => ({ to: String(l.args.to ?? ""), amount: s(l.args.amount), block: Number(l.block), ts: l.ts, tx: l.tx, logIndex: l.logIndex }));
}

/**
 * Per-address deferred / withdrawn / outstanding. `base` (e.g. the keeper feed's rows up to feed.toBlock) is added to
 * the deferred payouts and withdrawals given here (e.g. the live delta after it). Sorted by outstanding desc.
 */
export function pendingByAddress(payouts: Payout[], withdrawals: Withdrawal[], base: PendingRow[] = []): PendingRow[] {
  const m = new Map<string, { address: string; deferred: bigint; withdrawn: bigint }>();
  const row = (addr: string) => {
    const k = lc(addr);
    let r = m.get(k);
    if (!r) {
      r = { address: addr, deferred: 0n, withdrawn: 0n };
      m.set(k, r);
    }
    return r;
  };
  for (const r of base) {
    const x = row(r.address);
    x.deferred += big(r.deferred);
    x.withdrawn += big(r.withdrawn);
  }
  for (const p of payouts) if (p.delivery === "deferred" && p.to) row(p.to).deferred += big(p.amount);
  for (const w of withdrawals) row(w.to).withdrawn += big(w.amount);
  return [...m.values()]
    .map((r) => {
      const out = r.deferred > r.withdrawn ? r.deferred - r.withdrawn : 0n;
      return { address: r.address, deferred: r.deferred.toString(), withdrawn: r.withdrawn.toString(), outstanding: out.toString() };
    })
    .sort((x, y) => (big(y.outstanding) > big(x.outstanding) ? 1 : big(y.outstanding) < big(x.outstanding) ? -1 : lc(x.address) < lc(y.address) ? -1 : 1));
}

/**
 * Mark deferred payouts withdrawn FIFO against each address's total withdrawn (from `pending`). When `payouts` is a
 * truncated (newest-first, capped) list, deferrals missing from it (older) are consumed first: their sum is
 * `pending.deferred - sum(listed deferrals)`. Mutates and returns `payouts`.
 */
export function settleWithdrawals(payouts: Payout[], pending: PendingRow[]): Payout[] {
  const byAddr = new Map(pending.map((r) => [lc(r.address), r]));
  const deferredOldestFirst = payouts.filter((p) => p.delivery === "deferred" && p.to).sort((x, y) => x.block - y.block || x.logIndex - y.logIndex);
  const listed = new Map<string, bigint>();
  for (const p of deferredOldestFirst) listed.set(lc(p.to!), (listed.get(lc(p.to!)) ?? 0n) + big(p.amount));
  const running = new Map<string, bigint>();
  for (const p of deferredOldestFirst) {
    const k = lc(p.to!);
    const r = byAddr.get(k);
    const total = r ? big(r.deferred) : (listed.get(k) ?? 0n);
    const hidden = total > (listed.get(k) ?? 0n) ? total - (listed.get(k) ?? 0n) : 0n;
    const cum = (running.get(k) ?? hidden) + big(p.amount);
    running.set(k, cum);
    p.withdrawn = !!r && cum <= big(r.withdrawn);
  }
  return payouts;
}

/** Full derivation from a complete log history. */
export function derivePayouts(logs: PayoutLog[], payeeOf?: (causeId: string) => string | undefined): { payouts: Payout[]; pending: PendingRow[] } {
  const payouts = payoutsFromLogs(logs, payeeOf);
  const pending = pendingByAddress(payouts, withdrawalsFromLogs(logs));
  settleWithdrawals(payouts, pending);
  return { payouts, pending };
}

/**
 * Feed + live delta: `base` payouts / pending rows come from the keeper (up to its toBlock), `deltaLogs` are the logs
 * scanned after it. Payouts are deduped by tx+logIndex; withdrawn flags are recomputed over the merged list.
 */
export function mergePayouts(base: { payouts: Payout[]; pending: PendingRow[] }, deltaLogs: PayoutLog[], payeeOf?: (causeId: string) => string | undefined): { payouts: Payout[]; pending: PendingRow[] } {
  const seen = new Set(base.payouts.map(payoutKey));
  const fresh = payoutsFromLogs(deltaLogs, payeeOf).filter((p) => !seen.has(payoutKey(p)));
  const payouts = sortNewestFirst([...base.payouts.map((p) => ({ ...p })), ...fresh]);
  const pending = pendingByAddress(fresh, withdrawalsFromLogs(deltaLogs), base.pending);
  settleWithdrawals(payouts, pending);
  return { payouts, pending };
}

/** Fill in `to` for wallet deliveries whose payee was unknown when the record was built (e.g. an older feed). */
export function withPayees(payouts: Payout[], payeeOf: (causeId: string) => string | undefined): Payout[] {
  return payouts.map((p) => (p.delivery === "wallet" && !p.to && payeeOf(p.causeId) ? { ...p, to: payeeOf(p.causeId) } : p));
}
