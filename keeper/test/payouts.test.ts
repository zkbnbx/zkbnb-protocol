import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { derivePayouts, mergePayouts, payoutsFromLogs, type PayoutLog } from "../src/payouts.js";
import { aggregate, type FeedEvent } from "../src/commands/feed.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROT = "0x00000000000000000000000000000000000000d0" as const;
const PAYEE = "0x00000000000000000000000000000000000000aa";
const HELPER = "0x00000000000000000000000000000000000000bb";
const OTHER = "0x00000000000000000000000000000000000000cc";
const DONOR = "0x00000000000000000000000000000000000000dd";
const tx = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

let li = 0;
const log = (name: string, block: number, txn: number, args: Record<string, unknown>, logIndex = li++): PayoutLog => ({ name, args, block, ts: 1_800_000_000 + block, tx: tx(txn), logIndex });
const payee = (id: string) => (id === "2" ? PAYEE : undefined);

describe("derivePayouts", () => {
  it("shielded rotation", () => {
    const { payouts } = derivePayouts([log("Settled", 10, 1, { ringId: 0n, epoch: 3n, causeId: 1n, amount: 500n, shielded: true, leafIndex: 7n })]);
    expect(payouts).toEqual([{ kind: "rotation", causeId: "1", ringId: "0", epoch: "3", amount: "500", delivery: "shielded", leafIndex: "7", block: 10, ts: 1_800_000_010, tx: tx(1), logIndex: expect.any(Number) }]);
  });

  it("shielded direct (keeper-style string args)", () => {
    const { payouts } = derivePayouts([log("DirectDonation", 11, 2, { causeId: "1", amount: "42", from: DONOR, shielded: true, leafIndex: "9" })]);
    expect(payouts[0]).toMatchObject({ kind: "direct", causeId: "1", donor: DONOR, amount: "42", delivery: "shielded", leafIndex: "9" });
    expect(payouts[0].to).toBeUndefined();
  });

  it("wallet delivery takes the cause's current payee", () => {
    const { payouts, pending } = derivePayouts([log("DirectDonation", 12, 3, { causeId: 2n, amount: 10n, from: DONOR, shielded: false, leafIndex: 0n })], payee);
    expect(payouts[0]).toMatchObject({ delivery: "wallet", to: PAYEE });
    expect(payouts[0].leafIndex).toBeUndefined();
    expect(pending).toEqual([]);
  });

  it("deferred with poolFailed false and true", () => {
    const { payouts, pending } = derivePayouts([
      log("PayoutDeferred", 13, 4, { causeId: 2n, to: HELPER, amount: 10n, poolFailed: false }),
      log("DirectDonation", 13, 4, { causeId: 2n, amount: 10n, from: DONOR, shielded: false, leafIndex: 0n }),
      log("PayoutDeferred", 14, 5, { causeId: 1n, to: OTHER, amount: 20n, poolFailed: true }),
      log("Settled", 14, 5, { ringId: 0n, epoch: 0n, causeId: 1n, amount: 20n, shielded: false, leafIndex: 0n }),
    ], payee);
    expect(payouts.map((p) => [p.kind, p.delivery, p.to, p.poolFailed, p.withdrawn])).toEqual([
      ["rotation", "deferred", OTHER, true, false],
      ["direct", "deferred", HELPER, false, false],
    ]);
    expect(pending).toEqual([
      { address: OTHER, deferred: "20", withdrawn: "0", outstanding: "20" },
      { address: HELPER, deferred: "10", withdrawn: "0", outstanding: "10" },
    ]);
  });

  it("deferred then withdrawn: FIFO across two deferrals and one partially covering withdrawal", () => {
    const { payouts, pending } = derivePayouts([
      log("PayoutDeferred", 20, 6, { causeId: 2n, to: HELPER, amount: 100n, poolFailed: false }),
      log("DirectDonation", 20, 6, { causeId: 2n, amount: 100n, from: DONOR, shielded: false, leafIndex: 0n }),
      log("PayoutDeferred", 21, 7, { causeId: 2n, to: HELPER, amount: 50n, poolFailed: false }),
      log("Settled", 21, 7, { ringId: 1n, epoch: 0n, causeId: 2n, amount: 50n, shielded: false, leafIndex: 0n }),
      log("PendingWithdrawn", 22, 8, { to: HELPER, amount: 120n }),
    ]);
    const def = payouts.filter((p) => p.delivery === "deferred");
    expect(def.map((p) => [p.amount, p.withdrawn])).toEqual([
      ["50", false], // newest first: the second deferral is not covered (100 + 50 > 120)
      ["100", true],
    ]);
    expect(pending).toEqual([{ address: HELPER, deferred: "150", withdrawn: "120", outstanding: "30" }]);
  });

  it("two payouts in one tx: only the one preceded by its PayoutDeferred is deferred", () => {
    li = 0;
    const { payouts } = derivePayouts([
      log("DirectDonation", 30, 9, { causeId: 2n, amount: 5n, from: DONOR, shielded: false, leafIndex: 0n }, 0),
      log("PayoutDeferred", 30, 9, { causeId: 2n, to: HELPER, amount: 5n, poolFailed: false }, 1),
      log("Settled", 30, 9, { ringId: 0n, epoch: 4n, causeId: 2n, amount: 5n, shielded: false, leafIndex: 0n }, 2),
      log("Settled", 30, 9, { ringId: 1n, epoch: 0n, causeId: 1n, amount: 7n, shielded: true, leafIndex: 11n }, 3),
    ], payee);
    expect(payouts.map((p) => [p.logIndex, p.kind, p.delivery, p.to])).toEqual([
      [3, "rotation", "shielded", undefined],
      [2, "rotation", "deferred", HELPER],
      [0, "direct", "wallet", PAYEE],
    ]);
  });

  it("mergePayouts: feed + delta, dedupe by tx+logIndex, withdrawal in the delta covers a feed deferral", () => {
    const feedLogs = [
      log("PayoutDeferred", 40, 10, { causeId: 2n, to: HELPER, amount: 9n, poolFailed: false }, 0),
      log("DirectDonation", 40, 10, { causeId: 2n, amount: 9n, from: DONOR, shielded: false, leafIndex: 0n }, 1),
    ];
    const base = derivePayouts(feedLogs);
    expect(base.payouts[0].withdrawn).toBe(false);
    const delta = [feedLogs[1], log("PendingWithdrawn", 41, 11, { to: HELPER, amount: 9n }, 0), log("Settled", 42, 12, { ringId: 0n, epoch: 1n, causeId: 1n, amount: 3n, shielded: true, leafIndex: 12n }, 0)];
    // feedLogs[1] re-scanned without its deferral: must not duplicate or turn into a wallet payout
    const merged = mergePayouts(base, delta);
    expect(merged.payouts.length).toBe(2);
    expect(merged.payouts[1]).toMatchObject({ delivery: "deferred", withdrawn: true });
    expect(merged.pending).toEqual([{ address: HELPER, deferred: "9", withdrawn: "9", outstanding: "0" }]);
  });

  it("a truncated list consumes the hidden (older) deferrals first", () => {
    const all = derivePayouts([
      log("PayoutDeferred", 50, 13, { causeId: 2n, to: HELPER, amount: 4n, poolFailed: false }, 0),
      log("DirectDonation", 50, 13, { causeId: 2n, amount: 4n, from: DONOR, shielded: false, leafIndex: 0n }, 1),
      log("PayoutDeferred", 51, 14, { causeId: 2n, to: HELPER, amount: 4n, poolFailed: false }, 0),
      log("DirectDonation", 51, 14, { causeId: 2n, amount: 4n, from: DONOR, shielded: false, leafIndex: 0n }, 1),
      log("PendingWithdrawn", 52, 15, { to: HELPER, amount: 4n }, 0),
    ]);
    // keep only the newest payout (as a capped feed would) and re-merge with nothing new
    const merged = mergePayouts({ payouts: all.payouts.slice(0, 1), pending: all.pending }, []);
    expect(merged.payouts[0].withdrawn).toBe(false);
  });

  it("keeper and web copies are identical", () => {
    const k = fs.readFileSync(path.resolve(here, "..", "src", "payouts.ts"), "utf8");
    const w = path.resolve(here, "..", "..", "web", "src", "lib", "payouts.ts");
    if (!fs.existsSync(w)) return;
    expect(fs.readFileSync(w, "utf8").replace(/\r\n/g, "\n")).toBe(k.replace(/\r\n/g, "\n"));
  });
});

describe("feed aggregate: payouts", () => {
  const A = { feeRouter: "0x0000000000000000000000000000000000000001", roots: "0x0000000000000000000000000000000000000002", holderRewards: "0x0000000000000000000000000000000000000003", donationRotator: ROT } as const;
  const now = 1_900_000_000;
  const ev = (name: string, ts: number, txn: number, logIndex: number, args: FeedEvent["args"]): FeedEvent => ({ name, address: ROT, block: ts - 1_800_000_000, ts, tx: tx(txn) as `0x${string}`, logIndex, args });
  const events: FeedEvent[] = [
    ev("Settled", now - 100, 1, 0, { ringId: "0", epoch: "0", causeId: "1", amount: "1000", shielded: true, leafIndex: "3" }),
    ev("PayoutDeferred", now - 50, 2, 0, { causeId: "2", to: HELPER, amount: "200", poolFailed: false }),
    ev("DirectDonation", now - 50, 2, 1, { causeId: "2", amount: "200", from: DONOR, shielded: false, leafIndex: "0" }),
    ev("DirectDonation", now - 40, 3, 0, { causeId: "1", amount: "30", from: DONOR, shielded: true, leafIndex: "4" }),
    ev("PendingWithdrawn", now - 30, 4, 0, { to: HELPER, amount: "200" }),
  ];
  // an all-time payout older than the 30-day window
  const old = ev("Settled", now - 90 * 86400, 5, 0, { ringId: "0", epoch: "0", causeId: "2", amount: "7", shielded: false, leafIndex: "0" });

  it("adds payouts / pendingByAddress / day columns and keeps every old field", () => {
    const f = aggregate(events, { chainId: 97, now, windowDays: 30, fromBlock: 1, toBlock: 2, addresses: A }, { payoutEvents: [old, ...events], payeeOf: (id) => (id === "2" ? PAYEE : undefined) });
    expect(f.version).toBe(1);
    for (const k of ["days", "totals", "coins", "buybacks", "harvests", "runs", "claims", "settlements"]) expect(f).toHaveProperty(k);
    expect(f.settlements.length).toBe(1);
    expect(f.payouts.map((p) => [p.kind, p.delivery, p.amount, p.withdrawn ?? null, p.to ?? null])).toEqual([
      ["direct", "shielded", "30", null, null],
      ["direct", "deferred", "200", true, HELPER],
      ["rotation", "shielded", "1000", null, null],
      ["rotation", "wallet", "7", null, PAYEE],
    ]);
    expect(f.pendingByAddress).toEqual([{ address: HELPER, deferred: "200", withdrawn: "200", outstanding: "0" }]);
    expect(f.totals.payoutsBnb).toBe("1230"); // window only: the 90-day-old payout is not in the daily columns
    expect(f.totals.payouts).toBe(3);
    expect(f.totals.directBnb).toBe("230");
    expect(f.totals.directs).toBe(2);
    expect(f.totals.deferredBnb).toBe("200");
    expect(f.days.every((d) => typeof d.payoutsBnb === "string" && typeof d.payouts === "number")).toBe(true);
    // legacy columns untouched
    expect(f.totals.settlementsBnb).toBe("1000");
    expect(f.totals.donations).toBe(2);
  });

  it("without an all-time scan, payouts come from the window events", () => {
    const f = aggregate(events, { chainId: 97, now, windowDays: 30, fromBlock: 1, toBlock: 2, addresses: A });
    expect(f.payouts.length).toBe(3);
  });

  it("payouts are capped at 500, newest first", () => {
    const many: FeedEvent[] = Array.from({ length: 520 }, (_, i) => ev("DirectDonation", now - 10_000 + i, 100 + i, 0, { causeId: "1", amount: "1", from: DONOR, shielded: true, leafIndex: String(i) }));
    const f = aggregate(many, { chainId: 97, now, windowDays: 30, fromBlock: 1, toBlock: 2, addresses: A });
    expect(f.payouts.length).toBe(500);
    expect(f.payouts[0].leafIndex).toBe("519");
    expect(f.totals.payouts).toBe(520);
  });
});

describe("payoutsFromLogs", () => {
  it("ignores unrelated events", () => {
    expect(payoutsFromLogs([log("Funded", 1, 1, { ringId: 0n, coin: DONOR, amount: 1n, from: DONOR }), log("Donated", 1, 1, { ringId: 0n, amount: 1n, from: DONOR })])).toEqual([]);
  });
});
