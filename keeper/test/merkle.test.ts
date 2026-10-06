import { describe, it, expect } from "vitest";
import { keccak256, concat, encodeAbiParameters, toHex, type Hex, type Address } from "viem";
import { buildTree, getProof, hashPair, leafHash, verifyProof } from "../src/merkle.js";

/**
 * Independent re-implementation of OpenZeppelin MerkleProof.processProof (v5):
 *   for each proof element: computedHash = commutativeKeccak256(computedHash, p)
 *   commutativeKeccak256(a,b) = a < b ? keccak(a||b) : keccak(b||a)
 * Written without reusing src/merkle.ts helpers so the test is a genuine cross-check.
 */
function ozProcessProof(proof: Hex[], leaf: Hex): Hex {
  let h = leaf;
  for (const p of proof) {
    const a = BigInt(h);
    const b = BigInt(p);
    h = a < b ? keccak256(concat([h, p])) : keccak256(concat([p, h]));
  }
  return h;
}

function randomLeaf(i: number): Hex {
  return keccak256(toHex(`leaf-${i}-${Math.random()}`));
}

describe("merkle", () => {
  it("leafHash is keccak256(abi.encode(address,uint256,address,uint256)) with no double hashing", () => {
    const coin = "0x1111111111111111111111111111111111111111" as Address;
    const acct = "0x2222222222222222222222222222222222222222" as Address;
    const expected = keccak256(
      encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "address" }, { type: "uint256" }], [coin, 3n, acct, 1000n]),
    );
    expect(leafHash(coin, 3n, acct, 1000n)).toBe(expected);
    // abi.encode pads every word to 32 bytes: 4 words = 128 bytes before hashing
    const encoded = encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "address" }, { type: "uint256" }], [coin, 3n, acct, 1000n]);
    expect(encoded.length).toBe(2 + 128 * 2);
    // and the leaf is NOT the StandardMerkleTree double hash
    expect(leafHash(coin, 3n, acct, 1000n)).not.toBe(keccak256(keccak256(encoded)));
  });

  it("hashPair is commutative and sorted", () => {
    const a = keccak256("0x01");
    const b = keccak256("0x02");
    expect(hashPair(a, b)).toBe(hashPair(b, a));
    const lo = BigInt(a) < BigInt(b) ? a : b;
    const hi = lo === a ? b : a;
    expect(hashPair(a, b)).toBe(keccak256(concat([lo, hi])));
  });

  it("single leaf: root == leaf, empty proof verifies", () => {
    const leaf = randomLeaf(0);
    const t = buildTree([leaf]);
    expect(t.root).toBe(leaf);
    expect(getProof(t, 0)).toEqual([]);
    expect(verifyProof([], t.root, leaf)).toBe(true);
    expect(ozProcessProof([], leaf)).toBe(t.root);
  });

  it("every proof verifies with the Solidity-equivalent verifier for sizes 1..33 (odd nodes promoted)", () => {
    for (let n = 1; n <= 33; n++) {
      const leaves = Array.from({ length: n }, (_, i) => randomLeaf(i));
      const t = buildTree(leaves);
      for (let i = 0; i < n; i++) {
        const proof = getProof(t, i);
        expect(verifyProof(proof, t.root, leaves[i])).toBe(true);
        expect(ozProcessProof(proof, leaves[i])).toBe(t.root);
        // proof length never exceeds ceil(log2(n))
        expect(proof.length).toBeLessThanOrEqual(Math.ceil(Math.log2(Math.max(n, 2))));
      }
    }
  });

  it("rejects a wrong leaf, a tampered proof and a foreign root", () => {
    const leaves = Array.from({ length: 7 }, (_, i) => randomLeaf(i));
    const t = buildTree(leaves);
    const proof = getProof(t, 3);
    expect(verifyProof(proof, t.root, randomLeaf(99))).toBe(false);
    const bad = proof.slice();
    bad[0] = keccak256(bad[0]);
    expect(verifyProof(bad, t.root, leaves[3])).toBe(false);
    expect(verifyProof(proof, keccak256(t.root), leaves[3])).toBe(false);
    // proof for another leaf does not verify this leaf
    expect(verifyProof(getProof(t, 4), t.root, leaves[3])).toBe(false);
  });

  it("odd promotion: a 3-leaf tree hashes pair(0,1) with the promoted leaf 2", () => {
    const [a, b, c] = [randomLeaf(1), randomLeaf(2), randomLeaf(3)];
    const t = buildTree([a, b, c]);
    expect(t.root).toBe(hashPair(hashPair(a, b), c));
    expect(getProof(t, 2)).toEqual([hashPair(a, b)]);
  });

  it("buildTree rejects empty input", () => {
    expect(() => buildTree([])).toThrow();
  });
});
