// Prints every Appendix A constant (privacy/PRIVACY-SPEC.md) and checks that lib/constants.circom and
// lib/grove-zk-v2.mjs agree with the keccak derivations. At integration the same table is diffed against
// contracts/src/libraries/GroveConstants.sol (pass its path as argv[2] to check it here).
// Run from circuits/:  node scripts/zero-leaf-v2.mjs [../contracts/src/libraries/GroveConstants.sol]
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { keccak256, toUtf8Bytes } from "ethers";
import { constantsTable, FIELD_SIZE } from "../lib/grove-zk-v2.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const k = (s) => (BigInt(keccak256(toUtf8Bytes(s))) % FIELD_SIZE).toString();
const table = constantsTable();
let failed = 0;
const check = (name, want, got, where) => {
  if (want !== got) {
    failed++;
    console.error(`MISMATCH ${name} in ${where}: expected ${want}, found ${got}`);
  }
};

// derivations
check("ZERO_LEAF", k("grove-v2"), table.ZERO_LEAF, "grove-zk-v2.mjs");
check("INTENT_TAG", k("grove-v2/intent"), table.INTENT_TAG, "grove-zk-v2.mjs");
check("HANDLE_TAG", k("grove-v2/handle"), table.HANDLE_TAG, "grove-zk-v2.mjs");
check("OWNER_TAG", k("grove-v2/owner"), table.OWNER_TAG, "grove-zk-v2.mjs");
check("RESULT_TAG", k("grove-v2/result"), table.RESULT_TAG, "grove-zk-v2.mjs");

// constants.circom
const circ = readFileSync(join(here, "..", "lib", "constants.circom"), "utf8");
const circName = (n) => n.replace(/^BABYJUB_/, "");
for (const [name, val] of Object.entries(table)) {
  const m = circ.match(new RegExp(`function ${circName(name)}\\(\\)\\s*\\{\\s*return\\s+(\\d+);`));
  if (m) check(name, val, m[1], "lib/constants.circom");
}

// GroveConstants.sol (optional; integration)
const solPath = process.argv[2] ?? join(here, "..", "..", "contracts", "src", "libraries", "GroveConstants.sol");
if (existsSync(solPath)) {
  const sol = readFileSync(solPath, "utf8").replace(/_/g, "");
  for (const [name, val] of Object.entries(table)) {
    const m = sol.match(new RegExp(`\\b${name}\\b[^;=]*=\\s*(\\d+)`));
    if (m) check(name, val, m[1], solPath);
  }
  console.log(`checked ${solPath}`);
} else {
  console.log(`(GroveConstants.sol not found at ${solPath}; skipped)`);
}

for (const [name, val] of Object.entries(table)) console.log(`${name.padEnd(18)} = ${val}`);
if (failed) {
  console.error(`${failed} mismatch(es)`);
  process.exit(1);
}
console.log("all constants agree");
