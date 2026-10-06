import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { donationRotatorAbi, feeRouterAbi, flapBuybackAbi, groveCoinAbi, holderRewardsAbi, launchpadAbi, rootsAbi } from "../src/abis.js";

/**
 * Cross-checks the hand-written ABIs against the Foundry artifacts in contracts/out.
 * Skipped when the artifacts are not built (CI without forge). ABI_OUT points at another forge `--out` dir.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const out = process.env.ABI_OUT ? path.resolve(process.env.ABI_OUT) : path.resolve(here, "..", "..", "contracts", "out");

type AbiItem = { type: string; name?: string; inputs?: { type: string; name?: string; indexed?: boolean; components?: unknown[] }[]; outputs?: { type: string; components?: unknown[] }[]; stateMutability?: string };

function load(name: string): AbiItem[] | undefined {
  const f = path.join(out, `${name}.sol`, `${name}.json`);
  if (!fs.existsSync(f)) return undefined;
  return (JSON.parse(fs.readFileSync(f, "utf8")) as { abi: AbiItem[] }).abi;
}

const sig = (x: AbiItem) => `${x.type}:${x.name}(${(x.inputs ?? []).map((i) => i.type).join(",")})`;
const outs = (x: AbiItem) => (x.outputs ?? []).map((o) => o.type).join(",");

const pairs: [string, readonly unknown[]][] = [
  ["GroveCoin", groveCoinAbi],
  ["Launchpad", launchpadAbi],
  ["FeeRouter", feeRouterAbi],
  ["Roots", rootsAbi],
  ["HolderRewards", holderRewardsAbi],
  ["DonationRotator", donationRotatorAbi],
  ["FlapBuyback", flapBuybackAbi],
];

describe("keeper ABIs match compiled contracts", () => {
  for (const [name, abi] of pairs) {
    const compiled = load(name);
    const t = compiled ? it : it.skip;
    t(`${name}`, () => {
      const bySig = new Map(compiled!.map((x) => [sig(x), x]));
      for (const item of abi as AbiItem[]) {
        const s = sig(item);
        const c = bySig.get(s);
        expect(c, `missing in compiled ${name}: ${s}`).toBeDefined();
        if (item.type === "function") {
          expect(outs(item), `outputs differ for ${s}`).toBe(outs(c!));
          expect(item.stateMutability, `mutability differs for ${s}`).toBe(c!.stateMutability);
        }
        if (item.type === "event") {
          const idx = (item.inputs ?? []).map((i) => !!i.indexed).join(",");
          const cidx = (c!.inputs ?? []).map((i) => !!i.indexed).join(",");
          expect(idx, `indexed flags differ for ${s}`).toBe(cidx);
        }
      }
    });
  }
});
