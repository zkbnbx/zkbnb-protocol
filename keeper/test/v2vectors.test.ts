import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Hex } from "viem";
import * as bj from "../src/babyjub.js";
import { elgamal, encrypt, addCiphertexts, type Ciphertext } from "../src/elgamal.js";
import {
  FIELD_SIZE,
  ZERO_LEAF,
  LEVELS,
  keysFromSeed,
  shieldedAddress,
  fullViewingKey,
  salt,
  handleOf,
  elgamalK,
  poseidon,
  noteCommitment,
  nullifier,
  intentAsset,
  epochKey,
  intentLeaf,
  totalsHash,
  resultLeaf,
  voidTotals,
  zeros,
  rootOf,
  DIR,
} from "../src/grove2.js";

/**
 * Stage-2 vectors from circuits/scripts/fixtures-v2.mjs reproduced by the keeper's own helpers.
 * keys.json is a verbatim copy in test/fixtures/ (workplan §1.3); the other two are read from contracts/.
 */
const here = dirname(fileURLToPath(import.meta.url));
const keys = JSON.parse(readFileSync(join(here, "fixtures", "keys.json"), "utf8"));
const v2 = join(here, "..", "..", "contracts", "test", "fixtures", "v2");
const pv = JSON.parse(readFileSync(join(v2, "poseidon_vectors.json"), "utf8"));
const ev = JSON.parse(readFileSync(join(v2, "elgamal_vectors.json"), "utf8"));

const pt = (a: string[]): bj.Point => [BigInt(a[0]), BigInt(a[1])];

describe("keys.json (seed → ask, pk, nk, ovk, encPub, address, fvk, salt, handle, elgamalK)", () => {
  const k = keysFromSeed(keys.seed as Hex);

  it("the keeper copy is identical to the contracts fixture", () => {
    const original = readFileSync(join(v2, "keys.json"), "utf8");
    expect(readFileSync(join(here, "fixtures", "keys.json"), "utf8")).toBe(original);
  });

  it("derives every key component", () => {
    expect(k.ask.toString()).toBe(keys.ask);
    expect(k.pk.toString()).toBe(keys.pk);
    expect(k.nk.toString()).toBe(keys.nk);
    expect(k.ovk.toString()).toBe(keys.ovk);
    expect(k.encPriv).toBe(keys.encPriv);
    expect(k.encPub).toBe(keys.encPub);
    expect(shieldedAddress(k)).toBe(keys.address);
    expect(fullViewingKey(k)).toBe(keys.fvk);
  });

  it("salt(n) and one-shot handle(n)", () => {
    const s1 = salt(k.ovk, 1);
    const s2 = salt(k.ovk, 2);
    expect(s1.toString()).toBe(keys.salt1);
    expect(s2.toString()).toBe(keys.salt2);
    expect(handleOf(k.ovk, s1).toString()).toBe(keys.handle1);
    expect(handleOf(k.ovk, s2).toString()).toBe(keys.handle2);
    expect(() => salt(k.ovk, 0)).toThrow();
  });

  it("elgamalK(ask, nullifier0 = 1) is the deterministic k of spec §2.7", () => {
    expect(elgamalK(k.ask, 1n).toString()).toBe(keys.elgamalK_nullifier1);
    expect(elgamalK(k.ask, 2n)).not.toBe(elgamalK(k.ask, 1n));
    expect(elgamalK(k.ask, 1n) < bj.SUBORDER).toBe(true);
  });
});

describe("poseidon_vectors.json", () => {
  it("constants, zeros and the empty root", () => {
    expect(FIELD_SIZE.toString()).toBe(pv.fieldSize);
    expect(ZERO_LEAF.toString()).toBe(pv.zeroLeaf);
    expect(LEVELS).toBe(pv.levels);
    const z = zeros();
    expect(z.map(String)).toEqual(pv.zeros);
    expect(z[LEVELS].toString()).toBe(pv.emptyRoot);
    expect(rootOf([]).toString()).toBe(pv.emptyRoot);
  });

  it("raw Poseidon arities 2 and 3", () => {
    expect(poseidon([1n, 2n]).toString()).toBe(pv.poseidon2_1_2);
    expect(poseidon([1n, 2n, 3n]).toString()).toBe(pv.poseidon3_1_2_3);
  });

  it("note commitment and nullifier", () => {
    const n = pv.note;
    const { inner, commitment } = noteCommitment({
      assetId: BigInt(n.assetId),
      amount: BigInt(n.amount),
      pk: BigInt(n.pk),
      rpt0: BigInt(n.rpt0),
      blinding: BigInt(n.blinding),
    });
    expect(inner.toString()).toBe(n.inner);
    expect(commitment.toString()).toBe(n.commitment);
    expect(nullifier(commitment, n.leafIndex, BigInt(n.nk)).toString()).toBe(n.nullifier);
  });

  it("intent asset, epoch key, intent leaf, totals, result leaves", () => {
    const coin = BigInt(pv.note.assetId);
    expect(intentAsset(coin, DIR.SELL).toString()).toBe(pv.intentAsset_sell);
    const ek = epochKey(coin, 3, DIR.SELL);
    expect(ek.toString()).toBe(pv.epochKey_coin_3_sell);
    expect(intentLeaf(BigInt(pv.note.commitment), ek).toString()).toBe(pv.intentLeaf);
    const t = {
      totalIn: BigInt(pv.totals.totalIn),
      totalOut: BigInt(pv.totals.totalOut),
      totalRefund: BigInt(pv.totals.totalRefund),
      rptAtSettle: BigInt(pv.totals.rptAtSettle),
    };
    expect(totalsHash(t).toString()).toBe(pv.totalsHash);
    expect(resultLeaf(ek, t).toString()).toBe(pv.resultLeaf);
    expect(resultLeaf(ek, voidTotals(40n)).toString()).toBe(pv.voidResultLeaf_rpt40);
  });

  it("chunk root of one 4-leaf chunk", () => {
    expect(pv.chunk.start).toBe(0);
    expect(rootOf(pv.chunk.leaves.map(BigInt)).toString()).toBe(pv.chunk.root);
    // padding is implicit: the two real leaves alone give the same root
    expect(rootOf([1n, 2n]).toString()).toBe(pv.chunk.root);
  });

  it("handle vector", () => {
    expect(handleOf(BigInt(pv.handle.ovk), BigInt(pv.handle.salt1)).toString()).toBe(pv.handle.handle1);
  });
});

describe("elgamal_vectors.json", () => {
  const sk = BigInt(ev.coordinator.ecSk);
  const pk = pt(ev.coordinator.ecPk);
  const encs: (Ciphertext & { u: bigint })[] = ev.encryptions.map((e: { u: string; c1: string[]; c2: string[] }) => ({
    u: BigInt(e.u),
    c1: pt(e.c1),
    c2: pt(e.c2),
  }));

  it("curve constants and the coordinator key", () => {
    expect(bj.A.toString()).toBe(ev.curve.a);
    expect(bj.D.toString()).toBe(ev.curve.d);
    expect(bj.SUBORDER.toString()).toBe(ev.curve.subOrder);
    expect(bj.BASE8.map(String)).toEqual(ev.curve.base8);
    expect(bj.IDENTITY.map(String)).toEqual(ev.identityAffine);
    expect(bj.eq(elgamal.publicKey(sk), pk)).toBe(true);
    expect(bj.inSubgroup(pk)).toBe(true);
  });

  it("each encryption is reproduced from (u, pk, k) and its extended form matches the contract's", () => {
    for (const e of ev.encryptions) {
      const c = encrypt(BigInt(e.u), pk, BigInt(e.k));
      expect(c.c1.map(String)).toEqual(e.c1);
      expect(c.c2.map(String)).toEqual(e.c2);
      const x1 = bj.toContractPoint(c.c1);
      expect({ x: x1.x.toString(), y: x1.y.toString(), t: x1.t.toString(), z: x1.z.toString() }).toEqual(e.c1Extended);
      const x2 = bj.toContractPoint(c.c2);
      expect({ x: x2.x.toString(), y: x2.y.toString(), t: x2.t.toString(), z: x2.z.toString() }).toEqual(e.c2Extended);
    }
  });

  for (const [name, n] of [["sum_first3", 3], ["sum_all", 10]] as const) {
    it(`${name}: homomorphic sum, sum-only decryption to (Σu)·B8`, () => {
      const v = ev[name];
      const sum = elgamal.sumCiphertexts(encs.slice(0, n));
      expect(sum.count).toBe(n);
      expect(sum.c1.map(String)).toEqual(v.c1);
      expect(sum.c2.map(String)).toEqual(v.c2);
      const m = elgamal.decrypt(sum, sk);
      expect(m.map(String)).toEqual(v.decryptedPoint);
      expect(bj.mul(BigInt(v.u), bj.BASE8).map(String)).toEqual(v.uTimesB8);
      expect(encs.slice(0, n).reduce((a, e) => a + e.u, 0n).toString()).toBe(v.u);
      // pairwise addition agrees with the batched sum
      const pair = encs.slice(1, n).reduce<Ciphertext>((a, e) => addCiphertexts(a, e), encs[0]);
      expect(bj.eq(pair.c1, sum.c1) && bj.eq(pair.c2, sum.c2)).toBe(true);
    });
  }

  it("the on-chain (extended) running sum decrypts the same as the off-chain sum", () => {
    // simulate DarkCurve accumulating in extended coordinates without normalising
    let c1 = bj.EXT_IDENTITY as bj.Ext;
    let c2 = bj.EXT_IDENTITY as bj.Ext;
    for (const e of encs.slice(0, 3)) {
      c1 = bj.extAdd(c1, bj.toExt(e.c1));
      c2 = bj.extAdd(c2, bj.toExt(e.c2));
    }
    const sum = elgamal.onChainSum({ x: c1.X, y: c1.Y, t: c1.T, z: c1.Z }, { x: c2.X, y: c2.Y, t: c2.T, z: c2.Z }, 3);
    expect(sum.c1.map(String)).toEqual(ev.sum_first3.c1);
    expect(elgamal.decrypt(sum, sk).map(String)).toEqual(ev.sum_first3.decryptedPoint);
  });
});
