// Constants check (privacy/PRIVACY-WORKPLAN.md section 6 step 5).
//
// Compares the Appendix A constants in four places:
//   1. circuits: scripts/zero-leaf-v2.mjs (keccak derivations, lib/constants.circom, GroveConstants.sol)
//   2. contracts/src/libraries/GroveConstants.sol (every `constant`, parsed)
//   3. web/src/lib/zk (+ web/src/lib/relay.ts): every `export const NAME = <number>` with a known name, and the
//      synced copy src/lib/zk/zkbnb-zk-v2.mjs must be byte-identical to circuits/lib/grove-zk-v2.mjs
//   4. keeper/src: the same scan
// A name that one file declares must equal the canonical value; each file listed in EXPECT must declare at least the
// names listed there (so a rename cannot make the check pass vacuously).
//
// Run from circuits/:  npm run check:constants      (exit 1 on any mismatch)
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { createHash } from "node:crypto";
import { constantsTable, EPOCH_PARAMS, SUM_BITS } from "../lib/grove-zk-v2.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const rel = (p) => relative(root, p).replace(/\\/g, "/");
let failed = 0;
let checked = 0;
const fail = (msg) => {
  failed++;
  console.error(`MISMATCH ${msg}`);
};

// ---- 1. the existing circuits-side check (derivations, circom, Solidity tag/table names)
const sol = join(root, "contracts", "src", "libraries", "GroveConstants.sol");
const zl = spawnSync(process.execPath, [join(here, "zero-leaf-v2.mjs"), sol], { cwd: join(here, ".."), encoding: "utf8" });
if (zl.status !== 0) fail(`zero-leaf-v2.mjs exited ${zl.status}:\n${zl.stderr}${zl.stdout}`);
else console.log(`[1] zero-leaf-v2.mjs: ${zl.stdout.trim().split("\n").pop()}`);

// ---- canonical values: the JS table, then every GroveConstants.sol constant
/** @type {Map<string, bigint>} */
const canon = new Map();
for (const [k, v] of Object.entries(constantsTable())) canon.set(k, BigInt(v));
canon.set("SUM_BITS", BigInt(SUM_BITS));

function evalSolExpr(raw) {
  const s = raw.replace(/\s+/g, " ").trim().replace(/_/g, "");
  let m;
  if ((m = s.match(/^(\d+(?:\.\d+)?) (ether|gwei)$/))) {
    const [int, frac = ""] = m[1].split(".");
    const dec = m[2] === "ether" ? 18 : 9;
    return BigInt(int + frac.padEnd(dec, "0").slice(0, dec)) * 1n;
  }
  if ((m = s.match(/^(\d+)e(\d+)$/))) return BigInt(m[1]) * 10n ** BigInt(m[2]);
  if (/^\d+$/.test(s)) return BigInt(s);
  return null; // strings and anything else
}
const solText = readFileSync(sol, "utf8").replace(/\/\/[^\n]*/g, "");
const solConst = new Map();
for (const m of solText.matchAll(/\b(?:uint\d*|int\d*)\s+internal\s+constant\s+(\w+)\s*=\s*([^;]+);/g)) {
  const v = evalSolExpr(m[2]);
  if (v !== null) solConst.set(m[1], v);
}
// Solidity name -> table name where they differ
const SOL_ALIAS = { BJJ_A: "BABYJUB_A", BJJ_D: "BABYJUB_D", BJJ_ORDER: "BABYJUB_SUBORDER", B8_X: "BASE8_X", B8_Y: "BASE8_Y" };
for (const [name, v] of solConst) {
  const key = SOL_ALIAS[name] ?? name;
  if (canon.has(key)) {
    checked++;
    if (canon.get(key) !== v) fail(`${key}: grove-zk-v2.mjs ${canon.get(key)} vs GroveConstants.sol ${name} = ${v}`);
  } else canon.set(key, v);
}
// derived relations the table does not state
if (canon.get("MAX_U_SUM") !== 1n << canon.get("SUM_BITS")) fail(`MAX_U_SUM ${canon.get("MAX_U_SUM")} != 2^SUM_BITS`);
if (canon.get("MAX_INTENTS") * (1n << canon.get("U_BITS")) > canon.get("MAX_U_SUM")) fail("MAX_INTENTS * 2^U_BITS exceeds MAX_U_SUM");
// the library's epoch defaults against the contract defaults
for (const [k, v] of Object.entries(EPOCH_PARAMS)) {
  checked++;
  if (!canon.has(k)) fail(`EPOCH_PARAMS.${k} has no GroveConstants.sol counterpart`);
  else if (canon.get(k) !== BigInt(v)) fail(`EPOCH_PARAMS.${k}: grove-zk-v2.mjs ${v} vs GroveConstants.sol ${canon.get(k)}`);
}
console.log(`[2] GroveConstants.sol: ${solConst.size} numeric constants parsed, ${canon.size} canonical names`);

// ---- 3 + 4. scan TypeScript sources
// Names that mean the same constant under another spelling (global), and short names only meaningful in one file.
const ALIAS = {
  SUBORDER: "BABYJUB_SUBORDER",
  BJJ_ORDER: "BABYJUB_SUBORDER",
  KEY_OVERLAP_SEC: "OVERLAP",
};
const FILE_ALIAS = {
  "keeper/src/babyjub.ts": { A: "BABYJUB_A", D: "BABYJUB_D" },
};
// Names that collide with unrelated constants in a given file (not Appendix A constants).
const IGNORE = {
  "web/src/lib/logs.ts": ["CHUNK"], // eth_getLogs block range, stage 1
};
const EXPECT = {
  "web/src/lib/relay.ts": ["FIELD_SIZE", "MAX_RELAYER_FEE", "INTENT_FEE", "KEY_OVERLAP_SEC", "ACTION_HANDOVER", "ACTION_PLANT"],
  "web/src/lib/zk/elgamal-client.ts": ["SUBORDER", "UNIT_BNB", "UNIT_TOKEN", "MIN_U_BNB", "MIN_U_TOKEN", "DIR_BUY", "DIR_SELL", "DIR_HARVEST"],
  "web/src/lib/zk/index.ts": ["FIELD_SIZE"],
  "web/src/lib/zk/wallet2.ts": ["DIR_BUY", "DIR_SELL", "DIR_HARVEST", "RPT_SCALE"],
  "keeper/src/babyjub.ts": ["FIELD_SIZE", "SUBORDER", "A", "D", "BASE8"],
  "keeper/src/grove2.ts": ["ZERO_LEAF", "INTENT_TAG", "HANDLE_TAG", "OWNER_TAG", "RESULT_TAG", "LEVELS", "CHUNK", "CHECKPOINT_PERIOD"],
  "keeper/src/checkpoint.ts": ["CHECKPOINT_PERIOD"],
  "keeper/src/elgamal.ts": ["SUM_BITS", "U_BITS", "MAX_INTENTS"],
  "keeper/src/commands/coordinator.ts": ["UNIT_BNB", "UNIT_TOKEN", "MAX_U_SUM"],
  "keeper/src/commands/dividends.ts": ["MIN_REWARD_SUPPLY"],
  "keeper/src/commands/rotateKey.ts": ["OVERLAP"],
  "keeper/src/relayer/protocol.ts": ["FIELD_SIZE", "MAX_RELAYER_FEE", "INTENT_FEE", "KEY_OVERLAP_SEC", "ACTION_HANDOVER", "ACTION_PLANT"],
};

/** Evaluates a numeric TS literal expression (bigint or number) or returns null. */
function evalTsExpr(raw) {
  let s = raw.replace(/\/\/[^\n]*/g, "").replace(/\s+as\s+\w+.*$/s, "").trim().replace(/_/g, "");
  if (!/^[0-9n\s*+\-<>()]+$/.test(s) || !/\d/.test(s)) return null;
  s = s.replace(/(\d+)n?/g, "$1n");
  try {
    // only digits, n, + - * << >> ** ( ) reach here
    return BigInt(Function(`"use strict"; return (${s});`)());
  } catch {
    return null;
  }
}

function* walk(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.ts$/.test(f) && !/\.d\.ts$/.test(f) && !/\.generated\.ts$/.test(f)) yield p;
  }
}

function scan(files, label) {
  let n = 0;
  for (const file of files) {
    const r = rel(file);
    const text = readFileSync(file, "utf8");
    const seen = new Set();
    const aliases = { ...ALIAS, ...(FILE_ALIAS[r] ?? {}) };
    for (const m of text.matchAll(/^export const (\w+)(?:\s*:\s*[\w<>\[\]]+)?\s*=\s*([^;\n]+)/gm)) {
      const name = m[1];
      if ((IGNORE[r] ?? []).includes(name)) continue;
      const key = aliases[name] ?? name;
      if (!canon.has(key)) continue;
      if (name === "BASE8") continue; // handled below
      const v = evalTsExpr(m[2]);
      if (v === null) {
        fail(`${r}: ${name} is not a numeric literal (${m[2].trim()})`);
        continue;
      }
      seen.add(name);
      n++;
      if (v !== canon.get(key)) fail(`${r}: ${name} = ${v}, canonical ${key} = ${canon.get(key)}`);
    }
    const b8 = text.match(/export const BASE8\b[^=]*=\s*Object\.freeze\(\[\s*([0-9_]+)n,\s*([0-9_]+)n/);
    if (b8) {
      seen.add("BASE8");
      n += 2;
      if (BigInt(b8[1].replace(/_/g, "")) !== canon.get("BASE8_X") || BigInt(b8[2].replace(/_/g, "")) !== canon.get("BASE8_Y"))
        fail(`${r}: BASE8 differs from (${canon.get("BASE8_X")}, ${canon.get("BASE8_Y")})`);
    }
    const ord = text.match(/^export const ORDER\s*=\s*([0-9_]+)n/m);
    if (ord && r === "keeper/src/babyjub.ts") {
      n++;
      if (BigInt(ord[1].replace(/_/g, "")) !== 8n * canon.get("BABYJUB_SUBORDER")) fail(`${r}: ORDER != 8 * SUBORDER`);
    }
    for (const want of EXPECT[r] ?? []) if (!seen.has(want)) fail(`${r}: expected an exported numeric ${want}, not found`);
  }
  for (const r of Object.keys(EXPECT).filter((r) => r.startsWith(label))) if (!existsSync(join(root, r))) fail(`${r}: file missing`);
  checked += n;
  return n;
}

const webLib = join(root, "web", "src", "lib");
const webFiles = [...walk(join(webLib, "zk")), join(webLib, "relay.ts")];
console.log(`[3] web: ${scan(webFiles, "web/")} constants checked in ${webFiles.length} files`);
const v2src = readFileSync(join(root, "circuits", "lib", "grove-zk-v2.mjs"));
const v2web = join(webLib, "zk", "zkbnb-zk-v2.mjs");
const sha = (b) => createHash("sha256").update(b).digest("hex");
if (!existsSync(v2web)) fail("web/src/lib/zk/zkbnb-zk-v2.mjs missing (run npm run sync:zk in web)");
else if (sha(readFileSync(v2web)) !== sha(v2src)) fail("web/src/lib/zk/zkbnb-zk-v2.mjs differs from circuits/lib/grove-zk-v2.mjs (run npm run sync:zk in web)");
else console.log(`    web/src/lib/zk/zkbnb-zk-v2.mjs byte-identical to circuits/lib/grove-zk-v2.mjs (${sha(v2src).slice(0, 12)}…)`);

const keeperFiles = [...walk(join(root, "keeper", "src"))];
console.log(`[4] keeper: ${scan(keeperFiles, "keeper/")} constants checked in ${keeperFiles.length} files`);

if (failed) {
  console.error(`${failed} mismatch(es), ${checked} comparisons`);
  process.exit(1);
}
console.log(`constants agree: ${checked} comparisons across circuits, contracts, web and keeper`);
