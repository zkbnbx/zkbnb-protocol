import path from "node:path";
import { getAddress, parseEventLogs, formatLog, type Address, type Log, type Hex, type RpcLog } from "viem";
import type { Ctx } from "./chain.js";
import { groveCoinAbi } from "./abis.js";
import { applyTransfers, deserializeBalances, serializeBalances, type BalanceMap } from "./balances.js";
import { readJson, writeJsonAtomic } from "./state.js";
import { logger } from "./log.js";

const log = logger("logs");

export interface RawLog {
  address: Address;
  topics: readonly Hex[];
  data: Hex;
  blockNumber: bigint;
  transactionHash: Hex;
  logIndex: number;
}

function toRaw(l: Log): RawLog {
  return {
    address: getAddress(l.address),
    topics: l.topics,
    data: l.data,
    blockNumber: l.blockNumber!,
    transactionHash: l.transactionHash!,
    logIndex: l.logIndex!,
  };
}

const TOO_MANY = [/limit/i, /too many/i, /exceed/i, /range/i, /response size/i, /query returned more/i];

/**
 * getLogs in LOG_CHUNK-sized windows. If the node rejects a window as too large the window is
 * halved for that range (down to 1 block) so one over-active range never stalls the scan.
 */
export async function getLogsChunked(
  ctx: Ctx,
  args: { address: Address | Address[]; fromBlock: bigint; toBlock: bigint; topics?: (Hex | Hex[] | null)[] },
  onChunk?: (from: bigint, to: bigint, logs: RawLog[]) => void | Promise<void>,
): Promise<RawLog[]> {
  const out: RawLog[] = [];
  let chunk = ctx.cfg.logChunk > 0n ? ctx.cfg.logChunk : 2000n;
  let from = args.fromBlock;
  while (from <= args.toBlock) {
    const to = from + chunk - 1n > args.toBlock ? args.toBlock : from + chunk - 1n;
    try {
      const logs = await ctx.pub.request({
        method: "eth_getLogs",
        params: [
          {
            address: args.address,
            fromBlock: `0x${from.toString(16)}`,
            toBlock: `0x${to.toString(16)}`,
            topics: args.topics as never,
          },
        ],
      });
      const raw = (logs as unknown as RpcLog[]).map((l) => toRaw(formatLog(l)));
      raw.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
      out.push(...raw);
      if (onChunk) await onChunk(from, to, raw);
      from = to + 1n;
      if (chunk < ctx.cfg.logChunk) chunk = chunk * 2n > ctx.cfg.logChunk ? ctx.cfg.logChunk : chunk * 2n;
    } catch (e) {
      const msg = e instanceof Error ? `${e.message} ${(e as { details?: string }).details ?? ""}` : String(e);
      if (chunk > 1n && TOO_MANY.some((r) => r.test(msg))) {
        chunk = chunk / 2n;
        log.warn("getLogs window rejected, halving", { from, to, chunk });
        continue;
      }
      throw e;
    }
  }
  return out;
}

// ------------------------------------------------------------------ per-coin balance cache

interface CoinCache {
  coin: Address;
  chainId: number;
  /** last block whose Transfer logs are folded into `balances` (treated as final) */
  lastBlock: string;
  balances: Record<string, string>;
}

export function coinCachePath(snapshotDir: string, coin: Address): string {
  return path.join(snapshotDir, "cache", `${getAddress(coin)}.json`);
}

/**
 * Reconstruct the coin's balances at `snapshotBlock` from Transfer logs since startBlock.
 * Logs up to `snapshotBlock - confirmations` are folded into the on-disk cache; the tail is
 * applied in memory only, so a shallow reorg can never poison the cache.
 */
export async function balancesAt(ctx: Ctx, coin: Address, snapshotBlock: bigint): Promise<BalanceMap> {
  const { cfg, dep } = ctx;
  const file = coinCachePath(cfg.snapshotDir, coin);
  const cached = readJson<CoinCache>(file);
  let balances: BalanceMap = new Map();
  let from = BigInt(dep.startBlock);
  if (cached && cached.chainId === cfg.chainId && cached.coin.toLowerCase() === coin.toLowerCase()) {
    balances = deserializeBalances(cached.balances);
    from = BigInt(cached.lastBlock) + 1n;
  }
  const safe = snapshotBlock - BigInt(cfg.confirmations);
  const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as Hex;

  const fold = (logs: RawLog[]) => {
    const parsed = parseEventLogs({ abi: groveCoinAbi, eventName: "Transfer", logs: logs as never, strict: true });
    applyTransfers(
      balances,
      parsed.map((p) => ({ from: p.args.from, to: p.args.to, value: p.args.value })),
    );
  };

  if (from <= safe) {
    let lastSaved = from - 1n;
    await getLogsChunked(ctx, { address: coin, fromBlock: from, toBlock: safe, topics: [transferTopic] }, (_f, t, logs) => {
      fold(logs);
      lastSaved = t;
      // persist every chunk so an interrupted first scan resumes where it stopped
      writeJsonAtomic(file, { coin: getAddress(coin), chainId: cfg.chainId, lastBlock: lastSaved.toString(), balances: serializeBalances(balances) } satisfies CoinCache);
    });
    from = safe + 1n;
  }
  if (from <= snapshotBlock) {
    const tail = await getLogsChunked(ctx, { address: coin, fromBlock: from, toBlock: snapshotBlock, topics: [transferTopic] });
    fold(tail);
  }
  log.debug("balances reconstructed", { coin, snapshotBlock, accounts: balances.size });
  return balances;
}

// ------------------------------------------------------------------ block timestamps

interface BlockTsCache {
  chainId: number;
  ts: Record<string, number>;
}

export class BlockTimestamps {
  private file: string;
  private cache: BlockTsCache;
  constructor(private ctx: Ctx) {
    this.file = path.join(ctx.cfg.snapshotDir, "cache", "blocks.json");
    const c = readJson<BlockTsCache>(this.file);
    this.cache = c && c.chainId === ctx.cfg.chainId ? c : { chainId: ctx.cfg.chainId, ts: {} };
  }

  async get(block: bigint): Promise<number> {
    const k = block.toString();
    if (this.cache.ts[k] !== undefined) return this.cache.ts[k];
    const b = await this.ctx.pub.getBlock({ blockNumber: block });
    this.cache.ts[k] = Number(b.timestamp);
    return this.cache.ts[k];
  }

  async getMany(blocks: Iterable<bigint>, concurrency = 8): Promise<Map<bigint, number>> {
    const uniq = [...new Set([...blocks].map((b) => b.toString()))].map((s) => BigInt(s));
    const out = new Map<bigint, number>();
    let i = 0;
    const worker = async () => {
      while (i < uniq.length) {
        const b = uniq[i++];
        out.set(b, await this.get(b));
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, uniq.length) }, worker));
    this.save();
    return out;
  }

  /** Drop entries older than `keepBlocksBelow` to keep the file bounded. */
  prune(keepFrom: bigint) {
    for (const k of Object.keys(this.cache.ts)) if (BigInt(k) < keepFrom) delete this.cache.ts[k];
  }

  save() {
    writeJsonAtomic(this.file, this.cache);
  }
}

/** Binary-search the first block whose timestamp >= `target` (unix seconds). */
export async function blockAtTimestamp(ctx: Ctx, target: number, lo: bigint, hi: bigint): Promise<bigint> {
  const bts = new BlockTimestamps(ctx);
  if ((await bts.get(lo)) >= target) return lo;
  if ((await bts.get(hi)) < target) return hi;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if ((await bts.get(mid)) >= target) hi = mid;
    else lo = mid;
  }
  bts.save();
  return hi;
}
