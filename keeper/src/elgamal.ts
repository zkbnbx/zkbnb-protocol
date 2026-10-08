/**
 * Exponential ElGamal on Baby Jubjub for the Epoch Coordinator — privacy/PRIVACY-SPEC.md §2.7.
 *
 *   C1 = k·B8,  C2 = u·B8 + k·ecPk,  Σ(C1_i, C2_i) encrypts Σu_i,  M = C2 − ecSk·C1 = (Σu)·B8  → BSGS (bsgs.ts)
 *
 * SUM-ONLY DECRYPTION. `decrypt` accepts only a `SummedCiphertext`, which is produced by `sumCiphertexts` (from a
 * list of individual ciphertexts) or `onChainSum` (the epoch's running sum read from DarkCurve). There is
 * deliberately no helper that decrypts an individual intent's ciphertext; the Coordinator code path for one does
 * not exist. (Anyone holding ecSk could still do it by hand — that is the trust statement of spec §6.4, bounded by
 * daily key rotation.) The coordinator calls these through the `elgamal` object so tests can spy on `decrypt`.
 */
import {
  BASE8,
  EXT_IDENTITY,
  SUBORDER,
  extAdd,
  extMul,
  extNeg,
  extToAffine,
  fromContractPoint,
  inSubgroup,
  isOnCurve,
  toExt,
  type ContractPoint,
  type Point,
} from "./babyjub.js";

/** Σu < 256 · 2^32 = 2^40. */
export const SUM_BITS = 40;
/** Per-intent u < 2^32 (enforced in the intent circuit). */
export const U_BITS = 32;
/** DarkCurve's per-epoch intent cap. */
export const MAX_INTENTS = 256;

export interface Ciphertext {
  c1: Point;
  c2: Point;
}

declare const SUMMED: unique symbol;

/** A ciphertext known to be the homomorphic sum of an epoch direction's intents. */
export interface SummedCiphertext extends Ciphertext {
  /** number of individual ciphertexts in the sum */
  readonly count: number;
  /** type-level brand only; the runtime proof is membership in `summed` below */
  readonly [SUMMED]: true;
}

/** Objects produced by sumCiphertexts / onChainSum. A copy or a hand-made {c1, c2} is not in it. */
const summed = new WeakSet<object>();

function brand(c1: Point, c2: Point, count: number): SummedCiphertext {
  const s = Object.freeze({ c1, c2, count }) as unknown as SummedCiphertext;
  summed.add(s);
  return s;
}

/** ecPk = ecSk·B8 with ecSk in [1, l). */
export function publicKey(sk: bigint): Point {
  const k = BigInt(sk);
  if (k <= 0n || k >= SUBORDER) throw new Error("ecSk out of range [1, l)");
  return extToAffine(extMul(k, toExt(BASE8)));
}

/** COORDINATOR_SK: a decimal or 0x-hex scalar in [1, l). The value is never echoed in the error. */
export function parseSecretKey(raw: string): bigint {
  const s = raw.trim();
  let v: bigint;
  try {
    if (!/^(0x[0-9a-fA-F]+|[0-9]+)$/.test(s)) throw new Error("format");
    v = BigInt(s);
  } catch {
    throw new Error("COORDINATOR_SK must be a decimal or 0x-hex integer");
  }
  if (v <= 0n || v >= SUBORDER) throw new Error("COORDINATOR_SK out of range [1, l)");
  return v;
}

/**
 * Encrypts u under pk with the given k (the client derives k deterministically, spec §2.7). The keeper uses this
 * only in tests and simulations; it never encrypts a user's amount.
 */
export function encrypt(u: bigint, pk: Point, k: bigint): Ciphertext {
  const uu = BigInt(u);
  const kk = BigInt(k);
  if (uu < 0n || uu >= 1n << BigInt(SUM_BITS)) throw new Error("u out of range");
  if (kk <= 0n || kk >= SUBORDER) throw new Error("k out of range");
  if (!isOnCurve(pk)) throw new Error("pk not on curve");
  const c1 = extToAffine(extMul(kk, toExt(BASE8)));
  const c2 = extToAffine(extAdd(extMul(uu, toExt(BASE8)), extMul(kk, toExt(pk))));
  return { c1, c2 };
}

/** Component-wise point addition: encrypts u_a + u_b. */
export function addCiphertexts(a: Ciphertext, b: Ciphertext): Ciphertext {
  return {
    c1: extToAffine(extAdd(toExt(a.c1), toExt(b.c1))),
    c2: extToAffine(extAdd(toExt(a.c2), toExt(b.c2))),
  };
}

/** Homomorphic sum of a direction's individual ciphertexts (1..MAX_INTENTS of them). */
export function sumCiphertexts(list: readonly Ciphertext[]): SummedCiphertext {
  if (list.length === 0) throw new Error("nothing to sum");
  if (list.length > MAX_INTENTS) throw new Error(`more than ${MAX_INTENTS} ciphertexts`);
  let c1 = EXT_IDENTITY;
  let c2 = EXT_IDENTITY;
  for (const c of list) {
    if (!isOnCurve(c.c1) || !isOnCurve(c.c2)) throw new Error("ciphertext point not on curve");
    c1 = extAdd(c1, toExt(c.c1));
    c2 = extAdd(c2, toExt(c.c2));
  }
  return brand(extToAffine(c1), extToAffine(c2), list.length);
}

/** The epoch's running sum as DarkCurve stores it (extended coordinates) and its intent count. */
export function onChainSum(c1: ContractPoint, c2: ContractPoint, count: number | bigint): SummedCiphertext {
  const n = Number(count);
  if (!Number.isInteger(n) || n < 1 || n > MAX_INTENTS) throw new Error("epoch intent count out of range");
  return brand(fromContractPoint(c1), fromContractPoint(c2), n);
}

export function isSummed(c: unknown): c is SummedCiphertext {
  return typeof c === "object" && c !== null && summed.has(c);
}

/** M = C2 − ecSk·C1 = (Σu)·B8. Only for a SummedCiphertext; solve M with bsgs.solve. */
export function decrypt(sum: SummedCiphertext, sk: bigint): Point {
  if (!isSummed(sum)) throw new Error("decrypt takes a summed ciphertext only (sumCiphertexts / onChainSum)");
  const k = BigInt(sk);
  if (k <= 0n || k >= SUBORDER) throw new Error("ecSk out of range [1, l)");
  if (!isOnCurve(sum.c1) || !isOnCurve(sum.c2)) throw new Error("sum point not on curve");
  return extToAffine(extAdd(toExt(sum.c2), extNeg(extMul(k, toExt(sum.c1)))));
}

/** A coordinator key read from chain / config must be a subgroup point (DarkCurve checks the same). */
export function isValidPublicKey(pk: Point): boolean {
  return inSubgroup(pk) && !(pk[0] === 0n && pk[1] === 1n);
}

/** Spy-able facade: the coordinator calls `elgamal.decrypt`, never the named export, so a test can assert usage. */
export const elgamal = {
  publicKey,
  parseSecretKey,
  addCiphertexts,
  sumCiphertexts,
  onChainSum,
  decrypt,
  isSummed,
};
