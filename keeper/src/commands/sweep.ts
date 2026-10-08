import { formatEther } from "viem";
import { groveCoinAbi, launchpadAbi, routerAbi } from "../abis.js";
import { sendTx, ZERO, type Ctx } from "../chain.js";
import { logger } from "../log.js";

const log = logger("sweep");

/**
 * For every graduated coin: read accruedTax, quote it in BNB via the router and sweep it
 * (minOut = 98% of the quote) once it is worth >= MIN_SWEEP_BNB.
 */
export async function sweep(ctx: Ctx): Promise<{ swept: number; checked: number }> {
  const { pub, dep, cfg } = ctx;
  const coins = await pub.readContract({ address: dep.launchpad, abi: launchpadAbi, functionName: "allCoins" });
  const weth = await pub.readContract({ address: dep.router, abi: routerAbi, functionName: "WETH" });
  let swept = 0;
  let checked = 0;
  for (const coin of coins) {
    try {
      const pair = await pub.readContract({ address: dep.launchpad, abi: launchpadAbi, functionName: "pairOf", args: [coin] });
      if (pair === ZERO) continue;
      checked++;
      const tax = await pub.readContract({ address: coin, abi: groveCoinAbi, functionName: "accruedTax" });
      if (tax === 0n) continue;
      const amounts = await pub.readContract({
        address: dep.router,
        abi: routerAbi,
        functionName: "getAmountsOut",
        args: [tax, [coin, weth]],
      });
      const quote = amounts[amounts.length - 1];
      if (quote < cfg.minSweepWei) {
        log.debug("below MIN_SWEEP_BNB", { coin, tax, quoteBnb: formatEther(quote) });
        continue;
      }
      const minOut = (quote * 98n) / 100n;
      log.info("sweeping tax", { coin, tokens: tax, quoteBnb: formatEther(quote), minOutBnb: formatEther(minOut) });
      const res = await sendTx(ctx, { address: coin, abi: groveCoinAbi, functionName: "sweepTax", args: [minOut], label: `sweepTax(${coin})` });
      if (res.dryRun || res.status === "success") swept++;
    } catch (e) {
      log.error("sweep failed for coin", { coin, err: e });
    }
  }
  log.info("sweep done", { graduated: checked, swept });
  return { swept, checked };
}
