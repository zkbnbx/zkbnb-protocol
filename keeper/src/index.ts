#!/usr/bin/env node
import { setTimeout as sleep } from "node:timers/promises";
import { formatEther, parseEther } from "viem";
import { loadConfig, loadDeployments } from "./config.js";
import { makeCtx, type Ctx } from "./chain.js";
import { logger } from "./log.js";
import { sweep } from "./commands/sweep.js";
import { rewards } from "./commands/rewards.js";
import { rotate } from "./commands/rotate.js";
import { buyback } from "./commands/buyback.js";
import { feed } from "./commands/feed.js";
import { newCoordinatorRuntime, runCoordinator } from "./commands/coordinator.js";
import { rotateKey } from "./commands/rotateKey.js";
import { newPoolFeedRuntime, poolFeed } from "./commands/poolFeed.js";
import { dividends } from "./commands/dividends.js";
import { flush } from "./commands/flush.js";
import { roleOf, roleSeparation, roleSeparationMessage } from "./roles.js";
import { shutdownProver } from "./zkprove.js";
import { dryRunKey, loadRelayerConfig, runRelayer, type RelayerConfig } from "./relayer/server.js";

const log = logger("keeper");

const COMMANDS = ["sweep", "rewards", "rotate", "buyback", "feed", "coordinator", "rotate-key", "pool-feed", "dividends", "flush", "relayer", "all"] as const;
type Command = (typeof COMMANDS)[number];

function usage(): never {
  console.log(`grove-keeper <command> [--once] [--dry-run] [--interval <sec>]

commands:
  sweep     swap accrued pair-tax of graduated coins into BNB for FeeRouter
  rewards   schedule + take holder-reward snapshots, post Merkle roots
  rotate    settle donation rings whose epoch elapsed
  buyback   buy and burn $ZKBNB with the rootstock pot
  feed      write snapshots/rings.json (30-day Rings feed)
  all       run every command above plus pool-feed, dividends and flush, looping every KEEPER_INTERVAL_SEC
            (default 300). Never runs coordinator, rotate-key or relayer.

privacy stage 2 (inert while grovePool/darkCurve/planter are absent from the deployment file):
  coordinator  Epoch Coordinator: open / void per-direction epochs (own pm2 app, own host; default --interval 15)
  rotate-key   daily Coordinator key rotation and destruction of retired keys (coordinator host, cron --once)
  pool-feed    pool sync bundle + epochs.json (default --interval 15; --out <dir> for local output)
  dividends    pull holder rewards owed to GrovePool (pullRewards)
  flush        flush CreatorStubs of privately planted coins into their handles
  relayer      stage-2 relayer HTTP service (own pm2 app, NOT on the coordinator host; RELAYER_PRIVATE_KEY,
               RELAYER_PORT, RELAYER_ALLOWED_ORIGINS, GAS_UNITS_FILE, RELAYER_HELD_KEY). Stage-1 kinds work without
               the stage-2 addresses; --dry-run simulates and never sends

Every command loops unless --once is given. Env: see .env.example`);
  process.exit(2);
}

function parseArgs(argv: string[]) {
  const [cmd, ...rest] = argv;
  if (!cmd || !(COMMANDS as readonly string[]).includes(cmd) || rest.includes("--help") || rest.includes("-h")) usage();
  let once = false;
  let interval: number | undefined;
  let out: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--once") once = true;
    else if (a === "--dry-run") process.env.DRY_RUN = "1";
    else if (a === "--interval") interval = Number(rest[++i]);
    else if (a.startsWith("--interval=")) interval = Number(a.slice("--interval=".length));
    else if (a === "--out" && cmd === "pool-feed") out = rest[++i];
    else if (a.startsWith("--out=") && cmd === "pool-feed") out = a.slice("--out=".length);
    else usage();
  }
  return { cmd: cmd as Command, once, interval, out };
}

let stopping = false;
let poolFeedOut: string | undefined;
const coordinatorRt = newCoordinatorRuntime();
const poolFeedRt = newPoolFeedRuntime();

/** Runs `cmd`; returns an optional "wake me at" unix timestamp (rewards schedules). */
async function runCommand(ctx: Ctx, cmd: Command): Promise<number | undefined> {
  // one failing command is logged and must not stop the others or the loop
  const guard = async <T>(name: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (e) {
      log.error(`${name} failed`, { err: e });
      return undefined;
    }
  };
  switch (cmd) {
    case "sweep":
      await guard("sweep", () => sweep(ctx));
      return;
    case "rotate":
      await guard("rotate", () => rotate(ctx));
      return;
    case "buyback":
      await guard("buyback", () => buyback(ctx));
      return;
    case "feed":
      await guard("feed", () => feed(ctx));
      return;
    case "rewards": {
      const r = await guard("rewards", () => rewards(ctx));
      return r?.nextWakeAt;
    }
    case "coordinator":
      await guard("coordinator", () => runCoordinator(ctx, coordinatorRt));
      return;
    case "rotate-key":
      await guard("rotate-key", () => rotateKey(ctx));
      return;
    case "pool-feed":
      await guard("pool-feed", () => poolFeed(ctx, poolFeedRt, { out: poolFeedOut }));
      return;
    case "dividends":
      await guard("dividends", () => dividends(ctx));
      return;
    case "flush":
      await guard("flush", () => flush(ctx));
      return;
    case "all": {
      await guard("sweep", () => sweep(ctx));
      await guard("buyback", () => buyback(ctx));
      await guard("rotate", () => rotate(ctx));
      const r = await guard("rewards", () => rewards(ctx));
      await guard("feed", () => feed(ctx));
      // privacy stage 2: each is a no-op without its addresses in the deployment file. Never coordinator,
      // rotate-key or relayer here: they run as separate pm2 apps (ecosystem.config.cjs), on other hosts.
      await guard("dividends", () => dividends(ctx));
      await guard("flush", () => flush(ctx));
      await guard("pool-feed", () => poolFeed(ctx, poolFeedRt, { out: poolFeedOut, forceBundle: true }));
      return r?.nextWakeAt;
    }
  }
}

async function main() {
  const { cmd, once, interval, out } = parseArgs(process.argv.slice(2));
  poolFeedOut = out;
  const cfg = loadConfig();
  // the epoch loops tick every 15 s unless --interval says otherwise (T_MIN is 60 s, epochs.json is a 15 s feed);
  // KEEPER_INTERVAL_SEC is the stage-1 loop's setting and does not apply to them
  if ((cmd === "coordinator" || cmd === "pool-feed") && interval === undefined) cfg.intervalSec = 15;
  if (interval !== undefined && Number.isFinite(interval) && interval > 0) cfg.intervalSec = interval;
  const dep = loadDeployments(cfg);
  // relayer vs Coordinator: never one process with both roles' secrets (refused on chain 56, a warning elsewhere)
  const role = roleOf(cmd);
  if (role) {
    const sep = roleSeparation(role, cfg.chainId, process.env);
    if (sep.refuse) throw new Error(roleSeparationMessage(role, sep.names));
    if (sep.names.length > 0) log.warn(roleSeparationMessage(role, sep.names));
  }
  // relayer: its own wallet. RELAYER_PRIVATE_KEY replaces KEEPER_PRIVATE_KEY in this process (the keeper key never
  // signs a relayed transaction); a --dry-run without it quotes with an ephemeral key and never sends.
  let relayerCfg: RelayerConfig | undefined;
  if (cmd === "relayer") {
    relayerCfg = loadRelayerConfig();
    if (!relayerCfg.privateKey && !cfg.dryRun) throw new Error("RELAYER_PRIVATE_KEY missing: set it, or --dry-run to simulate only");
    cfg.privateKey = relayerCfg.privateKey ?? dryRunKey();
  }
  const ctx = makeCtx(cfg, dep);

  const chainId = await ctx.pub.getChainId();
  if (chainId !== cfg.chainId) throw new Error(`RPC chain id ${chainId} != CHAIN_ID ${cfg.chainId}`);
  if (ctx.account) {
    const bal = await ctx.pub.getBalance({ address: ctx.account.address });
    log.info("keeper ready", { chainId, account: ctx.account.address, balanceBnb: formatEther(bal), dryRun: cfg.dryRun, cmd, once });
    if (bal < parseEther("0.01")) log.warn("keeper balance below 0.01 BNB");
  } else {
    if (!cfg.dryRun) throw new Error("KEEPER_PRIVATE_KEY missing: set it, or DRY_RUN=1 to simulate only");
    log.info("keeper ready (no key, DRY_RUN)", { chainId, cmd, once });
  }

  const onStop = () => {
    if (stopping) process.exit(130);
    stopping = true;
    log.info("stopping after the current iteration (send again to force)");
  };
  process.on("SIGINT", onStop);
  process.on("SIGTERM", onStop);

  if (cmd === "relayer" && relayerCfg) {
    // serves until the first SIGINT / SIGTERM (a second one forces exit through onStop)
    const stop = new Promise<void>((resolve) => {
      process.once("SIGINT", () => resolve());
      process.once("SIGTERM", () => resolve());
    });
    await runRelayer(ctx, relayerCfg, stop);
    return;
  }

  do {
    const started = Date.now();
    const wakeAt = await runCommand(ctx, cmd);
    if (once || stopping) break;
    let waitSec = cfg.intervalSec - Math.floor((Date.now() - started) / 1000);
    if (wakeAt !== undefined) {
      const untilWake = wakeAt - Math.floor(Date.now() / 1000) + 1;
      if (untilWake < waitSec) waitSec = untilWake;
    }
    if (waitSec < 1) waitSec = 1;
    log.debug("sleeping", { seconds: waitSec });
    await sleep(waitSec * 1000);
  } while (!stopping);
}

main()
  .then(() => shutdownProver()) // snarkjs keeps worker threads alive after a coordinator pass
  .catch((e) => {
    log.error("fatal", { err: e });
    process.exit(1);
  });
