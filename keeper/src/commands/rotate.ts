import { formatEther } from "viem";
import { donationRotatorAbi } from "../abis.js";
import { sendTx, type Ctx } from "../chain.js";
import { logger } from "../log.js";

const log = logger("rotate");

/** settle(ringId) for every ring whose epoch has elapsed and whose pot is non-empty. */
export async function rotate(ctx: Ctx): Promise<{ settled: number; rings: number }> {
  const { pub, dep } = ctx;
  const count = await pub.readContract({ address: dep.donationRotator, abi: donationRotatorAbi, functionName: "ringCount" });
  // chain time, not wall-clock: epochs are judged by block.timestamp on-chain
  const now = (await pub.getBlock()).timestamp;
  let settled = 0;
  for (let ringId = 0n; ringId < count; ringId++) {
    try {
      const [pot, nextAt] = await Promise.all([
        pub.readContract({ address: dep.donationRotator, abi: donationRotatorAbi, functionName: "pot", args: [ringId] }),
        pub.readContract({ address: dep.donationRotator, abi: donationRotatorAbi, functionName: "nextSettleAt", args: [ringId] }),
      ]);
      if (pot === 0n) continue;
      if (now < nextAt) {
        log.debug("ring not due", { ringId, potBnb: formatEther(pot), dueIn: nextAt - now });
        continue;
      }
      log.info("settling ring", { ringId, potBnb: formatEther(pot) });
      const res = await sendTx(ctx, { address: dep.donationRotator, abi: donationRotatorAbi, functionName: "settle", args: [ringId], label: `settle(${ringId})` });
      if (res.dryRun || res.status === "success") settled++;
    } catch (e) {
      // e.g. "no active cause" — the pot simply waits
      log.error("settle failed for ring", { ringId, err: e });
    }
  }
  log.info("rotate done", { rings: Number(count), settled });
  return { settled, rings: Number(count) };
}
