import { logger } from "./log.js";

const log = logger("price");
const BINANCE = "https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT";

let cached: { value: number; at: number } | undefined;
const TTL_MS = 60_000;

/** BNB/USD from Binance's public ticker, cached for a minute, with env fallback. */
export async function bnbUsd(fallback?: number, fetchImpl: typeof fetch = fetch): Promise<number> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;
  try {
    const res = await fetchImpl(BINANCE, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`binance http ${res.status}`);
    const j = (await res.json()) as { price?: string };
    const p = Number(j.price);
    if (!Number.isFinite(p) || p <= 0) throw new Error(`binance returned ${j.price}`);
    cached = { value: p, at: Date.now() };
    return p;
  } catch (e) {
    if (fallback && fallback > 0) {
      log.warn("binance price unavailable, using BNB_USD fallback", { err: e, fallback });
      return fallback;
    }
    throw new Error(`BNB/USD unavailable (${e instanceof Error ? e.message : e}); set BNB_USD as a fallback`);
  }
}

export function _resetPriceCache() {
  cached = undefined;
}
