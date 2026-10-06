import { randomInt } from "node:crypto";
import { formatEther, getAddress, parseEventLogs, type Address } from "viem";
import { feeRouterAbi, holderRewardsAbi, launchpadAbi, pairAbi, routerAbi } from "../abis.js";
import { sendTx, ZERO, DEAD, type Ctx } from "../chain.js";
import { allocate, minHoldingWei } from "../allocation.js";
import { eligibleHolders } from "../balances.js";
import { balancesAt } from "../logs.js";
import { bnbUsd } from "../price.js";
import { buildSnapshot, publishSnapshot, verifySnapshot, writeSnapshot } from "../snapshot.js";
import { loadState, saveState } from "../state.js";
import { logger } from "../log.js";

const log = logger("rewards");

export const PAYOUT_HOLDERS = 2; // PayoutMode { Creator, Wallet, Holders, Donate }
const HOUR = 3600;

export interface RewardsResult {
  /** unix seconds of the earliest pending snapshot, so the loop can wake up for it */
  nextWakeAt?: number;
  posted: number;
  scheduled: number;
}

/**
 * Holder-reward runs. When a Holders-mode coin's pot crosses minPot and an hour has passed since
 * the last run, a snapshot moment is drawn uniformly within the next 60 minutes and persisted in
 * state.json. The moment is never logged or published. When it arrives the snapshot is taken at
 * the latest block, allocated, Merkle-ised, written to SNAPSHOT_DIR/<coin>/<runId>.json and
 * posted with HolderRewards.postRun.
 */
export async function rewards(ctx: Ctx): Promise<RewardsResult> {
  const { pub, dep, cfg } = ctx;
  const coins = await pub.readContract({ address: dep.launchpad, abi: launchpadAbi, functionName: "allCoins" });
  const minPot = cfg.minPotWei ?? (await pub.readContract({ address: dep.holderRewards, abi: holderRewardsAbi, functionName: "minPot" }));
  const state = loadState(cfg.snapshotDir);
  // chain time, not wall-clock: HolderRewards.postRun judges "1 hour since the last run" by block.timestamp
  const now = Number((await pub.getBlock()).timestamp);
  let nextWakeAt: number | undefined;
  let posted = 0;
  let scheduled = 0;

  if (ctx.account) {
    const keeper = await pub.readContract({ address: dep.holderRewards, abi: holderRewardsAbi, functionName: "keeper" });
    if (keeper.toLowerCase() !== ctx.account.address.toLowerCase()) {
      log.warn("this key is not HolderRewards.keeper; postRun will revert", { keeper, me: ctx.account.address });
    }
  }

  for (const coinRaw of coins) {
    const coin = getAddress(coinRaw);
    try {
      const conf = await pub.readContract({ address: dep.feeRouter, abi: feeRouterAbi, functionName: "configOf", args: [coin] });
      const mode = conf[1];
      if (mode !== PAYOUT_HOLDERS) {
        if (state.scheduled[coin]) {
          delete state.scheduled[coin];
          saveState(cfg.snapshotDir, state);
        }
        continue;
      }
      const [pot, lastRunAt] = await Promise.all([
        pub.readContract({ address: dep.holderRewards, abi: holderRewardsAbi, functionName: "pot", args: [coin] }),
        pub.readContract({ address: dep.holderRewards, abi: holderRewardsAbi, functionName: "lastRunAt", args: [coin] }),
      ]);
      const due = pot >= minPot && BigInt(now) >= lastRunAt + BigInt(HOUR);
      const sched = state.scheduled[coin];

      if (sched) {
        if (!due) {
          log.info("dropping scheduled snapshot: conditions no longer hold", { coin, potBnb: formatEther(pot) });
          delete state.scheduled[coin];
          saveState(cfg.snapshotDir, state);
          continue;
        }
        if (now < sched.at) {
          nextWakeAt = nextWakeAt === undefined ? sched.at : Math.min(nextWakeAt, sched.at);
          log.debug("snapshot pending", { coin });
          continue;
        }
        const ok = await takeSnapshotAndPost(ctx, coin, pot);
        delete state.scheduled[coin];
        saveState(cfg.snapshotDir, state);
        if (ok) posted++;
        continue;
      }

      if (due) {
        const at = now + randomInt(0, cfg.snapshotDelayMaxSec + 1);
        state.scheduled[coin] = { at, scheduledAt: now, potAtSchedule: pot.toString() };
        saveState(cfg.snapshotDir, state);
        scheduled++;
        // deliberately not logging `at`: the moment must stay unpredictable
        log.info("pot crossed minPot: snapshot scheduled within the next hour", { coin, potBnb: formatEther(pot) });
        nextWakeAt = nextWakeAt === undefined ? at : Math.min(nextWakeAt, at);
      } else {
        log.debug("not due", { coin, potBnb: formatEther(pot), minPotBnb: formatEther(minPot), lastRunAt });
      }
    } catch (e) {
      log.error("rewards failed for coin", { coin, err: e });
    }
  }
  log.info("rewards done", { coins: coins.length, posted, scheduled, pending: Object.keys(loadState(cfg.snapshotDir).scheduled).length });
  return { nextWakeAt, posted, scheduled };
}

/** wei of BNB per 1e18 tokens: Launchpad.price on the curve, pair reserves after graduation. */
export async function coinPriceWei(ctx: Ctx, coin: Address): Promise<{ price: bigint; pair: Address }> {
  const { pub, dep } = ctx;
  const pair = await pub.readContract({ address: dep.launchpad, abi: launchpadAbi, functionName: "pairOf", args: [coin] });
  if (pair === ZERO) {
    const price = await pub.readContract({ address: dep.launchpad, abi: launchpadAbi, functionName: "price", args: [coin] });
    return { price, pair };
  }
  const [token0, reserves, weth] = await Promise.all([
    pub.readContract({ address: pair, abi: pairAbi, functionName: "token0" }),
    pub.readContract({ address: pair, abi: pairAbi, functionName: "getReserves" }),
    pub.readContract({ address: dep.router, abi: routerAbi, functionName: "WETH" }),
  ]);
  const coinIs0 = token0.toLowerCase() === coin.toLowerCase();
  const reserveCoin = coinIs0 ? reserves[0] : reserves[1];
  const reserveWeth = coinIs0 ? reserves[1] : reserves[0];
  if (token0.toLowerCase() !== weth.toLowerCase() && !coinIs0) throw new Error(`pair ${pair} is not coin/WETH`);
  if (reserveCoin === 0n) throw new Error("pair has no coin reserve");
  return { price: (reserveWeth * 10n ** 18n) / reserveCoin, pair };
}

export async function takeSnapshotAndPost(ctx: Ctx, coin: Address, pot: bigint): Promise<boolean> {
  const { pub, dep, cfg } = ctx;
  const snapshotBlock = await pub.getBlockNumber();
  const takenAt = Math.floor(Date.now() / 1000);
  const { price, pair } = await coinPriceWei(ctx, coin);
  const usd = await bnbUsd(cfg.bnbUsdFallback);
  const minWei = minHoldingWei(cfg.minHoldingUsd, usd, price);

  const excluded: Address[] = [
    dep.launchpad,
    dep.roots,
    dep.feeRouter,
    dep.holderRewards,
    coin,
    ZERO,
    DEAD,
    ...cfg.excludeAddresses,
  ];
  if (pair !== ZERO) excluded.push(pair);

  const balances = await balancesAt(ctx, coin, snapshotBlock);
  const holders = eligibleHolders(balances, excluded, minWei);
  log.info("snapshot taken", {
    coin,
    block: snapshotBlock,
    accounts: balances.size,
    eligible: holders.length,
    minHoldingTokens: formatEther(minWei),
    bnbUsd: usd,
    potBnb: formatEther(pot),
  });
  if (holders.length === 0) {
    log.warn("no eligible holders; nothing to post (will re-evaluate next hour)", { coin });
    return false;
  }
  const shares = allocate(pot, holders);
  if (shares.length === 0) {
    log.warn("allocation produced no shares", { coin });
    return false;
  }

  const runId = await pub.readContract({ address: dep.holderRewards, abi: holderRewardsAbi, functionName: "runCount", args: [coin] });
  const built = buildSnapshot({ coin, runId, shares, snapshotBlock, takenAt, minHoldingWei: minWei, excluded });
  if (!verifySnapshot(built.json)) throw new Error("snapshot self-verification failed");
  if (built.amount !== pot) throw new Error(`allocation sum ${built.amount} != pot ${pot}`);

  const file = writeSnapshot(cfg.snapshotDir, built.json);
  log.info("snapshot written", { file, root: built.root, holders: built.json.holders });

  let uri: string;
  if (cfg.dryRun) {
    uri = cfg.snapshotBaseUrl ? `${cfg.snapshotBaseUrl}/${coin}/${runId}.json` : `dry-run://${coin}/${runId}.json`;
  } else {
    uri = await publishSnapshot({ snapshotBaseUrl: cfg.snapshotBaseUrl, blobToken: cfg.blobToken }, built.json);
  }

  const res = await sendTx(ctx, {
    address: dep.holderRewards,
    abi: holderRewardsAbi,
    functionName: "postRun",
    args: [coin, built.root, built.amount, BigInt(built.json.holders), uri],
    label: `postRun(${coin}, run ${runId})`,
  });
  if (res.dryRun) return true;
  if (res.status !== "success") return false;

  const postedRunId = res.result as bigint;
  const ev = parseEventLogs({ abi: holderRewardsAbi, eventName: "RunPosted", logs: (res.logs ?? []) as never });
  const onchainRunId = ev[0]?.args.runId ?? postedRunId;
  if (onchainRunId !== runId) {
    log.error("runId mismatch: leaves were hashed with a different runId; claims will fail for this run", {
      expected: runId,
      onchain: onchainRunId,
      hash: res.hash,
    });
  }
  const st = loadState(cfg.snapshotDir);
  st.lastTx[`rewards:${coin}`] = { hash: res.hash!, at: Math.floor(Date.now() / 1000) };
  saveState(cfg.snapshotDir, st);
  log.info("run posted", { coin, runId, amountBnb: formatEther(built.amount), holders: built.json.holders, uri, hash: res.hash });
  return true;
}
