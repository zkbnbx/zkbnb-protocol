/**
 * Stage-2 relayer (keeper/src/relayer) — workplan §4.3: quote tiers from the gas file, parse negatives incl. plant,
 * per-direction hold lifecycle submit/drop with jitter, claims never held, v1migrate notBefore, onChain input fill,
 * nullifier locks, no body logging. Everything runs against a mocked chain port; no RPC, no anvil.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FEE_TIERS,
  FIELD_SIZE,
  INTENT_FEE,
  MAX_RELAYER_FEE,
  RELEASE_JITTER_MS,
  parseRelayRequest2,
  type Hex,
  type OnChainPolicyInput,
} from "../src/relayer/protocol.js";
import {
  acceptedKeys,
  encodeHandle,
  holdDecision,
  intentPolicy,
  parseGasUnits,
  plantPolicy,
  releaseJitterMs,
  tierFeePolicy,
  tieredQuote,
  toField,
  transferPolicy,
  v1migratePolicy,
  type Stage2Env,
} from "../src/relayer/policy.js";
import { HeldCipher, HeldManager, HeldStore, stateKey, type HeldRecord } from "../src/relayer/held.js";
import { InflightLock, TokenBucket } from "../src/relayer/queue.js";
import { readPolicyInput } from "../src/relayer/onchain.js";
import { EpochsCache } from "../src/relayer/epochs.js";
import { Relayer, loadRelayerConfig, type RelayerChain, type RelayerConfig } from "../src/relayer/server.js";
import type { HoldEpochState } from "../src/relayer/policy.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const GAS_FILE = path.resolve(here, "..", "..", "contracts", "gas-v2.json");
const HELD_KEY = "11".repeat(32);

const ME = "0x3d37000000000000000000000000000000009c30" as Hex;
const OTHER = "0x00000000000000000000000000000000000000aa" as Hex;
const POOL = "0x9001000000000000000000000000000000000001" as Hex;
const DARK = "0xdc00000000000000000000000000000000000001" as Hex;
const PLANTER = "0x91a0000000000000000000000000000000000001" as Hex;
const LAUNCHPAD = "0x1a00000000000000000000000000000000000001" as Hex;
const V1 = "0x5b00000000000000000000000000000000000001" as Hex;
const COIN = "0xa000000000000000000000000000000000000001" as Hex;
const COIN2 = "0xa000000000000000000000000000000000000002" as Hex;
const RECIP = "0x00000000000000000000000000000000000000bb" as Hex;
const HASH = `0x${"ab".repeat(32)}` as Hex;
const B32 = `0x${"01".repeat(32)}` as Hex;
const GWEI_TENTH = 100_000_000n; // 0.1 gwei
const KEY: [string, string] = ["111", "222"];
const KEY_NEXT: [string, string] = ["333", "444"];
const PLANT_FEE = 5_000_000_000_000_000n;

const units = parseGasUnits(JSON.parse(fs.readFileSync(GAS_FILE, "utf8")));

function cfg(extra: NodeJS.ProcessEnv = {}): RelayerConfig {
  return loadRelayerConfig({ GAS_UNITS_FILE: GAS_FILE, RELAYER_HELD_KEY: HELD_KEY, RELAYER_ALLOWED_ORIGINS: "https://zkbnb.app", ...extra });
}

const proof2 = { a: ["1", "2"], b: [["3", "4"], ["5", "6"]], c: ["7", "8"] };
const enc3 = ["0x1234", "0x5678", "0x9abc"];
let nCounter = 1000n;
const nul = () => (nCounter++).toString();

function transferBody(o: { fee?: bigint; extAmountBnb?: bigint; recipient?: Hex; relayer?: Hex; kind?: "transfer" | "plant"; payload?: Hex; n?: [string, string] } = {}) {
  const fee = o.fee ?? FEE_TIERS[0];
  const ext = o.extAmountBnb ?? -10_000_000_000_000_000n;
  return {
    kind: o.kind ?? "transfer",
    chainId: 56,
    proof: proof2,
    pub: {
      root: "5",
      publicAmount: toField(ext - fee).toString(),
      coin: "0x0000000000000000000000000000000000000000",
      publicAmountCoin: "0",
      accRpt: "0",
      handle: "0",
      claimAmount: "0",
      extDataHash: B32,
      inputNullifiers: o.n ?? [nul(), nul()],
      outputCommitments: ["9", "10", "11"],
    },
    extData: { recipient: o.recipient ?? RECIP, extAmountBnb: ext.toString(), extAmountCoin: "0", relayer: o.relayer ?? ME, fee: fee.toString(), payload: o.payload ?? "0x", encryptedOutputs: enc3 },
  };
}

function intentBody(o: { coin?: Hex; dir?: number; fee?: bigint; hold?: unknown; ecPk?: [string, string]; c1x?: string } = {}) {
  const fee = o.fee ?? FEE_TIERS[1];
  const b: Record<string, unknown> = {
    kind: "intent",
    chainId: 56,
    proof: proof2,
    pub: {
      root: "5",
      publicAmount: (FIELD_SIZE - (fee + INTENT_FEE)).toString(),
      coin: o.coin ?? COIN,
      accRpt: "0",
      dir: o.dir ?? 0,
      ecPk: o.ecPk ?? KEY,
      c1: [o.c1x ?? nul(), "1"],
      c2: ["2", "3"],
      extDataHash: B32,
      inputNullifiers: [nul(), nul()],
      outputCommitments: ["9", "10", "11"],
    },
    extData: { relayer: ME, fee: fee.toString(), encryptedOutputs: enc3 },
  };
  if (o.hold !== undefined) b.hold = o.hold;
  return b;
}

function claimBody(extra: Record<string, unknown> = {}) {
  return { kind: "claim", chainId: 56, proof: proof2, pub: { root: "5", nullifier: nul(), outputCommitments: ["1", "2"], extDataHash: B32 }, extData: { relayer: ME, encryptedOutputs: ["0x12", "0x34"] }, ...extra };
}

function v1Body(o: { handle?: bigint; bound?: bigint; notBefore?: number; fee?: bigint } = {}) {
  const handle = o.handle ?? 777n;
  const fee = o.fee ?? FEE_TIERS[2];
  const ext = -100_000_000_000_000_000n;
  const b: Record<string, unknown> = {
    kind: "v1migrate",
    chainId: 56,
    proof: { ...proof2, root: "5", publicAmount: toField(ext - fee).toString(), extDataHash: B32, inputNullifiers: [nul(), nul()], outputCommitments: ["1", "2"] },
    extData: { recipient: POOL, extAmount: ext.toString(), relayer: ME, fee: fee.toString(), encryptedOutput1: "0x12", encryptedOutput2: encodeHandle(o.bound ?? handle) },
    handle: handle.toString(),
  };
  if (o.notBefore !== undefined) b.notBefore = o.notBefore;
  return b;
}

interface MockState {
  now: number;
  gasPrice: bigint;
  onChain: OnChainPolicyInput;
  states: Map<string, HoldEpochState>;
  sendGate?: Promise<void>;
  revert?: string;
}

function mockChain(st: MockState, over: Partial<RelayerChain> = {}): RelayerChain & { sent: { fn: string; args: readonly unknown[] }[] } {
  const sent: { fn: string; args: readonly unknown[] }[] = [];
  let i = 0;
  return {
    sent,
    address: ME,
    chainId: 56,
    addrs: { shieldedPool: V1, launchpad: LAUNCHPAD, grovePool: POOL, darkCurve: DARK, planter: PLANTER },
    dryRun: false,
    gasPrice: async () => st.gasPrice,
    balance: async () => 10n ** 18n,
    policyInput: async () => ({ onChain: st.onChain, now: st.now }),
    read: async () => undefined,
    vaultState: async () => ({ exists: false, balance: 0n }),
    estimate: async () => {
      if (st.revert) throw new Error(st.revert);
      return 900_000n;
    },
    send: async (call) => {
      if (st.sendGate) await st.sendGate;
      sent.push({ fn: call.functionName, args: call.args });
      i++;
      return `0x${i.toString(16).padStart(64, "0")}` as Hex;
    },
    holdStates: async (keys) => ({ now: st.now, states: new Map(keys.map((k) => [stateKey(k.coin, k.dir), st.states.get(stateKey(k.coin, k.dir)) ?? { seq: 0, status: 0, count: 0, startedAt: 0, tMax: 300 }])) }),
    epochs: async () => ({ chainId: 56, coins: { [COIN]: [] }, updatedAt: 1 }),
    checkpoint: async () => {},
    ...over,
  };
}

function baseState(): MockState {
  return { now: Math.floor(Date.now() / 1000), gasPrice: GWEI_TENTH, onChain: { coordinatorKey: [KEY, KEY_NEXT], keySwitchAt: 0, plantFee: PLANT_FEE.toString(), seenC1: false }, states: new Map() };
}

const silentLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function env(over: Partial<Stage2Env> = {}): Stage2Env {
  return { relayer: ME, expectedChainId: 56, gasPrice: GWEI_TENTH, gasUnits: units, flat: 0n, now: 1_800_000_000, grovePool: POOL, planter: PLANTER, ...over };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ------------------------------------------------------------------------------------------------- quotes

describe("quote tiers from the gas file", () => {
  it("loads every relayed kind from contracts/gas-v2.json", () => {
    const raw = JSON.parse(fs.readFileSync(GAS_FILE, "utf8"));
    expect(units).toEqual({ transfer: BigInt(raw.transfer), plant: BigInt(raw.plant), intent: BigInt(raw.intent), claim: BigInt(raw.claim), v1migrate: BigInt(raw.v1migrate) });
    expect(() => parseGasUnits({ ...raw, plant: undefined })).toThrow(/plant/);
    expect(() => parseGasUnits({ ...raw, intent: -1 })).toThrow(/intent/);
  });

  it("quotes the smallest tier ≥ gasPrice × gasUnits × 1.2 + flat, and every larger tier", () => {
    for (const kind of ["transfer", "plant", "intent", "v1migrate"] as const) {
      for (const gp of [GWEI_TENTH, 1_000_000_000n]) {
        const need = (gp * units[kind] * 12_000n) / 10_000n;
        const q = tieredQuote(gp, units[kind]);
        const expected = FEE_TIERS.filter((t) => t >= need);
        if (expected.length === 0) {
          expect(q.ok).toBe(false);
          continue;
        }
        expect(q).toMatchObject({ ok: true, fee: expected[0], tier: FEE_TIERS.indexOf(expected[0]), tiers: expected });
      }
    }
    // intent at 0.1 gwei: 2,099,000 × 1e8 × 1.2 = 2.52e14 → the 0.0005 BNB tier
    expect(tieredQuote(GWEI_TENTH, units.intent)).toMatchObject({ ok: true, fee: 500_000_000_000_000n, tier: 1 });
    // the flat part moves it up a tier
    expect(tieredQuote(GWEI_TENTH, units.intent, 2_000n, 300_000_000_000_000n)).toMatchObject({ ok: true, fee: 1_000_000_000_000_000n });
    // no tier fits: not available (never a fee above the largest tier or the contract cap)
    expect(tieredQuote(10_000_000_000n, units.plant)).toMatchObject({ ok: false });
    expect(FEE_TIERS.every((t) => t <= MAX_RELAYER_FEE)).toBe(true);
  });

  it("GET /relay?kind=intent answers a tiered quote; claims are free; untiered stage-1 quotes", async () => {
    const r = new Relayer(cfg(), mockChain(baseState()), { log: silentLog, heldInMemory: true });
    const q = (await r.quote("intent", 56)).body as Record<string, unknown>;
    expect(q).toMatchObject({ ok: true, chainId: 56, kind: "intent", relayer: ME, fee: "500000000000000", feeTier: 1, gasPrice: "100000000", gasUnits: String(units.intent) });
    expect(q.tiers).toEqual(FEE_TIERS.slice(1).map(String));
    expect(Number(q.validUntil)).toBeGreaterThan(Date.now() / 1000);
    const c = (await r.quote("claim", 56)).body as Record<string, unknown>;
    expect(c).toMatchObject({ ok: true, fee: "0", feeTier: null, tiers: [], gasUnits: String(units.claim) });
    const t = (await r.quote("transact", 56)).body as Record<string, unknown>;
    expect(t).toMatchObject({ ok: true, fee: String((GWEI_TENTH * 1_000_000n * 12n) / 10n), feeTier: null });
    expect((await r.quote("intent", 97)).body).toMatchObject({ ok: false });
  });

  it("stage-2 kinds are refused while the stage-2 addresses are absent; stage 1 still quotes", async () => {
    const chain = mockChain(baseState());
    chain.addrs = { shieldedPool: V1, launchpad: LAUNCHPAD };
    const r = new Relayer(cfg(), chain, { log: silentLog, heldInMemory: true });
    expect((await r.quote("intent", 56)).body).toMatchObject({ ok: false, reason: expect.stringMatching(/not deployed/) });
    expect((await r.quote("transact", 56)).body).toMatchObject({ ok: true });
    expect((await r.submit(transferBody())).body).toMatchObject({ ok: false, code: "unavailable" });
    expect(r.held).toBeNull();
    expect(r.epochsCache).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------- parsing

describe("parse", () => {
  it("accepts negative int256 amounts (transfer, plant, v1migrate) and refuses negative uints", () => {
    const p = parseRelayRequest2(transferBody({ kind: "plant", recipient: PLANTER, extAmountBnb: -PLANT_FEE }));
    expect(p).toMatchObject({ ok: true, kind: "plant" });
    if (p.ok && p.kind === "plant") expect(p.extData.extAmountBnb).toBe(-PLANT_FEE);
    const v = parseRelayRequest2(v1Body());
    expect(v).toMatchObject({ ok: true, kind: "v1migrate" });
    if (v.ok && v.kind === "v1migrate") expect(v.extData.extAmount).toBe(-100_000_000_000_000_000n);
    const bad = transferBody();
    (bad.extData as Record<string, unknown>).fee = "-1";
    expect(parseRelayRequest2(bad)).toMatchObject({ ok: false, error: expect.stringMatching(/extData.fee/) });
    const notField = transferBody();
    (notField.pub as Record<string, unknown>).root = FIELD_SIZE.toString();
    expect(parseRelayRequest2(notField)).toMatchObject({ ok: false, error: expect.stringMatching(/field/) });
  });

  it("validates hold, refuses hold on claims and notBefore outside v1migrate", () => {
    expect(parseRelayRequest2(intentBody({ hold: { minOthers: 3, submitByEpochEnd: true } }))).toMatchObject({ ok: true, hold: { minOthers: 3, submitByEpochEnd: true } });
    expect(parseRelayRequest2(intentBody({ hold: { minOthers: 0, submitByEpochEnd: true } }))).toMatchObject({ ok: false });
    expect(parseRelayRequest2(intentBody({ hold: { minOthers: 17, submitByEpochEnd: false } }))).toMatchObject({ ok: false });
    expect(parseRelayRequest2(claimBody({ hold: { minOthers: 1, submitByEpochEnd: true } }))).toMatchObject({ ok: false, error: expect.stringMatching(/never held/) });
    expect(parseRelayRequest2({ ...transferBody(), notBefore: 1 })).toMatchObject({ ok: false });
    expect(parseRelayRequest2(claimBody({ extData: { relayer: ME, fee: "1", encryptedOutputs: ["0x", "0x"] } }))).toMatchObject({ ok: false, error: expect.stringMatching(/no fee/) });
    expect(parseRelayRequest2({ kind: "nope", chainId: 56 })).toMatchObject({ ok: false });
    // stage-1 default kind
    expect(parseRelayRequest2({ chainId: 56, proof: v1Body().proof, extData: (v1Body() as { extData: unknown }).extData })).toMatchObject({ ok: true, kind: "transact" });
  });
});

// ------------------------------------------------------------------------------------------------- policies

describe("pure policies", () => {
  const parsedTransfer = (b: ReturnType<typeof transferBody>) => {
    const p = parseRelayRequest2(b);
    if (!p.ok || (p.kind !== "transfer" && p.kind !== "plant")) throw new Error("parse");
    return p;
  };

  it("transfer: no shields, not to the planter, payload only a hand-over, publicAmount bound, tier fee", () => {
    const ok = parsedTransfer(transferBody());
    expect(transferPolicy(56, ok.pub, ok.extData, env())).toBeNull();
    const shield = parsedTransfer(transferBody({ extAmountBnb: 10n ** 16n }));
    expect(transferPolicy(56, shield.pub, shield.extData, env())).toMatchObject({ code: "invalid", error: expect.stringMatching(/shield/) });
    const toPlanter = parsedTransfer(transferBody({ recipient: PLANTER }));
    expect(transferPolicy(56, toPlanter.pub, toPlanter.extData, env())).toMatchObject({ error: expect.stringMatching(/plant/) });
    const plantPayload = parsedTransfer(transferBody({ payload: encodeHandle(2n) }));
    expect(transferPolicy(56, plantPayload.pub, plantPayload.extData, env())).toMatchObject({ error: expect.stringMatching(/hand-over/) });
    const handover = parsedTransfer(transferBody({ payload: encodeHandle(1n) }));
    expect(transferPolicy(56, handover.pub, handover.extData, env())).toBeNull();
    const other = parsedTransfer(transferBody({ relayer: OTHER }));
    expect(transferPolicy(56, other.pub, other.extData, env())).toMatchObject({ error: expect.stringMatching(/not this relayer/) });
    const wrongChain = parsedTransfer(transferBody());
    expect(transferPolicy(97, wrongChain.pub, wrongChain.extData, env())).toMatchObject({ code: "chain" });
    const offTier = parsedTransfer(transferBody({ fee: 300_000_000_000_000n }));
    expect(transferPolicy(56, offTier.pub, offTier.extData, env())).toMatchObject({ code: "fee" });
    const lowTier = parsedTransfer(transferBody({ fee: FEE_TIERS[0] }));
    expect(transferPolicy(56, lowTier.pub, lowTier.extData, env({ gasPrice: 1_000_000_000n }))).toMatchObject({ code: "fee", error: expect.stringMatching(/cover/) });
    const bent = transferBody();
    bent.pub.publicAmount = "1";
    const bentP = parsedTransfer(bent);
    expect(transferPolicy(56, bentP.pub, bentP.extData, env())).toMatchObject({ error: expect.stringMatching(/publicAmount/) });
  });

  it("fee cap: never above MAX_RELAYER_FEE, never off-tier", () => {
    expect(tierFeePolicy(MAX_RELAYER_FEE * 2n, 1n, 1n)).toMatchObject({ code: "fee" });
    expect(tierFeePolicy(0n, 1n, 1n)).toMatchObject({ code: "fee" });
    expect(tierFeePolicy(FEE_TIERS[4], GWEI_TENTH, units.plant)).toBeNull();
  });

  it("plant: recipient == planter, −extAmountBnb == plantFee, ACTION_PLANT payload, its own gas units", () => {
    const plantPayload = `${encodeHandle(2n)}${"00".repeat(64)}` as Hex;
    const good = parsedTransfer(transferBody({ kind: "plant", recipient: PLANTER, extAmountBnb: -PLANT_FEE, payload: plantPayload, fee: FEE_TIERS[1] }));
    const oc = { plantFee: PLANT_FEE.toString() };
    expect(plantPolicy(56, good.pub, good.extData, env(), oc)).toBeNull();
    expect(plantPolicy(56, good.pub, good.extData, env({ planter: undefined }), oc)).toMatchObject({ error: expect.stringMatching(/not deployed/) });
    expect(plantPolicy(56, good.pub, good.extData, env(), { plantFee: "1" })).toMatchObject({ error: expect.stringMatching(/plant fee/) });
    // the plant's gas units (3.75 M) make the 0.0002 tier too small where a transfer's is enough
    const cheap = parsedTransfer(transferBody({ kind: "plant", recipient: PLANTER, extAmountBnb: -PLANT_FEE, payload: plantPayload, fee: FEE_TIERS[0] }));
    expect(plantPolicy(56, cheap.pub, cheap.extData, env(), oc)).toMatchObject({ code: "fee" });
    const handoverPayload = parsedTransfer(transferBody({ kind: "plant", recipient: PLANTER, extAmountBnb: -PLANT_FEE, payload: encodeHandle(1n), fee: FEE_TIERS[1] }));
    expect(plantPolicy(56, handoverPayload.pub, handoverPayload.extData, env(), oc)).toMatchObject({ error: expect.stringMatching(/ACTION_PLANT/) });
    const notPlanter = parsedTransfer(transferBody({ kind: "plant", recipient: RECIP, extAmountBnb: -PLANT_FEE, payload: plantPayload, fee: FEE_TIERS[1] }));
    expect(plantPolicy(56, notPlanter.pub, notPlanter.extData, env(), oc)).toMatchObject({ error: expect.stringMatching(/planter/) });
  });

  it("intent: publicAmount = field(−fee − INTENT_FEE), Coordinator key window, fresh C1", () => {
    const p = parseRelayRequest2(intentBody());
    if (!p.ok || p.kind !== "intent") throw new Error("parse");
    const oc: OnChainPolicyInput = { coordinatorKey: [KEY, KEY_NEXT], keySwitchAt: 0, plantFee: "0", seenC1: false };
    expect(intentPolicy(56, p.pub, p.extData, env(), oc)).toBeNull();
    expect(intentPolicy(56, p.pub, p.extData, env(), { ...oc, seenC1: true })).toMatchObject({ error: expect.stringMatching(/randomness/) });
    expect(intentPolicy(56, { ...p.pub, publicAmount: 5n }, p.extData, env(), oc)).toMatchObject({ error: expect.stringMatching(/INTENT_FEE/) });
    const next = parseRelayRequest2(intentBody({ ecPk: KEY_NEXT }));
    if (!next.ok || next.kind !== "intent") throw new Error("parse");
    const now = 1_800_000_000;
    // the pending key: refused before the overlap, accepted inside it, alone after switchAt
    expect(intentPolicy(56, next.pub, next.extData, env({ now }), { ...oc, keySwitchAt: now + 3600 })).toMatchObject({ error: expect.stringMatching(/Coordinator key/) });
    expect(intentPolicy(56, next.pub, next.extData, env({ now }), { ...oc, keySwitchAt: now + 300 })).toBeNull();
    expect(intentPolicy(56, p.pub, p.extData, env({ now }), { ...oc, keySwitchAt: now + 300 })).toBeNull();
    expect(intentPolicy(56, p.pub, p.extData, env({ now }), { ...oc, keySwitchAt: now - 1 })).toMatchObject({ error: expect.stringMatching(/Coordinator key/) });
    expect(acceptedKeys({ ...oc, keySwitchAt: now - 1 }, now)).toEqual([KEY_NEXT]);
  });

  it("v1migrate: unshield to the GrovePool, bound to the handle (encryptedOutput2 == abi.encode(handle)), notBefore ≤ 14 d", () => {
    const parse = (b: Record<string, unknown>) => {
      const p = parseRelayRequest2(b);
      if (!p.ok || p.kind !== "v1migrate") throw new Error("parse");
      return p;
    };
    const ok = parse(v1Body());
    const e = env();
    expect(v1migratePolicy(56, ok.proof.publicAmount, ok.extData, ok.handle, undefined, e)).toBeNull();
    const unbound = parse(v1Body({ handle: 777n, bound: 778n }));
    expect(v1migratePolicy(56, unbound.proof.publicAmount, unbound.extData, unbound.handle, undefined, e)).toMatchObject({ error: expect.stringMatching(/not bound/) });
    expect(v1migratePolicy(56, ok.proof.publicAmount, { ...ok.extData, recipient: RECIP }, ok.handle, undefined, e)).toMatchObject({ error: expect.stringMatching(/GrovePool/) });
    expect(v1migratePolicy(56, ok.proof.publicAmount, ok.extData, ok.handle, e.now + 14 * 86_400 + 1, e)).toMatchObject({ error: expect.stringMatching(/14 days/) });
    expect(v1migratePolicy(56, ok.proof.publicAmount, ok.extData, ok.handle, e.now + 14 * 86_400, e)).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------- holds

describe("per-direction hold lifecycle", () => {
  function manager(st: MockState, submit = vi.fn(async (_r: HeldRecord) => ({ ok: true as const, hash: HASH }))) {
    const scheduled: { fn: () => void; ms: number }[] = [];
    let r = 0;
    const rngs = [0.1, 0.9, 0.5, 0.3];
    const m = new HeldManager({
      store: new HeldStore(null, new HeldCipher(HELD_KEY)),
      readStates: async (keys) => ({ now: st.now, states: new Map(keys.map((k) => [stateKey(k.coin, k.dir), st.states.get(stateKey(k.coin, k.dir))!]).filter(([, v]) => v)) as Map<string, HoldEpochState> }),
      submit,
      schedule: (fn, ms) => scheduled.push({ fn, ms }),
      rng: () => rngs[r++ % rngs.length],
      nowSec: () => st.now,
    });
    return { m, scheduled, submit };
  }
  const rec = (coin: Hex, dir: number, minOthers: number, submitByEpochEnd: boolean, n: string) => ({ kind: "intent" as const, body: intentBody({ coin, dir }), nullifiers: [n], coin, dir, hold: { minOthers, submitByEpochEnd } });

  it("decision rule: count ≥ minOthers releases; at startedAt + T_MAX − 30 s submit or drop; idle waits", () => {
    const st = { seq: 4, status: 1, count: 2, startedAt: 1000, tMax: 300 };
    expect(holdDecision({ minOthers: 2, submitByEpochEnd: false }, st, 1100, 900)).toEqual({ action: "release" });
    expect(holdDecision({ minOthers: 3, submitByEpochEnd: false }, st, 1100, 900)).toEqual({ action: "wait", count: 2, opensAt: 1300 });
    expect(holdDecision({ minOthers: 3, submitByEpochEnd: true }, st, 1270, 900)).toEqual({ action: "release" });
    expect(holdDecision({ minOthers: 3, submitByEpochEnd: false }, st, 1270, 900)).toMatchObject({ action: "drop" });
    expect(holdDecision({ minOthers: 3, submitByEpochEnd: false }, { ...st, status: 0, count: 0 }, 99_999, 900)).toEqual({ action: "wait", count: 0 });
    expect(holdDecision({ minOthers: 3, submitByEpochEnd: false }, { ...st, status: 0, count: 0 }, 900 + 14 * 86_400, 900)).toMatchObject({ action: "drop" });
  });

  it("jitter is independent per release and inside [0, 20 s)", () => {
    expect(releaseJitterMs(() => 0)).toBe(0);
    expect(releaseJitterMs(() => 0.999999)).toBe(RELEASE_JITTER_MS - 1);
    expect(releaseJitterMs(() => 1)).toBe(0);
    const xs = Array.from({ length: 200 }, () => releaseJitterMs());
    expect(xs.every((x) => x >= 0 && x < RELEASE_JITTER_MS)).toBe(true);
    expect(new Set(xs).size).toBeGreaterThan(50);
  });

  it("releases each direction individually with its own jitter, re-checks on fire, drops at the epoch end", async () => {
    const st = baseState();
    const { m, scheduled, submit } = manager(st);
    const buy = m.add(rec(COIN, 0, 2, false, "1"));
    const sell = m.add(rec(COIN, 1, 2, false, "2"));
    const buy2 = m.add(rec(COIN, 0, 2, true, "3"));
    const harvest = m.add(rec(COIN2, 2, 5, false, "4"));
    if (!buy.ok || !sell.ok || !buy2.ok || !harvest.ok) throw new Error("add");
    // a second hold spending the same note is refused
    expect(m.add(rec(COIN, 0, 2, false, "1"))).toMatchObject({ ok: false });

    // BUY has 2 others, SELL 1, HARVEST of COIN2 is collecting with 1 (minOthers 5)
    st.states.set(stateKey(COIN, 0), { seq: 0, status: 1, count: 2, startedAt: st.now - 100, tMax: 300 });
    st.states.set(stateKey(COIN, 1), { seq: 0, status: 1, count: 1, startedAt: st.now - 100, tMax: 300 });
    st.states.set(stateKey(COIN2, 2), { seq: 3, status: 1, count: 1, startedAt: st.now - 10, tMax: 300 });
    expect(await m.tick()).toEqual({ released: 2, dropped: 0, waiting: 2 });
    // both BUY holds were scheduled separately, each with its own delay (rng 0.1 and 0.9), never as a burst
    expect(scheduled.map((s) => s.ms)).toEqual([2_000, 18_000]);
    expect(m.status(sell.ticket)).toEqual({ status: "held", count: 1, opensAt: st.now - 100 + 300 });
    expect(submit).not.toHaveBeenCalled();
    // a second tick does not schedule the releasing ones again
    await m.tick();
    expect(scheduled).toHaveLength(2);

    for (const s of scheduled) s.fn();
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    expect(submit.mock.calls.map((c) => c[0].ticket).sort()).toEqual([buy.ticket, buy2.ticket].sort());
    await vi.waitFor(() => expect(m.status(buy.ticket)).toEqual({ status: "submitted", hash: HASH }));
    expect(m.holdsNullifier("1")).toBe(false);

    // SELL reaches its end (startedAt + T_MAX − 30 s) with 1 other < 2 and no submitByEpochEnd → dropped
    st.now += 175;
    expect(await m.tick()).toMatchObject({ dropped: 1 });
    expect(m.status(sell.ticket)).toMatchObject({ status: "dropped", reason: expect.stringMatching(/fewer than 2/) });
    expect(m.status(harvest.ticket)).toMatchObject({ status: "held" });
    expect(m.size).toBe(1);
  });

  it("a release whose epoch opened during the jitter goes back to waiting; a failed submit is dropped", async () => {
    const st = baseState();
    const submit = vi.fn(async () => ({ ok: false as const, error: "reverted: UnknownRoot" }));
    const { m, scheduled } = manager(st, submit);
    const a = m.add(rec(COIN, 0, 1, false, "7"));
    if (!a.ok) throw new Error("add");
    st.states.set(stateKey(COIN, 0), { seq: 0, status: 1, count: 1, startedAt: st.now, tMax: 300 });
    await m.tick();
    expect(scheduled).toHaveLength(1);
    st.states.set(stateKey(COIN, 0), { seq: 1, status: 0, count: 0, startedAt: 0, tMax: 300 }); // opened meanwhile
    scheduled[0].fn();
    await vi.waitFor(() => expect(m.status(a.ticket)).toEqual({ status: "held", count: undefined, opensAt: undefined }));
    expect(submit).not.toHaveBeenCalled();
    st.states.set(stateKey(COIN, 0), { seq: 1, status: 1, count: 3, startedAt: st.now, tMax: 300 });
    await m.tick();
    scheduled[1].fn();
    await vi.waitFor(() => expect(m.status(a.ticket)).toMatchObject({ status: "dropped", reason: "reverted: UnknownRoot" }));
  });

  it("the held store is encrypted at rest and restores after a restart", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "held-"));
    try {
      const store = new HeldStore(dir, new HeldCipher(HELD_KEY));
      const st = baseState();
      const m = new HeldManager({ store, readStates: async () => ({ now: st.now, states: new Map() }), submit: async () => ({ ok: true, hash: HASH }), nowSec: () => st.now });
      const body = intentBody();
      const nullifier = (body.pub as { inputNullifiers: string[] }).inputNullifiers[0];
      const a = m.add({ kind: "intent", body, nullifiers: [nullifier], coin: COIN, dir: 0, hold: { minOthers: 2, submitByEpochEnd: true } });
      if (!a.ok) throw new Error("add");
      const raw = fs.readFileSync(path.join(dir, `${a.ticket}.bin`));
      expect(raw.toString("latin1")).not.toContain(nullifier);
      expect(raw.toString("latin1")).not.toContain("intent");
      const m2 = new HeldManager({ store: new HeldStore(dir, new HeldCipher(HELD_KEY)), readStates: async () => ({ now: 0, states: new Map() }), submit: async () => ({ ok: true, hash: HASH }) });
      expect(m2.restore()).toEqual({ restored: 1, unreadable: 0 });
      expect(m2.holdsNullifier(nullifier)).toBe(true);
      expect(new HeldStore(dir, new HeldCipher("22".repeat(32))).load()).toEqual({ records: [], unreadable: 1 });
      expect(() => new HeldCipher("1234")).toThrow(/32 bytes/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------------------------------------------------------- the server path

describe("relayer submit path", () => {
  it("sends a transfer immediately and an intent with `hold` only when its direction is ready", async () => {
    const st = baseState();
    const chain = mockChain(st);
    const scheduled: (() => void)[] = [];
    const r = new Relayer(cfg(), chain, { log: silentLog, heldInMemory: true, schedule: (fn) => scheduled.push(fn), unlockDelayMs: 0 });
    expect((await r.submit(transferBody())).body).toMatchObject({ ok: true, hash: expect.stringMatching(/^0x/) });
    expect(chain.sent[0].fn).toBe("transact");

    const held = await r.submit(intentBody({ dir: 1, hold: { minOthers: 2, submitByEpochEnd: false } }));
    expect(held.body).toMatchObject({ ok: true, held: true, ticket: expect.stringMatching(/^[0-9a-f]{32}$/) });
    const ticket = (held.body as { ticket: string }).ticket;
    expect(chain.sent).toHaveLength(1);
    expect(r.heldStatus(ticket).body).toEqual({ status: "held" });
    st.states.set(stateKey(COIN, 1), { seq: 0, status: 1, count: 2, startedAt: st.now, tMax: 300 });
    await r.pollHeld();
    expect(scheduled).toHaveLength(1);
    scheduled[0]();
    await vi.waitFor(() => expect(r.heldStatus(ticket).body).toMatchObject({ status: "submitted", hash: expect.stringMatching(/^0x/) }));
    expect(chain.sent[1].fn).toBe("submitIntent");
    expect(r.heldStatus("f".repeat(32)).status).toBe(404);
  });

  it("claims are never held: sent at once, free, and a `hold` on a claim is refused", async () => {
    const st = baseState();
    const chain = mockChain(st);
    const r = new Relayer(cfg(), chain, { log: silentLog, heldInMemory: true, unlockDelayMs: 0 });
    expect((await r.submit(claimBody({ hold: { minOthers: 1, submitByEpochEnd: true } }))).body).toMatchObject({ ok: false, code: "invalid", error: expect.stringMatching(/never held/) });
    st.gasPrice = 50_000_000_000n; // a claim has no fee: it is relayed whatever the gas price
    expect((await r.submit(claimBody())).body).toMatchObject({ ok: true, hash: expect.stringMatching(/^0x/) });
    expect(chain.sent.map((s) => s.fn)).toEqual(["claim"]);
    expect(r.held!.size).toBe(0);
    expect((await r.submit(claimBody({ extData: { relayer: OTHER, encryptedOutputs: ["0x", "0x"] } }))).body).toMatchObject({ ok: false, error: expect.stringMatching(/not this relayer/) });
  });

  it("v1migrate with a future notBefore is held until then; a past one is sent now", async () => {
    const st = baseState();
    const chain = mockChain(st);
    const scheduled: (() => void)[] = [];
    const r = new Relayer(cfg(), chain, { log: silentLog, heldInMemory: true, schedule: (fn) => scheduled.push(fn), unlockDelayMs: 0 });
    const res = await r.submit(v1Body({ notBefore: st.now + 3 * 86_400 }));
    expect(res.body).toMatchObject({ ok: true, held: true });
    const ticket = (res.body as { ticket: string }).ticket;
    await r.pollHeld();
    expect(r.heldStatus(ticket).body).toEqual({ status: "held", opensAt: st.now + 3 * 86_400 });
    expect(scheduled).toHaveLength(0);
    st.now += 3 * 86_400;
    await r.pollHeld();
    scheduled[0]();
    await vi.waitFor(() => expect(r.heldStatus(ticket).body).toMatchObject({ status: "submitted" }));
    expect(chain.sent.map((s) => s.fn)).toEqual(["migrateFromV1"]);
    expect(chain.sent[0].args[2]).toBe(777n);
    expect((await r.submit(v1Body({ notBefore: st.now - 1 }))).body).toMatchObject({ ok: true, hash: expect.stringMatching(/^0x/) });
    expect((await r.submit(v1Body({ notBefore: st.now + 15 * 86_400 }))).body).toMatchObject({ ok: false, code: "invalid" });
    expect((await r.submit(v1Body({ handle: 5n, bound: 6n }))).body).toMatchObject({ ok: false, error: expect.stringMatching(/not bound/) });
  });

  it("holds need RELAYER_HELD_KEY; without it immediate requests still work", async () => {
    const chain = mockChain(baseState());
    const r = new Relayer(cfg({ RELAYER_HELD_KEY: "" }), chain, { log: silentLog, unlockDelayMs: 0 });
    expect(r.held).toBeNull();
    expect((await r.submit(intentBody({ hold: { minOthers: 1, submitByEpochEnd: true } }))).body).toMatchObject({ ok: false, code: "unavailable" });
    expect((await r.submit(intentBody())).body).toMatchObject({ ok: true });
  });

  it("nullifier locks: a concurrent duplicate is refused while the first is in flight, and a held note cannot be spent twice", async () => {
    const st = baseState();
    let open!: () => void;
    st.sendGate = new Promise<void>((res) => (open = res));
    const chain = mockChain(st);
    const r = new Relayer(cfg(), chain, { log: silentLog, heldInMemory: true, unlockDelayMs: 0 });
    const n: [string, string] = [nul(), nul()];
    const first = r.submit(transferBody({ n }));
    await vi.waitFor(() => expect(r.inflight.has(`nullifier:${n[0]}`)).toBe(true));
    expect((await r.submit(transferBody({ n: [n[1], nul()] }))).body).toMatchObject({ ok: false, code: "busy" });
    open();
    expect((await first).body).toMatchObject({ ok: true });
    expect(r.inflight.has(`nullifier:${n[0]}`)).toBe(false);

    const body = intentBody({ hold: { minOthers: 9, submitByEpochEnd: false } });
    expect((await r.submit(body)).body).toMatchObject({ ok: true, held: true });
    const again = { ...body };
    delete (again as Record<string, unknown>).hold;
    expect((await r.submit(again)).body).toMatchObject({ ok: false, code: "busy" });
    // lock primitive
    const l = new InflightLock(1000);
    expect(l.take(["a", "b"], 0)).toBe(true);
    expect(l.take(["b", "c"], 10)).toBe(false);
    expect(l.take(["c"], 10)).toBe(true);
    expect(l.take(["a"], 2000)).toBe(true); // expired
  });

  it("a reverting simulation is refused and nothing is sent; dry-run never sends", async () => {
    const st = baseState();
    st.revert = "execution reverted";
    const chain = mockChain(st);
    const r = new Relayer(cfg(), chain, { log: silentLog, heldInMemory: true, unlockDelayMs: 0 });
    expect((await r.submit(transferBody())).body).toMatchObject({ ok: false, code: "reverted" });
    st.revert = undefined;
    const dry = mockChain(st, { dryRun: true });
    const rd = new Relayer(cfg(), dry, { log: silentLog, heldInMemory: true, unlockDelayMs: 0 });
    expect((await rd.submit(transferBody())).body).toMatchObject({ ok: false, code: "unavailable", error: expect.stringMatching(/dry run/) });
    expect(chain.sent).toHaveLength(0);
    expect(dry.sent).toHaveLength(0);
  });
});

// ------------------------------------------------------------------------------------------------- onChain fill

describe("onChain policy input", () => {
  it("fills coordinatorKey / keySwitchAt / plantFee / seenC1 from one batch of reads issued together", async () => {
    const calls: string[] = [];
    let issuedBeforeFirstResolve = -1;
    const gen = { value: 3n };
    const reader = {
      readContract: (p: { functionName: string; args?: readonly unknown[] }) => {
        calls.push(`${p.functionName}(${(p.args ?? []).map(String).join(",")})`);
        return Promise.resolve().then(() => {
          if (issuedBeforeFirstResolve < 0) issuedBeforeFirstResolve = calls.length;
          switch (p.functionName) {
            case "keyGen":
              return gen.value;
            case "keySwitchAt":
              return 1_800_000_500n;
            case "keyByGen": {
              const [g, i] = p.args as [bigint, bigint];
              return 1000n * g + i;
            }
            case "plantFee":
              return PLANT_FEE;
            case "seenC1":
              return (p.args as [bigint])[0] === 42n;
            default:
              throw new Error(p.functionName);
          }
        });
      },
      getBlock: () => {
        calls.push("block");
        return Promise.resolve({ timestamp: 1_800_000_000n });
      },
    };
    const cache: { gen?: number } = { gen: 3 };
    const r = await readPolicyInput(reader as never, { darkCurve: DARK as never, launchpad: LAUNCHPAD as never }, 42n, cache);
    expect(issuedBeforeFirstResolve).toBe(9); // all nine reads were in flight together (one JSON-RPC batch)
    expect(calls).toHaveLength(9);
    expect(r).toEqual({
      onChain: { coordinatorKey: [["3000", "3001"], ["4000", "4001"]], keySwitchAt: 1_800_000_500, plantFee: PLANT_FEE.toString(), seenC1: true },
      now: 1_800_000_000,
    });
    // keyGen moved since the cache: one re-issue with the new generation
    calls.length = 0;
    gen.value = 4n;
    const r2 = await readPolicyInput(reader as never, { darkCurve: DARK as never, launchpad: LAUNCHPAD as never }, 1n, cache);
    expect(calls).toHaveLength(18);
    expect(r2.onChain.coordinatorKey).toEqual([["4000", "4001"], ["5000", "5001"]]);
    expect(r2.onChain.seenC1).toBe(false);
    expect(cache.gen).toBe(4);
  });
});

// ------------------------------------------------------------------------------------------------- HTTP, logging

describe("HTTP server: CORS, rate limit, epochs cache, no body logging", () => {
  async function serve(c: RelayerConfig, chain: RelayerChain) {
    const r = new Relayer({ ...c, port: 0 }, chain, { heldInMemory: true, unlockDelayMs: 0 });
    const a = await r.listen();
    return { r, base: `http://127.0.0.1:${a.port}` };
  }

  it("logs exactly one line per send (kind and hash) and never the request", async () => {
    const lines: string[] = [];
    for (const m of ["log", "warn", "error", "info", "debug"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")));
    const st = baseState();
    const { r, base } = await serve(cfg(), mockChain(st));
    try {
      const body = transferBody();
      const text = JSON.stringify(body);
      const res = await fetch(`${base}/relay`, { method: "POST", headers: { "content-type": "application/json" }, body: text });
      const j = (await res.json()) as { ok: boolean; hash: string };
      expect(j.ok).toBe(true);
      // a failing request (bad JSON, a revert) logs nothing about its content either
      await fetch(`${base}/relay`, { method: "POST", body: "{not json" });
      st.revert = "boom";
      const body2 = transferBody();
      await fetch(`${base}/relay`, { method: "POST", body: JSON.stringify(body2) });
      await fetch(`${base}/relay?kind=intent&chainId=56`);
      const sends = lines.filter((l) => / sent /.test(l));
      expect(sends).toHaveLength(1);
      expect(sends[0]).toMatch(new RegExp(`\\[relayer\\] sent kind=transfer hash=${j.hash}$`));
      const secrets = [...body.pub.inputNullifiers, ...body2.pub.inputNullifiers, body.extData.recipient, "0x9abc", body.pub.publicAmount];
      for (const l of lines) for (const s of secrets) expect(l).not.toContain(s);
      expect(lines.filter((l) => /127\.0\.0\.1|GET|POST/.test(l))).toEqual([]); // no access log
    } finally {
      await r.close();
    }
  });

  it("CORS allow-list, per-IP rate limit, /relay/epochs from the cache (same bytes for everyone)", async () => {
    let builds = 0;
    const chain = mockChain(baseState(), {
      epochs: async () => {
        builds++;
        return { chainId: 56, coins: { [COIN]: [{ seq: 1, startedAt: 5, count: 2, openableAt: 305, refPrice: "9" }] }, updatedAt: 7 };
      },
    });
    const { r, base } = await serve(cfg({ RELAYER_QUOTE_RATE: "0.001", RELAYER_QUOTE_BURST: "5" }), chain);
    try {
      const bad = await fetch(`${base}/relay?kind=intent`, { headers: { origin: "https://evil.example" } });
      expect(bad.status).toBe(403);
      const good = await fetch(`${base}/relay?kind=intent`, { headers: { origin: "https://zkbnb.app" } });
      expect(good.headers.get("access-control-allow-origin")).toBe("https://zkbnb.app");
      const pre = await fetch(`${base}/relay`, { method: "OPTIONS", headers: { origin: "https://zkbnb.app" } });
      expect(pre.status).toBe(204);
      const e1 = await (await fetch(`${base}/relay/epochs?chainId=56`)).text();
      const e2 = await (await fetch(`${base}/relay/epochs`)).text();
      expect(e1).toBe(e2);
      expect(JSON.parse(e1)).toEqual({ chainId: 56, coins: { [COIN]: [{ seq: 1, startedAt: 5, count: 2, openableAt: 305, refPrice: "9" }] }, updatedAt: 7 });
      expect(builds).toBeLessThanOrEqual(2); // the listen-time refresh, at most one more
      expect((await fetch(`${base}/relay/epochs?chainId=97`)).status).toBe(400);
      // burst of 5 quotes per IP used up (4 above + this one), then 429
      expect((await fetch(`${base}/relay?kind=claim`)).status).toBe(200);
      expect((await fetch(`${base}/relay?kind=claim`)).status).toBe(429);
      expect((await fetch(`${base}/health`)).status).toBe(200);
    } finally {
      await r.close();
    }
  });

  it("token bucket refills over time and forgets idle IPs; epochs cache keeps a stale body on failure", async () => {
    const b = new TokenBucket(1, 2);
    expect([b.take("a", 0), b.take("a", 0), b.take("a", 0)]).toEqual([true, true, false]);
    expect(b.take("a", 1000)).toBe(true);
    b.sweep(10_000);
    expect(b.size).toBe(0);
    let fail = false;
    let t = 0;
    const c = new EpochsCache(
      async () => {
        if (fail) throw new Error("rpc");
        return { chainId: 56, coins: {}, updatedAt: t };
      },
      15_000,
      () => t,
    );
    expect(await c.get()).toBe('{"chainId":56,"coins":{},"updatedAt":0}');
    fail = true;
    t = 100_000;
    expect(await c.get()).toBe('{"chainId":56,"coins":{},"updatedAt":0}');
  });
});

// ------------------------------------------------------------------------------------------------- implementation review (chain step 9)

describe("implementation review K1/K2: rate-limit key and queue bound", () => {
  it("K1: behind the trusted proxy the LAST X-Forwarded-For hop is the client; client-written hops are ignored", async () => {
    const { clientIpOf } = await import("../src/relayer/server.js");
    expect(clientIpOf("6.6.6.6, 203.0.113.9", "127.0.0.1", true)).toBe("203.0.113.9");
    expect(clientIpOf(["1.1.1.1", "203.0.113.9"], "127.0.0.1", true)).toBe("203.0.113.9");
    expect(clientIpOf("203.0.113.9", "127.0.0.1", true)).toBe("203.0.113.9");
    expect(clientIpOf(undefined, "127.0.0.1", true)).toBe("127.0.0.1");
    expect(clientIpOf(" , ", "127.0.0.1", true)).toBe("127.0.0.1");
    // without RELAYER_TRUST_PROXY the header is never read
    expect(clientIpOf("203.0.113.9", "127.0.0.1", false)).toBe("127.0.0.1");

    // over HTTP: rotating a spoofed first hop no longer buys a fresh bucket
    const c = { ...cfg({ RELAYER_TRUST_PROXY: "1", RELAYER_SUBMIT_RATE: "0.001", RELAYER_SUBMIT_BURST: "2" }), port: 0 };
    const r = new Relayer(c, mockChain(baseState()), { log: silentLog, heldInMemory: true, unlockDelayMs: 0 });
    const a = await r.listen();
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) {
        const res = await fetch(`http://127.0.0.1:${a.port}/relay`, { method: "POST", headers: { "x-forwarded-for": `10.0.0.${i}, 198.51.100.7` }, body: "{not json" });
        statuses.push(res.status);
      }
      expect(statuses).toEqual([400, 400, 429, 429]);
      // a different real client (last hop) still has its own bucket
      const other = await fetch(`http://127.0.0.1:${a.port}/relay`, { method: "POST", headers: { "x-forwarded-for": "198.51.100.8" }, body: "{not json" });
      expect(other.status).toBe(400);
    } finally {
      await r.close();
    }
  });

  it("K2: POSTs are refused with 503 busy while RELAYER_MAX_QUEUE sends are queued; held releases are not", async () => {
    const st = baseState();
    let open!: () => void;
    st.sendGate = new Promise<void>((res) => (open = res));
    const chain = mockChain(st);
    const r = new Relayer(cfg({ RELAYER_MAX_QUEUE: "2" }), chain, { log: silentLog, heldInMemory: true, unlockDelayMs: 0 });
    expect(r.cfg.maxQueue).toBe(2);
    const first = r.submit(transferBody());
    const second = r.submit(transferBody());
    await vi.waitFor(() => expect(r.queue.size).toBe(2));
    expect((await r.submit(transferBody())).body).toMatchObject({ ok: false, code: "busy" });
    expect((await r.submit(transferBody())).status).toBe(503);
    open();
    expect((await first).body).toMatchObject({ ok: true });
    expect((await second).body).toMatchObject({ ok: true });
    expect((await r.submit(transferBody())).body).toMatchObject({ ok: true });
    expect(chain.sent).toHaveLength(3);
    // the default bound
    expect(loadRelayerConfig({ GAS_UNITS_FILE: GAS_FILE }).maxQueue).toBe(32);
  });
});

describe("implementation review K3: relayer and Coordinator secrets never in one process", () => {
  it("roleOf / roleSeparation: refused on chain 56, a warning elsewhere, names only", async () => {
    const { roleOf, roleSeparation, roleSeparationMessage } = await import("../src/roles.js");
    expect(roleOf("relayer")).toBe("relayer");
    expect(roleOf("coordinator")).toBe("coordinator");
    expect(roleOf("rotate-key")).toBe("coordinator");
    for (const c of ["all", "sweep", "rewards", "pool-feed", "dividends", "flush", "feed"]) expect(roleOf(c)).toBeNull();

    const secret = "789720796196013502825971079891341950334297791247242114870618952306578497880";
    expect(roleSeparation("relayer", 56, { COORDINATOR_SK: secret })).toEqual({ names: ["COORDINATOR_SK"], refuse: true });
    expect(roleSeparation("relayer", 56, { COORDINATOR_KEY_DIR: "/srv/keys" })).toEqual({ names: ["COORDINATOR_KEY_DIR"], refuse: true });
    expect(roleSeparation("relayer", 97, { COORDINATOR_SK: secret })).toEqual({ names: ["COORDINATOR_SK"], refuse: false });
    expect(roleSeparation("relayer", 56, { COORDINATOR_SK: "  ", RELAYER_PRIVATE_KEY: "0x01" })).toEqual({ names: [], refuse: false });
    expect(roleSeparation("coordinator", 56, { RELAYER_PRIVATE_KEY: "0x01", RELAYER_HELD_KEY: HELD_KEY })).toEqual({ names: ["RELAYER_PRIVATE_KEY", "RELAYER_HELD_KEY"], refuse: true });
    expect(roleSeparation("coordinator", 56, { COORDINATOR_SK: secret })).toEqual({ names: [], refuse: false });
    const msg = roleSeparationMessage("relayer", ["COORDINATOR_SK"]);
    expect(msg).toMatch(/COORDINATOR_SK/);
    expect(msg).not.toContain(secret);
  });
});

describe("implementation review K4: release jitter from a CSPRNG", () => {
  it("the default HeldManager rng is node:crypto, not Math.random", async () => {
    const { cryptoRandom } = await import("../src/relayer/held.js");
    for (let i = 0; i < 200; i++) {
      const x = cryptoRandom();
      expect(x >= 0 && x < 1).toBe(true);
    }
    const spy = vi.spyOn(Math, "random");
    const delays: number[] = [];
    const st = baseState();
    st.states.set(stateKey(COIN, 0), { seq: 0, status: 1, count: 5, startedAt: st.now - 10, tMax: 300 });
    const m = new HeldManager({
      store: new HeldStore(null, new HeldCipher(HELD_KEY)),
      readStates: async (keys) => ({ now: st.now, states: new Map(keys.map((k) => [stateKey(k.coin, k.dir), st.states.get(stateKey(k.coin, k.dir))!])) }),
      submit: async () => ({ ok: true, hash: HASH }),
      schedule: (_fn, ms) => void delays.push(ms),
    });
    for (let i = 0; i < 3; i++) m.add({ kind: "intent", body: {}, nullifiers: [nul()], hold: { minOthers: 3, submitByEpochEnd: false }, coin: COIN, dir: 0 });
    expect((await m.tick()).released).toBe(3);
    expect(delays).toHaveLength(3);
    for (const d of delays) expect(d >= 0 && d < RELEASE_JITTER_MS).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });
});
