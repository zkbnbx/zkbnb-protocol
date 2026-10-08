/**
 * Pure relayer policies — privacy/PRIVACY-SPEC.md §5.3, §2.10. No I/O here: the server fills `OnChainPolicyInput`
 * (onchain.ts) and the live gas price, and these functions decide. Each returns null when the request may be relayed
 * (the route then simulates, which catches everything the contract checks and these do not), else the reason.
 *
 * Stage-1 policies (relayPolicy / fillPolicy / vaultPolicy / recoverPolicy) mirror web/src/lib/relay.ts unchanged.
 */
import {
  ACTION_HANDOVER,
  ACTION_PLANT,
  EPOCH_END_LEAD_SEC,
  FEE_TIERS,
  FIELD_SIZE,
  HOLD_MAX_SEC,
  INTENT_FEE,
  KEY_OVERLAP_SEC,
  MAX_RELAYER_FEE,
  RELAY_GAS_UNITS_DEFAULT,
  RELAY_GAS_UNITS_FILL_DEFAULT,
  RELAY_GAS_UNITS_RECOVER_DEFAULT,
  RELAY_GAS_UNITS_VAULT_DEFAULT,
  RELAY_MARGIN_BPS_DEFAULT,
  RELEASE_JITTER_MS,
  VAULT_CALL_MAX_BYTES,
  ZERO_ADDRESS,
  type ClaimExt,
  type ExtData2,
  type ExtDataStruct,
  type Hex,
  type Hold,
  type IntentExt,
  type IntentPublic,
  type OnChainPolicyInput,
  type OrderStruct,
  type Stage1Kind,
  type Stage2Kind,
  type TransferPublic,
  type VaultCallStruct,
  type RelayKind2,
} from "./protocol.js";

export type PolicyResult = { code: "chain" | "invalid" | "fee"; error: string } | null;

// ------------------------------------------------------------------------------------------------- gas units

/** contracts/gas-v2.json (Appendix C). Only the relayed kinds are required here. */
export type GasUnits2 = Record<Stage2Kind, bigint>;

/** Parse contracts/gas-v2.json; throws when a relayed kind is missing or not a positive integer. */
export function parseGasUnits(raw: unknown): GasUnits2 {
  if (typeof raw !== "object" || raw === null) throw new Error("gas units file: not an object");
  const o = raw as Record<string, unknown>;
  const out = {} as GasUnits2;
  for (const k of ["transfer", "plant", "intent", "claim", "v1migrate"] as const) {
    const v = o[k];
    if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) throw new Error(`gas units file: "${k}" missing or not a positive integer`);
    out[k] = BigInt(v);
  }
  return out;
}

export function stage1GasUnitsDefault(kind: Stage1Kind): bigint {
  return kind === "fill" ? RELAY_GAS_UNITS_FILL_DEFAULT : kind === "vault" ? RELAY_GAS_UNITS_VAULT_DEFAULT : kind === "recover" ? RELAY_GAS_UNITS_RECOVER_DEFAULT : RELAY_GAS_UNITS_DEFAULT;
}

// ------------------------------------------------------------------------------------------------- fee maths

/** gasPrice × gasUnits × (1 + marginBps / 10 000) + flat (relay.ts `quoteFee`). */
export function quoteFee(gasPrice: bigint, gasUnits: bigint, marginBps = RELAY_MARGIN_BPS_DEFAULT, flat = 0n): bigint {
  return (gasPrice * gasUnits * (10_000n + marginBps)) / 10_000n + flat;
}

/** A submitted fee is accepted when it covers what the transaction costs now, plus the flat part (relay.ts). */
export function feeCovers(fee: bigint, gasPrice: bigint, gasUnits: bigint, flat = 0n): boolean {
  return fee >= gasPrice * gasUnits + flat;
}

export type TierQuote = { ok: true; fee: bigint; tier: number; tiers: bigint[] } | { ok: false; reason: string };

/**
 * Spec §2.10: the smallest tier ≥ gasPrice × gasUnits × (1 + margin) + flat, and every larger tier as acceptable
 * alternatives. No tier fits (gas too expensive) ⇒ not available. Tiers above MAX_RELAYER_FEE are never offered.
 */
export function tieredQuote(gasPrice: bigint, gasUnits: bigint, marginBps = RELAY_MARGIN_BPS_DEFAULT, flat = 0n): TierQuote {
  const need = quoteFee(gasPrice, gasUnits, marginBps, flat);
  const tiers = FEE_TIERS.filter((t) => t >= need && t <= MAX_RELAYER_FEE);
  if (tiers.length === 0) return { ok: false, reason: `gas is too expensive right now: ${need} wei exceeds the largest fee tier` };
  return { ok: true, fee: tiers[0], tier: FEE_TIERS.indexOf(tiers[0]), tiers };
}

/** Fee check of a stage-2 request: a tier, within the contract cap, and covering gasUnits at the live gas price. */
export function tierFeePolicy(fee: bigint, gasPrice: bigint, gasUnits: bigint, flat = 0n): PolicyResult {
  if (!FEE_TIERS.includes(fee)) return { code: "fee", error: `fee ${fee} wei is not a fee tier; re-quote and prove again` };
  if (fee > MAX_RELAYER_FEE) return { code: "fee", error: "fee is above the contract's relayer-fee cap" };
  if (!feeCovers(fee, gasPrice, gasUnits, flat)) return { code: "fee", error: `fee ${fee} wei does not cover gas (${gasUnits} × ${gasPrice} wei now); re-quote and prove again` };
  return null;
}

// ------------------------------------------------------------------------------------------------- helpers

/** x as the circuit's field element (negatives as p − |x|), as GrovePool.toField. */
export function toField(x: bigint): bigint {
  return ((x % FIELD_SIZE) + FIELD_SIZE) % FIELD_SIZE;
}

/** First 32-byte word of a payload, or null when shorter (GrovePool._action reverts on that). */
export function payloadAction(payload: Hex): bigint | null {
  if (payload.length < 2 + 64) return null;
  return BigInt(`0x${payload.slice(2, 66)}`);
}

/** abi.encode(uint256 handle) as 0x hex: what migrateFromV1 requires in `ve.encryptedOutput2`. */
export function encodeHandle(handle: bigint): Hex {
  return `0x${handle.toString(16).padStart(64, "0")}`;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function chainPolicy(chainId: number, expected: number): PolicyResult {
  return chainId === expected ? null : { code: "chain", error: `this relayer serves chain ${expected}, not ${chainId}` };
}

/** What every stage-2 policy needs from the server besides the request. */
export interface Stage2Env {
  relayer: Hex;
  expectedChainId: number;
  gasPrice: bigint;
  gasUnits: GasUnits2;
  flat: bigint;
  /** chain time (latest block), seconds */
  now: number;
  /** stage-2 addresses */
  grovePool: Hex;
  planter?: Hex;
}

// ------------------------------------------------------------------------------------------------- stage 2

/**
 * `transfer`: private send, BNB or token unshield, handle claim, hand-over. Shields are never relayed; the planter
 * is the `plant` kind (its own gas units).
 */
export function transferPolicy(chainId: number, pub: TransferPublic, e: ExtData2, env: Stage2Env): PolicyResult {
  const c = chainPolicy(chainId, env.expectedChainId);
  if (c) return c;
  if (!same(e.relayer, env.relayer)) return { code: "invalid", error: "extData.relayer is not this relayer; re-quote and prove again" };
  if (e.extAmountBnb > 0n || e.extAmountCoin > 0n) return { code: "invalid", error: "shields cannot be relayed: shield from your own wallet" };
  if (env.planter && same(e.recipient, env.planter)) return { code: "invalid", error: "a transfer to the planter is a plant: use kind plant" };
  if ((e.extAmountBnb < 0n || e.extAmountCoin < 0n) && same(e.recipient, ZERO_ADDRESS)) return { code: "invalid", error: "withdrawal without a recipient" };
  if (e.payload !== "0x" && e.payload.length > 2) {
    if (payloadAction(e.payload) !== ACTION_HANDOVER) return { code: "invalid", error: "a transfer payload must be a hand-over" };
  }
  const amounts = publicAmountsPolicy(pub, e);
  if (amounts) return amounts;
  return tierFeePolicy(e.fee, env.gasPrice, env.gasUnits.transfer, env.flat);
}

/** `plant`: recipient == planter, −extAmountBnb == plantFee, payload is ACTION_PLANT. */
export function plantPolicy(chainId: number, pub: TransferPublic, e: ExtData2, env: Stage2Env, onChain: Pick<OnChainPolicyInput, "plantFee">): PolicyResult {
  const c = chainPolicy(chainId, env.expectedChainId);
  if (c) return c;
  if (!same(e.relayer, env.relayer)) return { code: "invalid", error: "extData.relayer is not this relayer; re-quote and prove again" };
  if (!env.planter) return { code: "invalid", error: "private planting is not deployed on this chain" };
  if (!same(e.recipient, env.planter)) return { code: "invalid", error: "a plant must pay the planter" };
  if (-e.extAmountBnb !== BigInt(onChain.plantFee)) return { code: "invalid", error: `a plant must unshield exactly the plant fee (${onChain.plantFee} wei)` };
  if (e.extAmountCoin !== 0n) return { code: "invalid", error: "a plant moves no tokens" };
  if (payloadAction(e.payload) !== ACTION_PLANT) return { code: "invalid", error: "the plant payload must start with ACTION_PLANT" };
  const amounts = publicAmountsPolicy(pub, e);
  if (amounts) return amounts;
  return tierFeePolicy(e.fee, env.gasPrice, env.gasUnits.plant, env.flat);
}

function publicAmountsPolicy(pub: TransferPublic, e: ExtData2): PolicyResult {
  if (pub.handle === 0n && pub.claimAmount !== 0n) return { code: "invalid", error: "claimAmount without a handle" };
  if (pub.publicAmount !== toField(e.extAmountBnb - e.fee + pub.claimAmount)) return { code: "invalid", error: "publicAmount does not match extAmountBnb − fee + claimAmount" };
  if (pub.publicAmountCoin !== toField(e.extAmountCoin)) return { code: "invalid", error: "publicAmountCoin does not match extAmountCoin" };
  return null;
}

/**
 * The Coordinator keys DarkCurve accepts at chain time `now` (DarkCurve._keyIdOf): after a pending key's switchAt
 * only the new key; inside the overlap before it both; otherwise the current key.
 */
export function acceptedKeys(onChain: Pick<OnChainPolicyInput, "coordinatorKey" | "keySwitchAt">, now: number): [string, string][] {
  const [cur, next] = onChain.coordinatorKey;
  if (onChain.keySwitchAt !== 0 && now >= onChain.keySwitchAt) return [next];
  if (onChain.keySwitchAt !== 0 && now + KEY_OVERLAP_SEC >= onChain.keySwitchAt) return [cur, next];
  return [cur];
}

/** `intent`: publicAmount == field(−fee − INTENT_FEE), dir ∈ 0..2, ecPk an accepted Coordinator key, fresh C1. */
export function intentPolicy(chainId: number, pub: IntentPublic, e: IntentExt, env: Stage2Env, onChain: OnChainPolicyInput): PolicyResult {
  const c = chainPolicy(chainId, env.expectedChainId);
  if (c) return c;
  if (!same(e.relayer, env.relayer)) return { code: "invalid", error: "extData.relayer is not this relayer; re-quote and prove again" };
  if (pub.dir !== 0 && pub.dir !== 1 && pub.dir !== 2) return { code: "invalid", error: "dir must be 0, 1 or 2" };
  if (pub.publicAmount !== FIELD_SIZE - (e.fee + INTENT_FEE)) return { code: "invalid", error: "publicAmount must be field(−fee − INTENT_FEE)" };
  const keys = acceptedKeys(onChain, env.now);
  const pk = [pub.ecPk[0].toString(), pub.ecPk[1].toString()];
  if (!keys.some((k) => k[0] === pk[0] && k[1] === pk[1]) || pk[0] === "0") {
    return { code: "invalid", error: "ecPk is not the Coordinator key the contract accepts now; refresh and prove again" };
  }
  if (onChain.seenC1) return { code: "invalid", error: "this ciphertext randomness was already used" };
  return tierFeePolicy(e.fee, env.gasPrice, env.gasUnits.intent, env.flat);
}

/** `claim`: free (reimbursed on-chain from the claim budget to extData.relayer), so it must name this relayer. */
export function claimPolicy(chainId: number, e: ClaimExt, env: Pick<Stage2Env, "relayer" | "expectedChainId">): PolicyResult {
  const c = chainPolicy(chainId, env.expectedChainId);
  if (c) return c;
  if (!same(e.relayer, env.relayer)) return { code: "invalid", error: "extData.relayer is not this relayer (claims are reimbursed to it); prove again" };
  return null;
}

/**
 * `v1migrate`: a v1 unshield to GrovePool bound to `handle` (GrovePool.migrateFromV1: `ve.encryptedOutput2 ==
 * abi.encode(handle)`); `notBefore` at most 14 days ahead.
 */
export function v1migratePolicy(chainId: number, publicAmount: bigint, e: ExtDataStruct, handle: bigint, notBefore: number | undefined, env: Stage2Env): PolicyResult {
  const c = chainPolicy(chainId, env.expectedChainId);
  if (c) return c;
  if (!same(e.relayer, env.relayer)) return { code: "invalid", error: "extData.relayer is not this relayer; re-quote and prove again" };
  if (!same(e.recipient, env.grovePool)) return { code: "invalid", error: "a migration must unshield to the GrovePool" };
  if (e.extAmount >= 0n) return { code: "invalid", error: "a migration is a v1 withdrawal (extAmount < 0)" };
  if (handle === 0n || handle >= FIELD_SIZE) return { code: "invalid", error: "handle must be a non-zero field element" };
  if (e.encryptedOutput2.toLowerCase() !== encodeHandle(handle)) return { code: "invalid", error: "the v1 proof is not bound to this handle (encryptedOutput2 must be abi.encode(handle))" };
  if (publicAmount !== toField(e.extAmount - e.fee)) return { code: "invalid", error: "publicAmount does not match extAmount − fee" };
  if (notBefore !== undefined && notBefore > env.now + HOLD_MAX_SEC) return { code: "invalid", error: "notBefore is more than 14 days ahead" };
  return tierFeePolicy(e.fee, env.gasPrice, env.gasUnits.v1migrate, env.flat);
}

// ------------------------------------------------------------------------------------------------- stage 1 (relay.ts)

export function relayPolicy(extData: ExtDataStruct, relayer: Hex, chainId: number, expectedChainId: number): PolicyResult {
  if (chainId !== expectedChainId) return { code: "chain", error: `this relayer serves chain ${expectedChainId}, not ${chainId}` };
  if (extData.extAmount > 0n) return { code: "invalid", error: "deposits cannot be relayed: shield from your own wallet" };
  if (extData.relayer.toLowerCase() !== relayer.toLowerCase()) return { code: "invalid", error: "extData.relayer is not this relayer; re-quote and prove again" };
  if (extData.fee === 0n) return { code: "fee", error: "fee is zero" };
  if (extData.extAmount < 0n && extData.recipient === ZERO_ADDRESS) return { code: "invalid", error: "withdrawal without a recipient" };
  return null;
}

export function fillPolicy(extData: ExtDataStruct, order: OrderStruct, relayer: Hex, chainId: number, expectedChainId: number): PolicyResult {
  const base = relayPolicy(extData, relayer, chainId, expectedChainId);
  if (base) return base;
  if (order.bnbIn === 0n) return { code: "invalid", error: "order.bnbIn is zero" };
  if (order.owner === ZERO_ADDRESS) return { code: "invalid", error: "order.owner is the zero address" };
  if (order.coin === ZERO_ADDRESS) return { code: "invalid", error: "order.coin is the zero address" };
  if (extData.extAmount !== -order.bnbIn) return { code: "invalid", error: "extData.extAmount must equal -order.bnbIn" };
  return null;
}

export function vaultPolicy(call: VaultCallStruct, relayer: Hex, chainId: number, expectedChainId: number, nowSec: number): PolicyResult {
  if (chainId !== expectedChainId) return { code: "chain", error: `this relayer serves chain ${expectedChainId}, not ${chainId}` };
  if (call.relayer.toLowerCase() !== relayer.toLowerCase()) return { code: "invalid", error: "the signature names another relayer; re-quote and sign again" };
  if (call.fee === 0n) return { code: "fee", error: "fee is zero" };
  if (call.deadline <= BigInt(Math.floor(nowSec))) return { code: "invalid", error: "deadline has passed; sign again" };
  const dataBytes = (call.data.length - 2) / 2;
  if (dataBytes < 4) return { code: "invalid", error: "data is shorter than a selector" };
  if (dataBytes > VAULT_CALL_MAX_BYTES) return { code: "invalid", error: "data is too long" };
  if (call.sig.length !== 2 + 65 * 2) return { code: "invalid", error: "sig must be 65 bytes" };
  return null;
}

export function recoverPolicy(order: OrderStruct, chainId: number, expectedChainId: number): PolicyResult {
  if (chainId !== expectedChainId) return { code: "chain", error: `this relayer serves chain ${expectedChainId}, not ${chainId}` };
  if (order.bnbIn === 0n) return { code: "invalid", error: "order.bnbIn is zero" };
  if (order.owner === ZERO_ADDRESS) return { code: "invalid", error: "order.owner is the zero address" };
  if (order.coin === ZERO_ADDRESS) return { code: "invalid", error: "order.coin is the zero address" };
  return null;
}

// ------------------------------------------------------------------------------------------------- holds

/** The watched epoch of a held intent: DarkCurve.cur[coin][dir] and its Epoch, plus params.tMax. */
export interface HoldEpochState {
  seq: number;
  status: number;
  count: number;
  startedAt: number;
  tMax: number;
}

export type HoldDecision = { action: "release" } | { action: "wait"; count: number; opensAt?: number } | { action: "drop"; reason: string };

/**
 * Spec §5.3 "Held intents": submit when `count ≥ minOthers`, or at `startedAt + T_MAX − 30 s` when
 * `submitByEpochEnd`, else drop at that moment. While no epoch of the direction is collecting, keep waiting (an
 * epoch that opened early, before the deadline, is simply replaced by the next one). Expired after 14 days.
 */
export function holdDecision(hold: Hold, st: HoldEpochState, now: number, createdAt: number): HoldDecision {
  const collecting = st.status === 1 && st.count > 0;
  if (collecting && st.count >= hold.minOthers) return { action: "release" };
  if (collecting) {
    const deadline = st.startedAt + st.tMax - EPOCH_END_LEAD_SEC;
    if (now >= deadline) {
      return hold.submitByEpochEnd ? { action: "release" } : { action: "drop", reason: `the epoch reached its end with ${st.count} other intent(s), fewer than ${hold.minOthers}` };
    }
  }
  if (now >= createdAt + HOLD_MAX_SEC) return { action: "drop", reason: "held for 14 days without release" };
  return collecting ? { action: "wait", count: st.count, opensAt: st.startedAt + st.tMax } : { action: "wait", count: 0 };
}

/** `v1migrate` with notBefore: release once it has passed; expire after 14 days held. */
export function notBeforeDecision(notBefore: number, now: number, createdAt: number): HoldDecision {
  if (now >= notBefore) return { action: "release" };
  if (now >= createdAt + HOLD_MAX_SEC) return { action: "drop", reason: "held for 14 days without release" };
  return { action: "wait", count: 0, opensAt: notBefore };
}

/** Independent release delay in [0, RELEASE_JITTER_MS) for each held request (never one burst). */
export function releaseJitterMs(rng: () => number = Math.random): number {
  const r = rng();
  const x = Math.floor((r >= 0 && r < 1 ? r : 0) * RELEASE_JITTER_MS);
  return Math.min(Math.max(x, 0), RELEASE_JITTER_MS - 1);
}

/** Gas units a kind is quoted at (stage-2 from the gas file, stage-1 from env / relay.ts defaults). */
export function gasUnitsOf(kind: RelayKind2, units2: GasUnits2, units1: Record<Stage1Kind, bigint>): bigint {
  return kind in units2 ? units2[kind as Stage2Kind] : units1[kind as Stage1Kind];
}
