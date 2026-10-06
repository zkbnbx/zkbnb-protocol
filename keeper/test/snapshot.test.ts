import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEther, getAddress, type Address } from "viem";
import { allocate } from "../src/allocation.js";
import { buildSnapshot, snapshotPath, verifySnapshot, writeSnapshot, type SnapshotJson } from "../src/snapshot.js";
import { leafHash, verifyProof } from "../src/merkle.js";

const COIN = getAddress("0x2000000000000000000000000000000000000002");
const PAIR = getAddress("0x3000000000000000000000000000000000000003");
const holders = Array.from({ length: 11 }, (_, i) => ({
  account: getAddress(`0x${(i + 1).toString(16).padStart(40, "a")}`) as Address,
  balance: parseEther(String((i + 1) * 37)),
}));

function build() {
  const pot = parseEther("0.123456789");
  const shares = allocate(pot, holders);
  return buildSnapshot({ coin: COIN, runId: 4n, shares, snapshotBlock: 12345678n, takenAt: 1_800_000_000, minHoldingWei: parseEther("10"), excluded: [PAIR, COIN, PAIR] });
}

describe("snapshot JSON", () => {
  it("has exactly the published schema, amounts as decimal strings", () => {
    const { json } = build();
    expect(Object.keys(json)).toEqual(["coin", "runId", "root", "amount", "holders", "snapshotBlock", "takenAt", "rule", "leaves"]);
    expect(Object.keys(json.rule)).toEqual(["minHoldingWei", "excluded"]);
    expect(json.coin).toBe(COIN);
    expect(json.runId).toBe(4);
    expect(json.root).toMatch(/^0x[0-9a-f]{64}$/);
    expect(json.amount).toMatch(/^\d+$/);
    expect(json.amount).toBe(parseEther("0.123456789").toString());
    expect(json.holders).toBe(json.leaves.length);
    expect(json.snapshotBlock).toBe(12345678);
    expect(json.takenAt).toBe(1_800_000_000);
    expect(json.rule.minHoldingWei).toBe(parseEther("10").toString());
    expect(json.rule.excluded).toEqual([COIN, PAIR].sort()); // deduped + sorted
    for (const l of json.leaves) {
      expect(Object.keys(l)).toEqual(["account", "amount", "proof"]);
      expect(l.account).toBe(getAddress(l.account));
      expect(l.amount).toMatch(/^\d+$/);
      for (const p of l.proof) expect(p).toMatch(/^0x[0-9a-f]{64}$/);
    }
  });

  it("every leaf proof verifies against the root with the Solidity leaf layout", () => {
    const { json } = build();
    for (const l of json.leaves) {
      const leaf = leafHash(json.coin, BigInt(json.runId), l.account, BigInt(l.amount));
      expect(verifyProof(l.proof, json.root, leaf)).toBe(true);
    }
    expect(verifySnapshot(json)).toBe(true);
  });

  it("verifySnapshot fails when an amount or the root is tampered", () => {
    const { json } = build();
    const t1: SnapshotJson = JSON.parse(JSON.stringify(json));
    t1.leaves[0].amount = (BigInt(t1.leaves[0].amount) + 1n).toString();
    expect(verifySnapshot(t1)).toBe(false);
    const t2: SnapshotJson = JSON.parse(JSON.stringify(json));
    t2.root = ("0x" + "11".repeat(32)) as `0x${string}`;
    expect(verifySnapshot(t2)).toBe(false);
    const t3: SnapshotJson = JSON.parse(JSON.stringify(json));
    t3.holders += 1;
    expect(verifySnapshot(t3)).toBe(false);
  });

  it("writes SNAPSHOT_DIR/<coin>/<runId>.json and survives a JSON round trip", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grove-snap-"));
    try {
      const { json } = build();
      const file = writeSnapshot(dir, json);
      expect(file).toBe(snapshotPath(dir, COIN, 4));
      expect(file.endsWith(path.join(COIN, "4.json"))).toBe(true);
      const back = JSON.parse(fs.readFileSync(file, "utf8")) as SnapshotJson;
      expect(back).toEqual(json);
      expect(verifySnapshot(back)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses an empty allocation", () => {
    expect(() => buildSnapshot({ coin: COIN, runId: 0n, shares: [], snapshotBlock: 1n, takenAt: 1, minHoldingWei: 0n, excluded: [] })).toThrow();
  });
});
