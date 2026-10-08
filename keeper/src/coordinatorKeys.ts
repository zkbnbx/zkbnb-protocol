/**
 * Epoch Coordinator key material (spec section 2.7 "Key rotation and destruction", section 5.2).
 *
 * Keys live in COORDINATOR_KEY_DIR as one JSON file per key (`key-<pkX prefix>.json`, mode 0600), written by
 * `rotate-key` and read by `coordinator` on every pass, plus optionally COORDINATOR_SK (decimal or hex) from the
 * environment for a single-key setup. Secrets are never logged and never leave this module except as the bigint
 * the coordinator hands to elgamal.decrypt / proveOpen. Destruction overwrites the file with random bytes, syncs
 * it and unlinks it.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { SUBORDER, type Point } from "./babyjub.js";
import { elgamal, isValidPublicKey } from "./elgamal.js";

export interface KeyFile {
  version: 1;
  /** decimal secret scalar in [1, l) */
  sk: string;
  pk: [string, string];
  createdAt: number;
}

export interface CoordinatorKey {
  sk: bigint;
  pk: Point;
  /** file the key came from; undefined for COORDINATOR_SK */
  file?: string;
}

export const pkId = (pk: readonly [bigint | string, bigint | string]) => `${BigInt(pk[0])},${BigInt(pk[1])}`;

/** Short public label for logs: the first 10 hex digits of pk.x. Public data only. */
export const pkLabel = (pk: readonly [bigint | string, bigint | string]) => `0x${BigInt(pk[0]).toString(16).padStart(64, "0").slice(0, 10)}…`;

/** Uniform-enough scalar in [1, l): 512 random bits reduced mod l (bias < 2^-250). */
export function randomScalar(rand: (n: number) => Buffer = randomBytes): bigint {
  for (;;) {
    const k = BigInt("0x" + rand(64).toString("hex")) % SUBORDER;
    if (k !== 0n) return k;
  }
}

export function keyFileName(pk: Point): string {
  return `key-${pk[0].toString(16).padStart(64, "0").slice(0, 16)}.json`;
}

/** Writes a new key file atomically with mode 0600; returns its path. */
export function writeKeyFile(dir: string, sk: bigint, now = Math.floor(Date.now() / 1000)): { file: string; pk: Point } {
  const pk = elgamal.publicKey(sk);
  if (!isValidPublicKey(pk) || pk[0] === 0n) throw new Error("generated key is not a valid subgroup point");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, keyFileName(pk));
  if (existsSync(file)) throw new Error(`key file exists: ${file}`);
  const body: KeyFile = { version: 1, sk: sk.toString(), pk: [pk[0].toString(), pk[1].toString()], createdAt: now };
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(body));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
  return { file, pk };
}

function readKeyFile(file: string): CoordinatorKey {
  const j = JSON.parse(readFileSync(file, "utf8")) as KeyFile;
  const sk = elgamal.parseSecretKey(String(j.sk));
  const pk = elgamal.publicKey(sk);
  if (pkId(pk) !== pkId([j.pk[0], j.pk[1]])) throw new Error(`key file ${path.basename(file)}: pk does not match sk`);
  return { sk, pk, file };
}

/**
 * Every usable key: COORDINATOR_SK (if set) and the key files of `dir`. A file that fails to parse is reported by
 * name (never its content) and skipped.
 */
export function loadCoordinatorKeys(
  dir: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  onSkip: (file: string, reason: string) => void = () => {},
): Map<string, CoordinatorKey> {
  const out = new Map<string, CoordinatorKey>();
  const raw = env.COORDINATOR_SK;
  if (raw && raw.trim()) {
    const sk = elgamal.parseSecretKey(raw);
    const pk = elgamal.publicKey(sk);
    out.set(pkId(pk), { sk, pk });
  }
  if (dir && existsSync(dir)) {
    for (const name of readdirSync(dir).sort()) {
      if (!/^key-[0-9a-f]+\.json$/.test(name)) continue;
      const file = path.join(dir, name);
      try {
        const k = readKeyFile(file);
        if (!out.has(pkId(k.pk))) out.set(pkId(k.pk), k);
      } catch (e) {
        onSkip(name, (e as Error).message.replace(/\d{20,}/g, "<redacted>"));
      }
    }
  }
  return out;
}

/** Overwrites the key file with random bytes of the same length, syncs, then unlinks it. */
export function destroyKeyFile(file: string): void {
  if (!existsSync(file)) return;
  const size = Math.max(statSync(file).size, 256);
  const fd = openSync(file, "r+");
  try {
    writeSync(fd, randomBytes(size), 0, size, 0);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  unlinkSync(file);
}
