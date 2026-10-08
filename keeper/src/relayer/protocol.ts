/**
 * Relayer wire protocol — privacy/PRIVACY-SPEC.md §5.3 and Appendix C.
 *
 * `web/src/lib/relay.ts` is the single source of these types (WP-web owns it); the keeper imports nothing from web,
 * so the shapes are re-declared here and diff-checked at integration (workplan §6 step 6). Stage-1 kinds
 * (`transact`, `fill`, `vault`, `recover`) are copied from relay.ts as it stands today, byte for byte in behaviour.
 *
 * Wire format: every uint256 / int256 is a decimal string, bytes and addresses are 0x hex.
 *
 * GET  /relay?chainId=&kind=   → RelayQuote2 | RelayUnavailable
 * POST /relay                  → RelayResponse2
 * GET  /relay/held/<ticket>    → HeldStatusJson
 * GET  /relay/epochs?chainId=  → EpochsJson (all active coins; same bytes for everyone)
 */

export type Hex = `0x${string}`;
type S = string;

export const FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const ZERO_ADDRESS: Hex = "0x0000000000000000000000000000000000000000";

// ------------------------------------------------------------------------------------------------- constants

/** Spec §2.10: fees are quoted as the smallest of these tiers ≥ gasPrice × gasUnits × (1 + margin) + flat. */
export const FEE_TIERS: readonly bigint[] = Object.freeze([
  200_000_000_000_000n, // 0.0002 BNB
  500_000_000_000_000n, // 0.0005
  1_000_000_000_000_000n, // 0.001
  2_000_000_000_000_000n, // 0.002
  5_000_000_000_000_000n, // 0.005
]);
/** GroveConstants.MAX_RELAYER_FEE: `transact` reverts OverLimit, `submitIntent` FeeTooHigh above it. */
export const MAX_RELAYER_FEE = 10_000_000_000_000_000n; // 0.01 BNB
/** GroveConstants.INTENT_FEE (to the treasury, on top of the relayer fee). */
export const INTENT_FEE = 2_000_000_000_000_000n; // 0.002 BNB
/** GroveConstants.OVERLAP: the pending Coordinator key is accepted this long before its switchAt. */
export const KEY_OVERLAP_SEC = 600;
/** Transact payload actions (first word). */
export const ACTION_HANDOVER = 1n;
export const ACTION_PLANT = 2n;
/** A held proof is deleted after this long; `notBefore` may be at most this far ahead. */
export const HOLD_MAX_SEC = 14 * 86_400;
/** `hold.minOthers` bounds. */
export const HOLD_MIN_OTHERS_MAX = 16;
/** Releases of held requests are spread individually over [0, this) ms. */
export const RELEASE_JITTER_MS = 20_000;
/** `submitByEpochEnd`: the held intent is released this long (plus RELEASE_LAND_SEC) before startedAt + T_MAX. */
export const EPOCH_END_LEAD_SEC = 30;
/** Time a released request may take to land: the release jitter (20 s) plus inclusion. A held intent is released
 *  only into an epoch that cannot become openable within this window (review N8). */
export const RELEASE_LAND_SEC = 30;

/** Stage-1 constants, as web/src/lib/relay.ts has them. */
export const RELAY_GAS_UNITS_DEFAULT = 1_000_000n;
export const RELAY_GAS_UNITS_FILL_DEFAULT = 2_300_000n;
export const RELAY_GAS_UNITS_VAULT_DEFAULT = 450_000n;
export const RELAY_GAS_UNITS_RECOVER_DEFAULT = 500_000n;
export const VAULT_CALL_MAX_BYTES = 4096;
export const RELAY_MARGIN_BPS_DEFAULT = 2_000n;
export const QUOTE_TTL_SEC = 600;
export const MIN_RELAYER_RUNWAY_QUOTES = 10n;

// ------------------------------------------------------------------------------------------------- kinds

export type Stage2Kind = "transfer" | "plant" | "intent" | "claim" | "v1migrate";
export type Stage1Kind = "transact" | "fill" | "vault" | "recover";
/** Appendix C `RelayKind2`, plus stage 1's `recover` (relay.ts has it; the Vercel route serves it). */
export type RelayKind2 = Stage2Kind | Stage1Kind;
export const STAGE2_KINDS: readonly Stage2Kind[] = ["transfer", "plant", "intent", "claim", "v1migrate"];
export const STAGE1_KINDS: readonly Stage1Kind[] = ["transact", "fill", "vault", "recover"];
export const RELAY_KINDS2: readonly RelayKind2[] = [...STAGE2_KINDS, ...STAGE1_KINDS];
export const isRelayKind2 = (x: unknown): x is RelayKind2 => typeof x === "string" && (RELAY_KINDS2 as readonly string[]).includes(x);
export const isStage2Kind = (x: RelayKind2): x is Stage2Kind => (STAGE2_KINDS as readonly string[]).includes(x);

// ------------------------------------------------------------------------------------------------- JSON shapes (Appendix C)

/** Groth16 proof of a stage-2 circuit (the public signals travel in `pub`). */
export interface Proof2Json {
  a: [S, S];
  b: [[S, S], [S, S]];
  c: [S, S];
}
export interface TransferPublicJson {
  root: S;
  publicAmount: S;
  coin: Hex;
  publicAmountCoin: S;
  accRpt: S;
  handle: S;
  claimAmount: S;
  extDataHash: Hex;
  inputNullifiers: [S, S];
  outputCommitments: [S, S, S];
}
export interface ExtData2Json {
  recipient: Hex;
  extAmountBnb: S;
  extAmountCoin: S;
  relayer: Hex;
  fee: S;
  payload: Hex;
  encryptedOutputs: [Hex, Hex, Hex];
}
export interface IntentPublicJson {
  root: S;
  publicAmount: S;
  coin: Hex;
  accRpt: S;
  dir: 0 | 1 | 2;
  ecPk: [S, S];
  c1: [S, S];
  c2: [S, S];
  extDataHash: Hex;
  inputNullifiers: [S, S];
  outputCommitments: [S, S, S];
}
export interface IntentExtJson {
  relayer: Hex;
  fee: S;
  encryptedOutputs: [Hex, Hex, Hex];
}
export interface ClaimPublicJson {
  root: S;
  nullifier: S;
  outputCommitments: [S, S];
  extDataHash: Hex;
}
export interface ClaimExtJson {
  relayer: Hex;
  encryptedOutputs: [Hex, Hex];
}
/** Filled by the server from one eth_call batch, consumed by the pure policies. */
export interface OnChainPolicyInput {
  /** [current, next] Coordinator key (DarkCurve.keyByGen(keyGen), keyByGen(keyGen + 1)) */
  coordinatorKey: [[S, S], [S, S]];
  /** DarkCurve.keySwitchAt (0 = no pending key) */
  keySwitchAt: number;
  /** Launchpad.plantFee() */
  plantFee: S;
  /** DarkCurve.seenC1(c1.x) of the request (false when the request has no ciphertext) */
  seenC1: boolean;
}
export interface HoldJson {
  minOthers: number;
  submitByEpochEnd: boolean;
}

/** Stage-1 shapes (relay.ts). */
export interface ProofJson {
  a: [S, S];
  b: [[S, S], [S, S]];
  c: [S, S];
  root: S;
  publicAmount: S;
  extDataHash: Hex;
  inputNullifiers: [S, S];
  outputCommitments: [S, S];
}
export interface ExtDataJson {
  recipient: Hex;
  extAmount: S;
  relayer: Hex;
  fee: S;
  encryptedOutput1: Hex;
  encryptedOutput2: Hex;
}
export interface OrderJson {
  coin: Hex;
  bnbIn: S;
  minTokensOut: S;
  owner: Hex;
  deadline: S;
  nonce: Hex;
}

export type RelayRequest2 =
  | { kind: "transfer" | "plant"; chainId: number; proof: Proof2Json; pub: TransferPublicJson; extData: ExtData2Json }
  | { kind: "intent"; chainId: number; proof: Proof2Json; pub: IntentPublicJson; extData: IntentExtJson; hold?: HoldJson }
  | { kind: "claim"; chainId: number; proof: Proof2Json; pub: ClaimPublicJson; extData: ClaimExtJson }
  | { kind: "v1migrate"; chainId: number; proof: ProofJson; extData: ExtDataJson; handle: S; notBefore?: number }
  | { kind?: "transact"; chainId: number; proof: ProofJson; extData: ExtDataJson }
  | { kind: "fill"; chainId: number; proof: ProofJson; extData: ExtDataJson; order: OrderJson }
  | { kind: "vault"; chainId: number; vault: Hex; data: Hex; fee: S; deadline: S; relayer: Hex; sig: Hex }
  | { kind: "recover"; chainId: number; order: OrderJson };

export interface RelayQuote2 {
  ok: true;
  chainId: number;
  kind: RelayKind2;
  /** Address to put in extData.relayer. */
  relayer: Hex;
  /** Fee in wei (decimal string): the smallest acceptable tier; "0" for claims. */
  fee: S;
  /** Index of `fee` in FEE_TIERS; null for claims and stage-1 kinds (untiered). */
  feeTier: number | null;
  gasPrice: S;
  gasUnits: S;
  validUntil: number;
  /** Every tier this relayer accepts right now for this kind (decimal strings, ascending). */
  tiers: S[];
}
export interface RelayUnavailable {
  ok: false;
  reason: string;
}
export type RelayStatus2 = RelayQuote2 | RelayUnavailable;
export type RelayFailCode = "fee" | "chain" | "invalid" | "reverted" | "busy" | "unavailable";
export type RelayResponse2 = { ok: true; hash: Hex } | { ok: true; held: true; ticket: string } | { ok: false; error: string; code: RelayFailCode };
export interface HeldStatusJson {
  status: "held" | "submitted" | "dropped";
  hash?: Hex;
  reason?: string;
  /** intents: intents already in the watched (coin, dir) epoch */
  count?: number;
  /** intents: when the watched epoch can open (unix s); v1migrate: notBefore */
  opensAt?: number;
}
export interface EpochRowJson {
  seq: number;
  startedAt: number;
  count: number;
  openableAt: number;
  refPrice: S;
}
export interface EpochsJson {
  chainId: number;
  coins: Record<string, EpochRowJson[]>;
  updatedAt: number;
}

// ------------------------------------------------------------------------------------------------- structs (viem)

export interface Proof2 {
  a: readonly [bigint, bigint];
  b: readonly [readonly [bigint, bigint], readonly [bigint, bigint]];
  c: readonly [bigint, bigint];
}
export interface TransferPublic {
  root: bigint;
  publicAmount: bigint;
  coin: Hex;
  publicAmountCoin: bigint;
  accRpt: bigint;
  handle: bigint;
  claimAmount: bigint;
  extDataHash: Hex;
  inputNullifiers: readonly [bigint, bigint];
  outputCommitments: readonly [bigint, bigint, bigint];
}
export interface ExtData2 {
  recipient: Hex;
  extAmountBnb: bigint;
  extAmountCoin: bigint;
  relayer: Hex;
  fee: bigint;
  payload: Hex;
  encryptedOutputs: readonly [Hex, Hex, Hex];
}
export interface IntentPublic {
  root: bigint;
  publicAmount: bigint;
  coin: Hex;
  accRpt: bigint;
  dir: number;
  ecPk: readonly [bigint, bigint];
  c1: readonly [bigint, bigint];
  c2: readonly [bigint, bigint];
  extDataHash: Hex;
  inputNullifiers: readonly [bigint, bigint];
  outputCommitments: readonly [bigint, bigint, bigint];
}
export interface IntentExt {
  relayer: Hex;
  fee: bigint;
  encryptedOutputs: readonly [Hex, Hex, Hex];
}
export interface ClaimPublic {
  root: bigint;
  nullifier: bigint;
  outputCommitments: readonly [bigint, bigint];
  extDataHash: Hex;
}
export interface ClaimExt {
  relayer: Hex;
  encryptedOutputs: readonly [Hex, Hex];
}
export interface Hold {
  minOthers: number;
  submitByEpochEnd: boolean;
}
/** Stage-1 structs (relay.ts). */
export interface ProofStruct {
  a: readonly [bigint, bigint];
  b: readonly [readonly [bigint, bigint], readonly [bigint, bigint]];
  c: readonly [bigint, bigint];
  root: bigint;
  publicAmount: bigint;
  extDataHash: Hex;
  inputNullifiers: readonly [bigint, bigint];
  outputCommitments: readonly [bigint, bigint];
}
export interface ExtDataStruct {
  recipient: Hex;
  extAmount: bigint;
  relayer: Hex;
  fee: bigint;
  encryptedOutput1: Hex;
  encryptedOutput2: Hex;
}
export interface OrderStruct {
  coin: Hex;
  bnbIn: bigint;
  minTokensOut: bigint;
  owner: Hex;
  deadline: bigint;
  nonce: Hex;
}
export interface VaultCallStruct {
  vault: Hex;
  data: Hex;
  fee: bigint;
  deadline: bigint;
  relayer: Hex;
  sig: Hex;
}

export type ParsedRequest =
  | { kind: "transfer" | "plant"; chainId: number; proof: Proof2; pub: TransferPublic; extData: ExtData2 }
  | { kind: "intent"; chainId: number; proof: Proof2; pub: IntentPublic; extData: IntentExt; hold?: Hold }
  | { kind: "claim"; chainId: number; proof: Proof2; pub: ClaimPublic; extData: ClaimExt }
  | { kind: "v1migrate"; chainId: number; proof: ProofStruct; extData: ExtDataStruct; handle: bigint; notBefore?: number }
  | { kind: "transact"; chainId: number; proof: ProofStruct; extData: ExtDataStruct }
  | { kind: "fill"; chainId: number; proof: ProofStruct; extData: ExtDataStruct; order: OrderStruct }
  | { kind: "vault"; chainId: number; call: VaultCallStruct }
  | { kind: "recover"; chainId: number; order: OrderStruct };
export type ParseResult = ({ ok: true } & ParsedRequest) | { ok: false; error: string };

// ------------------------------------------------------------------------------------------------- parsing

const DEC = /^-?[0-9]{1,80}$/;
const HEX = /^0x[0-9a-fA-F]*$/;
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const B32 = /^0x[0-9a-fA-F]{64}$/;
/** Longest ciphertext / payload accepted per field (a note ciphertext is ~150 bytes; a plant payload < 2 KB). */
const BYTES_MAX = 4096;

export class ParseError extends Error {}

function obj(x: unknown, name: string): Record<string, unknown> {
  if (typeof x !== "object" || x === null || Array.isArray(x)) throw new ParseError(`${name}: expected an object`);
  return x as Record<string, unknown>;
}
export function uint(x: unknown, name: string): bigint {
  if (typeof x !== "string" || !DEC.test(x) || x.startsWith("-")) throw new ParseError(`${name}: expected a decimal uint256`);
  const v = BigInt(x);
  if (v >= 2n ** 256n) throw new ParseError(`${name}: out of range`);
  return v;
}
export function field(x: unknown, name: string): bigint {
  const v = uint(x, name);
  if (v >= FIELD_SIZE) throw new ParseError(`${name}: not a field element`);
  return v;
}
export function int(x: unknown, name: string): bigint {
  if (typeof x !== "string" || !DEC.test(x)) throw new ParseError(`${name}: expected a decimal int256`);
  const v = BigInt(x);
  if (v >= 2n ** 255n || v < -(2n ** 255n)) throw new ParseError(`${name}: out of range`);
  return v;
}
export function addr(x: unknown, name: string): Hex {
  if (typeof x !== "string" || !ADDR.test(x)) throw new ParseError(`${name}: expected an address`);
  return x.toLowerCase() as Hex;
}
export function bytes(x: unknown, name: string, max = BYTES_MAX): Hex {
  if (typeof x !== "string" || !HEX.test(x) || x.length % 2 !== 0) throw new ParseError(`${name}: expected 0x bytes`);
  if (x.length > 2 + max * 2) throw new ParseError(`${name}: too long`);
  return x as Hex;
}
function b32(x: unknown, name: string): Hex {
  if (typeof x !== "string" || !B32.test(x)) throw new ParseError(`${name}: expected bytes32`);
  return x as Hex;
}
function tuple<T>(x: unknown, n: number, name: string, f: (v: unknown, n: string) => T): T[] {
  if (!Array.isArray(x) || x.length !== n) throw new ParseError(`${name}: expected [${n}]`);
  return x.map((v, i) => f(v, `${name}[${i}]`));
}
const pair = (x: unknown, name: string, f: (v: unknown, n: string) => bigint) => tuple(x, 2, name, f) as unknown as readonly [bigint, bigint];
const triple = (x: unknown, name: string, f: (v: unknown, n: string) => bigint) => tuple(x, 3, name, f) as unknown as readonly [bigint, bigint, bigint];

function parseProof2(p: unknown): Proof2 {
  const o = obj(p, "proof");
  if (!Array.isArray(o.b) || o.b.length !== 2) throw new ParseError("proof.b: expected [2][2]");
  return { a: pair(o.a, "proof.a", uint), b: [pair(o.b[0], "proof.b[0]", uint), pair(o.b[1], "proof.b[1]", uint)], c: pair(o.c, "proof.c", uint) };
}
function parseTransferPublic(x: unknown): TransferPublic {
  const o = obj(x, "pub");
  return {
    root: field(o.root, "pub.root"),
    publicAmount: field(o.publicAmount, "pub.publicAmount"),
    coin: addr(o.coin, "pub.coin"),
    publicAmountCoin: field(o.publicAmountCoin, "pub.publicAmountCoin"),
    accRpt: field(o.accRpt, "pub.accRpt"),
    handle: field(o.handle, "pub.handle"),
    claimAmount: field(o.claimAmount, "pub.claimAmount"),
    extDataHash: b32(o.extDataHash, "pub.extDataHash"),
    inputNullifiers: pair(o.inputNullifiers, "pub.inputNullifiers", field),
    outputCommitments: triple(o.outputCommitments, "pub.outputCommitments", field),
  };
}
function parseExtData2(x: unknown): ExtData2 {
  const o = obj(x, "extData");
  return {
    recipient: addr(o.recipient, "extData.recipient"),
    extAmountBnb: int(o.extAmountBnb, "extData.extAmountBnb"),
    extAmountCoin: int(o.extAmountCoin, "extData.extAmountCoin"),
    relayer: addr(o.relayer, "extData.relayer"),
    fee: uint(o.fee, "extData.fee"),
    payload: bytes(o.payload ?? "0x", "extData.payload"),
    encryptedOutputs: tuple(o.encryptedOutputs, 3, "extData.encryptedOutputs", (v, n) => bytes(v, n)) as unknown as readonly [Hex, Hex, Hex],
  };
}
function parseIntentPublic(x: unknown): IntentPublic {
  const o = obj(x, "pub");
  const dir = Number(o.dir);
  if (!Number.isInteger(dir) || dir < 0 || dir > 2 || (typeof o.dir !== "number" && typeof o.dir !== "string")) throw new ParseError("pub.dir: expected 0, 1 or 2");
  return {
    root: field(o.root, "pub.root"),
    publicAmount: field(o.publicAmount, "pub.publicAmount"),
    coin: addr(o.coin, "pub.coin"),
    accRpt: field(o.accRpt, "pub.accRpt"),
    dir,
    ecPk: pair(o.ecPk, "pub.ecPk", field),
    c1: pair(o.c1, "pub.c1", field),
    c2: pair(o.c2, "pub.c2", field),
    extDataHash: b32(o.extDataHash, "pub.extDataHash"),
    inputNullifiers: pair(o.inputNullifiers, "pub.inputNullifiers", field),
    outputCommitments: triple(o.outputCommitments, "pub.outputCommitments", field),
  };
}
function parseIntentExt(x: unknown): IntentExt {
  const o = obj(x, "extData");
  return {
    relayer: addr(o.relayer, "extData.relayer"),
    fee: uint(o.fee, "extData.fee"),
    encryptedOutputs: tuple(o.encryptedOutputs, 3, "extData.encryptedOutputs", (v, n) => bytes(v, n)) as unknown as readonly [Hex, Hex, Hex],
  };
}
function parseClaimPublic(x: unknown): ClaimPublic {
  const o = obj(x, "pub");
  return {
    root: field(o.root, "pub.root"),
    nullifier: field(o.nullifier, "pub.nullifier"),
    outputCommitments: pair(o.outputCommitments, "pub.outputCommitments", field),
    extDataHash: b32(o.extDataHash, "pub.extDataHash"),
  };
}
function parseClaimExt(x: unknown): ClaimExt {
  const o = obj(x, "extData");
  if (o.fee !== undefined) throw new ParseError("extData.fee: claims carry no fee (the relayer is reimbursed on-chain)");
  return {
    relayer: addr(o.relayer, "extData.relayer"),
    encryptedOutputs: tuple(o.encryptedOutputs, 2, "extData.encryptedOutputs", (v, n) => bytes(v, n)) as unknown as readonly [Hex, Hex],
  };
}
function parseHold(x: unknown): Hold {
  const o = obj(x, "hold");
  const minOthers = o.minOthers;
  if (typeof minOthers !== "number" || !Number.isInteger(minOthers) || minOthers < 1 || minOthers > HOLD_MIN_OTHERS_MAX) {
    throw new ParseError(`hold.minOthers: expected an integer in 1..${HOLD_MIN_OTHERS_MAX}`);
  }
  if (typeof o.submitByEpochEnd !== "boolean") throw new ParseError("hold.submitByEpochEnd: expected a boolean");
  return { minOthers, submitByEpochEnd: o.submitByEpochEnd };
}
function parseProof(p: unknown): ProofStruct {
  const o = obj(p, "proof");
  if (!Array.isArray(o.b) || o.b.length !== 2) throw new ParseError("proof.b: expected [2][2]");
  return {
    a: pair(o.a, "proof.a", uint),
    b: [pair(o.b[0], "proof.b[0]", uint), pair(o.b[1], "proof.b[1]", uint)],
    c: pair(o.c, "proof.c", uint),
    root: field(o.root, "proof.root"),
    publicAmount: field(o.publicAmount, "proof.publicAmount"),
    extDataHash: b32(o.extDataHash, "proof.extDataHash"),
    inputNullifiers: pair(o.inputNullifiers, "proof.inputNullifiers", field),
    outputCommitments: pair(o.outputCommitments, "proof.outputCommitments", field),
  };
}
function parseExtData(e: unknown): ExtDataStruct {
  const o = obj(e, "extData");
  return {
    recipient: addr(o.recipient, "extData.recipient"),
    extAmount: int(o.extAmount, "extData.extAmount"),
    relayer: addr(o.relayer, "extData.relayer"),
    fee: uint(o.fee, "extData.fee"),
    encryptedOutput1: bytes(o.encryptedOutput1, "extData.encryptedOutput1"),
    encryptedOutput2: bytes(o.encryptedOutput2, "extData.encryptedOutput2"),
  };
}
function parseOrder(x: unknown): OrderStruct {
  const o = obj(x, "order");
  const deadline = uint(o.deadline, "order.deadline");
  if (deadline >= 2n ** 64n) throw new ParseError("order.deadline: out of range (uint64)");
  return {
    coin: addr(o.coin, "order.coin"),
    bnbIn: uint(o.bnbIn, "order.bnbIn"),
    minTokensOut: uint(o.minTokensOut, "order.minTokensOut"),
    owner: addr(o.owner, "order.owner"),
    deadline,
    nonce: b32(o.nonce, "order.nonce"),
  };
}

/** Validate an untrusted JSON body (discriminated by `kind`, default `transact` as in stage 1). */
export function parseRelayRequest2(body: unknown): ParseResult {
  try {
    const b = obj(body, "body");
    const chainId = Number(b.chainId);
    if (!Number.isInteger(chainId) || chainId <= 0) throw new ParseError("chainId: expected a positive integer");
    const kind: string = b.kind === undefined ? "transact" : typeof b.kind === "string" ? b.kind : "";
    if (kind !== "intent" && b.hold !== undefined) {
      throw new ParseError(kind === "claim" ? "hold: claims are never held" : "hold: only intents can be held");
    }
    if (kind !== "v1migrate" && b.notBefore !== undefined) throw new ParseError("notBefore: only v1migrate takes notBefore");
    switch (kind) {
      case "transfer":
      case "plant":
        return { ok: true, kind, chainId, proof: parseProof2(b.proof), pub: parseTransferPublic(b.pub), extData: parseExtData2(b.extData) };
      case "intent": {
        const r = { ok: true as const, kind, chainId, proof: parseProof2(b.proof), pub: parseIntentPublic(b.pub), extData: parseIntentExt(b.extData) };
        return b.hold === undefined || b.hold === null ? r : { ...r, hold: parseHold(b.hold) };
      }
      case "claim":
        return { ok: true, kind, chainId, proof: parseProof2(b.proof), pub: parseClaimPublic(b.pub), extData: parseClaimExt(b.extData) };
      case "v1migrate": {
        const r = { ok: true as const, kind, chainId, proof: parseProof(b.proof), extData: parseExtData(b.extData), handle: field(b.handle, "handle") };
        if (b.notBefore === undefined || b.notBefore === null) return r;
        if (typeof b.notBefore !== "number" || !Number.isInteger(b.notBefore) || b.notBefore < 0) throw new ParseError("notBefore: expected unix seconds");
        return { ...r, notBefore: b.notBefore };
      }
      case "transact":
        return { ok: true, kind, chainId, proof: parseProof(b.proof), extData: parseExtData(b.extData) };
      case "fill":
        return { ok: true, kind, chainId, proof: parseProof(b.proof), extData: parseExtData(b.extData), order: parseOrder(b.order) };
      case "vault":
        return {
          ok: true,
          kind,
          chainId,
          call: {
            vault: addr(b.vault, "vault"),
            data: bytes(b.data, "data", VAULT_CALL_MAX_BYTES),
            fee: uint(b.fee, "fee"),
            deadline: uint(b.deadline, "deadline"),
            relayer: addr(b.relayer, "relayer"),
            sig: bytes(b.sig, "sig", 65),
          },
        };
      case "recover":
        return { ok: true, kind, chainId, order: parseOrder(b.order) };
      default:
        throw new ParseError(`kind: expected one of ${RELAY_KINDS2.join(", ")}`);
    }
  } catch (err) {
    if (err instanceof ParseError) return { ok: false, error: err.message };
    return { ok: false, error: "malformed request" };
  }
}

/** The nullifiers a request spends (in-flight lock keys); empty for vault / recover. */
export function spentNullifiers(r: ParsedRequest): bigint[] {
  switch (r.kind) {
    case "transfer":
    case "plant":
    case "intent":
      return [...r.pub.inputNullifiers];
    case "claim":
      return [r.pub.nullifier];
    case "v1migrate":
    case "transact":
    case "fill":
      return [...r.proof.inputNullifiers];
    default:
      return [];
  }
}

/** JSON-safe form of a parsed request (bigints as decimal strings), for the encrypted held store. */
export function toWire(body: unknown): string {
  return JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}
