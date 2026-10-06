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

function num(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`env ${name} is not a number: ${v}`);
  return n;
}

function bnb(name: string, def: string): bigint {
  const v = process.env[name];
  return parseEther((v === undefined || v === "" ? def : v) as `${number}`);
}

function bool(name: string): boolean {
  const v = (process.env[name] ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): KeeperConfig {
  const chainId = num("CHAIN_ID", 97);
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

  const minPot = env.MIN_POT_BNB && env.MIN_POT_BNB !== "" ? bnb("MIN_POT_BNB", "0") : undefined;
  const bnbUsdFallback = env.BNB_USD && env.BNB_USD !== "" ? Number(env.BNB_USD) : undefined;

  return {
    rpcUrl,
    rpcUrls,
    chainId,
    privateKey,
    deploymentsPath,
    minSweepWei: bnb("MIN_SWEEP_BNB", "0.02"),
    minPotWei: minPot,
    minHoldingUsd: num("MIN_HOLDING_USD", 20),
    bnbUsdFallback,
    minBuybackWei: bnb("MIN_BUYBACK_BNB", "0.05"),
    snapshotDir: path.resolve(env.SNAPSHOT_DIR ?? "./snapshots"),
    snapshotBaseUrl: (env.SNAPSHOT_BASE_URL ?? "").replace(/\/+$/, ""),
    blobToken: env.BLOB_READ_WRITE_TOKEN || undefined,
    logChunk: BigInt(num("LOG_CHUNK", 2000)),
    snapshotDelayMaxSec: num("SNAPSHOT_DELAY_MAX_SEC", 3600),
    dryRun: bool("DRY_RUN"),
    intervalSec: num("KEEPER_INTERVAL_SEC", 300),
    excludeAddresses,
    confirmations: num("CONFIRMATIONS", 20),
    feedDays: num("FEED_DAYS", 30),
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
