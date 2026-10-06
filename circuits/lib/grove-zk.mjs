// zkBNB shielded-pool client library (SPEC §8).
// Plain ESM; runs in Node and in a browser bundle. No Node-only imports at module top level.
//
// Matches circuits/transaction.circom and contracts/src/ShieldedPool.sol:
//   commitment = Poseidon(amount, pubKey, blinding)
//   pubKey     = Poseidon(privKey)
//   signature  = Poseidon(privKey, commitment, leafIndex)
//   nullifier  = Poseidon(commitment, leafIndex, signature)
//   tree       = depth 20, zero leaf keccak("grove") mod p, Poseidon(left, right)

import { buildPoseidon } from "circomlibjs";
import { groth16 } from "snarkjs";
import { x25519 } from "@noble/curves/ed25519";
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { randomBytes } from "@noble/hashes/utils";
import { keccak256, AbiCoder, getBytes, hexlify, toBeHex, getAddress, ZeroAddress } from "ethers";

export const FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
// keccak256("grove") mod FIELD_SIZE — must equal MerkleTreeWithHistory.ZERO_VALUE
export const ZERO_VALUE = 19524425634078878347273533764823178855725786503789258942133279824547046949394n;
export const LEVELS = 20;
export const ADDRESS_PREFIX = "zkbnb1";

const abi = AbiCoder.defaultAbiCoder();
const EXT_DATA_TYPE = "tuple(address recipient,int256 extAmount,address relayer,uint256 fee,bytes encryptedOutput1,bytes encryptedOutput2)";

let _poseidon = null;
let _initPromise = null;

/** Builds Poseidon once. Must be awaited before any hashing / key generation. */
export async function init() {
  if (_poseidon) return;
  if (!_initPromise) {
    _initPromise = buildPoseidon().then((p) => {
      _poseidon = p;
    });
  }
  await _initPromise;
}

function requirePoseidon() {
  if (!_poseidon) throw new Error("grove-zk: call `await init()` first");
  return _poseidon;
}

/** Poseidon over 1..6 field elements, returns a bigint < FIELD_SIZE. */
export function poseidon(inputs) {
  const p = requirePoseidon();
  const ins = inputs.map((x) => toField(x));
  return p.F.toObject(p(ins));
}

// ----------------------------------------------------------------- helpers

export function toField(x) {
  const v = typeof x === "bigint" ? x : BigInt(x);
  const r = v % FIELD_SIZE;
  return r < 0n ? r + FIELD_SIZE : r;
}

export function randomField() {
  return bytesToBigInt(randomBytes(32)) % FIELD_SIZE;
}

export function bytesToBigInt(bytes) {
  let r = 0n;
  for (const b of bytes) r = (r << 8n) | BigInt(b);
  return r;
}

export function bigIntToBytes32(x) {
  return getBytes(toBeHex(toField(x), 32));
}

function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex) {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) throw new Error("bad hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}

function concatBytes(...parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// Encrypted blob layout: ephemeral x25519 pubkey (32) || xchacha nonce (24) || ciphertext+tag
const EPH_LEN = 32;
const NONCE_LEN = 24;

function sharedKey(priv, pub) {
  const shared = x25519.getSharedSecret(priv, pub);
  return getBytes(keccak256(shared));
}

// ----------------------------------------------------------------- Keypair

export class Keypair {
  /**
   * @param {bigint|null} privkey  spending key (field element) or null for a view-only keypair
   * @param {{pubkey?: bigint, encPub?: Uint8Array}} [viewOnly]
   */
  constructor(privkey, viewOnly) {
    if (privkey !== null && privkey !== undefined) {
      this.privkey = toField(privkey);
      this.pubkey = poseidon([this.privkey]);
      this.encPriv = getBytes(keccak256(bigIntToBytes32(this.privkey)));
      this.encPub = x25519.getPublicKey(this.encPriv);
    } else {
      this.privkey = null;
      this.encPriv = null;
      this.pubkey = toField(viewOnly.pubkey);
      this.encPub = new Uint8Array(viewOnly.encPub);
      if (this.encPub.length !== 32) throw new Error("encPub must be 32 bytes");
    }
  }

  static random() {
    return new Keypair(randomField());
  }

  static fromPrivkey(privkey) {
    return new Keypair(privkey);
  }

  /** privkey = keccak256(signature) mod FIELD_SIZE (sign the message "zkBNB shielded key v1"). */
  static fromSignature(sigHex) {
    return new Keypair(BigInt(keccak256(sigHex)) % FIELD_SIZE);
  }

  /** View-only keypair from a "zkbnb1…" address: can receive and encrypt, cannot spend/decrypt. */
  static fromAddress(addr) {
    const a = addr.trim();
    if (!a.startsWith(ADDRESS_PREFIX) || a.length !== ADDRESS_PREFIX.length + 128) {
      throw new Error("invalid zkbnb address");
    }
    const hex = a.slice(ADDRESS_PREFIX.length);
    const pubkey = BigInt("0x" + hex.slice(0, 64));
    if (pubkey >= FIELD_SIZE) throw new Error("invalid zkbnb address: pubkey out of field");
    const encPub = hexToBytes(hex.slice(64));
    return new Keypair(null, { pubkey, encPub });
  }

  /** "zkbnb1" + hex(pubkey, 32 bytes big-endian) + hex(encPub, 32 bytes) */
  address() {
    return ADDRESS_PREFIX + bytesToHex(bigIntToBytes32(this.pubkey)) + bytesToHex(this.encPub);
  }

  get canSpend() {
    return this.privkey !== null;
  }

  sign(commitment, merklePath) {
    if (this.privkey === null) throw new Error("view-only keypair cannot sign");
    return poseidon([this.privkey, commitment, merklePath]);
  }

  /** Encrypt to this keypair's encPub with an ephemeral x25519 key + XChaCha20-Poly1305. */
  encrypt(bytes) {
    const ephPriv = randomBytes(32);
    const ephPub = x25519.getPublicKey(ephPriv);
    const key = sharedKey(ephPriv, this.encPub);
    const nonce = randomBytes(NONCE_LEN);
    const ct = xchacha20poly1305(key, nonce).encrypt(bytes);
    return concatBytes(ephPub, nonce, ct);
  }

  decrypt(bytes) {
    if (this.encPriv === null) throw new Error("view-only keypair cannot decrypt");
    if (bytes.length < EPH_LEN + NONCE_LEN + 16) throw new Error("ciphertext too short");
    const ephPub = bytes.slice(0, EPH_LEN);
    const nonce = bytes.slice(EPH_LEN, EPH_LEN + NONCE_LEN);
    const ct = bytes.slice(EPH_LEN + NONCE_LEN);
    const key = sharedKey(this.encPriv, ephPub);
    return xchacha20poly1305(key, nonce).decrypt(ct); // throws on auth failure
  }
}

// ----------------------------------------------------------------- Utxo

export class Utxo {
  /**
   * @param {{amount: bigint|number|string, keypair: Keypair, blinding?: bigint, index?: number|null}} o
   */
  constructor({ amount, keypair, blinding, index }) {
    if (!(keypair instanceof Keypair)) throw new Error("Utxo needs a Keypair");
    this.amount = BigInt(amount);
    if (this.amount < 0n || this.amount >= 1n << 248n) throw new Error("amount out of range");
    this.keypair = keypair;
    this.blinding = blinding === undefined || blinding === null ? randomField() : toField(blinding);
    this.index = index === undefined || index === null ? null : Number(index);
    this._commitment = null;
  }

  commitment() {
    if (this._commitment === null) {
      this._commitment = poseidon([this.amount, this.keypair.pubkey, this.blinding]);
    }
    return this._commitment;
  }

  nullifier() {
    if (this.index === null) throw new Error("Utxo index unknown; cannot compute nullifier");
    const c = this.commitment();
    const idx = BigInt(this.index);
    return poseidon([c, idx, this.keypair.sign(c, idx)]);
  }

  /** abi.encode(uint256 amount, uint256 blinding), encrypted to the owner's encPub. */
  encrypt() {
    const plain = getBytes(abi.encode(["uint256", "uint256"], [this.amount, this.blinding]));
    return this.keypair.encrypt(plain);
  }

  /** Throws if the blob is not addressed to `keypair`. */
  static decrypt(keypair, bytes, index) {
    const data = typeof bytes === "string" ? hexToBytes(bytes) : bytes;
    const plain = keypair.decrypt(data);
    if (plain.length !== 64) throw new Error("bad note plaintext");
    const [amount, blinding] = abi.decode(["uint256", "uint256"], plain);
    return new Utxo({ amount, blinding, keypair, index });
  }
}

// ----------------------------------------------------------------- MerkleTree

/** Mirrors MerkleTreeWithHistory: zero leaf ZERO_VALUE, Poseidon(left, right), sequential leaves. */
export class MerkleTree {
  constructor(levels = LEVELS, leaves = []) {
    this.levels = levels;
    this.capacity = 2 ** levels;
    this._zeros = [ZERO_VALUE];
    for (let i = 1; i <= levels; i++) {
      this._zeros.push(poseidon([this._zeros[i - 1], this._zeros[i - 1]]));
    }
    this._layers = Array.from({ length: levels + 1 }, () => []);
    this.bulkInsert(leaves);
  }

  zeros(level) {
    return this._zeros[level];
  }

  get elements() {
    return this._layers[0].slice();
  }

  get length() {
    return this._layers[0].length;
  }

  leaf(index) {
    return this._layers[0][index];
  }

  insert(leaf) {
    const index = this._layers[0].length;
    if (index >= this.capacity) throw new Error("tree full");
    this._layers[0].push(toField(leaf));
    let cur = index;
    for (let level = 0; level < this.levels; level++) {
      const left = cur & ~1;
      const l = this._layers[level][left] ?? this._zeros[level];
      const r = this._layers[level][left + 1] ?? this._zeros[level];
      this._layers[level + 1][cur >> 1] = poseidon([l, r]);
      cur >>= 1;
    }
    return index;
  }

  bulkInsert(leaves) {
    if (leaves.length === 0) return;
    if (this._layers[0].length + leaves.length > this.capacity) throw new Error("tree full");
    for (const leaf of leaves) this._layers[0].push(toField(leaf));
    for (let level = 0; level < this.levels; level++) {
      const src = this._layers[level];
      const dst = [];
      for (let i = 0; i < src.length; i += 2) {
        dst.push(poseidon([src[i], src[i + 1] ?? this._zeros[level]]));
      }
      this._layers[level + 1] = dst;
    }
  }

  root() {
    return this._layers[this.levels][0] ?? this._zeros[this.levels];
  }

  path(index) {
    if (index < 0 || index >= this._layers[0].length) throw new Error("index out of range");
    const pathElements = [];
    let cur = index;
    for (let level = 0; level < this.levels; level++) {
      pathElements.push(this._layers[level][cur ^ 1] ?? this._zeros[level]);
      cur >>= 1;
    }
    return { pathElements, pathIndices: index };
  }

  indexOf(leaf) {
    const v = toField(leaf);
    return this._layers[0].findIndex((x) => x === v);
  }
}

// ----------------------------------------------------------------- ext data / amounts

/** keccak256(abi.encode(ExtData)) mod FIELD_SIZE — identical to ShieldedPool.hashExtData. */
export function hashExtData(extData) {
  const encoded = abi.encode(
    [EXT_DATA_TYPE],
    [
      [
        extData.recipient,
        BigInt(extData.extAmount),
        extData.relayer,
        BigInt(extData.fee),
        extData.encryptedOutput1,
        extData.encryptedOutput2,
      ],
    ],
  );
  return BigInt(keccak256(encoded)) % FIELD_SIZE;
}

/** publicAmount = extAmount - fee, mapped into the field (negative => FIELD_SIZE - |x|). */
export function calculatePublicAmount(extAmount, fee) {
  const e = BigInt(extAmount);
  const f = BigInt(fee);
  if (f < 0n || f >= 1n << 248n) throw new Error("fee out of range");
  if (e <= -(1n << 248n) || e >= 1n << 248n) throw new Error("extAmount out of range");
  const v = e - f;
  return v >= 0n ? v : FIELD_SIZE + v;
}

// ----------------------------------------------------------------- proving

function artifact(x) {
  if (typeof x === "string") return x; // file path (Node) — in the browser pass a Uint8Array
  if (x instanceof Uint8Array) return { type: "mem", data: x };
  if (x instanceof ArrayBuffer) return { type: "mem", data: new Uint8Array(x) };
  if (x && x.type === "mem") return x;
  throw new Error("wasm/zkey must be a path string or Uint8Array");
}

/** snarkjs proof -> ShieldedPool.Proof field layout (b coordinates swapped as the Solidity verifier expects). */
export function proofToSolidity(proof) {
  return {
    a: [BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1])],
    b: [
      [BigInt(proof.pi_b[0][1]), BigInt(proof.pi_b[0][0])],
      [BigInt(proof.pi_b[1][1]), BigInt(proof.pi_b[1][0])],
    ],
    c: [BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1])],
  };
}

/** Inverse of proofToSolidity (for snarkjs.groth16.verify). */
export function proofFromSolidity(p) {
  const s = (x) => BigInt(x).toString();
  return {
    protocol: "groth16",
    curve: "bn128",
    pi_a: [s(p.a[0]), s(p.a[1]), "1"],
    pi_b: [
      [s(p.b[0][1]), s(p.b[0][0])],
      [s(p.b[1][1]), s(p.b[1][0])],
      ["1", "0"],
    ],
    pi_c: [s(p.c[0]), s(p.c[1]), "1"],
  };
}

/**
 * Build witness inputs, prove, and return a Proof/ExtData pair for ShieldedPool.transact.
 * inputs/outputs are padded to 2 with zero-amount UTXOs (fresh random keypairs).
 */
export async function prepareTransaction({
  tree,
  inputs = [],
  outputs = [],
  extAmount = 0n,
  fee = 0n,
  recipient = ZeroAddress,
  relayer = ZeroAddress,
  wasm,
  zkey,
}) {
  if (!(tree instanceof MerkleTree)) throw new Error("tree must be a MerkleTree");
  if (inputs.length > 2 || outputs.length > 2) throw new Error("max 2 inputs and 2 outputs");
  extAmount = BigInt(extAmount);
  fee = BigInt(fee);

  const ins = inputs.slice();
  while (ins.length < 2) ins.push(new Utxo({ amount: 0n, keypair: Keypair.random(), index: 0 }));
  const outs = outputs.slice();
  while (outs.length < 2) outs.push(new Utxo({ amount: 0n, keypair: Keypair.random() }));

  const sumIn = ins.reduce((s, u) => s + u.amount, 0n);
  const sumOut = outs.reduce((s, u) => s + u.amount, 0n);
  if (sumIn + extAmount - fee !== sumOut) {
    throw new Error(`unbalanced: in ${sumIn} + ext ${extAmount} - fee ${fee} != out ${sumOut}`);
  }
  if (extAmount < 0n && recipient === ZeroAddress) throw new Error("withdraw needs a recipient");
  if (fee > 0n && relayer === ZeroAddress) throw new Error("fee needs a relayer");

  const inPathIndices = [];
  const inPathElements = [];
  for (const u of ins) {
    if (!u.keypair.canSpend) throw new Error("input UTXO keypair cannot spend");
    if (u.amount > 0n) {
      if (u.index === null) throw new Error("input UTXO has no leaf index");
      if (tree.leaf(u.index) !== u.commitment()) {
        throw new Error(`input commitment not found at leaf ${u.index}`);
      }
      const { pathElements, pathIndices } = tree.path(u.index);
      inPathIndices.push(pathIndices);
      inPathElements.push(pathElements);
    } else {
      if (u.index === null) u.index = 0;
      inPathIndices.push(u.index);
      inPathElements.push(new Array(tree.levels).fill(0n));
    }
  }

  const extData = {
    recipient: getAddress(recipient),
    extAmount,
    relayer: getAddress(relayer),
    fee,
    encryptedOutput1: hexlify(outs[0].encrypt()),
    encryptedOutput2: hexlify(outs[1].encrypt()),
  };
  const extDataHash = hashExtData(extData);
  const publicAmount = calculatePublicAmount(extAmount, fee);
  const root = tree.root();

  const s = (x) => BigInt(x).toString();
  const input = {
    root: s(root),
    publicAmount: s(publicAmount),
    extDataHash: s(extDataHash),
    inputNullifier: ins.map((u) => s(u.nullifier())),
    inAmount: ins.map((u) => s(u.amount)),
    inPrivateKey: ins.map((u) => s(u.keypair.privkey)),
    inBlinding: ins.map((u) => s(u.blinding)),
    inPathIndices: inPathIndices.map(s),
    inPathElements: inPathElements.map((row) => row.map(s)),
    outputCommitment: outs.map((u) => s(u.commitment())),
    outAmount: outs.map((u) => s(u.amount)),
    outPubkey: outs.map((u) => s(u.keypair.pubkey)),
    outBlinding: outs.map((u) => s(u.blinding)),
  };

  const { proof: snarkProof, publicSignals } = await groth16.fullProve(input, artifact(wasm), artifact(zkey));

  const proof = {
    ...proofToSolidity(snarkProof),
    root,
    publicAmount,
    extDataHash: toBeHex(extDataHash, 32),
    inputNullifiers: [ins[0].nullifier(), ins[1].nullifier()],
    outputCommitments: [outs[0].commitment(), outs[1].commitment()],
  };

  return { proof, extData, publicSignals, snarkProof, inputs: ins, outputs: outs };
}

// ----------------------------------------------------------------- note scanning

/**
 * Find this keypair's notes from NewCommitment / DepositFor / NewNullifier event data.
 * Needs a spending keypair (to decrypt and to compute nullifiers).
 */
export function scanNotes({ keypair, commitments = [], depositsFor = [], nullifiers = new Set() }) {
  const found = new Map(); // index -> Utxo
  for (const ev of commitments) {
    if (!ev.encryptedOutput || ev.encryptedOutput === "0x") continue;
    if (!keypair.canSpend) continue;
    let utxo;
    try {
      utxo = Utxo.decrypt(keypair, ev.encryptedOutput, Number(ev.index));
    } catch {
      continue; // not ours
    }
    if (utxo.commitment() !== toField(ev.commitment)) continue;
    if (utxo.amount === 0n) continue;
    found.set(utxo.index, utxo);
  }
  for (const ev of depositsFor) {
    if (toField(ev.pubKey) !== keypair.pubkey) continue;
    const utxo = new Utxo({ amount: BigInt(ev.amount), blinding: toField(ev.blinding), keypair, index: Number(ev.index) });
    if (utxo.amount === 0n) continue;
    found.set(utxo.index, utxo);
  }
  const spentSet = new Set(Array.from(nullifiers, (n) => toField(n)));
  const unspent = [];
  const spent = [];
  for (const utxo of [...found.values()].sort((a, b) => a.index - b.index)) {
    if (keypair.canSpend && spentSet.has(utxo.nullifier())) spent.push(utxo);
    else unspent.push(utxo);
  }
  return { unspent, spent };
}
