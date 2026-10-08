// zkBNB privacy launchpad (stage 2, "Dark Curve") client library.
// Authority: privacy/PRIVACY-SPEC.md (Appendix A constants, §2 crypto, §3 circuits) and
// privacy/PRIVACY-WORKPLAN.md §1 (export list, signal orders).
//
// Plain ESM; runs in Node and in a browser bundle. No Node-only imports at module top level.
//
//   inner      = Poseidon(assetId, rpt0, blinding)
//   commitment = Poseidon(amount, pk, inner)
//   nullifier  = Poseidon(commitment, leafIndex, nk)
//   pk = Poseidon(ask)   nk = Poseidon(ask, 1)   ovk = Poseidon(OWNER_TAG, ask)
//   tree: depth 23, zero leaf keccak("grove-v2") mod p, Poseidon(left, right), inserted in 4-leaf chunks,
//         roots known only at checkpoints.

import { buildPoseidon } from "circomlibjs";
import { groth16 } from "snarkjs";
import { x25519 } from "@noble/curves/ed25519";
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { randomBytes } from "@noble/hashes/utils";
import { keccak256, AbiCoder, getBytes, hexlify, toBeHex, toUtf8Bytes, getAddress, ZeroAddress } from "ethers";

// ----------------------------------------------------------------- Appendix A constants

export const FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const ZERO_LEAF = 1014863620666096670253896730964143634766893057150169129055179254946258934505n; // keccak256("grove-v2") mod p
export const INTENT_TAG = 5485727973690184042573032548250662701561163999721995087532894922013676652701n; // keccak256("grove-v2/intent") mod p
export const HANDLE_TAG = 4197082601223926234440412842350092754680596943151188710592157759256107473565n; // keccak256("grove-v2/handle") mod p
export const OWNER_TAG = 4084283354661981865798945521922129247864409744154712678450526337611273152227n; // keccak256("grove-v2/owner") mod p
export const RESULT_TAG = 19481998103912434576622020492478150961191355642108690953568066567392742677477n; // keccak256("grove-v2/result") mod p
export const LEVELS = 23;
export const CHUNK = 4;
export const CHECKPOINT_PERIOD = 600;
export const UNIT_BNB = 10_000_000_000_000n; // 1e13 wei
export const UNIT_TOKEN = 1_000_000_000_000_000_000n; // 1e18
export const U_BITS = 32;
export const MIN_U_BNB = 5_000n;
export const MIN_U_TOKEN = 50_000n;
export const INTENT_FEE = 2_000_000_000_000_000n; // 0.002 BNB
export const MAX_INTENTS = 256;
export const SUM_BITS = 40; // Σu < 2^40
export const RPT_SCALE = 1_000_000_000_000_000_000n;
export const DIR = Object.freeze({ BUY: 0, SELL: 1, HARVEST: 2 });
export const ACTION_HANDOVER = 1n;
export const ACTION_PLANT = 2n;
export const ADDRESS_PREFIX = "zkbnb2";
export const FVK_PREFIX = "zkbnb2view";
export const KEY_STRING_ASK = "zkbnb2/ask";
export const KEY_STRING_ENC = "zkbnb2/enc";
export const KEY_STRING_ELGAMAL = "zkbnb2/elgamal";
export const EIP712_DOMAIN = Object.freeze({ name: "zkBNB", version: "2" }); // + chainId, verifyingContract = GrovePool
export const EIP712_TYPES = Object.freeze({ ShieldedKey: [{ name: "purpose", type: "string" }] });
export const EIP712_PURPOSE = "Derive my zkBNB shielded key. Only sign this on zkbnbx.com.";
export const EPOCH_PARAMS = Object.freeze({ T_MIN: 60, T_MAX: 300, K: 5, GRACE: 1800, BAND_BPS: 1000, BAND_FLOOR: 500_000_000_000_000_000n, OVERLAP: 600 });

export const BABYJUB = Object.freeze({
  A: 168700n,
  D: 168696n,
  ORDER: 21888242871839275222246405745257275088614511777268538073601725287587578984328n,
  SUBORDER: 2736030358979909402780800718157159386076813972158567259200215660948447373041n,
  BASE8: Object.freeze([
    5299619240641551281634865583518297030282874472190772894086521144482721001553n,
    16950150798460657717958625567821834550301663161624707787222815936182638968203n,
  ]),
});

/** Every Appendix A constant as decimal strings (for zero-leaf-v2.mjs / the GroveConstants.sol diff). */
export function constantsTable() {
  return {
    FIELD_SIZE: FIELD_SIZE.toString(),
    ZERO_LEAF: ZERO_LEAF.toString(),
    INTENT_TAG: INTENT_TAG.toString(),
    HANDLE_TAG: HANDLE_TAG.toString(),
    OWNER_TAG: OWNER_TAG.toString(),
    RESULT_TAG: RESULT_TAG.toString(),
    LEVELS: String(LEVELS),
    CHUNK: String(CHUNK),
    CHECKPOINT_PERIOD: String(CHECKPOINT_PERIOD),
    UNIT_BNB: UNIT_BNB.toString(),
    UNIT_TOKEN: UNIT_TOKEN.toString(),
    U_BITS: String(U_BITS),
    MIN_U_BNB: MIN_U_BNB.toString(),
    MIN_U_TOKEN: MIN_U_TOKEN.toString(),
    INTENT_FEE: INTENT_FEE.toString(),
    MAX_INTENTS: String(MAX_INTENTS),
    RPT_SCALE: RPT_SCALE.toString(),
    BABYJUB_A: BABYJUB.A.toString(),
    BABYJUB_D: BABYJUB.D.toString(),
    BABYJUB_SUBORDER: BABYJUB.SUBORDER.toString(),
    BASE8_X: BABYJUB.BASE8[0].toString(),
    BASE8_Y: BABYJUB.BASE8[1].toString(),
    DIR_BUY: "0",
    DIR_SELL: "1",
    DIR_HARVEST: "2",
    ACTION_HANDOVER: ACTION_HANDOVER.toString(),
    ACTION_PLANT: ACTION_PLANT.toString(),
  };
}

const abi = AbiCoder.defaultAbiCoder();
const EXT_DATA2_TYPE =
  "tuple(address recipient,int256 extAmountBnb,int256 extAmountCoin,address relayer,uint256 fee,bytes payload,bytes[3] encryptedOutputs)";
const INTENT_EXT_TYPE = "tuple(address relayer,uint256 fee,bytes[3] encryptedOutputs)";
const CLAIM_EXT_TYPE = "tuple(address relayer,bytes[2] encryptedOutputs)";

// ----------------------------------------------------------------- Poseidon

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
  if (!_poseidon) throw new Error("grove-zk-v2: call `await init()` first");
  return _poseidon;
}

/** Poseidon over 1..6 field elements, returns a bigint < FIELD_SIZE. */
export function poseidon(inputs) {
  const p = requirePoseidon();
  const ins = inputs.map((x) => p.F.e(toField(x)));
  return p.F.toObject(p(ins));
}

// ----------------------------------------------------------------- helpers

export function toField(x) {
  const v = typeof x === "bigint" ? x : BigInt(x);
  const r = v % FIELD_SIZE;
  return r < 0n ? r + FIELD_SIZE : r;
}

/** Signed amount into the field: negatives as p − |x|. */
export function fieldAmount(x) {
  const v = BigInt(x);
  if (v <= -(1n << 248n) || v >= 1n << 248n) throw new Error("amount out of range");
  return v >= 0n ? v : FIELD_SIZE + v;
}

export function randomField() {
  return bytesToBigInt(randomBytes(32)) % FIELD_SIZE;
}

export function randomScalar() {
  return bytesToBigInt(randomBytes(32)) % BABYJUB.SUBORDER;
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

function toBytes(x, len) {
  const b = typeof x === "string" ? hexToBytes(x) : new Uint8Array(x);
  if (len !== undefined && b.length !== len) throw new Error(`expected ${len} bytes, got ${b.length}`);
  return b;
}

/** uint160(coin address) as the note asset id; 0 for BNB. */
export function assetOf(coin) {
  if (coin === 0 || coin === 0n || coin === undefined || coin === null || coin === ZeroAddress) return 0n;
  if (typeof coin === "string") return BigInt(getAddress(coin));
  return BigInt(coin);
}

const s = (x) => BigInt(x).toString();

// Encrypted blob layout: ephemeral x25519 pubkey (32) || xchacha nonce (24) || ciphertext+tag
const EPH_LEN = 32;
const NONCE_LEN = 24;

function sharedKey(priv, pub) {
  return getBytes(keccak256(x25519.getSharedSecret(priv, pub)));
}

function encryptTo(encPub, bytes) {
  const ephPriv = randomBytes(32);
  const ephPub = x25519.getPublicKey(ephPriv);
  const key = sharedKey(ephPriv, encPub);
  const nonce = randomBytes(NONCE_LEN);
  const ct = xchacha20poly1305(key, nonce).encrypt(bytes);
  return concatBytes(ephPub, nonce, ct);
}

function decryptWith(encPriv, bytes) {
  if (bytes.length < EPH_LEN + NONCE_LEN + 16) throw new Error("ciphertext too short");
  const ephPub = bytes.slice(0, EPH_LEN);
  const nonce = bytes.slice(EPH_LEN, EPH_LEN + NONCE_LEN);
  const ct = bytes.slice(EPH_LEN + NONCE_LEN);
  return xchacha20poly1305(sharedKey(encPriv, ephPub), nonce).decrypt(ct); // throws on auth failure
}

// ----------------------------------------------------------------- Keys (spec §2.2)

/**
 * Key hierarchy. Three capability levels:
 *   spending (ask)            — Keys.fromSeed / fromSignatureAndPassphrase / random
 *   FVK (pk, nk, encPriv)     — Keys.fromFvk: sees incoming notes and spends, cannot spend
 *   address (pk, encPub)      — Keys.fromAddress: can only receive / encrypt
 */
export class Keys {
  constructor({ ask, pk, nk, ovk, encPriv, encPub, seed }) {
    this.seed = seed ? new Uint8Array(seed) : null;
    if (ask !== undefined && ask !== null) {
      this.ask = toField(ask);
      this.pk = poseidon([this.ask]);
      this.nk = poseidon([this.ask, 1n]);
      this.ovk = poseidon([OWNER_TAG, this.ask]);
    } else {
      this.ask = null;
      this.pk = toField(pk);
      this.nk = nk === undefined || nk === null ? null : toField(nk);
      this.ovk = null;
    }
    if (encPriv) {
      this.encPriv = toBytes(encPriv, 32);
      this.encPub = x25519.getPublicKey(this.encPriv);
    } else {
      this.encPriv = null;
      this.encPub = toBytes(encPub, 32);
    }
  }

  /** seed: 32 bytes (Uint8Array or 0x hex). ask = keccak256(seed ‖ "zkbnb2/ask") mod p, encPriv = keccak256(seed ‖ "zkbnb2/enc"). */
  static fromSeed(seed) {
    const sd = toBytes(seed, 32);
    const ask = BigInt(keccak256(concatBytes(sd, toUtf8Bytes(KEY_STRING_ASK)))) % FIELD_SIZE;
    const encPriv = getBytes(keccak256(concatBytes(sd, toUtf8Bytes(KEY_STRING_ENC))));
    return new Keys({ ask, encPriv, seed: sd });
  }

  /** Wallet-derived mode: seed = keccak256(sig ‖ keccak256(utf8(passphrase))). */
  static fromSignatureAndPassphrase(sigHex, passphrase) {
    const sig = toBytes(sigHex);
    if (sig.length < 64) throw new Error("signature too short");
    const ph = getBytes(keccak256(toUtf8Bytes(String(passphrase ?? ""))));
    return Keys.fromSeed(getBytes(keccak256(concatBytes(sig, ph))));
  }

  static random() {
    return Keys.fromSeed(randomBytes(32));
  }

  /** Spending keys directly from ask (tests, dummies). No seed, no deterministic encPriv ⇒ encPriv = keccak(ask). */
  static fromAsk(ask) {
    const a = toField(ask);
    return new Keys({ ask: a, encPriv: getBytes(keccak256(bigIntToBytes32(a))) });
  }

  /** "zkbnb2" + hex32(pk) + hex32(encPub) */
  address() {
    return ADDRESS_PREFIX + bytesToHex(bigIntToBytes32(this.pk)) + bytesToHex(this.encPub);
  }

  static fromAddress(addr) {
    const a = addr.trim();
    if (!a.startsWith(ADDRESS_PREFIX) || a.length !== ADDRESS_PREFIX.length + 128 || a.startsWith(FVK_PREFIX)) {
      throw new Error("invalid zkbnb2 address");
    }
    const hex = a.slice(ADDRESS_PREFIX.length);
    const pk = BigInt("0x" + hex.slice(0, 64));
    if (pk >= FIELD_SIZE) throw new Error("invalid zkbnb2 address: pk out of field");
    return new Keys({ pk, encPub: hexToBytes(hex.slice(64)) });
  }

  /** Full viewing key: "zkbnb2view" + hex32(pk) + hex32(nk) + hex32(encPriv). Sees every incoming note and every spend. */
  fvk() {
    if (!this.canView) throw new Error("no viewing capability");
    return FVK_PREFIX + bytesToHex(bigIntToBytes32(this.pk)) + bytesToHex(bigIntToBytes32(this.nk)) + bytesToHex(this.encPriv);
  }

  static fromFvk(str) {
    const a = str.trim();
    if (!a.startsWith(FVK_PREFIX) || a.length !== FVK_PREFIX.length + 192) throw new Error("invalid zkbnb2 viewing key");
    const hex = a.slice(FVK_PREFIX.length);
    const pk = BigInt("0x" + hex.slice(0, 64));
    const nk = BigInt("0x" + hex.slice(64, 128));
    if (pk >= FIELD_SIZE || nk >= FIELD_SIZE) throw new Error("invalid zkbnb2 viewing key: out of field");
    return new Keys({ pk, nk, encPriv: hexToBytes(hex.slice(128)) });
  }

  get canSpend() {
    return this.ask !== null;
  }

  /** FVK capability: decrypt incoming notes and recompute nullifiers. */
  get canView() {
    return this.nk !== null && this.encPriv !== null;
  }

  /** salt(n) = Poseidon(ovk, n), n ≥ 1. Every handle is one-shot; no salt is special. */
  salt(n) {
    if (this.ovk === null) throw new Error("salt needs the spending key");
    const i = BigInt(n);
    if (i < 1n) throw new Error("handle index starts at 1");
    return poseidon([this.ovk, i]);
  }

  /** handle(n) = Poseidon(HANDLE_TAG, ovk, salt(n)) */
  handle(n) {
    return poseidon([HANDLE_TAG, this.ovk, this.salt(n)]);
  }

  encrypt(bytes) {
    return encryptTo(this.encPub, bytes);
  }

  decrypt(bytes) {
    if (this.encPriv === null) throw new Error("address-only keys cannot decrypt");
    return decryptWith(this.encPriv, bytes);
  }
}

/** handle from an owner key and a salt (what the circuit computes). */
export function handleOf(ovk, salt) {
  return poseidon([HANDLE_TAG, ovk, salt]);
}

/** k = keccak256("zkbnb2/elgamal" ‖ ask ‖ inputNullifier[0]) mod l — deterministic, unique per intent (spec §2.7). */
export function elgamalK(ask, nullifier0) {
  const h = keccak256(concatBytes(toUtf8Bytes(KEY_STRING_ELGAMAL), bigIntToBytes32(ask), bigIntToBytes32(nullifier0)));
  return BigInt(h) % BABYJUB.SUBORDER;
}

// ----------------------------------------------------------------- Note (spec §2.1)

export class Note {
  /**
   * @param {{assetId: bigint|string|number, amount: bigint|string|number, rpt0?: bigint, blinding?: bigint, keys: Keys, index?: number|null}} o
   */
  constructor({ assetId, amount, rpt0, blinding, keys, index }) {
    if (!(keys instanceof Keys)) throw new Error("Note needs Keys");
    this.assetId = assetOf(assetId);
    this.amount = BigInt(amount);
    if (this.amount < 0n || this.amount >= 1n << 128n) throw new Error("amount out of range (< 2^128)");
    this.rpt0 = rpt0 === undefined || rpt0 === null ? 0n : toField(rpt0);
    this.blinding = blinding === undefined || blinding === null ? randomField() : toField(blinding);
    this.keys = keys;
    this.index = index === undefined || index === null ? null : Number(index);
    this._inner = null;
    this._commitment = null;
  }

  get isCoin() {
    return this.assetId !== 0n;
  }

  inner() {
    if (this._inner === null) this._inner = poseidon([this.assetId, this.rpt0, this.blinding]);
    return this._inner;
  }

  commitment() {
    if (this._commitment === null) this._commitment = poseidon([this.amount, this.keys.pk, this.inner()]);
    return this._commitment;
  }

  /** nf = Poseidon(commitment, leafIndex, nk) — needs the FVK (nk), not the spending key. */
  nullifier(index) {
    const idx = index === undefined ? this.index : Number(index);
    if (idx === null || idx === undefined) throw new Error("Note index unknown; cannot compute nullifier");
    if (this.keys.nk === null) throw new Error("nullifier needs nk (FVK)");
    return poseidon([this.commitment(), BigInt(idx), this.keys.nk]);
  }

  /** abi.encode(uint256 assetId, uint256 amount, uint256 blinding, uint256 rpt0) (128 bytes), encrypted to the owner. */
  encrypt() {
    const plain = getBytes(abi.encode(["uint256", "uint256", "uint256", "uint256"], [this.assetId, this.amount, this.blinding, this.rpt0]));
    return this.keys.encrypt(plain);
  }

  /** Throws if the blob is not addressed to `keys`. */
  static decrypt(keys, bytes, index) {
    const data = typeof bytes === "string" ? hexToBytes(bytes) : bytes;
    const plain = keys.decrypt(data);
    if (plain.length !== 128) throw new Error("bad note plaintext");
    const [assetId, amount, blinding, rpt0] = abi.decode(["uint256", "uint256", "uint256", "uint256"], plain);
    return new Note({ assetId, amount, blinding, rpt0, keys, index });
  }
}

/** Zero-amount padding input: fresh random key so its nullifier is unique; skips the Merkle check in-circuit. */
export function dummyNote(keys = Keys.random(), index = 0) {
  return new Note({ assetId: 0n, amount: 0n, rpt0: 0n, keys, index });
}

// ----------------------------------------------------------------- leaf kinds (spec §2.1)

/** Poseidon(INTENT_TAG, coin, dir) */
export function intentAsset(coin, dir) {
  return poseidon([INTENT_TAG, assetOf(coin), BigInt(dir)]);
}

/** Poseidon(coin, epoch, dir) */
export function epochKey(coin, seq, dir) {
  return poseidon([assetOf(coin), BigInt(seq), BigInt(dir)]);
}

/** Poseidon(commitment, epochKey) — stamped by DarkCurve.submitIntent */
export function intentLeaf(commitment, epochKeyValue) {
  return poseidon([commitment, epochKeyValue]);
}

/** Poseidon(totalIn, totalOut, Poseidon(totalRefund, rptAtSettle)) */
export function totalsHash({ totalIn, totalOut, totalRefund, rptAtSettle }) {
  return poseidon([BigInt(totalIn), BigInt(totalOut), poseidon([BigInt(totalRefund), BigInt(rptAtSettle)])]);
}

/** Poseidon(RESULT_TAG, epochKey, totalsHash) — inserted by the contract at open / void */
export function resultLeaf(epochKeyValue, totals) {
  return poseidon([RESULT_TAG, epochKeyValue, totalsHash(totals)]);
}

/** The result leaf of a voided epoch: (1, 0, 1, accRpt) ⇒ every claim refunds 100 % in the escrowed asset. */
export function voidTotals(rptAtSettle) {
  return { totalIn: 1n, totalOut: 0n, totalRefund: 1n, rptAtSettle: BigInt(rptAtSettle) };
}

// ----------------------------------------------------------------- MerkleTree (spec §2.1, §4.1)

/**
 * Mirrors MerkleTreeWithHistoryV2: zero leaf ZERO_LEAF, Poseidon(left, right), 4-leaf chunks, and roots that are
 * known only at checkpoints. The empty root is checkpointed at construction (as the contract constructor does).
 * `pathAt(index, indexAfter)` yields the Merkle path valid for a checkpoint root, not just the current root.
 */
export class MerkleTree {
  constructor(levels = LEVELS, leaves = []) {
    this.levels = levels;
    this.capacity = 2 ** levels;
    this._zeros = [ZERO_LEAF];
    for (let i = 1; i <= levels; i++) this._zeros.push(poseidon([this._zeros[i - 1], this._zeros[i - 1]]));
    this._layers = Array.from({ length: levels + 1 }, () => []);
    this.checkpoints = []; // [{root, indexAfter}]
    this._known = new Map(); // root -> indexAfter
    this.bulkInsert(leaves);
    this.checkpoint();
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

  get nextIndex() {
    return this._layers[0].length;
  }

  leaf(index) {
    return this._layers[0][index];
  }

  _insertOne(leaf) {
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

  /** One transaction = one chunk of ≤ 4 leaves, unused slots ZERO_LEAF. Returns the index of the first slot. */
  insertChunk(leaves) {
    if (!Array.isArray(leaves) || leaves.length === 0 || leaves.length > CHUNK) throw new Error(`chunk must hold 1..${CHUNK} leaves`);
    if (this.nextIndex % CHUNK !== 0) throw new Error("nextIndex is not chunk-aligned");
    if (this.nextIndex + CHUNK > this.capacity) throw new Error("tree full");
    const start = this.nextIndex;
    const padded = leaves.map(toField);
    while (padded.length < CHUNK) padded.push(ZERO_LEAF);
    for (const l of padded) this._insertOne(l);
    return start;
  }

  /** Raw bulk insert (sync from a bundle; leaves already include the ZERO_LEAF padding). */
  bulkInsert(leaves) {
    if (leaves.length === 0) return;
    if (this._layers[0].length + leaves.length > this.capacity) throw new Error("tree full");
    for (const leaf of leaves) this._layers[0].push(toField(leaf));
    for (let level = 0; level < this.levels; level++) {
      const src = this._layers[level];
      const dst = [];
      for (let i = 0; i < src.length; i += 2) dst.push(poseidon([src[i], src[i + 1] ?? this._zeros[level]]));
      this._layers[level + 1] = dst;
    }
  }

  root() {
    return this._layers[this.levels][0] ?? this._zeros[this.levels];
  }

  /** Node (level, i) of the tree as it was with only the first `n` leaves. */
  _nodeAt(level, i, n) {
    const start = i * 2 ** level;
    if (start >= n) return this._zeros[level];
    if (level === 0) return this._layers[0][i];
    if (start + 2 ** level <= n) return this._layers[level][i]; // full subtree: append-only, never changes
    return poseidon([this._nodeAt(level - 1, 2 * i, n), this._nodeAt(level - 1, 2 * i + 1, n)]);
  }

  /** Root after the first `n` leaves. */
  rootAt(n) {
    if (n < 0 || n > this.length) throw new Error("indexAfter out of range");
    return this._nodeAt(this.levels, 0, n);
  }

  /** Merkle path for `index` against the root in force after `n` leaves (a checkpoint). */
  pathAt(index, n) {
    if (index < 0 || index >= n) throw new Error("leaf not yet in the tree at that checkpoint");
    if (n > this.length) throw new Error("indexAfter out of range");
    const pathElements = [];
    let cur = index;
    for (let level = 0; level < this.levels; level++) {
      pathElements.push(this._nodeAt(level, cur ^ 1, n));
      cur >>= 1;
    }
    return { pathElements, pathIndices: index };
  }

  path(index) {
    return this.pathAt(index, this.length);
  }

  /** Records the current root as known (what the contract does at a period boundary / `checkpoint()`). */
  checkpoint() {
    const root = this.root();
    const indexAfter = this.length;
    if (!this._known.has(root)) {
      this._known.set(root, indexAfter);
      this.checkpoints.push({ root, indexAfter });
    }
    return { root, indexAfter };
  }

  /** Adopts checkpoints from a sync manifest; each root must match this tree's history. */
  addCheckpoints(list) {
    for (const c of list) {
      const root = toField(c.root);
      const indexAfter = Number(c.indexAfter);
      if (this.rootAt(indexAfter) !== root) throw new Error(`checkpoint root mismatch at ${indexAfter}`);
      if (!this._known.has(root)) {
        this._known.set(root, indexAfter);
        this.checkpoints.push({ root, indexAfter });
      }
    }
    this.checkpoints.sort((a, b) => a.indexAfter - b.indexAfter);
  }

  isKnownRoot(root) {
    return this._known.has(toField(root));
  }

  /** indexAfter of a known root, or -1. */
  indexAfter(root) {
    const v = this._known.get(toField(root));
    return v === undefined ? -1 : v;
  }

  lastCheckpoint() {
    return this.checkpoints[this.checkpoints.length - 1];
  }

  indexOf(leaf) {
    const v = toField(leaf);
    return this._layers[0].findIndex((x) => x === v);
  }
}

/** Resolves the root a proof is made against: the given one (must be a checkpoint) or the latest checkpoint. */
function resolveRoot(tree, root) {
  if (!(tree instanceof MerkleTree)) throw new Error("tree must be a MerkleTree");
  const r = root === undefined || root === null ? tree.lastCheckpoint().root : toField(root);
  const n = tree.indexAfter(r);
  if (n < 0) throw new Error("root is not a checkpoint; proofs are only accepted against checkpoint roots");
  return { root: r, indexAfter: n };
}

// ----------------------------------------------------------------- ext data hashing (WORKPLAN §1.2)

function hashAbi(type, value) {
  return BigInt(keccak256(abi.encode([type], [value]))) % FIELD_SIZE;
}

/** keccak256(abi.encode(ExtData)) mod p — GrovePool.ExtData */
export function hashExtData2(e) {
  return hashAbi(EXT_DATA2_TYPE, [
    getAddress(e.recipient),
    BigInt(e.extAmountBnb),
    BigInt(e.extAmountCoin),
    getAddress(e.relayer),
    BigInt(e.fee),
    e.payload ?? "0x",
    e.encryptedOutputs,
  ]);
}

/** keccak256(abi.encode(IntentExt)) mod p — DarkCurve.IntentExt */
export function hashIntentExt(e) {
  return hashAbi(INTENT_EXT_TYPE, [getAddress(e.relayer), BigInt(e.fee), e.encryptedOutputs]);
}

/** keccak256(abi.encode(ClaimExt)) mod p — DarkCurve.ClaimExt */
export function hashClaimExt(e) {
  return hashAbi(CLAIM_EXT_TYPE, [getAddress(e.relayer), e.encryptedOutputs]);
}

// ----------------------------------------------------------------- Baby Jubjub (pure BigInt, extended twisted Edwards)

const P = FIELD_SIZE;
const { A: BJ_A, D: BJ_D } = BABYJUB;

function mod(a) {
  const r = a % P;
  return r < 0n ? r + P : r;
}

function modInv(a) {
  // extended Euclid
  let t = 0n;
  let newT = 1n;
  let r = P;
  let newR = mod(a);
  if (newR === 0n) throw new Error("inverse of zero");
  while (newR !== 0n) {
    const q = r / newR;
    [t, newT] = [newT, t - q * newT];
    [r, newR] = [newR, r - q * newR];
  }
  return mod(t);
}

/** Montgomery's trick: inverses of many field elements with one inversion. */
export function batchInverse(xs) {
  const n = xs.length;
  const out = new Array(n);
  if (n === 0) return out;
  const prefix = new Array(n);
  let acc = 1n;
  for (let i = 0; i < n; i++) {
    prefix[i] = acc;
    acc = (acc * xs[i]) % P;
  }
  let inv = modInv(acc);
  for (let i = n - 1; i >= 0; i--) {
    out[i] = (inv * prefix[i]) % P;
    inv = (inv * xs[i]) % P;
  }
  return out;
}

const EXT_ID = Object.freeze({ X: 0n, Y: 1n, T: 0n, Z: 1n });

function toExt(p) {
  const x = mod(BigInt(p[0]));
  const y = mod(BigInt(p[1]));
  return { X: x, Y: y, T: (x * y) % P, Z: 1n };
}

function extToAffine(e) {
  const zi = modInv(e.Z);
  return [(e.X * zi) % P, (e.Y * zi) % P];
}

// add-2008-hwcd (twisted Edwards, a != -1)
function extAdd(p, q) {
  const a = (p.X * q.X) % P;
  const b = (p.Y * q.Y) % P;
  const c = (((BJ_D * p.T) % P) * q.T) % P;
  const d = (p.Z * q.Z) % P;
  const e = mod((p.X + p.Y) * (q.X + q.Y) - a - b);
  const f = mod(d - c);
  const g = d + c;
  const h = mod(b - BJ_A * a);
  return { X: (e * f) % P, Y: (g * h) % P, T: (e * h) % P, Z: (f * g) % P };
}

function extNeg(p) {
  return { X: mod(-p.X), Y: p.Y, T: mod(-p.T), Z: p.Z };
}

function extMul(k, p) {
  let r = EXT_ID;
  let base = p;
  let n = BigInt(k);
  if (n < 0n) throw new Error("negative scalar");
  while (n > 0n) {
    if (n & 1n) r = extAdd(r, base);
    base = extAdd(base, base);
    n >>= 1n;
  }
  return r;
}

function extEq(p, q) {
  // X1/Z1 == X2/Z2 and Y1/Z1 == Y2/Z2
  return (p.X * q.Z) % P === (q.X * p.Z) % P && (p.Y * q.Z) % P === (q.Y * p.Z) % P;
}

export const BASE8 = BABYJUB.BASE8;
export const IDENTITY = Object.freeze([0n, 1n]);

export function babyAdd(p, q) {
  return extToAffine(extAdd(toExt(p), toExt(q)));
}

export function babyNeg(p) {
  return [mod(-BigInt(p[0])), mod(BigInt(p[1]))];
}

export function babyMul(k, p) {
  return extToAffine(extMul(k, toExt(p)));
}

export function babyEq(p, q) {
  return mod(BigInt(p[0])) === mod(BigInt(q[0])) && mod(BigInt(p[1])) === mod(BigInt(q[1]));
}

/** a·x² + y² == 1 + d·x²·y² */
export function isOnCurve(p) {
  const x = mod(BigInt(p[0]));
  const y = mod(BigInt(p[1]));
  const x2 = (x * x) % P;
  const y2 = (y * y) % P;
  return mod(BJ_A * x2 + y2) === mod(1n + (((BJ_D * x2) % P) * y2) % P);
}

export function inSubgroup(p) {
  return isOnCurve(p) && extEq(extMul(BABYJUB.SUBORDER, toExt(p)), EXT_ID);
}

/** Affine (x, y) -> extended (X, Y, T, Z) with Z = 1 — the contract's Point struct for a single ciphertext. */
export function toExtended(p) {
  const e = toExt(p);
  return { x: e.X, y: e.Y, t: e.T, z: e.Z };
}

/** Extended (x, y, t, z) -> affine [x, y]. */
export function toAffine(e) {
  return extToAffine({ X: BigInt(e.x), Y: BigInt(e.y), T: BigInt(e.t), Z: BigInt(e.z) });
}

// ----------------------------------------------------------------- ElGamal (spec §2.7)

/** ecPk = ecSk·B8 */
export function elgamalPublicKey(sk) {
  const k = BigInt(sk);
  if (k <= 0n || k >= BABYJUB.SUBORDER) throw new Error("ecSk out of range");
  return babyMul(k, BASE8);
}

/** Coordinator key pair; sk uniform in [1, l). */
export function elgamalKeypair(sk = randomScalar()) {
  const k = BigInt(sk);
  return { sk: k, pk: elgamalPublicKey(k) };
}

/**
 * C1 = k·B8, C2 = u·B8 + k·pk.  `k` MUST come from elgamalK (deterministic); it is a parameter so tests and the
 * circuit witness can be built from the same value — never pass a random k.
 */
export function elgamalEncrypt(u, pk, k) {
  const uu = BigInt(u);
  const kk = BigInt(k);
  if (uu < 0n || uu >= 1n << BigInt(SUM_BITS)) throw new Error("u out of range");
  if (kk <= 0n || kk >= BABYJUB.SUBORDER) throw new Error("k out of range");
  if (!isOnCurve(pk)) throw new Error("pk not on curve");
  const c1 = babyMul(kk, BASE8);
  const c2 = extToAffine(extAdd(extMul(uu, toExt(BASE8)), extMul(kk, toExt(pk))));
  return { c1, c2 };
}

/** Homomorphic sum: (C1a + C1b, C2a + C2b) encrypts u_a + u_b. */
export function elgamalAddCiphertexts(a, b) {
  return { c1: babyAdd(a.c1, b.c1), c2: babyAdd(a.c2, b.c2) };
}

export function elgamalSum(list) {
  return list.reduce((acc, c) => elgamalAddCiphertexts(acc, c), { c1: [0n, 1n], c2: [0n, 1n] });
}

/** M = C2 − sk·C1 = u·B8 (the point; the Coordinator then solves the discrete log with BSGS). */
export function elgamalDecryptPoint({ c1, c2 }, sk) {
  return extToAffine(extAdd(toExt(c2), extNeg(extMul(BigInt(sk), toExt(c1)))));
}

// ----------------------------------------------------------------- BSGS (spec §2.7)

/**
 * Baby-step table of x(j·B8) for j in [0, 2^bits), keyed by the low `truncate` bytes of x in an open-addressing
 * hash table (BigUint64Array keys, Uint32Array values = j + 1). Candidates are re-verified by a full scalar
 * multiplication in bsgsSolve, so truncation collisions cost time, never correctness.
 * Memory: 2^(bits+1) × 12 bytes (24 MB for 20 bits, 384 MB for 24 bits). Build time is reported in `.buildMs`.
 */
export function bsgsTable(bits = 20, truncate = 8) {
  if (bits < 1 || bits > 26) throw new Error("bits out of range");
  if (truncate < 1 || truncate > 8) throw new Error("truncate out of range (bytes, ≤ 8)");
  const t0 = Date.now();
  const m = 2 ** bits;
  const slots = 2 ** (bits + 1);
  const slotMask = slots - 1;
  const keyMask = (1n << BigInt(8 * truncate)) - 1n;
  const keys = new BigUint64Array(slots);
  const vals = new Uint32Array(slots);
  const base = toExt(BASE8);
  const BLOCK = 512;
  let cur = EXT_ID;
  const block = [];
  const insert = (key, j) => {
    let h = Number(key & BigInt(slotMask));
    while (vals[h] !== 0) h = (h + 1) & slotMask;
    keys[h] = key;
    vals[h] = j + 1;
  };
  for (let j = 0; j < m; j += BLOCK) {
    block.length = 0;
    for (let i = 0; i < BLOCK && j + i < m; i++) {
      block.push(cur);
      cur = extAdd(cur, base);
    }
    const zinv = batchInverse(block.map((e) => e.Z));
    for (let i = 0; i < block.length; i++) {
      const x = (block[i].X * zinv[i]) % P;
      insert(x & keyMask, j + i);
    }
  }
  return { bits, truncate, m, keys, vals, slotMask, keyMask, buildMs: Date.now() - t0 };
}

function bsgsLookup(table, key) {
  const out = [];
  let h = Number(key & BigInt(table.slotMask));
  while (table.vals[h] !== 0) {
    if (table.keys[h] === key) out.push(table.vals[h] - 1);
    h = (h + 1) & table.slotMask;
  }
  return out;
}

/**
 * Solves point == u·B8 for u in [0, 2^maxBits) with the given baby-step table. Giant steps are batched (one field
 * inversion per 256 steps). Returns null when no u in range matches.
 */
export function bsgsSolve(point, table, maxBits = SUM_BITS) {
  const target = toExt(point);
  if (extEq(target, EXT_ID)) return 0n;
  const m = BigInt(table.m);
  const giants = Number((1n << BigInt(maxBits)) / m) + 1;
  const negG = extNeg(extMul(m, toExt(BASE8)));
  const BLOCK = 256;
  let cur = target;
  for (let i0 = 0; i0 < giants; i0 += BLOCK) {
    const pts = [];
    for (let i = 0; i < BLOCK && i0 + i < giants; i++) {
      pts.push(cur);
      cur = extAdd(cur, negG);
    }
    const zinv = batchInverse(pts.map((e) => e.Z));
    for (let i = 0; i < pts.length; i++) {
      const x = (pts[i].X * zinv[i]) % P;
      for (const j of bsgsLookup(table, x & table.keyMask)) {
        const u = BigInt(i0 + i) * m + BigInt(j);
        if (u < 1n << BigInt(maxBits) && extEq(extMul(u, toExt(BASE8)), target)) return u;
      }
    }
  }
  return null;
}

// ----------------------------------------------------------------- proving

function artifact(x) {
  if (typeof x === "string") return x; // file path (Node) — in the browser pass a Uint8Array
  if (x instanceof Uint8Array) return { type: "mem", data: x };
  if (x instanceof ArrayBuffer) return { type: "mem", data: new Uint8Array(x) };
  if (x && x.type === "mem") return x;
  throw new Error("wasm/zkey must be a path string or Uint8Array");
}

/** snarkjs proof -> GrovePool.Proof field layout (b coordinates swapped as the Solidity verifier expects). */
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

/** Dividend settlement of a spent coin note: floor(amount · (accRpt − rpt0) / 1e18) and the remainder. */
export function dividendOwed(note, accRpt) {
  const acc = BigInt(accRpt);
  const delta = acc - note.rpt0;
  if (delta < 0n) throw new Error("note rpt0 is newer than accRpt");
  if (delta >= 1n << 128n) throw new Error("accRpt delta out of range");
  const prod = note.amount * delta;
  return { delta, q: prod / RPT_SCALE, r: prod % RPT_SCALE };
}

/** Shared input-side witness (transfer and intent): keys, paths against the checkpoint, dividends. */
function inputWitness(tree, indexAfter, root, ins, coinId, accRpt) {
  const w = { inAsset: [], inAmount: [], inRpt0: [], inBlinding: [], inAsk: [], inPathIndices: [], inPathElements: [], inQ: [], inR: [] };
  const nullifiers = [];
  let bnbIn = 0n;
  let coinIn = 0n;
  let owed = 0n;
  for (const note of ins) {
    if (!note.keys.canSpend) throw new Error("input note keys cannot spend");
    if (note.assetId !== 0n && note.assetId !== coinId) throw new Error("input asset is neither BNB nor the transaction coin");
    let path;
    if (note.amount > 0n) {
      if (note.index === null) throw new Error("input note has no leaf index");
      if (tree.leaf(note.index) !== note.commitment()) throw new Error(`input commitment not found at leaf ${note.index}`);
      path = tree.pathAt(note.index, indexAfter);
    } else {
      if (note.index === null) note.index = 0;
      path = { pathIndices: note.index, pathElements: new Array(tree.levels).fill(0n) };
    }
    const div = dividendOwed(note, accRpt);
    if (note.isCoin) {
      coinIn += note.amount;
      owed += div.q;
    } else bnbIn += note.amount;
    w.inAsset.push(s(note.assetId));
    w.inAmount.push(s(note.amount));
    w.inRpt0.push(s(note.rpt0));
    w.inBlinding.push(s(note.blinding));
    w.inAsk.push(s(note.keys.ask));
    w.inPathIndices.push(s(path.pathIndices));
    w.inPathElements.push(path.pathElements.map(s));
    w.inQ.push(s(div.q));
    w.inR.push(s(div.r));
    nullifiers.push(note.nullifier());
  }
  if (nullifiers.length === 2 && nullifiers[0] === nullifiers[1]) throw new Error("duplicate input nullifier");
  return { w, nullifiers, bnbIn, coinIn, owed };
}

/** Change/output notes must carry rpt0 = accRpt when they are coin notes, 0 otherwise (the circuit derives it). */
function checkOutputs(outs, coinId, accRpt) {
  let bnbOut = 0n;
  let coinOut = 0n;
  for (const note of outs) {
    if (note.assetId !== 0n && note.assetId !== coinId) throw new Error("output asset is neither BNB nor the transaction coin");
    const want = note.isCoin ? BigInt(accRpt) : 0n;
    if (note.rpt0 !== want) throw new Error(`output rpt0 must be ${want} for this asset (got ${note.rpt0})`);
    if (note.isCoin) coinOut += note.amount;
    else bnbOut += note.amount;
  }
  return { bnbOut, coinOut };
}

/**
 * transfer.circom witness + proof for GrovePool.transact.
 * @param {{tree: MerkleTree, root?: bigint, inputs?: Note[], outputs?: Note[], coin?: string|bigint, accRpt?: bigint,
 *          extData?: {recipient?: string, extAmountBnb?: bigint, extAmountCoin?: bigint, relayer?: string, fee?: bigint, payload?: string},
 *          handle?: bigint, handleSalt?: bigint, claimAmount?: bigint, handleKeys?: Keys, wasm, zkey}} o
 */
export async function prepareTransfer({
  tree,
  root,
  inputs = [],
  outputs = [],
  coin = 0n,
  accRpt = 0n,
  extData = {},
  handle = 0n,
  handleSalt,
  claimAmount = 0n,
  handleKeys,
  wasm,
  zkey,
}) {
  if (inputs.length > 2 || outputs.length > 3) throw new Error("max 2 inputs and 3 outputs");
  const { root: rootValue, indexAfter } = resolveRoot(tree, root);
  const coinId = assetOf(coin);
  const acc = BigInt(accRpt);
  if (coinId === 0n && acc !== 0n) throw new Error("accRpt must be 0 when no coin is involved");
  const ext = {
    recipient: getAddress(extData.recipient ?? ZeroAddress),
    extAmountBnb: BigInt(extData.extAmountBnb ?? 0n),
    extAmountCoin: BigInt(extData.extAmountCoin ?? 0n),
    relayer: getAddress(extData.relayer ?? ZeroAddress),
    fee: BigInt(extData.fee ?? 0n),
    payload: extData.payload ?? "0x",
  };
  if (coinId === 0n && ext.extAmountCoin !== 0n) throw new Error("extAmountCoin needs a coin");
  if (ext.fee > 0n && ext.relayer === ZeroAddress) throw new Error("fee needs a relayer");
  if ((ext.extAmountBnb < 0n || ext.extAmountCoin < 0n) && ext.recipient === ZeroAddress) throw new Error("withdraw needs a recipient");

  const ins = inputs.slice();
  while (ins.length < 2) ins.push(dummyNote());
  const outs = outputs.slice();
  while (outs.length < 3) outs.push(new Note({ assetId: 0n, amount: 0n, keys: Keys.random() }));

  const claim = BigInt(claimAmount);
  const h = toField(handle);
  let hAsk = 0n;
  let hSalt = 0n;
  if (h !== 0n) {
    if (!handleKeys || !handleKeys.canSpend) throw new Error("handle claim needs the owner's spending keys");
    if (handleSalt === undefined || handleSalt === null) throw new Error("handle claim needs handleSalt");
    hAsk = handleKeys.ask;
    hSalt = toField(handleSalt);
    if (handleOf(handleKeys.ovk, hSalt) !== h) throw new Error("handle does not match ovk/salt");
  } else if (claim !== 0n) throw new Error("claimAmount needs a handle");

  const inW = inputWitness(tree, indexAfter, rootValue, ins, coinId, acc);
  const outW = checkOutputs(outs, coinId, acc);
  const bnbNet = ext.extAmountBnb - ext.fee + claim;
  if (inW.bnbIn + inW.owed + bnbNet !== outW.bnbOut) {
    throw new Error(`BNB unbalanced: in ${inW.bnbIn} + owed ${inW.owed} + ext ${bnbNet} != out ${outW.bnbOut}`);
  }
  if (inW.coinIn + ext.extAmountCoin !== outW.coinOut) {
    throw new Error(`coin unbalanced: in ${inW.coinIn} + ext ${ext.extAmountCoin} != out ${outW.coinOut}`);
  }

  const encryptedOutputs = outs.map((o) => hexlify(o.encrypt()));
  const extFull = { ...ext, encryptedOutputs };
  const extDataHash = hashExtData2(extFull);
  const publicAmount = fieldAmount(bnbNet);
  const publicAmountCoin = fieldAmount(ext.extAmountCoin);

  const input = {
    root: s(rootValue),
    publicAmount: s(publicAmount),
    coin: s(coinId),
    publicAmountCoin: s(publicAmountCoin),
    accRpt: s(acc),
    handle: s(h),
    claimAmount: s(claim),
    extDataHash: s(extDataHash),
    inputNullifier: inW.nullifiers.map(s),
    outputCommitment: outs.map((o) => s(o.commitment())),
    ...inW.w,
    outAsset: outs.map((o) => s(o.assetId)),
    outAmount: outs.map((o) => s(o.amount)),
    outPubkey: outs.map((o) => s(o.keys.pk)),
    outBlinding: outs.map((o) => s(o.blinding)),
    handleAsk: s(hAsk),
    handleSalt: s(hSalt),
  };

  const { proof: snarkProof, publicSignals } = await groth16.fullProve(input, artifact(wasm), artifact(zkey));
  const pub = {
    root: rootValue,
    publicAmount,
    coin: coinId === 0n ? ZeroAddress : getAddress(toBeHex(coinId, 20)),
    publicAmountCoin,
    accRpt: acc,
    handle: h,
    claimAmount: claim,
    extDataHash: toBeHex(extDataHash, 32),
    inputNullifiers: inW.nullifiers,
    outputCommitments: outs.map((o) => o.commitment()),
  };
  return { proof: proofToSolidity(snarkProof), pub, extData: extFull, publicSignals, snarkProof, inputs: ins, outputs: outs, witness: input };
}

/** UNIT and MIN_U for a direction. */
export function unitFor(dir) {
  const d = Number(dir);
  if (d === DIR.BUY) return { unit: UNIT_BNB, minU: MIN_U_BNB };
  if (d === DIR.SELL || d === DIR.HARVEST) return { unit: UNIT_TOKEN, minU: MIN_U_TOKEN };
  throw new Error("dir must be 0, 1 or 2");
}

/**
 * intent.circom witness + proof for DarkCurve.submitIntent.
 * @param {{tree: MerkleTree, root?: bigint, inputs: Note[], coin: string|bigint, dir: 0|1|2, u: bigint, changeOutputs?: Note[],
 *          ecPk: [bigint, bigint], accRpt?: bigint, extData?: {relayer?: string, fee?: bigint}, intentKeys?: Keys,
 *          intentBlinding?: bigint, wasm, zkey}} o
 */
export async function prepareIntent({ tree, root, inputs = [], coin, dir, u, changeOutputs = [], ecPk, accRpt = 0n, extData = {}, intentKeys, intentBlinding, wasm, zkey }) {
  if (inputs.length < 1 || inputs.length > 2) throw new Error("1 or 2 inputs");
  if (changeOutputs.length > 2) throw new Error("max 2 change outputs");
  const { root: rootValue, indexAfter } = resolveRoot(tree, root);
  const coinId = assetOf(coin);
  if (coinId === 0n) throw new Error("intent needs a coin");
  const d = Number(dir);
  const { unit, minU } = unitFor(d);
  const uu = BigInt(u);
  if (uu < minU) throw new Error(`u below MIN_U (${minU})`);
  if (uu >= 1n << BigInt(U_BITS)) throw new Error("u too large (< 2^32)");
  if (!inSubgroup(ecPk)) throw new Error("ecPk is not in the Baby Jubjub subgroup");
  const acc = BigInt(accRpt);
  const ext = { relayer: getAddress(extData.relayer ?? ZeroAddress), fee: BigInt(extData.fee ?? 0n) };
  if (ext.fee > 0n && ext.relayer === ZeroAddress) throw new Error("fee needs a relayer");

  const ins = inputs.slice();
  while (ins.length < 2) ins.push(dummyNote());
  const chg = changeOutputs.slice();
  while (chg.length < 2) chg.push(new Note({ assetId: 0n, amount: 0n, keys: Keys.random() }));

  const isBuy = d === DIR.BUY;
  const out0Amount = uu * unit;
  const out0 = new Note({ assetId: intentAsset(coinId, d), amount: out0Amount, rpt0: 0n, blinding: intentBlinding, keys: intentKeys ?? ins[0].keys });

  const inW = inputWitness(tree, indexAfter, rootValue, ins, coinId, acc);
  const chgW = checkOutputs(chg, coinId, acc);
  const bnbNet = -ext.fee - INTENT_FEE;
  const bnbRight = chgW.bnbOut + (isBuy ? out0Amount : 0n);
  const coinRight = chgW.coinOut + (isBuy ? 0n : out0Amount);
  if (inW.bnbIn + inW.owed + bnbNet !== bnbRight) throw new Error(`BNB unbalanced: in ${inW.bnbIn} + owed ${inW.owed} - fees ${-bnbNet} != ${bnbRight}`);
  if (inW.coinIn !== coinRight) throw new Error(`coin unbalanced: in ${inW.coinIn} != ${coinRight}`);

  const k = elgamalK(ins[0].keys.ask, inW.nullifiers[0]);
  const { c1, c2 } = elgamalEncrypt(uu, ecPk, k);

  const outs = [out0, ...chg];
  const encryptedOutputs = outs.map((o) => hexlify(o.encrypt()));
  const extFull = { ...ext, encryptedOutputs };
  const extDataHash = hashIntentExt(extFull);
  const publicAmount = fieldAmount(bnbNet);

  const input = {
    root: s(rootValue),
    publicAmount: s(publicAmount),
    coin: s(coinId),
    accRpt: s(acc),
    dir: s(d),
    ecPk: ecPk.map(s),
    C1: c1.map(s),
    C2: c2.map(s),
    extDataHash: s(extDataHash),
    inputNullifier: inW.nullifiers.map(s),
    outputCommitment: outs.map((o) => s(o.commitment())),
    ...inW.w,
    chgAsset: chg.map((o) => s(o.assetId)),
    chgAmount: chg.map((o) => s(o.amount)),
    chgPubkey: chg.map((o) => s(o.keys.pk)),
    chgBlinding: chg.map((o) => s(o.blinding)),
    u: s(uu),
    k: s(k),
    out0Pubkey: s(out0.keys.pk),
    out0Blinding: s(out0.blinding),
  };

  const { proof: snarkProof, publicSignals } = await groth16.fullProve(input, artifact(wasm), artifact(zkey));
  const pub = {
    root: rootValue,
    publicAmount,
    coin: getAddress(toBeHex(coinId, 20)),
    accRpt: acc,
    dir: d,
    ecPk: [BigInt(ecPk[0]), BigInt(ecPk[1])],
    c1,
    c2,
    extDataHash: toBeHex(extDataHash, 32),
    inputNullifiers: inW.nullifiers,
    outputCommitments: outs.map((o) => o.commitment()),
  };
  return { proof: proofToSolidity(snarkProof), pub, extData: extFull, publicSignals, snarkProof, inputs: ins, outputs: outs, intentNote: out0, k, witness: input };
}

/** Pro-rata shares of an epoch: floor(a·totalOut/totalIn) and floor(a·totalRefund/totalIn). */
export function claimShares(a, totals) {
  const aa = BigInt(a);
  const tIn = BigInt(totals.totalIn);
  if (tIn === 0n) throw new Error("totalIn is 0");
  const po = aa * BigInt(totals.totalOut);
  const pr = aa * BigInt(totals.totalRefund);
  return { q: po / tIn, r: po % tIn, qr: pr / tIn, rr: pr % tIn };
}

/**
 * claim.circom witness + proof for DarkCurve.claim.
 * @param {{tree: MerkleTree, root?: bigint, intent: {note: Note, leafIndex: number, coin: string|bigint, seq: number, dir: 0|1|2},
 *          result: {totals: {totalIn, totalOut, totalRefund, rptAtSettle}, leafIndex: number},
 *          outputs?: [{keys?: Keys, blinding?: bigint}, {keys?: Keys, blinding?: bigint}], extData?: {relayer?: string}, wasm, zkey}} o
 */
export async function prepareClaim({ tree, root, intent, result, outputs = [], extData = {}, wasm, zkey }) {
  const { root: rootValue, indexAfter } = resolveRoot(tree, root);
  const note = intent.note;
  if (!note.keys.canSpend) throw new Error("claim needs the intent owner's spending keys");
  const coinId = assetOf(intent.coin);
  const d = Number(intent.dir);
  unitFor(d);
  const isBuy = d === DIR.BUY;
  if (note.assetId !== intentAsset(coinId, d) || note.rpt0 !== 0n) throw new Error("note is not an intent note for (coin, dir)");
  if (note.amount >= 1n << 96n) throw new Error("intent amount exceeds 96 bits");

  const ek = epochKey(coinId, intent.seq, d);
  const leaf = intentLeaf(note.commitment(), ek);
  if (tree.leaf(intent.leafIndex) !== leaf) throw new Error(`stamped intent leaf not found at ${intent.leafIndex}`);
  const totals = {
    totalIn: BigInt(result.totals.totalIn),
    totalOut: BigInt(result.totals.totalOut),
    totalRefund: BigInt(result.totals.totalRefund),
    rptAtSettle: BigInt(result.totals.rptAtSettle),
  };
  const rLeaf = resultLeaf(ek, totals);
  if (tree.leaf(result.leafIndex) !== rLeaf) throw new Error(`result leaf not found at ${result.leafIndex}`);
  const intentPath = tree.pathAt(intent.leafIndex, indexAfter);
  const resultPath = tree.pathAt(result.leafIndex, indexAfter);
  const nullifier = note.nullifier(intent.leafIndex);

  const { q, r, qr, rr } = claimShares(note.amount, totals);
  const k0 = outputs[0]?.keys ?? note.keys;
  const k1 = outputs[1]?.keys ?? note.keys;
  const out0 = new Note({ assetId: isBuy ? coinId : 0n, amount: q, rpt0: isBuy ? totals.rptAtSettle : 0n, blinding: outputs[0]?.blinding, keys: k0 });
  const out1 = new Note({ assetId: isBuy ? 0n : coinId, amount: qr, rpt0: isBuy ? 0n : totals.rptAtSettle, blinding: outputs[1]?.blinding, keys: k1 });
  const outs = [out0, out1];

  const ext = { relayer: getAddress(extData.relayer ?? ZeroAddress), encryptedOutputs: outs.map((o) => hexlify(o.encrypt())) };
  const extDataHash = hashClaimExt(ext);

  const input = {
    root: s(rootValue),
    nullifier: s(nullifier),
    outputCommitment: outs.map((o) => s(o.commitment())),
    extDataHash: s(extDataHash),
    ask: s(note.keys.ask),
    coin: s(coinId),
    dir: s(d),
    epoch: s(intent.seq),
    a: s(note.amount),
    blinding: s(note.blinding),
    intentPathIndices: s(intentPath.pathIndices),
    intentPathElements: intentPath.pathElements.map(s),
    totalIn: s(totals.totalIn),
    totalOut: s(totals.totalOut),
    totalRefund: s(totals.totalRefund),
    rptAtSettle: s(totals.rptAtSettle),
    resultPathIndices: s(resultPath.pathIndices),
    resultPathElements: resultPath.pathElements.map(s),
    q: s(q),
    r: s(r),
    qr: s(qr),
    rr: s(rr),
    outPubkey: outs.map((o) => s(o.keys.pk)),
    outBlinding: outs.map((o) => s(o.blinding)),
  };

  const { proof: snarkProof, publicSignals } = await groth16.fullProve(input, artifact(wasm), artifact(zkey));
  const pub = { root: rootValue, nullifier, outputCommitments: outs.map((o) => o.commitment()), extDataHash: toBeHex(extDataHash, 32) };
  return { proof: proofToSolidity(snarkProof), pub, extData: ext, publicSignals, snarkProof, outputs: outs, shares: { q, r, qr, rr }, witness: input };
}

/**
 * epochOpen.circom witness + proof for DarkCurve.openEpoch (one direction). `minOut` is the slippage floor the open
 * will be sent with; it is a public signal, so the proof only verifies with that exact value (review N2).
 * @param {{ecSk: bigint, ecPk?: [bigint, bigint], c1: [bigint, bigint], c2: [bigint, bigint], u: bigint, minOut: bigint, wasm, zkey}} o
 */
export async function prepareOpen({ ecSk, ecPk, c1, c2, u, minOut, wasm, zkey }) {
  if (minOut === undefined || minOut === null) throw new Error("minOut is required (it is bound into the open proof)");
  const mo = BigInt(minOut);
  if (mo < 0n || mo >= 1n << 128n) throw new Error("minOut out of range (< 2^128)");
  const sk = BigInt(ecSk);
  const pk = ecPk ? [BigInt(ecPk[0]), BigInt(ecPk[1])] : elgamalPublicKey(sk);
  if (!babyEq(pk, elgamalPublicKey(sk))) throw new Error("ecPk does not match ecSk");
  const uu = BigInt(u);
  if (uu < 0n || uu >= 1n << BigInt(SUM_BITS)) throw new Error("u out of range (< 2^40)");
  const M = elgamalDecryptPoint({ c1, c2 }, sk);
  if (!babyEq(M, babyMul(uu, BASE8))) throw new Error("ciphertext does not decrypt to u");
  const input = { ecPk: pk.map(s), C1: c1.map(s), C2: c2.map(s), u: s(uu), minOut: s(mo), ecSk: s(sk) };
  const { proof: snarkProof, publicSignals } = await groth16.fullProve(input, artifact(wasm), artifact(zkey));
  const pub = { ecPk: pk, c1: [BigInt(c1[0]), BigInt(c1[1])], c2: [BigInt(c2[0]), BigInt(c2[1])], u: uu, minOut: mo };
  return { proof: proofToSolidity(snarkProof), pub, publicSignals, snarkProof, witness: input };
}

// ----------------------------------------------------------------- scanning (Appendix C sync bundle)

/**
 * Finds this wallet's notes in sync-bundle chunks (Appendix C `chunk-<n>.json`). Needs at least the FVK.
 * @param {{keys: Keys, chunks: Array<{leaves: Array<{i, leaf, enc, kind}>, nullifiers?: string[], intents?: Array<{leaf, coin, dir, seq}>}>, coins?: string[]}} o
 * @returns {{notes: Note[], intents: Array<{note: Note, leafIndex: number, coin: string, seq: number, dir: number}>, spent: Note[]}}
 */
export function scanBundle({ keys, chunks = [], coins = [] }) {
  if (!keys.canView) throw new Error("scanBundle needs the FVK (nk + encPriv)");
  const coinAssets = new Map(coins.map((c) => [assetOf(c), getAddress(c)]));
  const intentIndex = new Map(); // intent leaf -> {coin, dir, seq}
  const spentSet = new Set();
  for (const ch of chunks) {
    for (const it of ch.intents ?? []) intentIndex.set(toField(it.leaf), it);
    for (const nf of ch.nullifiers ?? []) spentSet.add(toField(nf));
  }
  const notes = [];
  const intents = [];
  for (const ch of chunks) {
    for (const l of ch.leaves ?? []) {
      if (!l.enc || l.enc === "0x" || l.kind === "result" || l.kind === "zero") continue;
      let note;
      try {
        note = Note.decrypt(keys, l.enc, Number(l.i));
      } catch {
        continue; // not ours
      }
      if (note.amount === 0n) continue;
      const leaf = toField(l.leaf);
      const c = note.commitment();
      if (leaf === c) {
        notes.push(note);
        continue;
      }
      const meta = intentIndex.get(leaf);
      if (meta && intentLeaf(c, epochKey(meta.coin, meta.seq, meta.dir)) === leaf) {
        intents.push({ note, leafIndex: Number(l.i), coin: getAddress(meta.coin), seq: Number(meta.seq), dir: Number(meta.dir) });
        continue;
      }
      // intent note without bundle metadata: recognise by asset over the coin list
      for (const [asset, coin] of coinAssets) {
        for (const dir of [0, 1, 2]) {
          if (note.assetId === intentAsset(asset, dir)) intents.push({ note, leafIndex: Number(l.i), coin, seq: null, dir });
        }
      }
    }
  }
  const unspent = [];
  const spent = [];
  for (const n of notes.sort((a, b) => a.index - b.index)) (spentSet.has(n.nullifier()) ? spent : unspent).push(n);
  const liveIntents = [];
  for (const it of intents.sort((a, b) => a.leafIndex - b.leafIndex)) {
    if (spentSet.has(it.note.nullifier(it.leafIndex))) spent.push(it.note);
    else liveIntents.push(it);
  }
  return { notes: unspent, intents: liveIntents, spent };
}
