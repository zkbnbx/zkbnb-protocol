#!/usr/bin/env node
import { formatEther } from "viem";
import { loadConfig, loadDeployments } from "./config.js";
import { makeCtx, type Ctx } from "./chain.js";
import { logger } from "./log.js";
import { sweep } from "./commands/sweep.js";
import { rewards } from "./commands/rewards.js";
import { rotate } from "./commands/rotate.js";
import { buyback } from "./commands/buyback.js";
import { feed } from "./commands/feed.js";

const log = logger("keeper");

const COMMANDS = ["sweep", "rewards", "rotate", "buyback", "feed", "all"] as const;
type Command = (typeof COMMANDS)[number];

function usage(): never {
  console.log(`grove-keeper <command> [--once] [--dry-run] [--interval <sec>]

commands:
  sweep     swap accrued pair-tax of graduated coins into BNB for FeeRouter
  rewards   schedule + take holder-reward snapshots, post Merkle roots
  rotate    settle donation rings whose epoch elapsed
  buyback   buy and burn $ZKBNB with the rootstock pot
  feed      write snapshots/rings.json (30-day Rings feed)
  all       run every command, looping every KEEPER_INTERVAL_SEC (default 300)

Every command loops unless --once is given. Env: see .env.example`);
  process.exit(2);
}

function parseArgs(argv: string[]) {
  const [cmd, ...rest] = argv;
  if (!cmd || !(COMMANDS as readonly string[]).includes(cmd) || rest.includes("--help") || rest.includes("-h")) usage();
  let once = false;
  let interval: number | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--once") once = true;
    else if (a === "--dry-run") process.env.DRY_RUN = "1";
    else if (a === "--interval") interval = Number(rest[++i]);
    else if (a.startsWith("--interval=")) interval = Number(a.slice("--interval=".length));
    else usage();
  }
  return { cmd: cmd as Command, once, interval };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let stopping = false;

async function runCommand(ctx: Ctx, cmd: Command): Promise<number | undefined> {
  // returns an optional "wake me at" unix timestamp (rewards schedules)
  const guard = async (name: string, fn: () => Promise<unknown>) => {
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
      const r = (await guard("rewards", () => rewards(ctx))) as Awaited<ReturnType<typeof rewards>> | undefined;
      return r?.nextWakeAt;
    }
    case "all": {
      await guard("sweep", () => sweep(ctx));
      await guard("buyback", () => buyback(ctx));
      await guard("rotate", () => rotate(ctx));
      const r = (await guard("rewards", () => rewards(ctx))) as Awaited<ReturnType<typeof rewards>> | undefined;
      await guard("feed", () => feed(ctx));
      return r?.nextWakeAt;
    }
  }
}

async function main() {
  const { cmd, once, interval } = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  if (interval !== undefined && Number.isFinite(interval) && interval > 0) cfg.intervalSec = interval;
  const dep = loadDeployments(cfg);
  const ctx = makeCtx(cfg, dep);

  const chainId = await ctx.pub.getChainId();
  if (chainId !== cfg.chainId) throw new Error(`RPC chain id ${chainId} != CHAIN_ID ${cfg.chainId}`);
  if (ctx.account) {
    const bal = await ctx.pub.getBalance({ address: ctx.account.address });
    log.info("keeper ready", { chainId, account: ctx.account.address, balanceBnb: formatEther(bal), dryRun: cfg.dryRun, cmd, once });
    if (bal < 10n ** 16n) log.warn("keeper balance below 0.01 BNB");
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

main().catch((e) => {
  log.error("fatal", { err: e });
  process.exit(1);
});
