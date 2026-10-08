/**
 * The stage-2 relayer: a standalone HTTP service (Node `http`, no framework) — privacy/PRIVACY-SPEC.md §5.3, §2.10;
 * workplan §4.1. Runs as its own pm2 app (`grove-relayer`), on a different host from the Coordinator.
 *
 *   GET  /relay?chainId=&kind=   quote: { ok, chainId, kind, relayer, fee, feeTier, gasPrice, gasUnits, validUntil, tiers }
 *   POST /relay                  { ok, hash } | { ok, held, ticket } | { ok:false, error, code }
 *   GET  /relay/held/<ticket>    { status: held|submitted|dropped, hash?, reason?, count?, opensAt? }
 *   GET  /relay/epochs?chainId=  every active coin's epochs, from a 15 s cache (identical to epochs.json)
 *   GET  /health                 { ok }
 *
 * Privacy rules this file keeps: NO access log (requests are never logged; errors are logged without request data),
 * no request body is ever printed, and each send is one structured line with its kind and hash only. The rate
 * limiter keeps a token count per IP in memory and nothing else. Held requests are encrypted at rest (held.ts).
 *
 * The pure policies live in policy.ts; this file fills their chain inputs (onchain.ts), simulates (an invalid proof,
 * a spent note, a stale root reverts here and costs nothing), locks the spent nullifiers while in flight, and sends
 * from the relayer wallet through one serialised queue (queue.ts).
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { BaseError, ContractFunctionRevertedError, type Abi, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Ctx } from "../chain.js";
import { logger, type Logger } from "../log.js";
import { privacyAddresses } from "../config.js";
import { maybeCheckpoint } from "../checkpoint.js";
import { buildEpochsJson } from "../commands/poolFeed.js";
import {
  MIN_RELAYER_RUNWAY_QUOTES,
  QUOTE_TTL_SEC,
  RELAY_MARGIN_BPS_DEFAULT,
  isRelayKind2,
  isStage2Kind,
  parseRelayRequest2,
  spentNullifiers,
  type EpochsJson,
  type Hex,
  type ParsedRequest,
  type RelayFailCode,
  type RelayKind2,
  type RelayResponse2,
  type RelayStatus2,
  type Stage1Kind,
} from "./protocol.js";
import {
  claimPolicy,
  feeCovers,
  fillPolicy,
  gasUnitsOf,
  intentPolicy,
  parseGasUnits,
  plantPolicy,
  quoteFee,
  recoverPolicy,
  relayPolicy,
  stage1GasUnitsDefault,
  tieredQuote,
  transferPolicy,
  v1migratePolicy,
  vaultPolicy,
  type GasUnits2,
  type PolicyResult,
  type Stage2Env,
} from "./policy.js";
import { InflightLock, SendQueue, TokenBucket, nullifierLockKeys, vaultLockKey } from "./queue.js";
import { HeldCipher, HeldManager, HeldStore, isTicket, type HeldRecord, type SubmitOutcome } from "./held.js";
import { EpochsCache } from "./epochs.js";
import { callOf, darkPoolAbi, darkVaultAbi, readHoldStates, readPolicyInput, type Call, type KeyGenCache, type PolicyInputResult, type RelayerAddresses } from "./onchain.js";
import type { HoldEpochState } from "./policy.js";

// ------------------------------------------------------------------------------------------------- config

export interface RelayerConfig {
  /** RELAYER_PRIVATE_KEY (never KEEPER_PRIVATE_KEY); undefined only in --dry-run (an ephemeral key is used) */
  privateKey?: Hex;
  port: number;
  host: string;
  /** RELAYER_ALLOWED_ORIGINS; requests without an Origin header (curl, Tor clients) are always served */
  allowedOrigins: string[];
  flat: bigint;
  marginBps: bigint;
  gasUnitsFile: string;
  gasUnits2: GasUnits2;
  gasUnits1: Record<Stage1Kind, bigint>;
  /** RELAYER_HELD_KEY (32-byte hex); without it, hold / notBefore requests are refused */
  heldKey?: string;
  heldDir: string;
  /**
   * Take the client IP (rate limit only) from the LAST X-Forwarded-For hop, the one the single trusted proxy in front
   * (nginx / the Tor proxy on the same host) appended. Earlier hops are client-supplied and never trusted.
   */
  trustProxy: boolean;
  torHiddenServiceDir?: string;
  holdPollMs: number;
  checkpointMs: number;
  quoteRate: [number, number];
  submitRate: [number, number];
  /** RELAYER_MAX_QUEUE: POSTs refused with 503 while this many sends are queued (held releases are never refused) */
  maxQueue?: number;
}

const envNum = (env: NodeJS.ProcessEnv, n: string, d: number) => {
  const v = env[n];
  if (v === undefined || v === "") return d;
  const x = Number(v);
  if (!Number.isFinite(x)) throw new Error(`env ${n} is not a number: ${v}`);
  return x;
};
const envBig = (env: NodeJS.ProcessEnv, n: string, d: bigint) => {
  const v = env[n];
  if (v === undefined || v === "") return d;
  if (!/^\d+$/.test(v)) throw new Error(`env ${n} must be a non-negative integer`);
  return BigInt(v);
};

export function loadRelayerConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): RelayerConfig {
  let privateKey: Hex | undefined;
  const pkRaw = (env.RELAYER_PRIVATE_KEY ?? "").trim();
  if (pkRaw) {
    const pk = pkRaw.startsWith("0x") ? pkRaw : `0x${pkRaw}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error("RELAYER_PRIVATE_KEY must be a 32-byte hex key");
    privateKey = pk as Hex;
  }
  const gasUnitsFile = path.resolve(env.GAS_UNITS_FILE || path.join(cwd, "..", "contracts", "gas-v2.json"));
  if (!fs.existsSync(gasUnitsFile)) throw new Error(`GAS_UNITS_FILE not found: ${gasUnitsFile}`);
  const gasUnits2 = parseGasUnits(JSON.parse(fs.readFileSync(gasUnitsFile, "utf8")));
  const heldKey = (env.RELAYER_HELD_KEY ?? "").trim() || undefined;
  if (heldKey) new HeldCipher(heldKey); // validate early
  return {
    privateKey,
    port: envNum(env, "RELAYER_PORT", 8788),
    host: (env.RELAYER_HOST ?? "").trim() || "127.0.0.1",
    allowedOrigins: (env.RELAYER_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim().replace(/\/+$/, ""))
      .filter(Boolean),
    flat: envBig(env, "RELAY_FLAT_FEE_WEI", 0n),
    marginBps: envBig(env, "RELAY_MARGIN_BPS", RELAY_MARGIN_BPS_DEFAULT),
    gasUnitsFile,
    gasUnits2,
    gasUnits1: {
      transact: envBig(env, "RELAY_GAS_UNITS", stage1GasUnitsDefault("transact")),
      fill: envBig(env, "RELAY_GAS_UNITS_FILL", stage1GasUnitsDefault("fill")),
      vault: envBig(env, "RELAY_GAS_UNITS_VAULT", stage1GasUnitsDefault("vault")),
      recover: envBig(env, "RELAY_GAS_UNITS_RECOVER", stage1GasUnitsDefault("recover")),
    },
    heldKey,
    heldDir: path.resolve(env.RELAYER_HELD_DIR || path.join(env.SNAPSHOT_DIR ?? "./snapshots", "relayer-held")),
    trustProxy: ["1", "true", "yes"].includes((env.RELAYER_TRUST_PROXY ?? "").trim().toLowerCase()),
    torHiddenServiceDir: (env.TOR_HIDDEN_SERVICE_DIR ?? "").trim() || undefined,
    holdPollMs: envNum(env, "RELAYER_HOLD_POLL_SEC", 5) * 1000,
    checkpointMs: envNum(env, "RELAYER_CHECKPOINT_SEC", 60) * 1000,
    quoteRate: [envNum(env, "RELAYER_QUOTE_RATE", 5), envNum(env, "RELAYER_QUOTE_BURST", 20)],
    submitRate: [envNum(env, "RELAYER_SUBMIT_RATE", 0.2), envNum(env, "RELAYER_SUBMIT_BURST", 3)],
    maxQueue: envNum(env, "RELAYER_MAX_QUEUE", RELAYER_MAX_QUEUE_DEFAULT),
  };
}

/** Default RELAYER_MAX_QUEUE (implementation review K2). */
export const RELAYER_MAX_QUEUE_DEFAULT = 32;

/**
 * The client IP for the rate limiter (implementation review K1). Without `trustProxy` the socket address. With it, the
 * LAST X-Forwarded-For entry: a proxy that appends (`proxy_add_x_forwarded_for`) puts the address it saw at the end,
 * while everything before it is whatever the client sent, so the first hop would let one client pick a fresh rate-limit
 * bucket per request.
 */
export function clientIpOf(xff: string | string[] | undefined, remoteAddress: string | undefined, trustProxy: boolean): string {
  if (trustProxy) {
    const all = (Array.isArray(xff) ? xff.join(",") : (xff ?? "")).split(",").map((s) => s.trim()).filter(Boolean);
    const last = all[all.length - 1];
    if (last) return last;
  }
  return remoteAddress ?? "?";
}

// ------------------------------------------------------------------------------------------------- chain port

/** Everything the relayer needs from the chain; `chainPort(ctx)` implements it, tests mock it. */
export interface RelayerChain {
  address: Hex;
  chainId: number;
  addrs: RelayerAddresses;
  dryRun: boolean;
  gasPrice(): Promise<bigint>;
  balance(): Promise<bigint>;
  /** OnChainPolicyInput + chain time, one eth_call batch */
  policyInput(c1x: bigint): Promise<PolicyInputResult>;
  read(call: Call): Promise<unknown>;
  vaultState(vault: Address): Promise<{ exists: boolean; balance: bigint }>;
  /** simulation from the relayer account; throws on revert */
  estimate(call: Call): Promise<bigint>;
  send(call: Call, gas: bigint, gasPrice: bigint): Promise<Hex>;
  holdStates(keys: readonly { coin: Hex; dir: number }[]): Promise<{ now: number; states: Map<string, HoldEpochState> }>;
  epochs(): Promise<EpochsJson>;
  checkpoint(): Promise<void>;
}

export function chainPort(ctx: Ctx): RelayerChain {
  if (!ctx.account || !ctx.wallet) throw new Error("relayer: no account");
  const account = ctx.account;
  const wallet = ctx.wallet;
  const p = privacyAddresses(ctx.dep);
  const addrs: RelayerAddresses = {
    shieldedPool: ctx.dep.shieldedPool,
    darkPool: ctx.dep.darkPool,
    launchpad: ctx.dep.launchpad,
    grovePool: p?.grovePool,
    darkCurve: p?.darkCurve,
    planter: p?.planter,
  };
  const keyGen: KeyGenCache = {};
  return {
    address: account.address.toLowerCase() as Hex,
    chainId: ctx.cfg.chainId,
    addrs,
    dryRun: ctx.cfg.dryRun,
    gasPrice: () => ctx.pub.getGasPrice(),
    balance: () => ctx.pub.getBalance({ address: account.address }),
    policyInput: (c1x) => {
      if (!addrs.darkCurve) throw new Error("darkCurve not deployed");
      return readPolicyInput(ctx.pub, { darkCurve: addrs.darkCurve, launchpad: addrs.launchpad }, c1x, keyGen);
    },
    read: (call) => ctx.pub.readContract({ address: call.address, abi: call.abi, functionName: call.functionName, args: call.args } as never),
    vaultState: async (vault) => {
      const [code, balance] = await Promise.all([ctx.pub.getCode({ address: vault }), ctx.pub.getBalance({ address: vault })]);
      return { exists: !!code && code !== "0x", balance };
    },
    estimate: (call) => ctx.pub.estimateContractGas({ address: call.address, abi: call.abi, functionName: call.functionName, args: call.args, account } as never),
    send: async (call, gas, gasPrice) => {
      const nonce = await ctx.pub.getTransactionCount({ address: account.address, blockTag: "pending" });
      return wallet.writeContract({ address: call.address, abi: call.abi, functionName: call.functionName, args: call.args, account, chain: ctx.chain, gas: (gas * 13n) / 10n, gasPrice, nonce } as never);
    },
    holdStates: (keys) => {
      if (!addrs.darkCurve) throw new Error("darkCurve not deployed");
      return readHoldStates(ctx.pub, addrs.darkCurve, keys);
    },
    epochs: () => {
      if (!addrs.darkCurve) throw new Error("darkCurve not deployed");
      return buildEpochsJson(ctx, addrs.darkCurve);
    },
    checkpoint: async () => {
      await maybeCheckpoint(ctx, addrs.grovePool);
    },
  };
}

// ------------------------------------------------------------------------------------------------- errors

/** A revert reason without the call's arguments (viem's full message repeats the calldata: never log or echo it). */
export function shortError(e: unknown): string {
  if (e instanceof BaseError) {
    const rev = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (rev?.data?.errorName) return `reverted: ${rev.data.errorName}`;
    if (rev?.reason) return `reverted: ${rev.reason}`;
    return (e.shortMessage || e.name).split("\n")[0].slice(0, 160);
  }
  if (e instanceof Error) return e.message.split("\n")[0].slice(0, 160);
  return "error";
}

// ------------------------------------------------------------------------------------------------- relayer

type Reply = { status: number; body: unknown; cache?: string; raw?: string };
const reply = (body: unknown, status = 200): Reply => ({ status, body });
const fail = (code: RelayFailCode, error: string, status: number): Reply => reply({ ok: false, error, code } satisfies RelayResponse2, status);
const fromPolicy = (p: NonNullable<PolicyResult>): Reply => fail(p.code, p.error, 400);

export interface RelayerOptions {
  log?: Logger;
  /** in-memory held store (tests) instead of RELAYER_HELD_DIR */
  heldInMemory?: boolean;
  schedule?: (fn: () => void, ms: number) => void;
  rng?: () => number;
  /** delay before an in-flight lock is released after a send (ms) */
  unlockDelayMs?: number;
}

export class Relayer {
  readonly queue = new SendQueue();
  readonly inflight = new InflightLock(120_000);
  readonly held: HeldManager | null;
  readonly epochsCache: EpochsCache | null;
  private readonly quoteLimiter: TokenBucket;
  private readonly submitLimiter: TokenBucket;
  private readonly log: Logger;
  private readonly unlockDelayMs: number;
  private server: http.Server | null = null;
  private timers: NodeJS.Timeout[] = [];

  constructor(
    readonly cfg: RelayerConfig,
    readonly chain: RelayerChain,
    opts: RelayerOptions = {},
  ) {
    this.log = opts.log ?? logger("relayer");
    this.unlockDelayMs = opts.unlockDelayMs ?? 15_000;
    this.quoteLimiter = new TokenBucket(cfg.quoteRate[0], cfg.quoteRate[1]);
    this.submitLimiter = new TokenBucket(cfg.submitRate[0], cfg.submitRate[1]);
    const stage2 = !!(chain.addrs.grovePool && chain.addrs.darkCurve);
    this.epochsCache = stage2 ? new EpochsCache(() => chain.epochs()) : null;
    this.held =
      stage2 && cfg.heldKey
        ? new HeldManager({
            store: new HeldStore(opts.heldInMemory ? null : cfg.heldDir, new HeldCipher(cfg.heldKey)),
            readStates: (keys) => chain.holdStates(keys),
            submit: (rec) => this.submitHeld(rec),
            schedule: opts.schedule,
            rng: opts.rng,
          })
        : null;
  }

  get stage2(): boolean {
    return !!(this.chain.addrs.grovePool && this.chain.addrs.darkCurve);
  }

  // --------------------------------------------------------------------------------------------- quote

  async quote(kind: RelayKind2, chainId: number): Promise<Reply> {
    const no = (reason: string, status = 200) => reply({ ok: false, reason } satisfies RelayStatus2, status);
    if (chainId !== this.chain.chainId) return no(`relayer serves chain ${this.chain.chainId}`);
    if (isStage2Kind(kind)) {
      if (!this.stage2) return no("privacy stage 2 is not deployed on this chain");
      if (kind === "plant" && !this.chain.addrs.planter) return no("private planting is not deployed on this chain");
    } else if (kind !== "transact" && !this.chain.addrs.darkPool) {
      return no("dark pool not deployed on this chain");
    }
    try {
      const [gasPrice, balance] = await Promise.all([this.chain.gasPrice(), this.chain.balance()]);
      const units = gasUnitsOf(kind, this.cfg.gasUnits2, this.cfg.gasUnits1);
      let fee = 0n;
      let feeTier: number | null = null;
      let tiers: string[] = [];
      if (kind === "claim") {
        fee = 0n; // reimbursed on-chain from the claim budget (spec §2.6.5)
      } else if (isStage2Kind(kind)) {
        const q = tieredQuote(gasPrice, units, this.cfg.marginBps, this.cfg.flat);
        if (!q.ok) return no(q.reason);
        fee = q.fee;
        feeTier = q.tier;
        tiers = q.tiers.map(String);
      } else {
        fee = quoteFee(gasPrice, units, this.cfg.marginBps, this.cfg.flat);
      }
      const cost = quoteFee(gasPrice, units, this.cfg.marginBps, this.cfg.flat);
      const runway = (fee > cost ? fee : cost) * MIN_RELAYER_RUNWAY_QUOTES;
      if (!this.chain.dryRun && balance < runway) {
        this.log.warn("relayer low on gas funds", { balance });
        return no("relayer is out of gas funds");
      }
      const q: RelayStatus2 = {
        ok: true,
        chainId,
        kind,
        relayer: this.chain.address,
        fee: fee.toString(),
        feeTier,
        gasPrice: gasPrice.toString(),
        gasUnits: units.toString(),
        validUntil: Math.floor(Date.now() / 1000) + QUOTE_TTL_SEC,
        tiers,
      };
      return reply(q);
    } catch (e) {
      this.log.warn("quote failed", { error: shortError(e) });
      return no("relayer cannot reach the chain", 502);
    }
  }

  // --------------------------------------------------------------------------------------------- submit

  /** POST /relay with an already-JSON-parsed body. */
  async submit(body: unknown): Promise<Reply> {
    // K2: every POST that passes the cheap policies costs one serialised simulation; refuse instead of queueing without
    // bound (held releases call relay() directly and are never refused here)
    if (this.queue.size >= (this.cfg.maxQueue ?? RELAYER_MAX_QUEUE_DEFAULT)) return fail("busy", "the relayer is busy; try again in a minute", 503);
    const parsed = parseRelayRequest2(body);
    if (!parsed.ok) return fail("invalid", parsed.error, 400);
    return this.relay(parsed, body, false);
  }

  /** Release of a held request: the same path without holding. */
  private async submitHeld(rec: HeldRecord): Promise<SubmitOutcome> {
    const parsed = parseRelayRequest2(rec.body);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const r = await this.relay(parsed, rec.body, true);
    const b = r.body as RelayResponse2;
    if (b.ok && "hash" in b) return { ok: true, hash: b.hash };
    return { ok: false, error: b.ok ? "unexpected hold" : b.error };
  }

  private async relay(r: ParsedRequest, rawBody: unknown, fromHeld: boolean): Promise<Reply> {
    const me = this.chain.address;
    const expected = this.chain.chainId;
    const ns = spentNullifiers(r);
    if (!fromHeld && this.held && ns.some((n) => this.held!.holdsNullifier(n))) return fail("busy", "this note is already held for release", 409);

    // ---------------------------------------------------------------- stage 1 (relay.ts / the Vercel route)
    if (r.kind === "vault") return this.relayVault(r.call);
    if (r.kind === "recover") return this.relayRecover(r.order, r.chainId);
    if (r.kind === "transact" || r.kind === "fill") {
      const policy = r.kind === "fill" ? fillPolicy(r.extData, r.order, me, r.chainId, expected) : relayPolicy(r.extData, me, r.chainId, expected);
      if (policy) return fromPolicy(policy);
      let call: Call;
      if (r.kind === "fill") {
        const dp = this.chain.addrs.darkPool;
        if (!dp) return fail("unavailable", "dark pool not deployed on this chain", 503);
        let vault: Address;
        let st: { exists: boolean; balance: bigint };
        try {
          vault = (await this.chain.read({ address: dp, abi: darkPoolAbi as unknown as Abi, functionName: "vaultFor", args: [r.order] })) as Address;
          st = await this.chain.vaultState(vault);
        } catch (e) {
          return fail("unavailable", `cannot reach the chain: ${shortError(e)}`, 502);
        }
        if (vault.toLowerCase() !== r.extData.recipient.toLowerCase()) return fail("invalid", "extData.recipient is not the vault for this order", 400);
        if (st.exists) return fail("invalid", "this order's vault already exists", 400);
        if (st.balance >= r.order.bnbIn) return this.recoverFill(dp, r.order, vault);
        call = { address: dp, abi: darkPoolAbi as unknown as Abi, functionName: "transactAndFill", args: [r.proof, r.extData, r.order] };
      } else {
        call = callOf(r, this.chain.addrs);
      }
      return this.lockedSend(ns, call, r.kind, r.extData.fee, false);
    }

    // ---------------------------------------------------------------- stage 2
    const a = this.chain.addrs;
    if (!a.grovePool || !a.darkCurve) return fail("unavailable", "privacy stage 2 is not deployed on this chain", 503);
    let gasPrice: bigint;
    let pin: PolicyInputResult;
    try {
      [gasPrice, pin] = await Promise.all([this.chain.gasPrice(), this.chain.policyInput(r.kind === "intent" ? r.pub.c1[0] : 0n)]);
    } catch (e) {
      return fail("unavailable", `cannot reach the chain: ${shortError(e)}`, 502);
    }
    const env: Stage2Env = { relayer: me, expectedChainId: expected, gasPrice, gasUnits: this.cfg.gasUnits2, flat: this.cfg.flat, now: pin.now, grovePool: a.grovePool, planter: a.planter };
    let policy: PolicyResult;
    let fee: bigint;
    switch (r.kind) {
      case "transfer":
        policy = transferPolicy(r.chainId, r.pub, r.extData, env);
        fee = r.extData.fee;
        break;
      case "plant":
        policy = plantPolicy(r.chainId, r.pub, r.extData, env, pin.onChain);
        fee = r.extData.fee;
        break;
      case "intent":
        policy = intentPolicy(r.chainId, r.pub, r.extData, env, pin.onChain);
        fee = r.extData.fee;
        break;
      case "claim":
        policy = claimPolicy(r.chainId, r.extData, env);
        fee = 0n;
        break;
      case "v1migrate":
        policy = v1migratePolicy(r.chainId, r.proof.publicAmount, r.extData, r.handle, r.notBefore, env);
        fee = r.extData.fee;
        break;
    }
    if (policy) return fromPolicy(policy);
    const call = callOf(r, a);

    // holds: intents with `hold`, migrations with a future `notBefore` (never claims: the parser refuses `hold` there)
    const wantsHold = !fromHeld && ((r.kind === "intent" && r.hold) || (r.kind === "v1migrate" && r.notBefore !== undefined && r.notBefore > pin.now));
    if (wantsHold) {
      if (!this.held) return fail("unavailable", "this relayer does not hold requests (no RELAYER_HELD_KEY); submit without a hold", 503);
      try {
        await this.chain.estimate(call); // refuse now what could never land later
      } catch (e) {
        return fail("reverted", shortError(e), 400);
      }
      const base = { body: rawBody, nullifiers: ns.map(String) };
      const added =
        r.kind === "intent"
          ? this.held.add({ ...base, kind: "intent", hold: r.hold, coin: r.pub.coin, dir: r.pub.dir })
          : this.held.add({ ...base, kind: "v1migrate", notBefore: (r as Extract<ParsedRequest, { kind: "v1migrate" }>).notBefore });
      if (!added.ok) return fail("busy", added.error, 409);
      return reply({ ok: true, held: true, ticket: added.ticket } satisfies RelayResponse2);
    }
    return this.lockedSend(ns, call, r.kind, fee, r.kind === "claim");
  }

  private async lockedSend(ns: readonly bigint[], call: Call, kind: RelayKind2, fee: bigint, feeless: boolean): Promise<Reply> {
    const lock = nullifierLockKeys(ns);
    if (!this.inflight.take(lock)) return fail("busy", "this spend is already being relayed", 409);
    try {
      return await this.simulateAndSend(call, kind, fee, feeless);
    } finally {
      this.unlockLater(lock);
    }
  }

  private unlockLater(keys: readonly string[]) {
    if (this.unlockDelayMs <= 0) this.inflight.release(keys);
    else setTimeout(() => this.inflight.release(keys), this.unlockDelayMs).unref?.();
  }

  /** Simulate, check the fee against the live gas price and the estimate, send; serialised (one nonce at a time). */
  private simulateAndSend(call: Call, kind: RelayKind2, fee: bigint, feeless: boolean): Promise<Reply> {
    return this.queue.run<Reply>(async () => {
      let gas: bigint;
      try {
        gas = await this.chain.estimate(call);
      } catch (e) {
        return fail("reverted", shortError(e), 400);
      }
      let gasPrice: bigint;
      try {
        gasPrice = await this.chain.gasPrice();
      } catch (e) {
        return fail("unavailable", `cannot reach the chain: ${shortError(e)}`, 502);
      }
      if (!feeless && !feeCovers(fee, gasPrice, gas, this.cfg.flat)) {
        return fail("fee", `fee ${fee} wei does not cover gas (${gas} × ${gasPrice} wei now); re-quote and ${kind === "vault" ? "sign" : "prove"} again`, 409);
      }
      if (this.chain.dryRun) return fail("unavailable", "dry run: the simulation passed, nothing was sent", 503);
      try {
        const hash = await this.chain.send(call, gas, gasPrice);
        this.log.info("sent", { kind, hash }); // the only line per send: kind and hash
        return reply({ ok: true, hash } satisfies RelayResponse2);
      } catch (e) {
        const msg = shortError(e);
        this.log.warn("send failed", { kind, error: msg });
        return fail("reverted", msg, 502);
      }
    });
  }

  private async relayVault(call: Extract<ParsedRequest, { kind: "vault" }>["call"]): Promise<Reply> {
    const policy = vaultPolicy(call, this.chain.address, this.chain.chainId, this.chain.chainId, Date.now() / 1000);
    if (policy) return fromPolicy(policy);
    const dp = this.chain.addrs.darkPool;
    if (!dp) return fail("unavailable", "dark pool not deployed on this chain", 503);
    let known = false;
    try {
      known = Boolean(await this.chain.read({ address: dp, abi: darkPoolAbi as unknown as Abi, functionName: "isVault", args: [call.vault] }));
    } catch (e) {
      return fail("unavailable", `cannot reach the chain: ${shortError(e)}`, 502);
    }
    if (!known) return fail("invalid", "not a dark vault of this DarkPool", 400);
    const lock = [vaultLockKey(call.vault)];
    if (!this.inflight.take(lock)) return fail("busy", "this vault already has a relay in flight", 409);
    try {
      return await this.simulateAndSend(
        { address: call.vault, abi: darkVaultAbi as unknown as Abi, functionName: "relay", args: [call.data, call.fee, call.deadline, call.sig] },
        "vault",
        call.fee,
        false,
      );
    } finally {
      this.unlockLater(lock);
    }
  }

  private async relayRecover(order: Extract<ParsedRequest, { kind: "recover" }>["order"], chainId: number): Promise<Reply> {
    const policy = recoverPolicy(order, chainId, this.chain.chainId);
    if (policy) return fromPolicy(policy);
    const dp = this.chain.addrs.darkPool;
    if (!dp) return fail("unavailable", "dark pool not deployed on this chain", 503);
    let vault: Address;
    let st: { exists: boolean; balance: bigint };
    try {
      vault = (await this.chain.read({ address: dp, abi: darkPoolAbi as unknown as Abi, functionName: "vaultFor", args: [order] })) as Address;
      st = await this.chain.vaultState(vault);
    } catch (e) {
      return fail("unavailable", `cannot reach the chain: ${shortError(e)}`, 502);
    }
    if (st.exists) return fail("invalid", "this order's vault already exists", 400);
    if (st.balance < order.bnbIn) return fail("invalid", "the withdrawal for this order has not landed at the vault address", 400);
    return this.recoverFill(dp, order, vault);
  }

  /** DarkPool.fill(order) for a funded, codeless vault (paid for by the fee the withdrawal already paid). */
  private async recoverFill(dp: Address, order: Extract<ParsedRequest, { kind: "recover" }>["order"], vault: Address): Promise<Reply> {
    const lock = [vaultLockKey(vault)];
    if (!this.inflight.take(lock)) return fail("busy", "this vault already has a fill in flight", 409);
    try {
      return await this.simulateAndSend({ address: dp, abi: darkPoolAbi as unknown as Abi, functionName: "fill", args: [order] }, "recover", 0n, true);
    } finally {
      this.unlockLater(lock);
    }
  }

  // --------------------------------------------------------------------------------------------- reads

  heldStatus(ticket: string): Reply {
    if (!isTicket(ticket) || !this.held) return reply({ ok: false, reason: "unknown ticket" }, 404);
    const s = this.held.status(ticket);
    return s ? reply(s) : reply({ ok: false, reason: "unknown ticket" }, 404);
  }

  async epochs(chainId: number): Promise<Reply> {
    if (chainId !== this.chain.chainId) return reply({ ok: false, reason: `relayer serves chain ${this.chain.chainId}` }, 400);
    if (!this.epochsCache) return reply({ ok: false, reason: "privacy stage 2 is not deployed on this chain" }, 503);
    const body = await this.epochsCache.get();
    if (body === null) return reply({ ok: false, reason: "epochs not available yet" }, 503);
    return { status: 200, body: null, raw: body, cache: "public, max-age=5" };
  }

  // --------------------------------------------------------------------------------------------- HTTP

  private clientIp(req: http.IncomingMessage): string {
    return clientIpOf(req.headers["x-forwarded-for"], req.socket.remoteAddress, this.cfg.trustProxy);
  }

  /** CORS: an Origin header must be on the allow-list; requests without one (curl, Tor clients) are served. */
  private cors(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const origin = req.headers.origin;
    if (!origin) return true;
    if (!this.cfg.allowedOrigins.includes(origin.replace(/\/+$/, ""))) return false;
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "Origin");
    return true;
  }

  private write(res: http.ServerResponse, r: Reply) {
    res.statusCode = r.status;
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", r.cache ?? "no-store");
    res.end(r.raw ?? JSON.stringify(r.body));
  }

  /** The request handler (exported through `handler` for tests). Never logs the request. */
  readonly handler = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    try {
      if (!this.cors(req, res)) return this.write(res, reply({ ok: false, reason: "origin not allowed" }, 403));
      const url = new URL(req.url ?? "/", "http://relayer.local");
      const p = url.pathname.replace(/\/+$/, "") || "/";
      if (req.method === "OPTIONS") {
        res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
        res.setHeader("access-control-allow-headers", "content-type");
        res.setHeader("access-control-max-age", "600");
        res.statusCode = 204;
        return void res.end();
      }
      const ip = this.clientIp(req);
      if (req.method === "GET") {
        if (p === "/health") return this.write(res, reply({ ok: true, chainId: this.chain.chainId, relayer: this.chain.address, stage2: this.stage2 }));
        if (!this.quoteLimiter.take(ip)) return this.write(res, reply({ ok: false, reason: "rate limited" }, 429));
        const chainId = Number(url.searchParams.get("chainId") ?? this.chain.chainId);
        if (p === "/relay") {
          const kind = url.searchParams.get("kind") ?? "transact";
          if (!isRelayKind2(kind)) return this.write(res, reply({ ok: false, reason: "unknown quote kind" }, 400));
          return this.write(res, await this.quote(kind, chainId));
        }
        if (p === "/relay/epochs") return this.write(res, await this.epochs(chainId));
        if (p.startsWith("/relay/held/")) return this.write(res, this.heldStatus(p.slice("/relay/held/".length)));
        return this.write(res, reply({ ok: false, reason: "not found" }, 404));
      }
      if (req.method === "POST" && p === "/relay") {
        if (!this.submitLimiter.take(ip)) return this.write(res, fail("busy", "rate limited: one relayed transaction every few seconds per client", 429));
        const text = await readBody(req, 64 * 1024);
        if (text === null) return this.write(res, fail("invalid", "request too large", 413));
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          return this.write(res, fail("invalid", "body is not JSON", 400));
        }
        return this.write(res, await this.submit(body));
      }
      return this.write(res, reply({ ok: false, reason: "not found" }, 404));
    } catch (e) {
      this.log.warn("handler error", { error: shortError(e) });
      if (!res.headersSent) this.write(res, reply({ ok: false, reason: "internal error" }, 500));
    }
  };

  // --------------------------------------------------------------------------------------------- lifecycle

  /** One background pass: held releases, and (on its own timer) checkpoint. */
  async pollHeld(): Promise<void> {
    if (!this.held || this.held.size === 0) return;
    try {
      const r = await this.held.tick();
      if (r.released || r.dropped) this.log.info("held", { released: r.released, dropped: r.dropped, waiting: r.waiting });
    } catch (e) {
      this.log.warn("held poll failed", { error: shortError(e) });
    }
  }

  async checkpointOnce(): Promise<void> {
    if (!this.chain.addrs.grovePool) return;
    try {
      await this.queue.run(() => this.chain.checkpoint());
    } catch (e) {
      this.log.warn("checkpoint failed", { error: shortError(e) });
    }
  }

  async listen(): Promise<AddressInfo> {
    if (this.held) {
      const { restored, unreadable } = this.held.restore();
      if (restored || unreadable) this.log.info("held requests restored", { restored, unreadable });
    }
    this.server = http.createServer((req, res) => void this.handler(req, res));
    this.server.requestTimeout = 30_000;
    this.server.headersTimeout = 15_000;
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.cfg.port, this.cfg.host, () => resolve());
    });
    if (this.epochsCache) {
      void this.epochsCache.refresh().catch((e) => this.log.warn("epochs refresh failed", { error: shortError(e) }));
      this.timers.push(setInterval(() => void this.epochsCache!.refresh().catch((e) => this.log.warn("epochs refresh failed", { error: shortError(e) })), 15_000));
    }
    if (this.held) this.timers.push(setInterval(() => void this.pollHeld(), this.cfg.holdPollMs));
    if (this.chain.addrs.grovePool) this.timers.push(setInterval(() => void this.checkpointOnce(), this.cfg.checkpointMs));
    return this.server.address() as AddressInfo;
  }

  async close(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    const s = this.server;
    this.server = null;
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }
}

function readBody(req: http.IncomingMessage, max: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) over = true;
      else chunks.push(c);
    });
    req.on("end", () => resolve(over ? null : Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ------------------------------------------------------------------------------------------------- command

/** The ephemeral key a --dry-run relayer quotes with when RELAYER_PRIVATE_KEY is unset (it never sends). */
export function dryRunKey(): Hex {
  return generatePrivateKey();
}

/** Account address of a relayer key (for index.ts logging). */
export const relayerAddress = (pk: Hex): Hex => privateKeyToAccount(pk).address;

/**
 * `grove-keeper relayer`: serves until SIGINT / SIGTERM. `ctx` must be built with the relayer's key (index.ts swaps
 * RELAYER_PRIVATE_KEY in for KEEPER_PRIVATE_KEY before makeCtx). Stage-2 kinds are refused while grovePool /
 * darkCurve are absent from the deployment file; stage-1 kinds work either way.
 */
export async function runRelayer(ctx: Ctx, cfg: RelayerConfig, stop: Promise<void>): Promise<void> {
  const log = logger("relayer");
  const r = new Relayer(cfg, chainPort(ctx), { log });
  const addr = await r.listen();
  let onion: string | undefined;
  if (cfg.torHiddenServiceDir) {
    try {
      onion = fs.readFileSync(path.join(cfg.torHiddenServiceDir, "hostname"), "utf8").trim();
    } catch {
      log.warn("TOR_HIDDEN_SERVICE_DIR has no hostname file yet");
    }
  }
  log.info("relayer listening", {
    host: addr.address,
    port: addr.port,
    relayer: r.chain.address,
    stage2: r.stage2,
    held: r.held ? "on" : "off",
    origins: cfg.allowedOrigins.length,
    gasUnits: path.basename(cfg.gasUnitsFile),
    dryRun: r.chain.dryRun,
    ...(onion ? { onion } : {}),
  });
  await stop;
  await r.close();
  log.info("relayer stopped");
}
