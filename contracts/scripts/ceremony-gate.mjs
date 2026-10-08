#!/usr/bin/env node
// Chain-56 ceremony gate for the privacy stage-2 verifiers (privacy/PRIVACY-SPEC.md section 3.5,
// circuits/CEREMONY-v2.md). The verifiers are immutable in GrovePool / DarkCurve, so dev keys on mainnet
// would mean a new pool and a v2 -> v3 migration. `deploy.sh 56 --privacy` runs this first and stops
// unless it exits 0.
//
//   node contracts/scripts/ceremony-gate.mjs <chainId>
//
// For each circuit (transfer, intent, claim, epochOpen) it recomputes the verification key embedded in
// contracts/src/verifiers/Groth16Verifier<Name>.sol (alpha, beta, gamma, delta, IC constants), hashes it
// (sha256 of a canonical JSON), and compares it with the same hash of circuits/build/verification_key_<name>.json,
// whose file sha256 must be the entry in circuits/build/CEREMONY-HASHES-v2.txt; the .sol file's own sha256 must
// match its entry too. Then it looks for dev markers: the hashes file header "DEV KEYS", a "DEV KEY" header
// in any verifier source, and the absence of the drand beacon round the ceremony records.
//
// Exit codes: 0 allowed (chain 56: ceremony keys, everything matches; other chains: always, with warnings),
//             1 refused (chain 56 only), 2 usage / read error.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CIRCUITS_DIR = join(ROOT, "circuits");
const HASHES = join(CIRCUITS_DIR, "build", "CEREMONY-HASHES-v2.txt");
const CIRCUITS = [
  ["transfer", "Transfer"],
  ["intent", "Intent"],
  ["claim", "Claim"],
  ["epochOpen", "Open"],
];

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** Canonical vkey: decimal strings in the Solidity constant layout of the snarkjs template. */
function canonical({ alpha, beta, gamma, delta, ic }) {
  return JSON.stringify({ alpha, beta, gamma, delta, ic });
}

export function vkeyFromSolidity(src) {
  const c = {};
  for (const m of src.matchAll(/uint256\s+constant\s+(\w+)\s*=\s*(\d+)\s*;/g)) c[m[1]] = m[2];
  const need = (k) => {
    if (c[k] === undefined) throw new Error(`verifier source has no constant ${k}`);
    return c[k];
  };
  const g2 = (p) => [need(`${p}x1`), need(`${p}x2`), need(`${p}y1`), need(`${p}y2`)];
  const ic = [];
  for (let i = 0; c[`IC${i}x`] !== undefined; i++) ic.push([need(`IC${i}x`), need(`IC${i}y`)]);
  if (ic.length === 0) throw new Error("verifier source has no IC constants");
  return { alpha: [need("alphax"), need("alphay")], beta: g2("beta"), gamma: g2("gamma"), delta: g2("delta"), ic };
}

export function vkeyFromJson(vk) {
  // snarkjs exportSolidityVerifier: <p>x1 = vk_<p>_2[0][1], <p>x2 = [0][0], <p>y1 = [1][1], <p>y2 = [1][0]
  const g2 = (p) => [p[0][1], p[0][0], p[1][1], p[1][0]].map(String);
  return {
    alpha: [String(vk.vk_alpha_1[0]), String(vk.vk_alpha_1[1])],
    beta: g2(vk.vk_beta_2),
    gamma: g2(vk.vk_gamma_2),
    delta: g2(vk.vk_delta_2),
    ic: vk.IC.map((p) => [String(p[0]), String(p[1])]),
  };
}

/** CEREMONY-HASHES-v2.txt: "<sha256> *<path relative to circuits/>" lines plus free-form comment lines. */
export function parseHashes(text) {
  const entries = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/i.exec(line.trim());
    if (m) entries.set(resolve(CIRCUITS_DIR, m[2]), m[1].toLowerCase());
  }
  return entries;
}

export function evaluate(chainId) {
  const problems = [];
  const rows = [];
  if (!existsSync(HASHES)) throw new Error(`missing ${HASHES}`);
  const hashesText = readFileSync(HASHES, "utf8");
  const entries = parseHashes(hashesText);
  const devHeader = /DEV KEYS/.test(hashesText);
  const hasDrand = /drand/i.test(hashesText);

  for (const [name, sol] of CIRCUITS) {
    const solPath = join(ROOT, "contracts", "src", "verifiers", `Groth16Verifier${sol}.sol`);
    const vkPath = join(CIRCUITS_DIR, "build", `verification_key_${name}.json`);
    const solBuf = readFileSync(solPath);
    const vkBuf = readFileSync(vkPath);
    const embedded = sha256(canonical(vkeyFromSolidity(solBuf.toString("utf8"))));
    const fromJson = sha256(canonical(vkeyFromJson(JSON.parse(vkBuf.toString("utf8")))));
    const vkFile = sha256(vkBuf);
    const solFile = sha256(solBuf);
    const vkEntry = entries.get(resolve(vkPath)) ?? null;
    const solEntry = entries.get(resolve(solPath)) ?? null;
    const devSol = /DEV KEY/.test(solBuf.toString("utf8"));
    const row = {
      circuit: name,
      embeddedVkey: embedded,
      vkeyJson: fromJson,
      embeddedMatchesJson: embedded === fromJson,
      vkeyFileSha256: vkFile,
      vkeyFileEntry: vkEntry,
      vkeyFileMatchesEntry: vkEntry === vkFile,
      solSha256: solFile,
      solEntry,
      solMatchesEntry: solEntry === solFile,
      devKeyMarker: devSol,
    };
    rows.push(row);
    if (!row.embeddedMatchesJson) problems.push(`${name}: the verifier's embedded vkey differs from verification_key_${name}.json`);
    if (!row.vkeyFileMatchesEntry) problems.push(`${name}: verification_key_${name}.json sha256 is not the CEREMONY-HASHES-v2.txt entry`);
    if (!row.solMatchesEntry) problems.push(`${name}: Groth16Verifier${sol}.sol sha256 is not the CEREMONY-HASHES-v2.txt entry`);
    if (devSol) problems.push(`${name}: Groth16Verifier${sol}.sol carries the "DEV KEY" header (exported by setup-v2.sh, not the ceremony)`);
  }
  if (devHeader) problems.push('CEREMONY-HASHES-v2.txt is the "DEV KEYS" set from setup-v2.sh (no ceremony has run)');
  if (!hasDrand) problems.push("CEREMONY-HASHES-v2.txt records no drand beacon round (CEREMONY-v2.md, final beacon)");

  const mainnet = Number(chainId) === 56;
  return { chainId: Number(chainId), mainnet, rows, problems, allowed: !mainnet || problems.length === 0 };
}

function main() {
  const chainId = process.argv[2];
  if (!chainId || !/^\d+$/.test(chainId)) {
    console.error("usage: node contracts/scripts/ceremony-gate.mjs <chainId>");
    process.exit(2);
  }
  let r;
  try {
    r = evaluate(chainId);
  } catch (e) {
    console.error(`ceremony gate: ${e.message ?? e}`);
    process.exit(2);
  }
  console.log(`privacy ceremony gate, chain ${r.chainId}`);
  console.log(`hashes file: ${HASHES}`);
  for (const row of r.rows) {
    const ok = (b) => (b ? "match" : "MISMATCH");
    console.log(`  ${row.circuit}`);
    console.log(`    embedded vkey sha256   ${row.embeddedVkey}`);
    console.log(`    vkey json   sha256     ${row.vkeyJson}  (${ok(row.embeddedMatchesJson)})`);
    console.log(`    vkey file   sha256     ${row.vkeyFileSha256}  entry ${row.vkeyFileEntry ?? "none"}  (${ok(row.vkeyFileMatchesEntry)})`);
    console.log(`    verifier .sol sha256   ${row.solSha256}  entry ${row.solEntry ?? "none"}  (${ok(row.solMatchesEntry)})`);
    console.log(`    DEV KEY header         ${row.devKeyMarker ? "yes" : "no"}`);
  }
  if (r.problems.length) {
    console.log(r.mainnet ? "problems:" : "warnings (allowed off chain 56):");
    for (const p of r.problems) console.log(`  - ${p}`);
  }
  if (!r.allowed) {
    console.log("REFUSED: chain 56 needs ceremony verifiers whose embedded vkeys hash to CEREMONY-HASHES-v2.txt (circuits/CEREMONY-v2.md).");
    process.exit(1);
  }
  console.log(r.mainnet ? "ALLOWED: ceremony verifiers match CEREMONY-HASHES-v2.txt." : `ALLOWED on chain ${r.chainId} (dev keys permitted off mainnet).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
