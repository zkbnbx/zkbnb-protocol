import { describe, it, expect } from "vitest";
import * as elgamalModule from "../src/elgamal.js";
import { elgamal, encrypt, SUM_BITS } from "../src/elgamal.js";
import { BASE8, SUBORDER, eq, mul, toContractPoint } from "../src/babyjub.js";

const sk = 123456789123456789n;
const pk = elgamal.publicKey(sk);

describe("elgamal: sum-only decryption", () => {
  it("decrypt refuses an individual (un-summed) ciphertext at runtime", () => {
    const c = encrypt(5000n, pk, 777n);
    // a plain {c1, c2} object is not a SummedCiphertext
    expect(() => elgamal.decrypt(c as never, sk)).toThrow(/summed ciphertext only/);
    expect(() => elgamal.decrypt({ ...elgamal.sumCiphertexts([c]) } as never, sk)).toThrow(/summed ciphertext only/);
  });

  it("the module exports no per-intent decrypt helper", () => {
    const names = Object.keys(elgamalModule).filter((k) => /decrypt/i.test(k));
    expect(names).toEqual(["decrypt"]);
    expect(Object.keys(elgamal).filter((k) => /decrypt/i.test(k))).toEqual(["decrypt"]);
  });

  it("sum of many ciphertexts decrypts to (Σu)·B8; summed values are frozen", () => {
    const us = [5000n, 6000n, 123456n, (1n << 32n) - 1n];
    const cs = us.map((u, i) => encrypt(u, pk, 1000n + BigInt(i)));
    const sum = elgamal.sumCiphertexts(cs);
    expect(Object.isFrozen(sum)).toBe(true);
    expect(eq(elgamal.decrypt(sum, sk), mul(us.reduce((a, b) => a + b, 0n), BASE8))).toBe(true);
    // a different key does not decrypt it
    expect(eq(elgamal.decrypt(sum, sk + 1n), mul(us.reduce((a, b) => a + b, 0n), BASE8))).toBe(false);
  });

  it("onChainSum validates the intent count and normalises extended points", () => {
    const c = encrypt(42n, pk, 99n);
    const e1 = toContractPoint(c.c1);
    const e2 = toContractPoint(c.c2);
    // scale (X, Y, T, Z) by 3: same affine point
    const s3 = (e: typeof e1) => ({ x: e.x * 3n, y: e.y * 3n, t: e.t * 3n, z: 3n });
    const sum = elgamal.onChainSum(s3(e1), s3(e2), 1);
    expect(eq(sum.c1, c.c1) && eq(sum.c2, c.c2)).toBe(true);
    expect(() => elgamal.onChainSum(e1, e2, 0)).toThrow();
    expect(() => elgamal.onChainSum(e1, e2, 257)).toThrow();
  });

  it("parseSecretKey accepts decimal and hex in [1, l) and never echoes the value", () => {
    expect(elgamal.parseSecretKey("12345")).toBe(12345n);
    expect(elgamal.parseSecretKey(" 0x3039 ")).toBe(12345n);
    for (const bad of ["0", SUBORDER.toString(), "-5", "12ab", "", "0x"]) {
      try {
        elgamal.parseSecretKey(bad);
        throw new Error("accepted");
      } catch (e) {
        expect((e as Error).message).toMatch(/^COORDINATOR_SK/);
        if (bad.length > 2) expect((e as Error).message).not.toContain(bad);
      }
    }
  });

  it("encrypt range checks", () => {
    expect(() => encrypt(1n << BigInt(SUM_BITS), pk, 5n)).toThrow();
    expect(() => encrypt(1n, pk, 0n)).toThrow();
    expect(() => encrypt(1n, pk, SUBORDER)).toThrow();
    expect(() => elgamal.publicKey(0n)).toThrow();
  });

  it("isValidPublicKey: subgroup point, not identity", () => {
    expect(elgamalModule.isValidPublicKey(pk)).toBe(true);
    expect(elgamalModule.isValidPublicKey([0n, 1n])).toBe(false);
    expect(elgamalModule.isValidPublicKey([1n, 2n])).toBe(false);
  });
});
