import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { feeRouterPendingAbi, launchpadQuoteAbi, rootsQuoteAbi } from "../src/abis.js";
import { creatorStubAbi, darkCurveAbi, grovePoolAbi, planterAbi } from "../src/abis-v2.js";

/**
 * src/abis-v2.ts is generated from contracts/out by scripts/sync-abis.mjs; this fails when it is stale.
 * Skipped when the Foundry artifacts are not built. ABI_OUT points at another forge --out dir.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const out = process.env.ABI_OUT ? path.resolve(process.env.ABI_OUT) : path.resolve(here, "..", "..", "contracts", "out");
const has = (n: string) => fs.existsSync(path.join(out, `${n}.sol`, `${n}.json`));

type Item = { type: string; name?: string; inputs?: { type: string; indexed?: boolean }[]; outputs?: { type: string }[]; stateMutability?: string };
const load = (n: string) => (JSON.parse(fs.readFileSync(path.join(out, `${n}.sol`, `${n}.json`), "utf8")) as { abi: Item[] }).abi;
const sig = (x: Item) => `${x.type}:${x.name}(${(x.inputs ?? []).map((i) => i.type).join(",")})`;

describe("stage-2 ABIs", () => {
  const all = ["GrovePool", "DarkCurve", "Planter", "CreatorStub"].every(has);
  (all ? it : it.skip)("abis-v2.ts equals what sync-abis.mjs renders from contracts/out", async () => {
    const mod = (await import(path.resolve(here, "..", "scripts", "sync-abis.mjs"))) as { render: (dir: string) => string };
    const generated = fs.readFileSync(path.resolve(here, "..", "src", "abis-v2.ts"), "utf8").replace(/\r\n/g, "\n");
    expect(generated, "src/abis-v2.ts is stale: run `npm run sync:abis`").toBe(mod.render(out));
  });

  it("carries the entry points the commands use", () => {
    const names = (abi: readonly { type: string; name?: string }[]) => new Set(abi.map((x) => x.name));
    for (const n of ["openEpoch", "voidEpoch", "epochsOf", "cur", "keyByGen", "params", "setCoordinatorKey", "activeCoordinatorKey", "IntentSubmitted", "EpochOpened", "EpochVoided"]) {
      expect(names(darkCurveAbi).has(n), n).toBe(true);
    }
    for (const n of ["pullRewards", "checkpoint", "NewCommitment", "NewNullifier", "Credited", "HandleClaimed", "RewardsPulled", "Checkpoint"]) {
      expect(names(grovePoolAbi).has(n), n).toBe(true);
    }
    expect(names(planterAbi).has("PlantedPrivately")).toBe(true);
    expect(names(creatorStubAbi).has("flush")).toBe(true);
  });

  for (const [name, abi] of [
    ["Launchpad", launchpadQuoteAbi],
    ["Roots", rootsQuoteAbi],
    ["FeeRouter", feeRouterPendingAbi],
  ] as const) {
    (has(name) ? it : it.skip)(`hand-written ${name} fragment matches the compiled contract`, () => {
      const bySig = new Map(load(name).map((x) => [sig(x), x]));
      for (const item of abi as readonly Item[]) {
        const c = bySig.get(sig(item));
        expect(c, `missing in compiled ${name}: ${sig(item)}`).toBeDefined();
        expect((item.outputs ?? []).map((o) => o.type).join(",")).toBe((c!.outputs ?? []).map((o) => o.type).join(","));
      }
    });
  }
});
