import { randomInt } from "node:crypto";
import { formatEther, getAddress, parseEventLogs, type Address } from "viem";
import { feeRouterAbi, holderRewardsAbi, launchpadAbi, pairAbi, routerAbi } from "../abis.js";
import { sameAddr, sendTx, ZERO, DEAD, type Ctx } from "../chain.js";
import { allocate, minHoldingWei } from "../allocation.js";
import { eligibleHolders } from "../balances.js";
import { balancesAt } from "../logs.js";
import { bnbUsd } from "../price.js";
import { buildSnapshot, publishSnapshot, verifySnapshot, writeSnapshot } from "../snapshot.js";
import { loadState, saveState } from "../state.js";
import { logger } from "../log.js";
import { applyPrivacyExclusions, hasPrivacyModules, knownStubs } from "../stubs.js";
import { rewardPosterAbi } from "../abis-v2.js";
import { MIN_REWARD_SUPPLY, poolLeafFromSnapshot } from "./dividends.js";

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
    if (dep.rewardPoster) {
      // review N1: HolderRewards' keeper is the RewardPoster, and this key is its operator
      const operator = await pub.readContract({ address: dep.rewardPoster, abi: rewardPosterAbi, functionName: "operator" });
      if (!sameAddr(keeper, dep.rewardPoster)) log.warn("HolderRewards.keeper is not the RewardPoster; posts will revert", { keeper, rewardPoster: dep.rewardPoster });
      if (!sameAddr(operator, ctx.account.address)) log.warn("this key is not RewardPoster.operator; posts will revert", { operator, me: ctx.account.address });
    } else if (!sameAddr(keeper, ctx.account.address)) {
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
        state.lastTx = loadState(cfg.snapshotDir).lastTx; // keep the tx record takeSnapshotAndPost just saved
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
  const coinIs0 = sameAddr(token0, coin);
  const reserveCoin = coinIs0 ? reserves[0] : reserves[1];
  const reserveWeth = coinIs0 ? reserves[1] : reserves[0];
  if (!sameAddr(token0, weth) && !coinIs0) throw new Error(`pair ${pair} is not coin/WETH`);
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
  // privacy stage 2 (spec section 5.2): GrovePool is a holder; DarkCurve, Planter and CreatorStubs are excluded.
  // Inert while the deployment file has no stage-2 address: no RPC call, the list above is used unchanged.
  if (hasPrivacyModules(dep)) {
    const p = applyPrivacyExclusions(excluded, dep, await knownStubs(ctx));
    if (p.poolWasListed) log.warn("EXCLUDE_ADDRESSES names GrovePool; it is an eligible holder and was kept in the snapshot", { grovePool: dep.grovePool });
    excluded.splice(0, excluded.length, ...p.excluded);
  }

  const balances = await balancesAt(ctx, coin, snapshotBlock);
  // review N1: with a RewardPoster the pool's share is pulled in the posting transaction, and GrovePool.pullRewards
  // refuses a pool coin balance below MIN_REWARD_SUPPLY, so a dust pool is left out instead of reverting the post
  if (dep.rewardPoster && dep.grovePool) {
    const poolBal = [...balances].find(([a]) => sameAddr(a, dep.grovePool!))?.[1] ?? 0n;
    if (poolBal > 0n && poolBal < MIN_REWARD_SUPPLY) {
      excluded.push(dep.grovePool);
      log.info("GrovePool holds less than one token; left out of this run", { coin });
    }
  }
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

  const res = dep.rewardPoster
    ? await postThroughPoster(ctx, dep.rewardPoster, built, uri, runId)
    : await sendTx(ctx, {
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

/**
 * Review N1: post through the RewardPoster, which pulls GrovePool's leaf in the same transaction, so nobody can
 * shield between the run becoming public and the pool's share being spread over the pool's notes.
 */
function postThroughPoster(ctx: Ctx, poster: Address, built: ReturnType<typeof buildSnapshot>, uri: string, runId: bigint) {
  const coin = getAddress(built.json.coin);
  const pl = ctx.dep.grovePool ? poolLeafFromSnapshot(built.json, ctx.dep.grovePool) : undefined;
  if (pl) log.info("pool share pulled in the posting transaction", { coin, runId, poolAmountBnb: formatEther(pl.amount) });
  return sendTx(ctx, {
    address: poster,
    abi: rewardPosterAbi,
    functionName: "post",
    args: [coin, built.root, built.amount, BigInt(built.json.holders), uri, pl?.amount ?? 0n, pl?.proof ?? []],
    label: `RewardPoster.post(${coin}, run ${runId})`,
  } as never);
}
