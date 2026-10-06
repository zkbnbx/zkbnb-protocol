// Regenerates contracts/test/fixtures/pool.json from the deterministic scenario.
// Run from circuits/: node scripts/fixtures.mjs   (needs build/transaction.{wasm,zkey})
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { init, poseidon, MerkleTree, ZERO_VALUE, FIELD_SIZE } from "../lib/grove-zk.mjs";
import { runScenario, RECIPIENT, RELAYER } from "./scenario.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const build = join(here, "..", "build");
const outDir = join(here, "..", "..", "contracts", "test", "fixtures");
const outFile = join(outDir, "pool.json");

const s = (x) => BigInt(x).toString();

function proofJson(p) {
  return {
    a: p.a.map(s),
    b: [p.b[0].map(s), p.b[1].map(s)],
    c: p.c.map(s),
    root: s(p.root),
    publicAmount: s(p.publicAmount),
    extDataHash: p.extDataHash,
    inputNullifiers: p.inputNullifiers.map(s),
    outputCommitments: p.outputCommitments.map(s),
  };
}

function extDataJson(e) {
  return {
    recipient: e.recipient,
    extAmount: s(e.extAmount),
    relayer: e.relayer,
    fee: s(e.fee),
    encryptedOutput1: e.encryptedOutput1,
    encryptedOutput2: e.encryptedOutput2,
  };
}

await init();
const t0 = Date.now();
const { steps, alice, bob } = await runScenario({
  wasm: join(build, "transaction.wasm"),
  zkey: join(build, "transaction.zkey"),
  onStep: (step) => console.log(`proved ${step.name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`),
});

const fixture = {
  fieldSize: s(FIELD_SIZE),
  zeroLeaf: s(ZERO_VALUE),
  emptyRoot: s(new MerkleTree().root()),
  hashLeftRight_1_2: s(poseidon([1n, 2n])),
  poseidon3_1_2_3: s(poseidon([1n, 2n, 3n])),
  recipient: RECIPIENT,
  relayer: RELAYER,
  alicePubkey: s(alice.pubkey),
  bobPubkey: s(bob.pubkey),
  bobAddress: bob.address(),
};
for (const step of steps) {
  if (step.kind === "transact") {
    fixture[step.name] = {
      kind: "transact",
      proof: proofJson(step.tx.proof),
      extData: extDataJson(step.tx.extData),
      value: s(step.value),
      recipientGets: s(step.recipientGets ?? 0n),
      relayerGets: s(step.relayerGets ?? 0n),
      rootAfter: s(step.rootAfter),
    };
  } else {
    fixture[step.name] = {
      kind: "depositFor",
      pubKey: s(step.pubKey),
      blinding: s(step.blinding),
      value: s(step.value),
      commitment: s(step.commitment),
      index: step.index,
      rootAfter: s(step.rootAfter),
    };
  }
}

mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, JSON.stringify(fixture, null, 2) + "\n");
console.log("wrote", outFile);
process.exit(0);
