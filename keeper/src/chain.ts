import {
  createPublicClient,
  createWalletClient,
  defineChain,
  fallback,
  http,
  type Abi,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Account,
  type ContractFunctionArgs,
  type ContractFunctionName,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc, bscTestnet } from "viem/chains";
import type { KeeperConfig, Deployments } from "./config.js";
import { logger } from "./log.js";

const log = logger("chain");

export function chainFor(chainId: number, rpcUrl: string): Chain {
  if (chainId === 56) return { ...bsc, rpcUrls: { default: { http: [rpcUrl] } } };
  if (chainId === 97) return { ...bscTestnet, rpcUrls: { default: { http: [rpcUrl] } } };
  return defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

export interface Ctx {
  cfg: KeeperConfig;
  dep: Deployments;
  chain: Chain;
  pub: PublicClient;
  wallet?: WalletClient;
  account?: Account;
  /** serialises sends so parallel commands never race on the nonce */
  txLock: Promise<void>;
}

export function makeCtx(cfg: KeeperConfig, dep: Deployments): Ctx {
  const chain = chainFor(cfg.chainId, cfg.rpcUrl);
  const urls = cfg.rpcUrls?.length ? cfg.rpcUrls : [cfg.rpcUrl];
  const one = (u: string) => http(u, { batch: true, retryCount: 2, retryDelay: 500, timeout: 30_000 });
  // failover across providers: a 429/5xx/timeout on the primary moves the request to the next URL
  const transport = urls.length > 1 ? fallback(urls.map(one), { rank: false, retryCount: 2 }) : one(urls[0]);
  const pub = createPublicClient({ chain, transport });
  let wallet: WalletClient | undefined;
  let account: Account | undefined;
  if (cfg.privateKey) {
    account = privateKeyToAccount(cfg.privateKey);
    wallet = createWalletClient({ chain, transport, account });
  }
  return { cfg, dep, chain, pub, wallet, account, txLock: Promise.resolve() };
}

export interface TxResult {
  hash?: Hex;
  dryRun: boolean;
  /** decoded return value from simulateContract */
  result: unknown;
  blockNumber?: bigint;
  gasUsed?: bigint;
  status?: "success" | "reverted";
  logs?: readonly { address: Address; topics: readonly Hex[]; data: Hex }[];
}

const NONCE_ERRORS = [/nonce too low/i, /replacement transaction underpriced/i, /already known/i, /nonce.*(low|high|used)/i, /invalid nonce/i];

function isNonceError(e: unknown): boolean {
  const m = e instanceof Error ? `${e.message}\n${(e as { details?: string }).details ?? ""}` : String(e);
  return NONCE_ERRORS.some((r) => r.test(m));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * simulate → (DRY_RUN ? stop : write → wait for receipt). Retries nonce collisions with a fresh
 * pending nonce. Throws if the simulation reverts, so callers can treat "would revert" as skip.
 */
/** Floor for the gas limit of every keeper transaction (see sendTx). */
const MIN_GAS_LIMIT = 800_000n;

export async function sendTx<
  const TAbi extends Abi,
  TName extends ContractFunctionName<TAbi, "nonpayable" | "payable">,
>(
  ctx: Ctx,
  params: {
    address: Address;
    abi: TAbi;
    functionName: TName;
    args: ContractFunctionArgs<TAbi, "nonpayable" | "payable", TName>;
    value?: bigint;
    label: string;
  },
): Promise<TxResult> {
  const { cfg, pub } = ctx;
  if (!ctx.account) throw new Error("KEEPER_PRIVATE_KEY is required to send transactions (or set DRY_RUN=1)");

  const sim = await pub.simulateContract({
    address: params.address,
    abi: params.abi,
    functionName: params.functionName as never,
    args: params.args as never,
    account: ctx.account,
    value: params.value,
  } as never);

  if (cfg.dryRun) {
    log.info(`DRY_RUN ${params.label}: simulation ok`, { result: sim.result as unknown });
    return { dryRun: true, result: sim.result };
  }

  // Generous gas limit: a buyback of a Flap tax token can trigger the token's own tax liquidation and
  // dividend distribution mid-swap, which the estimate (taken in a quieter state) does not include.
  // Two mainnet buybacks ran out of gas at ~490k with the default limit. Unused gas is not charged.
  const estimate = await pub.estimateContractGas({ ...(sim.request as object), account: ctx.account } as never);
  const gas = estimate * 2n > MIN_GAS_LIMIT ? estimate * 2n : MIN_GAS_LIMIT;

  const release = await acquire(ctx);
  try {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const nonce = await pub.getTransactionCount({ address: ctx.account.address, blockTag: "pending" });
        const hash = await ctx.wallet!.writeContract({ ...(sim.request as object), nonce, gas } as never);
        log.info(`${params.label}: sent`, { hash, nonce });
        const receipt = await pub.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 180_000 });
        if (receipt.status !== "success") {
          log.error(`${params.label}: reverted on-chain`, { hash });
        } else {
          log.info(`${params.label}: mined`, { hash, block: receipt.blockNumber, gasUsed: receipt.gasUsed });
        }
        return {
          hash,
          dryRun: false,
          result: sim.result,
          blockNumber: receipt.blockNumber,
          gasUsed: receipt.gasUsed,
          status: receipt.status,
          logs: receipt.logs,
        };
      } catch (e) {
        lastErr = e;
        if (isNonceError(e) && attempt < 4) {
          log.warn(`${params.label}: nonce collision, retrying`, { attempt, err: e });
          await sleep(1500 * attempt);
          continue;
        }
        throw e;
      }
    }
    throw lastErr;
  } finally {
    release();
  }
}

async function acquire(ctx: Ctx): Promise<() => void> {
  let release!: () => void;
  const prev = ctx.txLock;
  ctx.txLock = new Promise<void>((r) => (release = r));
  await prev;
  return release;
}

/** Address helpers */
export const ZERO: Address = "0x0000000000000000000000000000000000000000";
export const DEAD: Address = "0x000000000000000000000000000000000000dEaD";

export function sameAddr(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
