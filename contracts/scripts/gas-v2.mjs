#!/usr/bin/env node
// Writes contracts/gas-v2.json (privacy/PRIVACY-SPEC.md Appendix C) from forge test gas logs. Nothing in
// that file is typed by hand: the relayer's `gasUnits` and DeployPrivacy's `params.claimGas` read it.
//
//   cd contracts && node scripts/gas-v2.mjs                 # runs the gas-logging tests (one forge command)
//   node scripts/gas-v2.mjs --log forge-gas.log             # parse a saved `forge test -vv` output instead
//   node scripts/gas-v2.mjs --out /tmp/gas-v2.json          # write elsewhere (default: contracts/gas-v2.json)
//   node scripts/gas-v2.mjs --print                         # print, do not write
//
// Per kind:  units = roundUp1000( (exec + nVerify * verifyDelta + 21000 + calldata) * MARGIN )
//   exec        execution gas of the call, logged by GrovePool.t.sol / DarkCurve.t.sol ("gas ...") against the
//               real Launchpad / v1 ShieldedPool with MockVerifierN stand-ins
//   verifyDelta real (dev-key) Groth16 verifier minus the mock, on the fixture proofs ("gasv2 verifyDelta.*",
//               PrivacyFixtures.t.sol test_gas_realVerifierAndCalldata); pairing cost does not depend on the key
//   21000       intrinsic transaction gas
//   calldata    4/16 gas per zero/non-zero byte of the ABI-encoded fixture call ("gasv2 calldata.*")
//   MARGIN      1.2: storage warmed earlier in the same test, venue variance, unmeasured transfer variants
//               (hand-over through Planter, handle claims)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CONTRACTS = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MARGIN = 1.2;
const INTRINSIC = 21000;
const CLAIM_GAS_LO = 300_000; // GroveConstants.CLAIM_GAS_LO
const CLAIM_GAS_HI = 3_000_000; // GroveConstants.CLAIM_GAS_HI

// test functions whose logs are parsed (keep in step with the console2.log labels below)
const TESTS = [
  "test_invalidProof_unknownRoot_doubleSpend", // gas transact private transfer
  "test_unshield_gasLog", // gas transact unshield
  "test_privatePlant_endToEnd", // gas transact private plant
  "test_migrateFromV1_creditsHandle", // gas migrateFromV1
  "test_submitIntent_insertsStampedChunk_sums_fees", // gas submitIntent
  "test_openEpoch_allThreeDirections_order_fees_resultLeaves", // gas openEpoch (3 directions)
  "test_voidEpoch_afterGrace_insertsRefundLeaf", // gas voidEpoch
  "test_claim_marksNullifier_insertsChunk_reimburses", // gas claim
  "test_gas_realVerifierAndCalldata", // gasv2 verifyDelta.* / calldata.*
];

// kind -> [exec labels (max taken)], verifier, number of proofs verified, calldata key
const KINDS = {
  transfer: { exec: ["gas transact private transfer", "gas transact unshield"], verify: "transfer", n: 1 },
  plant: { exec: ["gas transact private plant"], verify: "transfer", n: 1 },
  intent: { exec: ["gas submitIntent"], verify: "intent", n: 1 },
  claim: { exec: ["gas claim"], verify: "claim", n: 1 },
  v1migrate: { exec: ["gas migrateFromV1"], verify: "v1", n: 1 },
  openEpoch3: { exec: ["gas openEpoch (3 directions)"], verify: "open", n: 3 },
  voidEpoch: { exec: ["gas voidEpoch"], verify: null, n: 0 },
};

function arg(name) {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
}

function forgeBin() {
  if (process.env.FORGE) return process.env.FORGE;
  for (const f of ["forge.exe", "forge"]) {
    const p = join(homedir(), ".foundry", "bin", f);
    if (existsSync(p)) return p;
  }
  return "forge";
}

function runForge() {
  const args = [
    "test",
    "--match-path",
    "test/{GrovePool,DarkCurve,PrivacyFixtures}.t.sol",
    "--match-test",
    TESTS.join("|"),
    "-vv",
  ];
  console.error(`$ forge ${args.join(" ")}`);
  try {
    return execFileSync(forgeBin(), args, { cwd: CONTRACTS, encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "inherit"] });
  } catch (e) {
    process.stderr.write(e.stdout ?? "");
    throw new Error("forge test failed: gas-v2.json not written");
  }
}

export function parseLog(text) {
  const out = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const m = /^(gasv2 \S+|gas .+?) (\d+)$/.exec(line);
    if (!m) continue;
    const key = m[1].trim();
    const v = Number(m[2]);
    // a label logged by several tests (or runs): keep the largest
    if (!out.has(key) || out.get(key) < v) out.set(key, v);
  }
  return out;
}

export function compute(log) {
  const need = (k) => {
    if (!log.has(k)) throw new Error(`missing "${k}" in the forge output (did every test in TESTS pass and log?)`);
    return log.get(k);
  };
  const result = {};
  const detail = {};
  for (const [kind, spec] of Object.entries(KINDS)) {
    const exec = Math.max(...spec.exec.map(need));
    const delta = spec.verify ? need(`gasv2 verifyDelta.${spec.verify}`) : 0;
    const calldata = need(`gasv2 calldata.${kind}`);
    const base = exec + spec.n * delta + INTRINSIC + calldata;
    result[kind] = Math.ceil((base * MARGIN) / 1000) * 1000;
    detail[kind] = { exec, verifyDelta: delta, proofs: spec.n, intrinsic: INTRINSIC, calldata, base };
  }
  return { result, detail };
}

function commitId() {
  try {
    const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: CONTRACTS, encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain", "--", "src", "test"], { cwd: CONTRACTS, encoding: "utf8" }).trim();
    return dirty ? `${head}+uncommitted` : head;
  } catch {
    return "unknown";
  }
}

function main() {
  const logFile = arg("--log");
  const text = logFile ? readFileSync(logFile, "utf8") : runForge();
  const { result, detail } = compute(parseLog(text));

  for (const k of Object.keys(KINDS)) {
    if (!Number.isInteger(result[k]) || result[k] <= 0) throw new Error(`kind ${k}: no gas figure`);
  }
  if (result.claim < CLAIM_GAS_LO || result.claim > CLAIM_GAS_HI) {
    throw new Error(`claim gas ${result.claim} outside [${CLAIM_GAS_LO}..${CLAIM_GAS_HI}] (DarkCurve.setParams would revert)`);
  }

  const json = {
    measuredAt: new Date().toISOString(),
    commit: commitId(),
    ...result,
    margin: MARGIN,
    method:
      "units = roundUp1000((exec + proofs*verifyDelta + 21000 + calldata) * margin); exec from GrovePool.t.sol/DarkCurve.t.sol " +
      "(mock verifiers), verifyDelta and calldata from PrivacyFixtures.t.sol test_gas_realVerifierAndCalldata (fixture proofs). " +
      "Written by contracts/scripts/gas-v2.mjs; do not edit by hand.",
    detail,
  };
  const text2 = JSON.stringify(json, null, 2) + "\n";
  if (process.argv.includes("--print")) {
    process.stdout.write(text2);
    return;
  }
  const out = arg("--out") ?? join(CONTRACTS, "gas-v2.json");
  writeFileSync(out, text2);
  console.log(`wrote ${out}`);
  for (const k of Object.keys(KINDS)) console.log(`  ${k.padEnd(11)} ${result[k]}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(String(e.message ?? e));
    process.exit(1);
  }
}
