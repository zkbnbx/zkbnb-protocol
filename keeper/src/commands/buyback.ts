import { formatEther, type Address } from "viem";
import { feeRouterAbi, launchpadAbi, routerAbi } from "../abis.js";
import { errorText, sendTx, ZERO, type Ctx } from "../chain.js";
import { logger } from "../log.js";

const log = logger("buyback");

/**
 * When FeeRouter.rootstockPot >= MIN_BUYBACK_BNB, quote the $ZKBNB the pot buys and
 * buybackAndBurn with minOut = 97%. In-house rootstock: curve quote while $ZKBNB is on the
 * Launchpad, router quote after graduation. Rootstock on Flap (FeeRouter.rootstockBuyback set):
 * simulate buybackAndBurn(0) from the keeper and take its return value as the quote.
 */
export async function buyback(ctx: Ctx): Promise<{ done: boolean; potWei: bigint }> {
  const { pub, dep, cfg } = ctx;
  const pot = await pub.readContract({ address: dep.feeRouter, abi: feeRouterAbi, functionName: "rootstockPot" });
  const res = await tryBuyback(ctx, pot);
  // one info line per run, like the other commands, so operators can see the step ran and the pot size
  log.info("buyback done", { potBnb: formatEther(pot), thresholdBnb: formatEther(cfg.minBuybackWei), executed: res.done });
  return res;
}

async function tryBuyback(ctx: Ctx, pot: bigint): Promise<{ done: boolean; potWei: bigint }> {
  const { pub, dep, cfg } = ctx;
  if (pot < cfg.minBuybackWei) {
    log.debug("rootstock pot below MIN_BUYBACK_BNB", { potBnb: formatEther(pot) });
    return { done: false, potWei: pot };
  }
  const grove = await pub.readContract({ address: dep.feeRouter, abi: feeRouterAbi, functionName: "rootstockCoin" });
  if (grove === ZERO) {
    log.warn("rootstock coin not set on FeeRouter; cannot buy back");
    return { done: false, potWei: pot };
  }
  const external = await externalBuyback(ctx);
  if (external) return externalTryBuyback(ctx, pot, grove, external);

  const graduated = await pub.readContract({ address: dep.launchpad, abi: launchpadAbi, functionName: "isGraduated", args: [grove] });
  let quote: bigint;
  if (graduated) {
    const weth = await pub.readContract({ address: dep.router, abi: routerAbi, functionName: "WETH" });
    const amounts = await pub.readContract({ address: dep.router, abi: routerAbi, functionName: "getAmountsOut", args: [pot, [weth, grove]] });
    quote = amounts[amounts.length - 1];
    // the pair-tax takes 2% of tokens leaving the pair; the router quote does not know that
    quote = (quote * 98n) / 100n;
  } else {
    const [tokensOut] = await pub.readContract({ address: dep.launchpad, abi: launchpadAbi, functionName: "quoteBuy", args: [grove, pot] });
    quote = tokensOut;
  }
  if (quote === 0n) {
    log.warn("buyback quote is zero, skipping", { potBnb: formatEther(pot) });
    return { done: false, potWei: pot };
  }
  const minOut = (quote * 97n) / 100n;
  log.info("buying back $ZKBNB", { potBnb: formatEther(pot), rootstock: grove, graduated, quote, minOut });
  const res = await sendTx(ctx, { address: dep.feeRouter, abi: feeRouterAbi, functionName: "buybackAndBurn", args: [minOut], label: "buybackAndBurn" });
  return { done: res.dryRun || res.status === "success", potWei: pot };
}

/**
 * The FlapBuyback adapter when the rootstock lives on Flap, else undefined. The deployments json
 * flags it; otherwise ask the FeeRouter (older FeeRouters have no getter: treat a revert as in-house).
 */
async function externalBuyback(ctx: Ctx): Promise<Address | undefined> {
  const { pub, dep } = ctx;
  if (dep.rootstockBuyback && dep.rootstockBuyback !== ZERO) return dep.rootstockBuyback;
  try {
    const b = await pub.readContract({ address: dep.feeRouter, abi: feeRouterAbi, functionName: "rootstockBuyback" });
    if (b !== ZERO) return b;
  } catch (e) {
    if (dep.rootstockExternal) throw e;
  }
  if (dep.rootstockExternal) throw new Error("deployments say rootstockExternal but FeeRouter.rootstockBuyback is not set");
  return undefined;
}

/** FlapBuyback reverts with this while the Flap token is neither on its curve nor on PancakeSwap (e.g. migrating). */
function isNotTradable(e: unknown): boolean {
  return /not tradable/i.test(errorText(e));
}

async function externalTryBuyback(ctx: Ctx, pot: bigint, token: Address, adapter: Address): Promise<{ done: boolean; potWei: bigint }> {
  const { pub, dep } = ctx;
  // simulate from the address that will send (the keeper is uncapped); with no key (DRY_RUN) use FeeRouter.keeper()
  const from = ctx.account?.address ?? (await pub.readContract({ address: dep.feeRouter, abi: feeRouterAbi, functionName: "keeper" }));
  // covers both the quote and the send: the status can flip in between (the token migrates to PancakeSwap)
  try {
    // the return value is what the adapter burned after Flap's buy tax and PancakeSwap fees, so no haircut is needed
    const { result: quote } = await pub.simulateContract({ address: dep.feeRouter, abi: feeRouterAbi, functionName: "buybackAndBurn", args: [0n], account: from });
    if (quote === 0n) {
      log.warn("buyback quote is zero, skipping", { potBnb: formatEther(pot) });
      return { done: false, potWei: pot };
    }
    const minOut = (quote * 97n) / 100n;
    log.info("buying back $ZKBNB on Flap", { potBnb: formatEther(pot), rootstock: token, adapter, quote, minOut });
    const res = await sendTx(ctx, { address: dep.feeRouter, abi: feeRouterAbi, functionName: "buybackAndBurn", args: [minOut], label: "buybackAndBurn" });
    return { done: res.dryRun || res.status === "success", potWei: pot };
  } catch (e) {
    if (isNotTradable(e)) {
      log.warn("Flap rootstock is not tradable right now, skipping", { rootstock: token });
      return { done: false, potWei: pot };
    }
    throw e;
  }
}
