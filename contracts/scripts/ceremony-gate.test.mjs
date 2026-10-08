// node --test contracts/scripts/ceremony-gate.test.mjs
// The chain-56 ceremony gate must refuse today's dev keys, allow them off mainnet, and notice a verifier
// whose embedded key differs from the recorded verification key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate, vkeyFromJson, vkeyFromSolidity } from "./ceremony-gate.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("chain 56 refuses the dev-key verifiers", () => {
  const r = evaluate(56);
  assert.equal(r.allowed, false);
  assert.ok(r.problems.some((p) => p.includes("DEV KEYS")), "hashes file is the dev set");
  assert.equal(r.rows.filter((row) => row.devKeyMarker).length, 4, "four DEV KEY verifier headers");
});

test("embedded vkeys match the recorded verification keys and hashes (dev set is self-consistent)", () => {
  const r = evaluate(56);
  assert.equal(r.rows.length, 4);
  for (const row of r.rows) {
    assert.ok(row.embeddedMatchesJson, `${row.circuit}: embedded vkey`);
    assert.ok(row.vkeyFileMatchesEntry, `${row.circuit}: vkey file entry`);
    assert.ok(row.solMatchesEntry, `${row.circuit}: .sol entry`);
  }
});

test("other chains are allowed with dev keys", () => {
  assert.equal(evaluate(97).allowed, true);
  assert.equal(evaluate(31337).allowed, true);
});

test("a changed embedded constant is detected", () => {
  const src = readFileSync(join(ROOT, "contracts/src/verifiers/Groth16VerifierClaim.sol"), "utf8");
  const vk = JSON.parse(readFileSync(join(ROOT, "circuits/build/verification_key_claim.json"), "utf8"));
  const good = JSON.stringify(vkeyFromSolidity(src));
  assert.equal(good, JSON.stringify(vkeyFromJson(vk)));
  const tampered = src.replace(/(uint256 constant IC1x = )(\d)/, (_, a, d) => a + ((Number(d) + 1) % 10));
  assert.notEqual(tampered, src);
  assert.notEqual(JSON.stringify(vkeyFromSolidity(tampered)), good);
});
