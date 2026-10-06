import path from "node:path";
import { formatEther, getAddress, parseEventLogs, toEventSelector, type AbiEvent, type Address, type Hex } from "viem";
import { donationRotatorAbi, feedEventsAbi, feeRouterAbi } from "../abis.js";
import { derivePayouts, sortNewestFirst, PAYOUT_EVENTS, type Payout, type PendingRow } from "../payouts.js";
import type { Ctx } from "../chain.js";
import { BlockTimestamps, blockAtTimestamp, getLogsChunked } from "../logs.js";
import { readJson, writeJsonAtomic } from "../state.js";
import { logger } from "../log.js";

const log = logger("feed");

/** One decoded event kept in the feed cache. `args` are stringified (bigint → decimal string). */
export interface FeedEvent {
  name: string;
  address: Address;
  block: number;
  ts: number;
  tx: Hex;
  logIndex: number;
  args: Record<string, string | boolean | number>;
}

interface FeedCache {
  chainId: number;
  lastBlock: number;
  events: FeedEvent[];
}

export interface DayRow {
  date: string; // YYYY-MM-DD (UTC)
  feesCollected: string;
  toRoots: string;
  toRootstock: string;
  toTreasury: string;
  toDeployer: string;
  rootsDeposited: string;
  rootsOverflow: string;
  buybackBnb: string;
  groveBurned: string;
  buybacks: number;
  harvestBnb: string;
  harvestTokens: string;
  harvests: number;
  harvestsShielded: number;
  runsBnb: string;
  runs: number;
  claimsBnb: string;
  claims: number;
  claimsShielded: number;
  settlementsBnb: string;
  settlements: number;
  donationsBnb: string;
  donations: number;
  /** every payout to a cause (rotation + direct), by the day it happened */
  payoutsBnb: string;
  payouts: number;
  directBnb: string;
  directs: number;
  /** payouts whose push failed and that waited in pending[to] */
  deferredBnb: string;
}

export interface RingsFeed {
  version: 1;
  chainId: number;
  generatedAt: number;
  windowDays: number;
  fromBlock: number;
  toBlock: number;
  days: DayRow[];
  totals: Omit<DayRow, "date">;
  coins: {
    coin: Address;
    collected: string;
    toRoots: string;
    toRootstock: string;
    toTreasury: string;
    toDeployer: string;
    mode: number;
    feeEvents: number;
    lifetimeCollected: string;
  }[];
  buybacks: { block: number; ts: number; tx: Hex; bnbIn: string; groveBurned: string }[];
  harvests: { block: number; ts: number; tx: Hex; coin: Address; harvester: Address; tokensBurned: string; bnb: string; shielded: boolean; leafIndex: string }[];
  runs: { block: number; ts: number; tx: Hex; coin: Address; runId: string; root: string; amount: string; holders: string; uri: string }[];
  claims: { block: number; ts: number; tx: Hex; coin: Address; runId: string; account: Address; amount: string; shielded: boolean; leafIndex: string }[];
  settlements: { block: number; ts: number; tx: Hex; ringId: string; epoch: string; causeId: string; amount: string; shielded: boolean; leafIndex: string }[];
  /** All-time donation payouts (src/payouts.ts), newest first, capped at PAYOUTS_CAP. Additive in version 1. */
  payouts: Payout[];
  /** Per payee: all-time deferred, withdrawn and still outstanding (pending) BNB. Additive in version 1. */
  pendingByAddress: PendingRow[];
}

/** All-time DonationRotator payout events, kept apart from the windowed feed cache. */
interface PayoutCache {
  chainId: number;
  rotator: Address;
  lastBlock: number;
  events: FeedEvent[];
}

export const PAYOUTS_CAP = 500;

const zeroDay = (date: string): DayRow => ({
  date,
  feesCollected: "0",
  toRoots: "0",
  toRootstock: "0",
  toTreasury: "0",
  toDeployer: "0",
  rootsDeposited: "0",
  rootsOverflow: "0",
  buybackBnb: "0",
  groveBurned: "0",
  buybacks: 0,
  harvestBnb: "0",
  harvestTokens: "0",
  harvests: 0,
  harvestsShielded: 0,
  runsBnb: "0",
  runs: 0,
  claimsBnb: "0",
  claims: 0,
  claimsShielded: 0,
  settlementsBnb: "0",
  settlements: 0,
  donationsBnb: "0",
  donations: 0,
  payoutsBnb: "0",
  payouts: 0,
  directBnb: "0",
  directs: 0,
  deferredBnb: "0",
});

function dayOf(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

function add(row: DayRow, key: keyof DayRow, v: bigint | number) {
  const cur = row[key];
  if (typeof cur === "number") (row as unknown as Record<string, number>)[key] = cur + Number(v);
  else (row as unknown as Record<string, string>)[key] = (BigInt(cur) + BigInt(v)).toString();
}

function stringifyArgs(args: unknown): Record<string, string | boolean | number> {
  const out: Record<string, string | boolean | number> = {};
  for (const [k, v] of Object.entries((args ?? {}) as Record<string, unknown>)) {
    if (typeof v === "bigint") out[k] = v.toString();
    else if (typeof v === "boolean" || typeof v === "number") out[k] = v;
    else if (typeof v === "string") out[k] = v;
    else out[k] = JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
  }
  return out;
}

export function feedCachePath(snapshotDir: string): string {
  return path.join(snapshotDir, "cache", "feed-events.json");
}

export function payoutCachePath(snapshotDir: string): string {
  return path.join(snapshotDir, "cache", "payout-events.json");
}

const payoutEventsAbi = donationRotatorAbi.filter((x): x is Extract<(typeof donationRotatorAbi)[number], { type: "event" }> => x.type === "event" && (PAYOUT_EVENTS as readonly string[]).includes(x.name));

/** Incrementally scan Settled / DirectDonation / PayoutDeferred / PendingWithdrawn from the deployment's start block. */
async function scanPayoutEvents(ctx: Ctx, safe: bigint, bts: BlockTimestamps): Promise<FeedEvent[]> {
  const { dep, cfg } = ctx;
  const file = payoutCachePath(cfg.snapshotDir);
  const cached = readJson<PayoutCache>(file);
  const valid = !!cached && cached.chainId === cfg.chainId && cached.rotator.toLowerCase() === dep.donationRotator.toLowerCase();
  const events: FeedEvent[] = valid ? cached!.events : [];
  const from = valid ? BigInt(cached!.lastBlock) + 1n : BigInt(dep.startBlock);
  if (from <= safe) {
    const topics = [payoutEventsAbi.map((e) => toEventSelector(e as AbiEvent))];
    await getLogsChunked(ctx, { address: dep.donationRotator, fromBlock: from, toBlock: safe, topics }, async (_f, t, raw) => {
      const parsed = parseEventLogs({ abi: payoutEventsAbi, logs: raw as never, strict: false });
      const tsMap = parsed.length ? await bts.getMany(parsed.map((p) => p.blockNumber!)) : new Map<bigint, number>();
      for (const p of parsed) {
        events.push({ name: p.eventName, address: getAddress(p.address), block: Number(p.blockNumber), ts: tsMap.get(p.blockNumber!)!, tx: p.transactionHash!, logIndex: p.logIndex!, args: stringifyArgs(p.args) });
      }
      // persist per chunk so an interrupted first scan resumes where it stopped
      writeJsonAtomic(file, { chainId: cfg.chainId, rotator: dep.donationRotator, lastBlock: Number(t), events } satisfies PayoutCache);
    });
    log.info("payout events scanned", { fromBlock: from, toBlock: safe, total: events.length });
  }
  events.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  return events;
}

/** causeId -> current payee of a public payout (fallbackWallet, or the owner when there is none). */
async function readPayees(ctx: Ctx): Promise<Map<string, string>> {
  const { pub, dep } = ctx;
  const out = new Map<string, string>();
  try {
    const n = await pub.readContract({ address: dep.donationRotator, abi: donationRotatorAbi, functionName: "causeCount" });
    for (let i = 0n; i < n; i++) {
      const c = await pub.readContract({ address: dep.donationRotator, abi: donationRotatorAbi, functionName: "getCause", args: [i] });
      out.set(i.toString(), getAddress(c.fallbackWallet === "0x0000000000000000000000000000000000000000" ? c.owner : c.fallbackWallet));
    }
  } catch (e) {
    log.warn("could not read causes; wallet payouts will have no recipient", { err: e });
  }
  return out;
}

/** Incrementally scan FeeRouter/Roots/HolderRewards/DonationRotator events and aggregate the last N days. */
export async function feed(ctx: Ctx): Promise<RingsFeed> {
  const { pub, dep, cfg } = ctx;
  // chain time, not wall-clock, so the window is right on chains whose clock differs from ours (anvil, time jumps)
  const latestBlock = await pub.getBlock();
  const now = Number(latestBlock.timestamp);
  const windowStart = now - cfg.feedDays * 86400;
  const latest = latestBlock.number;
  const safe = latest - BigInt(cfg.confirmations) > BigInt(dep.startBlock) ? latest - BigInt(cfg.confirmations) : BigInt(dep.startBlock);

  const cacheFile = feedCachePath(cfg.snapshotDir);
  const cached = readJson<FeedCache>(cacheFile);
  let events: FeedEvent[] = cached && cached.chainId === cfg.chainId ? cached.events : [];
  let from: bigint;
  if (cached && cached.chainId === cfg.chainId) {
    from = BigInt(cached.lastBlock) + 1n;
  } else {
    from = await blockAtTimestamp(ctx, windowStart - 86400, BigInt(dep.startBlock), latest);
    log.info("first feed scan", { fromBlock: from, toBlock: safe });
  }

  const bts = new BlockTimestamps(ctx);
  const addresses = [dep.feeRouter, dep.roots, dep.holderRewards, dep.donationRotator];
  if (from <= safe) {
    const raw = await getLogsChunked(ctx, { address: addresses, fromBlock: from, toBlock: safe });
    const parsed = parseEventLogs({ abi: feedEventsAbi, logs: raw as never, strict: false });
    const tsMap = await bts.getMany(parsed.map((p) => p.blockNumber!));
    for (const p of parsed) {
      events.push({
        name: p.eventName,
        address: getAddress(p.address),
        block: Number(p.blockNumber),
        ts: tsMap.get(p.blockNumber!)!,
        tx: p.transactionHash!,
        logIndex: p.logIndex!,
        args: stringifyArgs(p.args),
      });
    }
    log.info("feed scanned", { fromBlock: from, toBlock: safe, newEvents: parsed.length });
  }
  // keep one day of slack so re-bucketing around midnight is stable
  events = events.filter((e) => e.ts >= windowStart - 86400);
  events.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  writeJsonAtomic(cacheFile, { chainId: cfg.chainId, lastBlock: Number(safe), events } satisfies FeedCache);
  bts.prune(from - 1_000_000n > 0n ? from - 1_000_000n : 0n);
  bts.save();

  const payoutEvents = await scanPayoutEvents(ctx, safe, bts);
  bts.save();
  const payees = await readPayees(ctx);
  const out = aggregate(events, { chainId: cfg.chainId, now, windowDays: cfg.feedDays, fromBlock: Number(from), toBlock: Number(safe), addresses: dep }, { payoutEvents, payeeOf: (id) => payees.get(id) });

  // lifetime collected per coin straight from the contract
  for (const c of out.coins) {
    try {
      c.lifetimeCollected = (await pub.readContract({ address: dep.feeRouter, abi: feeRouterAbi, functionName: "collectedOf", args: [c.coin] })).toString();
    } catch {
      /* leave window value */
    }
  }

  const file = path.join(cfg.snapshotDir, "rings.json");
  writeJsonAtomic(file, out);
  log.info("rings.json written", { file, days: out.days.length, events: events.length, payouts: out.payouts.length, feesBnb: formatEther(BigInt(out.totals.feesCollected)) });

  if (cfg.blobToken && !cfg.dryRun) {
    try {
      const { put } = await import("@vercel/blob");
      const res = await put(`snapshots/${cfg.chainId}/rings.json`, JSON.stringify(out), { access: "public", addRandomSuffix: false, contentType: "application/json", token: cfg.blobToken });
      log.info("rings.json uploaded", { url: res.url });
    } catch (e) {
      log.warn("rings.json blob upload failed", { err: e });
    }
  }
  return out;
}

export function aggregate(
  events: FeedEvent[],
  meta: { chainId: number; now: number; windowDays: number; fromBlock: number; toBlock: number; addresses: { feeRouter: Address; roots: Address; holderRewards: Address; donationRotator: Address } },
  opts: {
    /** all-time DonationRotator payout events; when absent the window's events are used */
    payoutEvents?: FeedEvent[];
    /** causeId -> current public payee, for "wallet" deliveries */
    payeeOf?: (causeId: string) => string | undefined;
  } = {},
): RingsFeed {
  const { now, windowDays } = meta;
  const windowStart = now - windowDays * 86400;
  const days = new Map<string, DayRow>();
  for (let i = windowDays - 1; i >= 0; i--) {
    const d = dayOf(now - i * 86400);
    days.set(d, zeroDay(d));
  }
  const dayRow = (ts: number): DayRow | undefined => days.get(dayOf(ts));
  const coins = new Map<Address, RingsFeed["coins"][number]>();
  const coinRow = (coin: Address) => {
    const k = getAddress(coin);
    let r = coins.get(k);
    if (!r) {
      r = { coin: k, collected: "0", toRoots: "0", toRootstock: "0", toTreasury: "0", toDeployer: "0", mode: 0, feeEvents: 0, lifetimeCollected: "0" };
      coins.set(k, r);
    }
    return r;
  };
  const addS = (o: Record<string, unknown>, k: string, v: string) => {
    o[k] = (BigInt(o[k] as string) + BigInt(v)).toString();
  };

  const feed: RingsFeed = {
    version: 1,
    chainId: meta.chainId,
    generatedAt: now,
    windowDays,
    fromBlock: meta.fromBlock,
    toBlock: meta.toBlock,
    days: [],
    totals: zeroDay("") as Omit<DayRow, "date">,
    coins: [],
    buybacks: [],
    harvests: [],
    runs: [],
    claims: [],
    settlements: [],
    payouts: [],
    pendingByAddress: [],
  };
  delete (feed.totals as Partial<DayRow>).date;

  const lc = (a: string) => a.toLowerCase();
  const A = meta.addresses;

  for (const e of events) {
    if (e.ts < windowStart) continue;
    const row = dayRow(e.ts);
    if (!row) continue;
    const a = e.args;
    const from = lc(e.address);
    switch (e.name) {
      case "FeeCollected":
        if (from !== lc(A.feeRouter)) break;
        add(row, "feesCollected", BigInt(a.amount as string));
        addS(coinRow(a.coin as Address), "collected", a.amount as string);
        coinRow(a.coin as Address).feeEvents++;
        break;
      case "FeeSplit": {
        if (from !== lc(A.feeRouter)) break;
        add(row, "toRoots", BigInt(a.toRoots as string));
        add(row, "toRootstock", BigInt(a.toRootstock as string));
        add(row, "toTreasury", BigInt(a.toTreasury as string));
        add(row, "toDeployer", BigInt(a.toDeployer as string));
        const c = coinRow(a.coin as Address);
        addS(c, "toRoots", a.toRoots as string);
        addS(c, "toRootstock", a.toRootstock as string);
        addS(c, "toTreasury", a.toTreasury as string);
        addS(c, "toDeployer", a.toDeployer as string);
        c.mode = Number(a.mode);
        break;
      }
      case "Buyback":
        if (from !== lc(A.feeRouter)) break;
        add(row, "buybackBnb", BigInt(a.bnbIn as string));
        add(row, "groveBurned", BigInt(a.groveBurned as string));
        add(row, "buybacks", 1);
        feed.buybacks.push({ block: e.block, ts: e.ts, tx: e.tx, bnbIn: a.bnbIn as string, groveBurned: a.groveBurned as string });
        break;
      case "Deposited":
        if (from !== lc(A.roots)) break;
        add(row, "rootsDeposited", BigInt(a.amount as string));
        add(row, "rootsOverflow", BigInt(a.overflow as string));
        break;
      case "Harvested":
        if (from !== lc(A.roots)) break;
        add(row, "harvestBnb", BigInt(a.bnb as string));
        add(row, "harvestTokens", BigInt(a.tokensBurned as string));
        add(row, "harvests", 1);
        if (a.shielded) add(row, "harvestsShielded", 1);
        feed.harvests.push({ block: e.block, ts: e.ts, tx: e.tx, coin: a.coin as Address, harvester: a.harvester as Address, tokensBurned: a.tokensBurned as string, bnb: a.bnb as string, shielded: Boolean(a.shielded), leafIndex: String(a.leafIndex) });
        break;
      case "RunPosted":
        if (from !== lc(A.holderRewards)) break;
        add(row, "runsBnb", BigInt(a.amount as string));
        add(row, "runs", 1);
        feed.runs.push({ block: e.block, ts: e.ts, tx: e.tx, coin: a.coin as Address, runId: String(a.runId), root: String(a.root), amount: a.amount as string, holders: String(a.holders), uri: String(a.uri) });
        break;
      case "Claimed":
        if (from !== lc(A.holderRewards)) break;
        add(row, "claimsBnb", BigInt(a.amount as string));
        add(row, "claims", 1);
        if (a.shielded) add(row, "claimsShielded", 1);
        feed.claims.push({ block: e.block, ts: e.ts, tx: e.tx, coin: a.coin as Address, runId: String(a.runId), account: a.account as Address, amount: a.amount as string, shielded: Boolean(a.shielded), leafIndex: String(a.leafIndex) });
        break;
      case "Settled":
        if (from !== lc(A.donationRotator)) break;
        add(row, "settlementsBnb", BigInt(a.amount as string));
        add(row, "settlements", 1);
        feed.settlements.push({ block: e.block, ts: e.ts, tx: e.tx, ringId: String(a.ringId), epoch: String(a.epoch), causeId: String(a.causeId), amount: a.amount as string, shielded: Boolean(a.shielded), leafIndex: String(a.leafIndex) });
        break;
      case "Donated":
      case "DirectDonation":
        if (from !== lc(A.donationRotator)) break;
        add(row, "donationsBnb", BigInt(a.amount as string));
        add(row, "donations", 1);
        break;
      default:
        break;
    }
  }

  // ---- donation payouts (all time) and their daily columns (window)
  const rot = lc(A.donationRotator);
  const payoutSource = (opts.payoutEvents ?? events).filter((e) => lc(e.address) === rot && (PAYOUT_EVENTS as readonly string[]).includes(e.name));
  const derived = derivePayouts(payoutSource, opts.payeeOf);
  for (const p of derived.payouts) {
    if (p.ts < windowStart) continue;
    const row = dayRow(p.ts);
    if (!row) continue;
    add(row, "payoutsBnb", BigInt(p.amount));
    add(row, "payouts", 1);
    if (p.kind === "direct") {
      add(row, "directBnb", BigInt(p.amount));
      add(row, "directs", 1);
    }
    if (p.delivery === "deferred") add(row, "deferredBnb", BigInt(p.amount));
  }
  feed.payouts = sortNewestFirst(derived.payouts).slice(0, PAYOUTS_CAP);
  feed.pendingByAddress = derived.pending;

  feed.days = [...days.values()];
  const totals = feed.totals as unknown as Record<string, string | number>;
  for (const d of feed.days) {
    for (const [k, v] of Object.entries(d)) {
      if (k === "date") continue;
      if (typeof v === "number") totals[k] = (totals[k] as number) + v;
      else totals[k] = (BigInt(totals[k] as string) + BigInt(v)).toString();
    }
  }
  feed.coins = [...coins.values()].sort((x, y) => (BigInt(y.collected) > BigInt(x.collected) ? 1 : -1));
  const recent = <T extends { block: number }>(xs: T[]) => xs.sort((p, q) => q.block - p.block).slice(0, 500);
  feed.buybacks = recent(feed.buybacks);
  feed.harvests = recent(feed.harvests);
  feed.runs = recent(feed.runs);
  feed.claims = recent(feed.claims);
  feed.settlements = recent(feed.settlements);
  return feed;
}
