import path from "node:path";
import { getAddress, type Address, type Hex } from "viem";
import { buildTree, getProof, leafHash, verifyProof } from "./merkle.js";
import type { Share } from "./allocation.js";
import { writeJsonAtomic } from "./state.js";
import { logger } from "./log.js";

const log = logger("snapshot");

/**
 * The published snapshot. This is the schema the web's Rings page and any auditor reads;
 * amounts are decimal strings, addresses checksummed, proofs are bytes32 hex arrays.
 */
export interface SnapshotJson {
  coin: Address;
  runId: number;
  root: Hex;
  amount: string;
  holders: number;
  snapshotBlock: number;
  takenAt: number;
  rule: {
    minHoldingWei: string;
    excluded: Address[];
  };
  leaves: { account: Address; amount: string; proof: Hex[] }[];
}

export interface BuiltSnapshot {
  json: SnapshotJson;
  root: Hex;
  amount: bigint;
}

export function buildSnapshot(args: {
  coin: Address;
  runId: bigint;
  shares: readonly Share[];
  snapshotBlock: bigint;
  takenAt: number;
  minHoldingWei: bigint;
  excluded: readonly Address[];
}): BuiltSnapshot {
  const coin = getAddress(args.coin);
  if (args.shares.length === 0) throw new Error("snapshot: no shares");
  const leaves = args.shares.map((s) => leafHash(coin, args.runId, getAddress(s.account), s.amount));
  const tree = buildTree(leaves);
  const amount = args.shares.reduce((a, s) => a + s.amount, 0n);

  const out: SnapshotJson["leaves"] = args.shares.map((s, i) => {
    const proof = getProof(tree, i);
    if (!verifyProof(proof, tree.root, leaves[i])) {
      throw new Error(`snapshot: proof for ${s.account} does not verify against root`);
    }
    return { account: getAddress(s.account), amount: s.amount.toString(), proof };
  });

  const json: SnapshotJson = {
    coin,
    runId: Number(args.runId),
    root: tree.root,
    amount: amount.toString(),
    holders: out.length,
    snapshotBlock: Number(args.snapshotBlock),
    takenAt: args.takenAt,
    rule: {
      minHoldingWei: args.minHoldingWei.toString(),
      excluded: [...new Set(args.excluded.map((a) => getAddress(a)))].sort(),
    },
    leaves: out,
  };
  return { json, root: tree.root, amount };
}

/** Re-verify every leaf of a snapshot file against its root (used before posting and by tests). */
export function verifySnapshot(s: SnapshotJson): boolean {
  if (s.leaves.length !== s.holders) return false;
  let sum = 0n;
  for (const l of s.leaves) {
    const leaf = leafHash(s.coin, BigInt(s.runId), l.account, BigInt(l.amount));
    if (!verifyProof(l.proof, s.root, leaf)) return false;
    sum += BigInt(l.amount);
  }
  return sum === BigInt(s.amount);
}

export function snapshotPath(snapshotDir: string, coin: Address, runId: bigint | number): string {
  return path.join(snapshotDir, getAddress(coin), `${runId}.json`);
}

export function writeSnapshot(snapshotDir: string, s: SnapshotJson): string {
  const file = snapshotPath(snapshotDir, s.coin, s.runId);
  writeJsonAtomic(file, s);
  return file;
}

/** Public URI for the snapshot: Vercel Blob if a token is set, else SNAPSHOT_BASE_URL/<coin>/<runId>.json */
export async function publishSnapshot(opts: { snapshotBaseUrl: string; blobToken?: string }, s: SnapshotJson): Promise<string> {
  const rel = `${s.coin}/${s.runId}.json`;
  if (opts.blobToken) {
    try {
      const { put } = await import("@vercel/blob");
      const res = await put(`snapshots/${rel}`, JSON.stringify(s), {
        access: "public",
        addRandomSuffix: false,
        contentType: "application/json",
        token: opts.blobToken,
      });
      log.info("snapshot uploaded to Vercel Blob", { url: res.url });
      return res.url;
    } catch (e) {
      if (!opts.snapshotBaseUrl) throw e;
      log.warn("blob upload failed, falling back to SNAPSHOT_BASE_URL", { err: e });
    }
  }
  if (!opts.snapshotBaseUrl) {
    throw new Error("no public URI for the snapshot: set SNAPSHOT_BASE_URL or BLOB_READ_WRITE_TOKEN");
  }
  return `${opts.snapshotBaseUrl}/${rel}`;
}
