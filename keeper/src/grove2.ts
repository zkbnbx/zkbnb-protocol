/**
 * Stage-2 ("Dark Curve") hashing helpers for the keeper: Appendix A constants, Poseidon, key derivation and the
 * leaf kinds of privacy/PRIVACY-SPEC.md §2.1–2.2 / §2.7. Mirrors circuits/lib/grove-zk-v2.mjs and is checked
 * against contracts/test/fixtures/v2/{keys,poseidon_vectors}.json (copied to keeper/test/fixtures/), so a
 * derivation mismatch fails the circuits, web and keeper suites alike.
 *
 * Poseidon is poseidon-lite (circomlib parameters, the same function as circomlibjs `buildPoseidon` and the
 * on-chain PoseidonT3/T4 hashers).
 */
import { poseidon1, poseidon2, poseidon3, poseidon4, poseidon5, poseidon6 } from "poseidon-lite";
import { x25519 } from "@noble/curves/ed25519";
import { concat, getAddress, hexToBytes, keccak256, numberToHex, stringToBytes, toHex, type Address, type Hex } from "viem";
import { FIELD_SIZE, SUBORDER } from "./babyjub.js";

export { FIELD_SIZE };

// Appendix A (byte-identical with GroveConstants.sol and grove-zk-v2.mjs)
export const ZERO_LEAF = 1014863620666096670253896730964143634766893057150169129055179254946258934505n; // keccak256("grove-v2") mod p
export const INTENT_TAG = 5485727973690184042573032548250662701561163999721995087532894922013676652701n;
export const HANDLE_TAG = 4197082601223926234440412842350092754680596943151188710592157759256107473565n;
export const OWNER_TAG = 4084283354661981865798945521922129247864409744154712678450526337611273152227n;
export const RESULT_TAG = 19481998103912434576622020492478150961191355642108690953568066567392742677477n;
export const LEVELS = 23;
export const CHUNK = 4;
export const CHECKPOINT_PERIOD = 600;
export const DIR = Object.freeze({ BUY: 0, SELL: 1, HARVEST: 2 });
export const ADDRESS_PREFIX = "zkbnb2";
export const FVK_PREFIX = "zkbnb2view";

const POSEIDON = [poseidon1, poseidon2, poseidon3, poseidon4, poseidon5, poseidon6];

export function toField(x: bigint | number | string): bigint {
  const v = typeof x === "bigint" ? x : BigInt(x);
  const r = v % FIELD_SIZE;
  return r < 0n ? r + FIELD_SIZE : r;
}

/** Poseidon over 1..6 field elements. */
export function poseidon(inputs: readonly (bigint | number | string)[]): bigint {
  const f = POSEIDON[inputs.length - 1];
  if (!f) throw new Error("poseidon: 1..6 inputs");
  return f(inputs.map(toField));
}

function bytes32(x: bigint): Uint8Array {
  return hexToBytes(numberToHex(toField(x), { size: 32 }));
}

function hex32(x: bigint): string {
  return numberToHex(toField(x), { size: 32 }).slice(2);
}

export interface V2Keys {
  ask: bigint;
  pk: bigint;
  nk: bigint;
  ovk: bigint;
  encPriv: Hex;
  encPub: Hex;
}

/** ask = keccak256(seed ‖ "zkbnb2/ask") mod p, encPriv = keccak256(seed ‖ "zkbnb2/enc"); pk, nk, ovk by Poseidon. */
export function keysFromSeed(seed: Hex): V2Keys {
  const sd = hexToBytes(seed);
  if (sd.length !== 32) throw new Error("seed must be 32 bytes");
  const ask = BigInt(keccak256(concat([sd, stringToBytes("zkbnb2/ask")]))) % FIELD_SIZE;
  const encPriv = keccak256(concat([sd, stringToBytes("zkbnb2/enc")]));
  const encPub = toHex(x25519.getPublicKey(hexToBytes(encPriv)));
  return { ask, pk: poseidon([ask]), nk: poseidon([ask, 1n]), ovk: poseidon([OWNER_TAG, ask]), encPriv, encPub };
}

/** "zkbnb2" + hex32(pk) + hex32(encPub) */
export function shieldedAddress(k: Pick<V2Keys, "pk" | "encPub">): string {
  return ADDRESS_PREFIX + hex32(k.pk) + k.encPub.slice(2).toLowerCase();
}

/** "zkbnb2view" + hex32(pk) + hex32(nk) + hex32(encPriv) */
export function fullViewingKey(k: Pick<V2Keys, "pk" | "nk" | "encPriv">): string {
  return FVK_PREFIX + hex32(k.pk) + hex32(k.nk) + k.encPriv.slice(2).toLowerCase();
}

/** salt(n) = Poseidon(ovk, n), n ≥ 1 */
export function salt(ovk: bigint, n: number | bigint): bigint {
  const i = BigInt(n);
  if (i < 1n) throw new Error("handle index starts at 1");
  return poseidon([ovk, i]);
}

/** handle = Poseidon(HANDLE_TAG, ovk, salt) */
export function handleOf(ovk: bigint, s: bigint): bigint {
  return poseidon([HANDLE_TAG, ovk, s]);
}

/** k = keccak256("zkbnb2/elgamal" ‖ ask ‖ nullifier0) mod l (client rule, spec §2.7). */
export function elgamalK(ask: bigint, nullifier0: bigint): bigint {
  return BigInt(keccak256(concat([stringToBytes("zkbnb2/elgamal"), bytes32(ask), bytes32(nullifier0)]))) % SUBORDER;
}

/** uint160(coin) as asset id; 0 for BNB. */
export function assetOf(coin: Address | bigint | number | null | undefined): bigint {
  if (coin === null || coin === undefined || coin === 0 || coin === 0n) return 0n;
  if (typeof coin === "string") return BigInt(getAddress(coin));
  return BigInt(coin);
}

/** inner = Poseidon(assetId, rpt0, blinding); commitment = Poseidon(amount, pk, inner) */
export function noteCommitment(n: { assetId: bigint; amount: bigint; pk: bigint; rpt0: bigint; blinding: bigint }): { inner: bigint; commitment: bigint } {
  const inner = poseidon([n.assetId, n.rpt0, n.blinding]);
  return { inner, commitment: poseidon([n.amount, n.pk, inner]) };
}

/** nf = Poseidon(commitment, leafIndex, nk) */
export function nullifier(commitment: bigint, leafIndex: number | bigint, nk: bigint): bigint {
  return poseidon([commitment, BigInt(leafIndex), nk]);
}

/** Poseidon(INTENT_TAG, coin, dir) */
export function intentAsset(coin: Address | bigint, dir: number): bigint {
  return poseidon([INTENT_TAG, assetOf(coin), BigInt(dir)]);
}

/** Poseidon(coin, seq, dir) */
export function epochKey(coin: Address | bigint, seq: number | bigint, dir: number): bigint {
  return poseidon([assetOf(coin), BigInt(seq), BigInt(dir)]);
}

/** Poseidon(commitment, epochKey) */
export function intentLeaf(commitment: bigint, epochKeyValue: bigint): bigint {
  return poseidon([commitment, epochKeyValue]);
}

export interface Totals {
  totalIn: bigint;
  totalOut: bigint;
  totalRefund: bigint;
  rptAtSettle: bigint;
}

/** Poseidon(totalIn, totalOut, Poseidon(totalRefund, rptAtSettle)) */
export function totalsHash(t: Totals): bigint {
  return poseidon([t.totalIn, t.totalOut, poseidon([t.totalRefund, t.rptAtSettle])]);
}

/** Poseidon(RESULT_TAG, epochKey, totalsHash) */
export function resultLeaf(epochKeyValue: bigint, t: Totals): bigint {
  return poseidon([RESULT_TAG, epochKeyValue, totalsHash(t)]);
}

/** A voided epoch's totals: (1, 0, 1, rpt) ⇒ every claim refunds in full. */
export function voidTotals(rptAtSettle: bigint): Totals {
  return { totalIn: 1n, totalOut: 0n, totalRefund: 1n, rptAtSettle };
}

/** zeros[0] = ZERO_LEAF, zeros[i] = Poseidon(zeros[i−1], zeros[i−1]); zeros[levels] = the empty root. */
export function zeros(levels = LEVELS): bigint[] {
  const z = [ZERO_LEAF];
  for (let i = 1; i <= levels; i++) z.push(poseidon([z[i - 1], z[i - 1]]));
  return z;
}

/**
 * Root of a tree whose only non-zero leaves are `leaves` starting at 0 (what MerkleTreeWithHistoryV2 computes
 * after inserting them as 4-leaf chunks, ZERO_LEAF padded).
 */
export function rootOf(leaves: readonly bigint[], levels = LEVELS): bigint {
  const z = zeros(levels);
  let layer = leaves.map(toField);
  if (layer.length % CHUNK !== 0) layer = layer.concat(Array(CHUNK - (layer.length % CHUNK)).fill(ZERO_LEAF));
  for (let l = 0; l < levels; l++) {
    const next: bigint[] = [];
    for (let i = 0; i < layer.length; i += 2) next.push(poseidon([layer[i], layer[i + 1] ?? z[l]]));
    layer = next.length ? next : [z[l + 1]];
  }
  return layer[0] ?? z[levels];
}
