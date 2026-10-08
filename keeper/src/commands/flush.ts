/**
 * Creator income of privately planted coins — privacy/PRIVACY-SPEC.md section 2.8 and 5.2; workplan section 4.1.
 *
 * Every CreatorStub (enumerated from Planter.PlantedPrivately, stubs.ts) is flushed with CreatorStub.flush() when
 * its BNB balance plus FeeRouter.pending(stub) reaches MIN_FLUSH_BNB; flush() pulls the pending push and credits
 * the stub's handle in GrovePool. Permissionless. Inert while the deployment file has no planter.
 */
import type { Address } from "viem";
import { creatorStubAbi, feeRouterPendingAbi } from "../abis.js";
import { errorText, sendTx, type Ctx } from "../chain.js";
import { loadPrivacyConfig } from "../config.js";
import { knownStubs } from "../stubs.js";
import { logger } from "../log.js";

const log = logger("flush");

export const shouldFlush = (balance: bigint, pending: bigint, min: bigint): boolean => balance + pending > 0n && balance + pending >= min;

export interface FlushResult {
  inert?: boolean;
  stubs: number;
  flushed: { stub: Address; hash?: string }[];
}

export async function flush(ctx: Ctx, env: NodeJS.ProcessEnv = process.env): Promise<FlushResult> {
  if (!ctx.dep.planter) {
    log.debug("no planter in the deployment file: flush is inert");
    return { inert: true, stubs: 0, flushed: [] };
  }
  const min = loadPrivacyConfig(env, ctx.cfg.snapshotDir).minFlushWei;
  const stubs = await knownStubs(ctx);
  const out: FlushResult = { stubs: stubs.length, flushed: [] };
  for (const s of stubs) {
    try {
      const [balance, pending] = await Promise.all([
        ctx.pub.getBalance({ address: s.stub }),
        ctx.pub.readContract({ address: ctx.dep.feeRouter, abi: feeRouterPendingAbi, functionName: "pending", args: [s.stub] }),
      ]);
      if (!shouldFlush(balance, pending, min)) continue;
      const r = await sendTx(ctx, { address: s.stub, abi: creatorStubAbi, functionName: "flush", args: [], label: `flush(${s.stub})` } as never);
      out.flushed.push({ stub: s.stub, hash: r.hash });
      log.info(r.dryRun ? "DRY_RUN flush simulated ok" : "creator stub flushed", { coin: s.coin, stub: s.stub, hash: r.hash });
    } catch (e) {
      log.warn("flush failed", { stub: s.stub, err: errorText(e).split("\n")[0] });
    }
  }
  log.info("flush done", { stubs: out.stubs, flushed: out.flushed.length });
  return out;
}
