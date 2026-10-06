#!/usr/bin/env bash
# Compare the runtime bytecode of the deployed contracts with a local `forge build`.
# Immutable slots are masked; everything else, including the metadata hash, must match.
# Usage (from contracts/): bash script/check-deployed.sh [rpc-url] [chain-id]
set -euo pipefail
RPC=${1:-https://bsc-dataseed.bnbchain.org}
CHAIN=${2:-56}
DEP=deployments/$CHAIN.json
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
for pair in Launchpad:launchpad FeeRouter:feeRouter Roots:roots HolderRewards:holderRewards \
            DonationRotator:donationRotator ShieldedPool:shieldedPool FlapBuyback:rootstockBuyback \
            Groth16Verifier:verifier; do
  name=${pair%%:*}; key=${pair##*:}
  addr=$(node -e "const d=require('./$DEP'); process.stdout.write(d['$key']||'')")
  [ -n "$addr" ] || { echo "skip  $name (no $key in $DEP)"; continue; }
  cast code "$addr" --rpc-url "$RPC" > "$tmp/$name.hex"
  node -e '
    const fs = require("fs");
    const [name, addr, file] = process.argv.slice(1);
    const j = JSON.parse(fs.readFileSync(`out/${name}.sol/${name}.json`, "utf8"));
    const a = fs.readFileSync(file, "utf8").trim().slice(2).split("");
    const b = j.deployedBytecode.object.slice(2).split("");
    for (const refs of Object.values(j.deployedBytecode.immutableReferences || {}))
      for (const r of refs) for (let i = r.start * 2; i < (r.start + r.length) * 2; i++) { a[i] = "0"; b[i] = "0"; }
    const ok = a.length === b.length && a.join("") === b.join("");
    console.log(`${ok ? "ok  " : "FAIL"}  ${name.padEnd(16)} ${addr}`);
    if (!ok) process.exitCode = 1;
  ' "$name" "$addr" "$tmp/$name.hex"
done
