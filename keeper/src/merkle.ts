import { encodeAbiParameters, keccak256, concat, hexToBytes, type Address, type Hex } from "viem";

/**
 * OpenZeppelin-compatible Merkle tree over plain `keccak256(abi.encode(coin, runId, account, amount))`
 * leaves (NOT the double-hashed StandardMerkleTree). Internal nodes hash the sorted pair; an odd
 * node at any level is promoted unchanged. `MerkleProof.verify` in HolderRewards accepts these proofs.
 */

export function leafHash(coin: Address, runId: bigint, account: Address, amount: bigint): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }, { type: "address" }, { type: "uint256" }],
      [coin, runId, account, amount],
    ),
  );
}

function lt(a: Hex, b: Hex): boolean {
  const x = hexToBytes(a);
  const y = hexToBytes(b);
  for (let i = 0; i < 32; i++) {
    if (x[i] !== y[i]) return x[i] < y[i];
  }
  return false;
}

/** keccak256 of the pair in ascending byte order, as OZ `Hashes.commutativeKeccak256`. */
export function hashPair(a: Hex, b: Hex): Hex {
  return lt(a, b) ? keccak256(concat([a, b])) : keccak256(concat([b, a]));
}

export interface MerkleTree {
  root: Hex;
  leaves: Hex[];
  /** layers[0] = leaves, layers[last] = [root] */
  layers: Hex[][];
}

export function buildTree(leaves: Hex[]): MerkleTree {
  if (leaves.length === 0) throw new Error("merkle: no leaves");
  const layers: Hex[][] = [leaves.slice()];
  while (layers[layers.length - 1].length > 1) {
    const prev = layers[layers.length - 1];
    const next: Hex[] = [];
    for (let i = 0; i < prev.length; i += 2) {
      if (i + 1 < prev.length) next.push(hashPair(prev[i], prev[i + 1]));
      else next.push(prev[i]); // odd node promoted
    }
    layers.push(next);
  }
  return { root: layers[layers.length - 1][0], leaves: layers[0], layers };
}

export function getProof(tree: MerkleTree, index: number): Hex[] {
  if (index < 0 || index >= tree.leaves.length) throw new Error("merkle: bad index");
  const proof: Hex[] = [];
  let i = index;
  for (let level = 0; level < tree.layers.length - 1; level++) {
    const layer = tree.layers[level];
    const sibling = i % 2 === 0 ? i + 1 : i - 1;
    if (sibling < layer.length) proof.push(layer[sibling]);
    i = Math.floor(i / 2);
  }
  return proof;
}

/** Solidity-equivalent of OpenZeppelin `MerkleProof.verify` (sorted-pair keccak). */
export function verifyProof(proof: readonly Hex[], root: Hex, leaf: Hex): boolean {
  let computed = leaf;
  for (const p of proof) computed = hashPair(computed, p);
  return computed.toLowerCase() === root.toLowerCase();
}
