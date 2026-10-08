import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { parseEther, isAddress, getAddress, type Address, type Hex } from "viem";

export interface Deployments {
  chainId: number;
  poseidonT3: Address;
  poseidonT4: Address;
  verifier: Address;
  shieldedPool: Address;
  feeRouter: Address;
  roots: Address;
  holderRewards: Address;
  donationRotator: Address;
  launchpad: Address;
  grove: Address;
  router: Address;
  treasury: Address;
  startBlock: number;
  /** FlapBuyback adapter when the rootstock token lives on Flap (chain 56); absent for the in-house one */
  rootstockBuyback?: Address;
  /** true when "grove" is a token launched outside zkBNB (Flap) */
  rootstockExternal?: boolean;
  /** stage-1 dark pools (DarkPool factory); read only by the relayer's `fill` / `vault` / `recover` kinds */
  darkPool?: Address;
  // ---- privacy stage 2 (all optional; every stage-2 command is inert while they are absent) ----
  grovePool?: Address;
  darkCurve?: Address;
  planter?: Address;
  /** first block of the stage-2 contracts (log scans start here; falls back to startBlock) */
  privacyStartBlock?: number;
}

export interface KeeperConfig {
  rpcUrl: string;
  /** primary first, then failovers */
  rpcUrls: string[];
  chainId: number;
  privateKey?: Hex;
  deploymentsPath: string;
  minSweepWei: bigint;
  /** undefined = read HolderRewards.minPot() */
  minPotWei?: bigint;
  minHoldingUsd: number;
  bnbUsdFallback?: number;
  minBuybackWei: bigint;
  snapshotDir: string;
  snapshotBaseUrl: string;
  blobToken?: string;
  logChunk: bigint;
  /** upper bound (seconds) of the random delay before a holder snapshot; 3600 = "within the hour" */
  snapshotDelayMaxSec: number;
  dryRun: boolean;
  intervalSec: number;
  excludeAddresses: Address[];
  /** blocks behind head that are treated as final for the balance cache */
  confirmations: number;
  feedDays: number;
}

type Env = NodeJS.ProcessEnv;

function num(env: Env, name: string, def: number): number {
  const v = env[name];
  if (v === undefined || v === "") return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`env ${name} is not a number: ${v}`);
  return n;
}

function bnb(env: Env, name: string, def: string): bigint {
  const v = env[name];
  return parseEther((v === undefined || v === "" ? def : v) as `${number}`);
}

function bool(env: Env, name: string): boolean {
  const v = (env[name] ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export function loadConfig(env: Env = process.env): KeeperConfig {
  const chainId = num(env, "CHAIN_ID", 97);
  // RPC_URL may be a comma-separated list: first is primary, the rest are failovers.
  const rpcUrls = (env.RPC_URL ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (rpcUrls.length === 0) throw new Error("RPC_URL is required");
  const rpcUrl = rpcUrls[0];

  let privateKey: Hex | undefined;
  if (env.KEEPER_PRIVATE_KEY) {
    const pk = env.KEEPER_PRIVATE_KEY.startsWith("0x") ? env.KEEPER_PRIVATE_KEY : `0x${env.KEEPER_PRIVATE_KEY}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error("KEEPER_PRIVATE_KEY must be a 32-byte hex key");
    privateKey = pk as Hex;
  }

  const deploymentsPath = env.DEPLOYMENTS_PATH
    ? path.resolve(env.DEPLOYMENTS_PATH)
    : path.resolve(process.cwd(), "..", "contracts", "deployments", `${chainId}.json`);

  const excludeAddresses = (env.EXCLUDE_ADDRESSES ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      if (!isAddress(s)) throw new Error(`EXCLUDE_ADDRESSES contains a non-address: ${s}`);
      return getAddress(s);
    });

  const minPot = env.MIN_POT_BNB ? bnb(env, "MIN_POT_BNB", "0") : undefined;
  const bnbUsdFallback = env.BNB_USD ? Number(env.BNB_USD) : undefined;

  return {
    rpcUrl,
    rpcUrls,
    chainId,
    privateKey,
    deploymentsPath,
    minSweepWei: bnb(env, "MIN_SWEEP_BNB", "0.02"),
    minPotWei: minPot,
    minHoldingUsd: num(env, "MIN_HOLDING_USD", 20),
    bnbUsdFallback,
    minBuybackWei: bnb(env, "MIN_BUYBACK_BNB", "0.05"),
    snapshotDir: path.resolve(env.SNAPSHOT_DIR ?? "./snapshots"),
    snapshotBaseUrl: (env.SNAPSHOT_BASE_URL ?? "").replace(/\/+$/, ""),
    blobToken: env.BLOB_READ_WRITE_TOKEN || undefined,
    logChunk: BigInt(num(env, "LOG_CHUNK", 2000)),
    snapshotDelayMaxSec: num(env, "SNAPSHOT_DELAY_MAX_SEC", 3600),
    dryRun: bool(env, "DRY_RUN"),
    intervalSec: num(env, "KEEPER_INTERVAL_SEC", 300),
    excludeAddresses,
    confirmations: num(env, "CONFIRMATIONS", 20),
    feedDays: num(env, "FEED_DAYS", 30),
  };
}

const DEPLOYMENT_KEYS: (keyof Deployments)[] = [
  "chainId",
  "poseidonT3",
  "poseidonT4",
  "verifier",
  "shieldedPool",
  "feeRouter",
  "roots",
  "holderRewards",
  "donationRotator",
  "launchpad",
  "grove",
  "router",
  "treasury",
  "startBlock",
];

export function parseDeployments(raw: unknown, expectedChainId?: number): Deployments {
  if (!raw || typeof raw !== "object") throw new Error("deployments: not an object");
  const o = raw as Record<string, unknown>;
  for (const k of DEPLOYMENT_KEYS) {
    if (o[k] === undefined || o[k] === null) throw new Error(`deployments: missing key "${k}"`);
  }
  const addr = (k: keyof Deployments): Address => {
    const v = o[k];
    if (typeof v !== "string" || !isAddress(v)) throw new Error(`deployments: "${k}" is not an address`);
    return getAddress(v);
  };
  const d: Deployments = {
    chainId: Number(o.chainId),
    poseidonT3: addr("poseidonT3"),
    poseidonT4: addr("poseidonT4"),
    verifier: addr("verifier"),
    shieldedPool: addr("shieldedPool"),
    feeRouter: addr("feeRouter"),
    roots: addr("roots"),
    holderRewards: addr("holderRewards"),
    donationRotator: addr("donationRotator"),
    launchpad: addr("launchpad"),
    grove: addr("grove"),
    router: addr("router"),
    treasury: addr("treasury"),
    startBlock: Number(o.startBlock),
  };
  // optional: only chains whose rootstock was launched on Flap carry these
  if (o.rootstockBuyback !== undefined && o.rootstockBuyback !== null) d.rootstockBuyback = addr("rootstockBuyback");
  if (o.rootstockExternal !== undefined) d.rootstockExternal = o.rootstockExternal === true;
  // optional: stage-1 dark pools (the relayer's fill / vault / recover kinds)
  if (o.darkPool !== undefined && o.darkPool !== null) d.darkPool = addr("darkPool");
  // optional: privacy stage 2 (DeployPrivacy adds these keys; absent on the live chain-56 file today)
  for (const k of ["grovePool", "darkCurve", "planter"] as const) {
    if (o[k] !== undefined && o[k] !== null) d[k] = addr(k);
  }
  if (o.privacyStartBlock !== undefined && o.privacyStartBlock !== null) {
    const b = Number(o.privacyStartBlock);
    if (!Number.isInteger(b) || b < 0) throw new Error("deployments: bad privacyStartBlock");
    d.privacyStartBlock = b;
  }
  if (!Number.isInteger(d.startBlock) || d.startBlock < 0) throw new Error("deployments: bad startBlock");
  if (expectedChainId !== undefined && d.chainId !== expectedChainId) {
    throw new Error(`deployments: chainId ${d.chainId} does not match CHAIN_ID ${expectedChainId}`);
  }
  return d;
}

export function loadDeployments(cfg: KeeperConfig): Deployments {
  if (!fs.existsSync(cfg.deploymentsPath)) {
    throw new Error(`deployments file not found: ${cfg.deploymentsPath} (set DEPLOYMENTS_PATH)`);
  }
  const raw = JSON.parse(fs.readFileSync(cfg.deploymentsPath, "utf8"));
  return parseDeployments(raw, cfg.chainId);
}

// ------------------------------------------------------------------ privacy stage 2

/**
 * Settings of the stage-2 commands (coordinator, rotate-key, pool-feed, dividends, flush). Read separately from
 * KeeperConfig so the stage-1 commands never depend on them. COORDINATOR_SK is NOT read here: only the
 * coordinator / rotate-key commands read it (coordinatorKeys.ts), so no other code path holds the secret.
 */
export interface PrivacyConfig {
  /** basis points of slippage on every openEpoch minOut (spec section 5.2, default 300) */
  slippageBps: number;
  /** private-transaction RPC for openEpoch (48 Club / bloXroute); undefined = public RPC with a warning */
  privateTxRpc?: string;
  /** directory of Coordinator key files (rotate-key writes, coordinator reads, destruction overwrites) */
  coordinatorKeyDir: string;
  /** minimum seconds between two key proposals (daily) */
  rotateEverySec: number;
  /** switchAt = now + this (spec: 1 h) */
  rotateLeadSec: number;
  /** BSGS table file and size */
  bsgsPath: string;
  bsgsBits: number;
  /** consecutive failed open attempts of one direction before it is left out of the mask */
  maxOpenAttempts: number;
  /** pool-feed: local output directory (bundle under <dir>/<chainId>/) and how often the bundle is rebuilt */
  poolFeedDir: string;
  poolFeedBundleSec: number;
  /** flush: CreatorStub.flush() when balance + FeeRouter.pending(stub) >= this */
  minFlushWei: bigint;
  /** dividends: how many of each Holders coin's latest runs are checked per pass */
  dividendsLookback: number;
}

export function loadPrivacyConfig(env: Env = process.env, snapshotDir = path.resolve(env.SNAPSHOT_DIR ?? "./snapshots")): PrivacyConfig {
  const slippageBps = num(env, "SLIPPAGE_BPS", 300);
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10_000) throw new Error("SLIPPAGE_BPS must be an integer in [0, 10000)");
  const bsgsBits = num(env, "BSGS_BITS", 24);
  return {
    slippageBps,
    privateTxRpc: (env.PRIVATE_TX_RPC ?? "").trim() || undefined,
    coordinatorKeyDir: path.resolve(env.COORDINATOR_KEY_DIR ?? path.join(snapshotDir, "coordinator-keys")),
    rotateEverySec: num(env, "ROTATE_EVERY_SEC", 86_400),
    rotateLeadSec: num(env, "ROTATE_LEAD_SEC", 3_600),
    bsgsPath: path.resolve(env.BSGS_PATH ?? path.join(snapshotDir, `bsgs-${bsgsBits}.bin`)),
    bsgsBits,
    maxOpenAttempts: num(env, "MAX_OPEN_ATTEMPTS", 3),
    poolFeedDir: path.resolve(env.POOL_FEED_DIR ?? path.join(snapshotDir, "pool")),
    poolFeedBundleSec: num(env, "POOL_FEED_BUNDLE_SEC", 60),
    minFlushWei: bnb(env, "MIN_FLUSH_BNB", "0.01"),
    dividendsLookback: num(env, "DIVIDENDS_LOOKBACK", 5),
  };
}

/** Stage-2 addresses present in the deployment file, or undefined (the command is then inert). */
export function privacyAddresses(dep: Deployments): { grovePool: Address; darkCurve: Address; planter?: Address; fromBlock: number } | undefined {
  if (!dep.grovePool || !dep.darkCurve) return undefined;
  return { grovePool: dep.grovePool, darkCurve: dep.darkCurve, planter: dep.planter, fromBlock: dep.privacyStartBlock ?? dep.startBlock };
}
