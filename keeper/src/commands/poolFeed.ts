/**
 * Pool sync bundle and epochs feed — privacy/PRIVACY-SPEC.md section 5.2 and Appendix C; workplan section 4.1.
 *
 *   <out>/<chainId>/manifest.json   { chainId, grovePool, darkCurve, fromBlock, toBlock, nextIndex, chunkSize: 4096,
 *                                     chunks: [{ file, fromIndex, toIndex, sha256 }], checkpoints, updatedAt }
 *   <out>/<chainId>/chunk-<n>.json  { leaves, nullifiers, intents, epochs, credits, accRpt }
 *   <out>/<chainId>/epochs.json     { chainId, coins: { [coin]: [buy, sell, harvest] }, updatedAt }   (every pass)
 *
 * Chunk n holds the tree leaves [n*4096, (n+1)*4096) and every non-leaf record (nullifier, intent, epoch, credit,
 * accRpt) logged while the tree's nextIndex was inside that range, so a chunk is immutable once the tree has moved
 * past it and an incremental pass only rewrites the last chunk (plus new ones). `toIndex` is exclusive. Leaves that
 * a chunked insert left as ZERO_LEAF (no NewCommitment) are listed with kind "zero". A credit row is either a
 * `Credited` (amount > 0, claimedAmount "0") or a `HandleClaimed` (amount "0", claimedAmount > 0); a client sums
 * both per handle. `sha256` is over the exact bytes of the chunk file. Chunks are written before the manifest
 * (atomically), locally and to Vercel Blob (`snapshots/pool/<chainId>/...`) when BLOB_READ_WRITE_TOKEN is set.
 *
 * Inert while the deployment file has no grovePool / darkCurve.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getAddress, parseEventLogs, type Address, type Hex } from "viem";
import { darkCurveAbi, grovePoolAbi, launchpadAbi } from "../abis.js";
import type { Ctx } from "../chain.js";
import { loadPrivacyConfig, privacyAddresses } from "../config.js";
import { getLogsChunked, type RawLog } from "../logs.js";
import { readJson, writeJsonAtomic } from "../state.js";
import { epochKey, resultLeaf, ZERO_LEAF } from "../grove2.js";
import { readEpochs, readSeqs, type EpochView } from "./coordinator.js";
import { logger } from "../log.js";

const log = logger("pool-feed");

export const CHUNK_SIZE = 4096;
const INSERT = 4; // leaves per tree insert

type S = string; // decimal uint

export interface LeafRow {
  i: number;
  leaf: S;
  enc: Hex | "";
  kind: "note" | "intent" | "result" | "zero";
}
export interface ChunkJson {
  leaves: LeafRow[];
  nullifiers: S[];
  intents: { leaf: S; coin: Hex; dir: 0 | 1 | 2; seq: number }[];
  epochs: { coin: Hex; dir: 0 | 1 | 2; seq: number; status: "opened" | "voided"; totalIn: S; totalOut: S; refund: S; rptAtSettle: S; resultLeaf: S | null }[];
  credits: { handle: S; amount: S; block: number; claimedAmount: S }[];
  accRpt: { coin: Hex; values: S[] }[];
}
export interface ManifestJson {
  chainId: number;
  grovePool: Address;
  darkCurve: Address;
  fromBlock: number;
  toBlock: number;
  nextIndex: number;
  chunkSize: number;
  chunks: { file: string; fromIndex: number; toIndex: number; sha256: string }[];
  checkpoints: { root: S; indexAfter: number; period: number }[];
  updatedAt: number;
}

/** Off-manifest state the incremental scan needs (local only). */
export interface FeedState {
  /** accRpt per coin as of manifest.toBlock (void result leaves are stamped with it) */
  accRpt: Record<string, S>;
}

export const emptyChunk = (): ChunkJson => ({ leaves: [], nullifiers: [], intents: [], epochs: [], credits: [], accRpt: [] });

/** A decoded log as the builder consumes it (grovePool and darkCurve events). */
export interface FeedLog {
  eventName: string;
  args: Record<string, unknown>;
  blockNumber: bigint;
  transactionHash: Hex;
  logIndex: number;
}

export interface BundleWork {
  nextIndex: number;
  chunks: Map<number, ChunkJson>;
  touched: Set<number>;
  checkpoints: ManifestJson["checkpoints"];
  state: FeedState;
  /** result leaves whose recomputation did not match the emitted leaf (should stay 0) */
  mismatches: number;
}

function chunkAt(w: BundleWork, n: number): ChunkJson {
  let c = w.chunks.get(n);
  if (!c) {
    c = emptyChunk();
    w.chunks.set(n, c);
  }
  w.touched.add(n);
  return c;
}

const recordChunk = (w: BundleWork) => chunkAt(w, Math.floor(w.nextIndex / CHUNK_SIZE));

function pushLeaf(w: BundleWork, row: LeafRow) {
  chunkAt(w, Math.floor(row.i / CHUNK_SIZE)).leaves.push(row);
  w.nextIndex = row.i + 1;
}

function padTo(w: BundleWork, index: number) {
  while (w.nextIndex < index) pushLeaf(w, { i: w.nextIndex, leaf: ZERO_LEAF.toString(), enc: "", kind: "zero" });
}

/** Pads the tree to the end of the current 4-leaf insert (inserts are always 4 leaves). */
function padInsert(w: BundleWork) {
  if (w.nextIndex % INSERT !== 0) padTo(w, w.nextIndex + (INSERT - (w.nextIndex % INSERT)));
}

const big = (x: unknown) => BigInt(x as bigint);
const dirOf = (x: unknown) => Number(x) as 0 | 1 | 2;

/** Applies one block range of decoded logs (already sorted by block, logIndex). Pure apart from `w`. */
export function applyLogs(w: BundleWork, logs: readonly FeedLog[]): void {
  // group by transaction (log order is preserved): classification needs the whole transaction
  const groups: FeedLog[][] = [];
  for (const l of logs) {
    const last = groups[groups.length - 1];
    if (last && last[0].transactionHash === l.transactionHash) last.push(l);
    else groups.push([l]);
  }
  for (const g of groups) {
    const intentLeaves = new Set(g.filter((l) => l.eventName === "IntentSubmitted").map((l) => big(l.args.intentLeaf).toString()));
    const settles = g.some((l) => l.eventName === "EpochOpened" || l.eventName === "EpochVoided");
    const resultLeaves: string[] = [];
    // DarkCurve.openEpoch emits EpochOpened before pool.insertChunk emits the result leaves' NewCommitment, so an
    // epoch row's result leaf is checked against the whole transaction, after the loop.
    const settled: { row: ChunkJson["epochs"][number]; leaf: string }[] = [];
    for (const l of g) {
      const a = l.args;
      switch (l.eventName) {
        case "NewCommitment": {
          const i = Number(a.index);
          if (i < w.nextIndex) break; // already in the bundle (overlapping rescan)
          padTo(w, i); // ZERO_LEAF slots of a chunked insert emit nothing
          const leaf = big(a.commitment).toString();
          const enc = (a.encryptedOutput as Hex) ?? "0x";
          const kind: LeafRow["kind"] = intentLeaves.has(leaf) ? "intent" : settles && enc === "0x" ? "result" : "note";
          if (kind === "result") resultLeaves.push(leaf);
          pushLeaf(w, { i, leaf, enc: kind === "result" || enc === "0x" ? "" : enc, kind });
          break;
        }
        case "NewNullifier":
          recordChunk(w).nullifiers.push(big(a.nullifier).toString());
          break;
        case "IntentSubmitted":
          recordChunk(w).intents.push({ leaf: big(a.intentLeaf).toString(), coin: getAddress(a.coin as Address), dir: dirOf(a.dir), seq: Number(a.seq) });
          break;
        case "EpochOpened":
        case "EpochVoided": {
          const coin = getAddress(a.coin as Address);
          const dir = dirOf(a.dir);
          const seq = Number(a.seq);
          const opened = l.eventName === "EpochOpened";
          const rpt = opened ? big(a.rptAtSettle) : BigInt(w.state.accRpt[coin] ?? "0");
          const totals = opened
            ? { totalIn: big(a.totalIn), totalOut: big(a.totalOut), totalRefund: big(a.refund), rptAtSettle: rpt }
            : { totalIn: 1n, totalOut: 0n, totalRefund: 1n, rptAtSettle: rpt };
          const leaf = resultLeaf(epochKey(coin, seq, dir), totals).toString();
          const row: ChunkJson["epochs"][number] = {
            coin,
            dir,
            seq,
            status: opened ? "opened" : "voided",
            totalIn: totals.totalIn.toString(),
            totalOut: totals.totalOut.toString(),
            refund: totals.totalRefund.toString(),
            rptAtSettle: rpt.toString(),
            resultLeaf: leaf,
          };
          recordChunk(w).epochs.push(row);
          settled.push({ row, leaf });
          break;
        }
        case "Credited":
          recordChunk(w).credits.push({ handle: big(a.handle).toString(), amount: big(a.amount).toString(), block: Number(l.blockNumber), claimedAmount: "0" });
          break;
        case "HandleClaimed":
          recordChunk(w).credits.push({ handle: big(a.handle).toString(), amount: "0", block: Number(l.blockNumber), claimedAmount: big(a.claimAmount).toString() });
          break;
        case "RewardsPulled": {
          const coin = getAddress(a.coin as Address);
          const v = big(a.accRpt).toString();
          w.state.accRpt[coin] = v;
          const c = recordChunk(w);
          const row = c.accRpt.find((r) => r.coin === coin);
          if (row) row.values.push(v);
          else c.accRpt.push({ coin, values: [v] });
          break;
        }
        case "Checkpoint":
          w.checkpoints.push({ root: big(a.root).toString(), indexAfter: Number(a.indexAfter), period: Number(a.period) });
          break;
        default:
          break;
      }
    }
    for (const { row, leaf } of settled) {
      if (!resultLeaves.includes(leaf)) {
        w.mismatches++;
        row.resultLeaf = null;
      }
    }
    padInsert(w);
  }
}

export function chunkFile(n: number): string {
  return `chunk-${n}.json`;
}

export function serializeChunk(c: ChunkJson): string {
  return JSON.stringify(c);
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Manifest entries for the given chunk files; toIndex is exclusive. */
export function manifestChunks(chunks: Map<number, { body: string; leaves: number }>, prev: ManifestJson["chunks"]): ManifestJson["chunks"] {
  const byFile = new Map(prev.map((c) => [c.file, c]));
  for (const [n, { body, leaves }] of chunks) {
    byFile.set(chunkFile(n), { file: chunkFile(n), fromIndex: n * CHUNK_SIZE, toIndex: n * CHUNK_SIZE + leaves, sha256: sha256Hex(body) });
  }
  return [...byFile.values()].sort((a, b) => a.fromIndex - b.fromIndex);
}

/** Re-checks a bundle on disk: every listed chunk's sha256 and index range. Used by tests and by the next pass. */
export function verifyBundle(dir: string): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const m = readJson<ManifestJson>(path.join(dir, "manifest.json"));
  if (!m) return { ok: false, errors: ["no manifest"] };
  let expected = 0;
  for (const c of m.chunks) {
    const f = path.join(dir, c.file);
    if (!fs.existsSync(f)) {
      errors.push(`${c.file} missing`);
      continue;
    }
    const body = fs.readFileSync(f, "utf8");
    if (sha256Hex(body) !== c.sha256) errors.push(`${c.file} sha256 mismatch`);
    const j = JSON.parse(body) as ChunkJson;
    if (c.fromIndex !== expected && j.leaves.length > 0) errors.push(`${c.file} starts at ${c.fromIndex}, expected ${expected}`);
    j.leaves.forEach((l, k) => {
      if (l.i !== c.fromIndex + k) errors.push(`${c.file} leaf ${k} has index ${l.i}`);
    });
    if (c.toIndex !== c.fromIndex + j.leaves.length) errors.push(`${c.file} toIndex ${c.toIndex} != ${c.fromIndex + j.leaves.length}`);
    expected = c.toIndex;
  }
  if (expected !== m.nextIndex) errors.push(`chunks end at ${expected}, nextIndex ${m.nextIndex}`);
  return { ok: errors.length === 0, errors };
}

export interface PoolFeedRuntime {
  lastBundleAt: number;
}

export function newPoolFeedRuntime(): PoolFeedRuntime {
  return { lastBundleAt: 0 };
}

export interface PoolFeedOptions {
  /** local output root (default POOL_FEED_DIR = SNAPSHOT_DIR/pool); files go to <out>/<chainId>/ */
  out?: string;
  /** rebuild the bundle on this pass regardless of POOL_FEED_BUNDLE_SEC */
  forceBundle?: boolean;
  /** blocks behind head treated as final (default POOL_FEED_CONFIRMATIONS, 3) */
  confirmations?: number;
}

export interface PoolFeedResult {
  inert?: boolean;
  bundle?: { fromBlock: number; toBlock: number; nextIndex: number; chunksWritten: number; logs: number; mismatches: number };
  epochsCoins?: number;
}

/** Decodes raw grovePool / darkCurve logs. */
export function decodeFeedLogs(raw: readonly RawLog[], grovePool: Address, darkCurve: Address): FeedLog[] {
  const pool = raw.filter((l) => l.address.toLowerCase() === grovePool.toLowerCase());
  const dc = raw.filter((l) => l.address.toLowerCase() === darkCurve.toLowerCase());
  const a = parseEventLogs({ abi: grovePoolAbi, logs: pool as never, strict: false }) as unknown as FeedLog[];
  const b = parseEventLogs({ abi: darkCurveAbi, logs: dc as never, strict: false }) as unknown as FeedLog[];
  return [...a, ...b]
    .map((l) => ({ eventName: l.eventName, args: l.args, blockNumber: BigInt(l.blockNumber), transactionHash: l.transactionHash, logIndex: Number(l.logIndex) }))
    .sort((x, y) => (x.blockNumber === y.blockNumber ? x.logIndex - y.logIndex : x.blockNumber < y.blockNumber ? -1 : 1));
}

async function upload(ctx: Ctx, rel: string, body: string, maxAge?: number): Promise<void> {
  const { put } = await import("@vercel/blob");
  await put(`snapshots/pool/${ctx.cfg.chainId}/${rel}`, body, {
    access: "public",
    addRandomSuffix: false,
    contentType: "application/json",
    token: ctx.cfg.blobToken,
    ...(maxAge ? { cacheControlMaxAge: maxAge } : {}),
  });
}

/** Incremental bundle pass: scans [manifest.toBlock + 1, head - confirmations] and appends. */
export async function buildBundle(ctx: Ctx, dir: string, confirmations: number): Promise<NonNullable<PoolFeedResult["bundle"]>> {
  const pa = privacyAddresses(ctx.dep)!;
  const manifestPath = path.join(dir, "manifest.json");
  const statePath = path.join(dir, "feed-state.json");
  let prev = readJson<ManifestJson>(manifestPath);
  if (prev && (prev.chainId !== ctx.cfg.chainId || prev.grovePool.toLowerCase() !== pa.grovePool.toLowerCase() || prev.chunkSize !== CHUNK_SIZE)) {
    log.warn("manifest belongs to another deployment; rebuilding from scratch", { dir });
    prev = undefined;
  }
  const head = await ctx.pub.getBlockNumber();
  const safe = head - BigInt(confirmations);
  const fromBlock = prev ? BigInt(prev.toBlock) + 1n : BigInt(pa.fromBlock);
  const w: BundleWork = {
    nextIndex: prev?.nextIndex ?? 0,
    chunks: new Map(),
    touched: new Set(),
    checkpoints: [...(prev?.checkpoints ?? [])],
    state: readJson<FeedState>(statePath) ?? { accRpt: {} },
    mismatches: 0,
  };
  if (!prev) w.state = { accRpt: {} };
  // the open chunk (the one nextIndex points into) is the only one that can still change
  const open = Math.floor(w.nextIndex / CHUNK_SIZE);
  const openFile = path.join(dir, chunkFile(open));
  if (prev && fs.existsSync(openFile)) w.chunks.set(open, JSON.parse(fs.readFileSync(openFile, "utf8")) as ChunkJson);

  let logs = 0;
  if (fromBlock <= safe) {
    const raw = await getLogsChunked(ctx, { address: [pa.grovePool, pa.darkCurve], fromBlock, toBlock: safe });
    const decoded = decodeFeedLogs(raw, pa.grovePool, pa.darkCurve);
    logs = decoded.length;
    applyLogs(w, decoded);
  }
  const toBlock = fromBlock <= safe ? Number(safe) : prev ? prev.toBlock : Number(fromBlock) - 1;

  // chunks first, manifest last (atomic), both locally and on Blob
  const written = new Map<number, { body: string; leaves: number }>();
  for (const n of [...w.touched].sort((a, b) => a - b)) {
    const c = w.chunks.get(n)!;
    written.set(n, { body: serializeChunk(c), leaves: c.leaves.length });
  }
  fs.mkdirSync(dir, { recursive: true });
  for (const [n, { body }] of written) {
    const f = path.join(dir, chunkFile(n));
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, f);
  }
  const manifest: ManifestJson = {
    chainId: ctx.cfg.chainId,
    grovePool: pa.grovePool,
    darkCurve: pa.darkCurve,
    fromBlock: prev?.fromBlock ?? pa.fromBlock,
    toBlock,
    nextIndex: w.nextIndex,
    chunkSize: CHUNK_SIZE,
    chunks: manifestChunks(written, prev?.chunks ?? []),
    checkpoints: w.checkpoints,
    updatedAt: Math.floor(Date.now() / 1000),
  };
  writeJsonAtomic(statePath, w.state);
  writeJsonAtomic(manifestPath, manifest);
  if (ctx.cfg.blobToken && !ctx.cfg.dryRun) {
    try {
      for (const [n, { body }] of written) await upload(ctx, chunkFile(n), body);
      await upload(ctx, "manifest.json", JSON.stringify(manifest), 60);
    } catch (e) {
      log.warn("pool bundle blob upload failed (local copy is current; retried next pass)", { err: e });
    }
  }
  if (w.mismatches > 0) log.warn("result leaves that did not match the recomputed leaf", { count: w.mismatches });
  return { fromBlock: Number(fromBlock), toBlock, nextIndex: w.nextIndex, chunksWritten: written.size, logs, mismatches: w.mismatches };
}

export interface EpochsJson {
  chainId: number;
  coins: Record<string, { seq: number; startedAt: number; count: number; openableAt: number; refPrice: S }[]>;
  updatedAt: number;
}

/** openableAt: startedAt + tMin once K intents are in, else startedAt + tMax; 0 when the epoch has no intent. */
export function epochRow(ep: Pick<EpochView, "startedAt" | "count" | "refPrice" | "status">, seq: number, p: { tMin: number; tMax: number; k: number }) {
  const started = ep.status === 1 && ep.count > 0;
  const startedAt = started ? Number(ep.startedAt) : 0;
  return {
    seq,
    startedAt,
    count: started ? ep.count : 0,
    openableAt: started ? startedAt + (ep.count >= p.k ? p.tMin : p.tMax) : 0,
    refPrice: (started ? ep.refPrice : 0n).toString(),
  };
}

/** epochs.json for every coin of the Launchpad (identical to the relayer's GET /relay/epochs). */
export async function buildEpochsJson(ctx: Ctx, darkCurve: Address): Promise<EpochsJson> {
  const coins = (await ctx.pub.readContract({ address: ctx.dep.launchpad, abi: launchpadAbi, functionName: "allCoins" })).map((c) => getAddress(c));
  const out: EpochsJson = { chainId: ctx.cfg.chainId, coins: {}, updatedAt: Math.floor(Date.now() / 1000) };
  if (coins.length === 0) return out;
  const r = (await ctx.pub.readContract({ address: darkCurve, abi: darkCurveAbi, functionName: "params" })) as unknown as readonly unknown[];
  const p = { tMin: Number(r[0]), tMax: Number(r[1]), k: Number(r[2]) };
  const epochs = await readEpochs(ctx, darkCurve, coins);
  const seqs = await Promise.all(coins.map((c) => readSeqs(ctx, darkCurve, c)));
  coins.forEach((c, i) => {
    out.coins[c] = [0, 1, 2].map((d) => epochRow(epochs[i][d], seqs[i][d], p));
  });
  return out;
}

export async function poolFeed(ctx: Ctx, rt: PoolFeedRuntime, opts: PoolFeedOptions = {}, env: NodeJS.ProcessEnv = process.env): Promise<PoolFeedResult> {
  const pa = privacyAddresses(ctx.dep);
  if (!pa) {
    log.debug("no grovePool/darkCurve in the deployment file: pool-feed is inert");
    return { inert: true };
  }
  const pcfg = loadPrivacyConfig(env, ctx.cfg.snapshotDir);
  const dir = path.join(opts.out ? path.resolve(opts.out) : pcfg.poolFeedDir, String(ctx.cfg.chainId));
  const confirmations = opts.confirmations ?? Number(env.POOL_FEED_CONFIRMATIONS ?? 3);
  const res: PoolFeedResult = {};

  const ep = await buildEpochsJson(ctx, pa.darkCurve);
  writeJsonAtomic(path.join(dir, "epochs.json"), ep);
  res.epochsCoins = Object.keys(ep.coins).length;
  if (ctx.cfg.blobToken && !ctx.cfg.dryRun) {
    try {
      await upload(ctx, "epochs.json", JSON.stringify(ep), 60);
    } catch (e) {
      log.warn("epochs.json blob upload failed", { err: e });
    }
  }

  const nowMs = Date.now();
  if (opts.forceBundle || nowMs - rt.lastBundleAt >= pcfg.poolFeedBundleSec * 1000) {
    res.bundle = await buildBundle(ctx, dir, confirmations);
    rt.lastBundleAt = nowMs;
    log.info("pool bundle written", { dir, ...res.bundle });
  }
  return res;
}
