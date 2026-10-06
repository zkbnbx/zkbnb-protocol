// Builds a Safe Transaction Builder batch that accepts ownership of all six zkBNB modules
// (and the FlapBuyback when deployments/<chainId>.json has a rootstockBuyback).
// After `deploy.sh` on mainnet the deployer has offered ownership to the Safe (Ownable2Step);
// the Safe must call acceptOwnership() on each module before it can administer anything.
//
// Usage:  node script/safe-accept-ownership.mjs [chainId=56] [safeAddress]
// Output: deployments/<chainId>.safe-accept-ownership.json
// Import it in app.safe.global -> Apps -> Transaction Builder -> "drag and drop a JSON file".
import { readFileSync, writeFileSync } from "node:fs";

const chainId = process.argv[2] ?? "56";
const safe = process.argv[3] ?? process.env.OWNER ?? "";
const dep = JSON.parse(readFileSync(`deployments/${chainId}.json`, "utf8"));
const modules = ["shieldedPool", "feeRouter", "roots", "holderRewards", "donationRotator", "launchpad"];
// rootstock on Flap: the FlapBuyback is Ownable2Step too
if (dep.rootstockBuyback && !/^0x0{40}$/i.test(dep.rootstockBuyback)) modules.push("rootstockBuyback");

const batch = {
  version: "1.0",
  chainId: String(chainId),
  createdAt: Date.now(),
  meta: {
    name: "zkBNB: accept ownership of all modules",
    description: "Ownable2Step handover from the deployer. One acceptOwnership() per module.",
    txBuilderVersion: "1.16.5",
    createdFromSafeAddress: safe,
  },
  transactions: modules.map((m) => {
    if (!dep[m]) throw new Error(`deployments/${chainId}.json has no ${m}`);
    return {
      to: dep[m],
      value: "0",
      data: "0x79ba5097", // acceptOwnership()
      contractMethod: { inputs: [], name: "acceptOwnership", payable: false },
      contractInputsValues: {},
    };
  }),
};

const out = `deployments/${chainId}.safe-accept-ownership.json`;
writeFileSync(out, JSON.stringify(batch, null, 2));
console.log(`wrote ${out} (${batch.transactions.length} transactions)`);
for (const m of modules) console.log(`  ${m.padEnd(16)} ${dep[m]}`);
