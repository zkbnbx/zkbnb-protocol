/**
 * Baby-step giant-step discrete log on Baby Jubjub for summed epoch ciphertexts — privacy/PRIVACY-SPEC.md §2.7.
 *
 * Solves M = u·B8 for u < 2^maxBits (Σu < 2^40). The baby-step table holds, for every j in [0, 2^bits), the low
 * `truncate` bytes (default 8) of x(j·B8). Truncation makes false matches possible, so every candidate u is
 * re-verified with a full scalar multiplication: collisions cost time, never correctness.
 *
 * Layout (memory and disk): `keys` is a Uint32Array of 2·2^bits words, keys[2j] = low 32 bits of the truncated x,
 * keys[2j+1] = the next 32 bits — indexed by j, so the file is just the keys (2^24 · 8 B = 128 MB for the
 * Coordinator table). At load a bucket index (counting sort of j by the low key bits) is built in memory:
 * `order` (Uint32 per entry, 64 MB for 2^24) and `start` (Uint32 per bucket). Lookup = one bucket, ~16 entries.
 *
 * With m = 2^24 a 2^40 range needs ≤ 2^16 giant steps; one batched field inversion per GIANT_BLOCK steps.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { endianness } from "node:os";
import { BASE8, EXT_IDENTITY, FIELD_SIZE, batchInverse, extAdd, extEq, extMul, extNeg, toExt, type Ext, type Point } from "./babyjub.js";
import { SUM_BITS } from "./elgamal.js";

const P = FIELD_SIZE;
const BABY_BLOCK = 1024;
const GIANT_BLOCK = 256;
const MAGIC = 0x4753_4242; // bytes "BBSG" read as a little-endian uint32
const VERSION = 1;
const HEADER_BYTES = 32;
const SPOT_CHECKS = 16;

export interface BsgsTable {
  bits: number;
  /** bytes of x kept, 1..8 */
  truncate: number;
  /** 2^bits */
  m: number;
  /** keys[2j] = low word, keys[2j+1] = high word of x(j·B8) truncated */
  keys: Uint32Array;
  /** j values grouped by bucket */
  order: Uint32Array;
  /** bucket b holds order[start[b] .. start[b+1]) */
  start: Uint32Array;
  bucketBits: number;
  /** ms spent computing the baby steps (0 when loaded from disk) */
  buildMs: number;
  /** ms spent reading / indexing */
  loadMs: number;
  source: "built" | "file";
}

function keyMasks(truncate: number): { lo: number; hi: number } {
  const loBits = Math.min(32, 8 * truncate);
  const hiBits = Math.max(0, 8 * truncate - 32);
  const lo = loBits === 32 ? 0xffff_ffff : (1 << loBits) - 1;
  const hi = hiBits === 32 ? 0xffff_ffff : hiBits === 0 ? 0 : (1 << hiBits) - 1;
  return { lo, hi };
}

/** The (lo, hi) words of the truncated x of an affine x. */
function splitX(x: bigint, masks: { lo: number; hi: number }): [number, number] {
  const lo = Number(x & 0xffff_ffffn) & masks.lo;
  const hi = Number((x >> 32n) & 0xffff_ffffn) & masks.hi;
  return [lo >>> 0, hi >>> 0];
}

function checkParams(bits: number, truncate: number): void {
  if (!Number.isInteger(bits) || bits < 4 || bits > 26) throw new Error("bsgs: bits must be an integer in [4, 26]");
  if (!Number.isInteger(truncate) || truncate < 1 || truncate > 8) throw new Error("bsgs: truncate must be 1..8 bytes");
}

/** Computes keys for j in [0, 2^bits): consecutive additions of B8, one inversion per BABY_BLOCK points. */
export function computeKeys(bits: number, truncate = 8, onProgress?: (done: number, total: number) => void): Uint32Array {
  checkParams(bits, truncate);
  const m = 2 ** bits;
  const masks = keyMasks(truncate);
  const keys = new Uint32Array(2 * m);
  const base = toExt(BASE8);
  let cur: Ext = EXT_IDENTITY;
  const block: Ext[] = [];
  const zs: bigint[] = [];
  const step = Math.max(BABY_BLOCK, m >>> 4);
  for (let j = 0; j < m; j += BABY_BLOCK) {
    block.length = 0;
    zs.length = 0;
    for (let i = 0; i < BABY_BLOCK && j + i < m; i++) {
      block.push(cur);
      zs.push(cur.Z);
      cur = extAdd(cur, base);
    }
    const zinv = batchInverse(zs);
    for (let i = 0; i < block.length; i++) {
      const [lo, hi] = splitX((block[i].X * zinv[i]) % P, masks);
      keys[2 * (j + i)] = lo;
      keys[2 * (j + i) + 1] = hi;
    }
    if (onProgress && (j + BABY_BLOCK) % step === 0) onProgress(j + BABY_BLOCK, m);
  }
  return keys;
}

/** Bucket index over the low key word (counting sort of j). */
function indexKeys(keys: Uint32Array, bits: number, truncate: number): { order: Uint32Array; start: Uint32Array; bucketBits: number } {
  const m = 2 ** bits;
  const bucketBits = Math.max(1, Math.min(bits - 4, 8 * Math.min(truncate, 4), 24));
  const nb = 2 ** bucketBits;
  const mask = nb - 1;
  const start = new Uint32Array(nb + 1);
  for (let j = 0; j < m; j++) start[(keys[2 * j] & mask) + 1]++;
  for (let b = 0; b < nb; b++) start[b + 1] += start[b];
  const fill = start.slice(0, nb);
  const order = new Uint32Array(m);
  for (let j = 0; j < m; j++) order[fill[keys[2 * j] & mask]++] = j;
  return { order, start, bucketBits };
}

function makeTable(keys: Uint32Array, bits: number, truncate: number, buildMs: number, source: "built" | "file", t0: number): BsgsTable {
  const { order, start, bucketBits } = indexKeys(keys, bits, truncate);
  return { bits, truncate, m: 2 ** bits, keys, order, start, bucketBits, buildMs, loadMs: Date.now() - t0, source };
}

/** Builds a table in memory (2^20 for tests: ~12 MB; 2^24 for the Coordinator: ~196 MB incl. the index). */
export function buildTable(bits = 20, truncate = 8, onProgress?: (done: number, total: number) => void): BsgsTable {
  const t0 = Date.now();
  const keys = computeKeys(bits, truncate, onProgress);
  const buildMs = Date.now() - t0;
  return makeTable(keys, bits, truncate, buildMs, "built", Date.now());
}

/** Candidate j values whose truncated x equals (lo, hi). */
function lookup(t: BsgsTable, lo: number, hi: number, out: number[]): void {
  out.length = 0;
  const b = lo & (2 ** t.bucketBits - 1);
  for (let p = t.start[b]; p < t.start[b + 1]; p++) {
    const j = t.order[p];
    if (t.keys[2 * j] === lo && t.keys[2 * j + 1] === hi) out.push(j);
  }
}

export interface SolveStats {
  giantSteps: number;
  candidates: number;
  falseCandidates: number;
}

/**
 * u in [0, 2^maxBits) with point == u·B8, or null. `stats` (optional) is filled with the work done, so tests can
 * show that truncation collisions were met and rejected.
 */
export function solve(point: Point, table: BsgsTable, maxBits = SUM_BITS, stats?: SolveStats): bigint | null {
  if (!Number.isInteger(maxBits) || maxBits < 1 || maxBits > 64) throw new Error("bsgs: maxBits out of range");
  const target = toExt(point);
  const s: SolveStats = stats ?? { giantSteps: 0, candidates: 0, falseCandidates: 0 };
  s.giantSteps = 0;
  s.candidates = 0;
  s.falseCandidates = 0;
  const bound = 1n << BigInt(maxBits);
  const m = BigInt(table.m);
  const giants = Number((bound + m - 1n) / m);
  const masks = keyMasks(table.truncate);
  const base8 = toExt(BASE8);
  const negG = extNeg(extMul(m, base8));
  const found: number[] = [];
  let cur = target;
  for (let i0 = 0; i0 < giants; i0 += GIANT_BLOCK) {
    const pts: Ext[] = [];
    const zs: bigint[] = [];
    for (let i = 0; i < GIANT_BLOCK && i0 + i < giants; i++) {
      pts.push(cur);
      zs.push(cur.Z);
      cur = extAdd(cur, negG);
    }
    const zinv = batchInverse(zs);
    for (let i = 0; i < pts.length; i++) {
      s.giantSteps++;
      const [lo, hi] = splitX((pts[i].X * zinv[i]) % P, masks);
      lookup(table, lo, hi, found);
      for (const j of found) {
        const u = BigInt(i0 + i) * m + BigInt(j);
        s.candidates++;
        if (u < bound && extEq(extMul(u, base8), target)) return u;
        s.falseCandidates++;
      }
    }
  }
  return null;
}

// ----------------------------------------------------------------------------- persistence

/** Header: magic, version, bits, truncate, truncated x(B8) (lo, hi), reserved ×2. Little-endian uint32 words. */
function header(bits: number, truncate: number, keys: Uint32Array): Uint32Array {
  return Uint32Array.from([MAGIC, VERSION, bits, truncate, keys[2], keys[3], 0, 0]);
}

/** Writes the keys atomically (tmp file + rename). */
export function saveTable(path: string, table: BsgsTable): void {
  if (endianness() !== "LE") throw new Error("bsgs: table files are little-endian only");
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    const h = header(table.bits, table.truncate, table.keys);
    writeSync(fd, new Uint8Array(h.buffer, h.byteOffset, h.byteLength));
    const k = table.keys;
    const CH = 1 << 24; // 16 MB slices
    const bytes = new Uint8Array(k.buffer, k.byteOffset, k.byteLength);
    for (let o = 0; o < bytes.length; o += CH) writeSync(fd, bytes.subarray(o, Math.min(bytes.length, o + CH)));
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/** Recomputes x(j·B8) for a few j and compares with the stored keys (catches a corrupt or foreign file). */
function spotCheck(keys: Uint32Array, bits: number, truncate: number): boolean {
  const m = 2 ** bits;
  const masks = keyMasks(truncate);
  const base8 = toExt(BASE8);
  const js = [0, 1, m - 1];
  for (let i = 0; i < SPOT_CHECKS; i++) js.push(Math.floor(Math.random() * m));
  for (const j of js) {
    const e = extMul(BigInt(j), base8);
    const zinv = batchInverse([e.Z])[0];
    const [lo, hi] = splitX((e.X * zinv) % P, masks);
    if (keys[2 * j] !== lo || keys[2 * j + 1] !== hi) return false;
  }
  return true;
}

/** Loads a table file; throws if the header, size or spot check does not match. */
export function loadTable(path: string, bits: number, truncate = 8): BsgsTable {
  checkParams(bits, truncate);
  if (endianness() !== "LE") throw new Error("bsgs: table files are little-endian only");
  const t0 = Date.now();
  const buf = readFileSync(path);
  const m = 2 ** bits;
  if (buf.byteLength !== HEADER_BYTES + 8 * m) throw new Error(`bsgs: ${path} has the wrong size for 2^${bits}`);
  // a large readFileSync result is an unpooled buffer at offset 0; copy if it is ever unaligned
  const aligned = buf.byteOffset % 4 === 0 ? buf : Buffer.from(buf);
  const words = new Uint32Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 4);
  const h = words.subarray(0, HEADER_BYTES / 4);
  if (h[0] !== MAGIC || h[1] !== VERSION || h[2] !== bits || h[3] !== truncate) throw new Error(`bsgs: ${path} header mismatch`);
  const keys = words.subarray(HEADER_BYTES / 4);
  if (h[4] !== keys[2] || h[5] !== keys[3] || !spotCheck(keys, bits, truncate)) throw new Error(`bsgs: ${path} failed the spot check`);
  return makeTable(keys, bits, truncate, 0, "file", t0);
}

/**
 * The Coordinator's entry point: load `path` if it holds a valid table, otherwise build it (2^24: minutes, once)
 * and persist it. A corrupt file is rebuilt, never trusted.
 */
export function loadOrBuildTable(
  path: string,
  bits = 24,
  opts: { truncate?: number; log?: (msg: string, meta?: Record<string, unknown>) => void } = {},
): BsgsTable {
  const truncate = opts.truncate ?? 8;
  const log = opts.log ?? (() => {});
  if (existsSync(path)) {
    try {
      const t = loadTable(path, bits, truncate);
      log("bsgs table loaded", { path, bits, loadMs: t.loadMs });
      return t;
    } catch (e) {
      log("bsgs table unusable, rebuilding", { path, error: (e as Error).message });
      try {
        unlinkSync(path);
      } catch {
        /* already gone */
      }
    }
  }
  log("bsgs table build start", { bits, truncate });
  const t = buildTable(bits, truncate, (done, total) => log("bsgs build progress", { done, total }));
  saveTable(path, t);
  log("bsgs table built and saved", { path, bits, buildMs: t.buildMs });
  return t;
}

/** Bytes the table occupies in memory (keys + index). */
export function tableBytes(t: BsgsTable): number {
  return t.keys.byteLength + t.order.byteLength + t.start.byteLength;
}

/** Default location of the Coordinator table, relative to the keeper's working directory. */
export const BSGS24_PATH = "snapshots/bsgs-24.bin";
