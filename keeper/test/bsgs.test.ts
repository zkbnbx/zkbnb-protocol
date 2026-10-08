import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { BASE8, mul, type Point } from "../src/babyjub.js";
import { elgamal } from "../src/elgamal.js";
import { buildTable, solve, saveTable, loadTable, loadOrBuildTable, tableBytes, type BsgsTable, type SolveStats } from "../src/bsgs.js";

const here = dirname(fileURLToPath(import.meta.url));
const ev = JSON.parse(readFileSync(join(here, "..", "..", "contracts", "test", "fixtures", "v2", "elgamal_vectors.json"), "utf8"));
const pt = (a: string[]): Point => [BigInt(a[0]), BigInt(a[1])];

/** uniform in [0, 2^bits) */
function randU(bits: number): bigint {
  const b = randomBytes(8);
  return b.readBigUInt64BE() & ((1n << BigInt(bits)) - 1n);
}

const mb = (n: number) => Math.round(n / 1048576);

describe("bsgs, 2^20 table (test variant)", () => {
  let t20: BsgsTable;
  beforeAll(() => {
    const before = process.memoryUsage();
    t20 = buildTable(20);
    const after = process.memoryUsage();
    console.log(
      `bsgs 2^20 build: ${t20.buildMs} ms + index ${t20.loadMs} ms, table ${mb(tableBytes(t20))} MB, rss +${mb(after.rss - before.rss)} MB`,
    );
  }, 120_000);

  it("u < 2^32 is recovered in < 300 ms each (random samples and edges)", () => {
    const samples = [0n, 1n, (1n << 20n) - 1n, 1n << 20n, (1n << 32n) - 1n, 4_000_000_000n];
    for (let i = 0; i < 8; i++) samples.push(randU(32));
    let worst = 0;
    for (const u of samples) {
      const p = mul(u, BASE8);
      const t0 = performance.now();
      const got = solve(p, t20, 32);
      const ms = performance.now() - t0;
      worst = Math.max(worst, ms);
      expect(got).toBe(u);
      expect(ms).toBeLessThan(300);
    }
    console.log(`bsgs 2^20 / u < 2^32: ${samples.length} solves, worst ${worst.toFixed(1)} ms`);
  });

  it("returns null when u is outside the searched range", () => {
    expect(solve(mul((1n << 32n) + 12345n, BASE8), t20, 32)).toBeNull();
  });

  it("solves the fixture sums after sum-only decryption (sum_first3, sum_all)", () => {
    const sk = BigInt(ev.coordinator.ecSk);
    const encs = ev.encryptions.map((e: { c1: string[]; c2: string[] }) => ({ c1: pt(e.c1), c2: pt(e.c2) }));
    expect(solve(elgamal.decrypt(elgamal.sumCiphertexts(encs.slice(0, 3)), sk), t20, 32)?.toString()).toBe(ev.sum_first3.u);
    // Σu of all ten is 8,296,158,793 > 2^32: search 2^34
    expect(solve(elgamal.decrypt(elgamal.sumCiphertexts(encs), sk), t20, 34)?.toString()).toBe(ev.sum_all.u);
  });
});

describe("bsgs truncation collisions and persistence (small tables)", () => {
  it("1-byte truncation: false candidates occur and are rejected by re-verification", () => {
    const t = buildTable(12, 1); // 4096 entries, 256 possible keys ⇒ ~16 j per key
    const total: SolveStats = { giantSteps: 0, candidates: 0, falseCandidates: 0 };
    for (let i = 0; i < 6; i++) {
      const u = randU(20);
      const st: SolveStats = { giantSteps: 0, candidates: 0, falseCandidates: 0 };
      expect(solve(mul(u, BASE8), t, 20, st)).toBe(u);
      total.candidates += st.candidates;
      total.falseCandidates += st.falseCandidates;
    }
    expect(total.falseCandidates).toBeGreaterThan(0);
    // and a point outside the range is never "found" through a colliding key
    expect(solve(mul((1n << 20n) + 7n, BASE8), t, 20)).toBeNull();
  });

  it("save → load round trip; a corrupt file is rejected and rebuilt", () => {
    const dir = mkdtempSync(join(tmpdir(), "bsgs-"));
    try {
      const path = join(dir, "bsgs-12.bin");
      const t = buildTable(12);
      saveTable(path, t);
      expect(statSync(path).size).toBe(32 + 8 * 4096);
      expect(existsSync(`${path}.tmp`)).toBe(false);
      const l = loadTable(path, 12);
      expect(l.source).toBe("file");
      expect(Array.from(l.keys)).toEqual(Array.from(t.keys));
      const u = randU(24);
      expect(solve(mul(u, BASE8), l, 24)).toBe(u);
      // wrong parameters
      expect(() => loadTable(path, 13)).toThrow(/size/);
      expect(() => loadTable(path, 12, 4)).toThrow(/header/);
      // flip the stored key of j = 1 (always spot-checked)
      const buf = readFileSync(path);
      buf[32 + 8] ^= 0xff;
      writeFileSync(path, buf);
      expect(() => loadTable(path, 12)).toThrow(/spot check/);
      const logs: string[] = [];
      const r = loadOrBuildTable(path, 12, { log: (m) => logs.push(m) });
      expect(r.source).toBe("built");
      expect(logs).toContain("bsgs table unusable, rebuilding");
      expect(loadTable(path, 12).source).toBe("file");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * The Coordinator configuration: the 2^24 table of 8-byte truncated x persisted to snapshots/bsgs-24.bin
 * (128 MB file, ~196 MB in memory with the index; minutes to build once). Heavy, so gated: BSGS_FULL=1.
 * Workplan §1.4 / §4.3: Σu < 2^40 (sampled, incl. 2^40 − 1) recovered in < 5 s each; build time and memory logged.
 */
describe.runIf(process.env.BSGS_FULL === "1")("bsgs, 2^24 table, Σu < 2^40 (BSGS_FULL=1)", () => {
  let t24: BsgsTable;
  beforeAll(() => {
    const path = join(here, "..", "snapshots", "bsgs-24.bin");
    const before = process.memoryUsage();
    const t0 = Date.now();
    t24 = loadOrBuildTable(path, 24, { log: (m, meta) => console.log(`${m} ${meta ? JSON.stringify(meta) : ""}`) });
    const after = process.memoryUsage();
    console.log(
      `bsgs 2^24 ${t24.source}: ${Date.now() - t0} ms total (baby steps ${t24.buildMs} ms, index ${t24.loadMs} ms); ` +
        `table ${mb(tableBytes(t24))} MB; rss ${mb(after.rss)} MB (+${mb(after.rss - before.rss)}), ` +
        `arrayBuffers ${mb(after.arrayBuffers)} MB, heapUsed ${mb(after.heapUsed)} MB; file ${mb(statSync(path).size)} MB`,
    );
  }, 1_800_000);

  it("Σu < 2^40 recovered in < 5 s each, incl. 2^40 − 1", () => {
    const samples = [(1n << 40n) - 1n, 0n, 1n << 39n, (1n << 24n) - 1n];
    for (let i = 0; i < 6; i++) samples.push(randU(40));
    let worst = 0;
    for (const u of samples) {
      const t0 = performance.now();
      const got = solve(mul(u, BASE8), t24, 40);
      const ms = performance.now() - t0;
      worst = Math.max(worst, ms);
      expect(got).toBe(u);
      expect(ms).toBeLessThan(5000);
    }
    console.log(`bsgs 2^24 / Σu < 2^40: ${samples.length} solves, worst ${worst.toFixed(0)} ms`);
  }, 120_000);
});
