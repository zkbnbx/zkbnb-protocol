// Run with: node --test test/   (from circuits/). Needs build/transaction.{wasm,zkey} + verification_key.json.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { groth16 } from "snarkjs";
import { keccak256, AbiCoder, toUtf8Bytes, ZeroAddress } from "ethers";
import {
  init,
  poseidon,
  Keypair,
  Utxo,
  MerkleTree,
  hashExtData,
  calculatePublicAmount,
  scanNotes,
  prepareTransaction,
  proofFromSolidity,
  FIELD_SIZE,
  ZERO_VALUE,
  LEVELS,
} from "../lib/grove-zk.mjs";
import { runScenario, key, blind, dummyIn, dummyOut, ETH, RECIPIENT, RELAYER } from "../scripts/scenario.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const build = join(here, "..", "build");
const WASM = join(build, "transaction.wasm");
const ZKEY = join(build, "transaction.zkey");
const VKEY = join(build, "verification_key.json");

before(async () => {
  await init();
});

// snarkjs keeps a worker-thread pool alive; shut it down so the test process can exit
after(async () => {
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
});

test("constants match the contract", () => {
  assert.equal(ZERO_VALUE, BigInt(keccak256(toUtf8Bytes("grove"))) % FIELD_SIZE);
  assert.equal(LEVELS, 20);
  // circomlib Poseidon(1, 2) reference value
  assert.equal(poseidon([1n, 2n]), 7853200120776062878684798364095072458815029376092732009249414926327459813530n);
});

test("keypair / address round trip", () => {
  const k = Keypair.fromPrivkey(123456789n);
  assert.equal(k.pubkey, poseidon([123456789n]));
  const addr = k.address();
  assert.ok(addr.startsWith("zkbnb1"));
  assert.equal(addr.length, 6 + 128);
  const v = Keypair.fromAddress(addr);
  assert.equal(v.pubkey, k.pubkey);
  assert.deepEqual(Array.from(v.encPub), Array.from(k.encPub));
  assert.equal(v.privkey, null);
  assert.equal(v.address(), addr);
  assert.throws(() => v.sign(1n, 0n));

  const fromSig = Keypair.fromSignature("0x" + "ab".repeat(65));
  assert.equal(fromSig.privkey, BigInt(keccak256("0x" + "ab".repeat(65))) % FIELD_SIZE);
  const r1 = Keypair.random();
  const r2 = Keypair.random();
  assert.notEqual(r1.privkey, r2.privkey);
});

test("encryption round trip (to a view-only address, decrypted by the owner)", () => {
  const owner = Keypair.fromPrivkey(42n);
  const viewOnly = Keypair.fromAddress(owner.address());
  const msg = new Uint8Array([1, 2, 3, 4, 5, 250, 251, 252]);
  const ct = viewOnly.encrypt(msg);
  assert.deepEqual(Array.from(owner.decrypt(ct)), Array.from(msg));
  assert.throws(() => Keypair.fromPrivkey(43n).decrypt(ct));
  const tampered = new Uint8Array(ct);
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => owner.decrypt(tampered));

  const u = new Utxo({ amount: 77n, keypair: owner, blinding: 99n });
  const back = Utxo.decrypt(owner, u.encrypt(), 5);
  assert.equal(back.amount, 77n);
  assert.equal(back.blinding, 99n);
  assert.equal(back.index, 5);
  assert.equal(back.commitment(), u.commitment());
  assert.throws(() => Utxo.decrypt(Keypair.fromPrivkey(43n), u.encrypt(), 5));
});

test("merkle tree matches an independent computation", () => {
  const naiveRoot = (leaves) => {
    let layer = leaves.slice();
    let zero = ZERO_VALUE;
    for (let l = 0; l < LEVELS; l++) {
      const next = [];
      for (let i = 0; i < layer.length; i += 2) next.push(poseidon([layer[i], layer[i + 1] ?? zero]));
      layer = next;
      zero = poseidon([zero, zero]);
    }
    return layer[0] ?? zero;
  };
  const t = new MerkleTree();
  assert.equal(t.root(), naiveRoot([]));
  const leaves = [1n, 2n, 3n, 4n, 5n];
  for (const l of leaves) t.insert(l);
  assert.equal(t.root(), naiveRoot(leaves));
  assert.equal(new MerkleTree(LEVELS, leaves).root(), t.root());
  assert.deepEqual(t.elements, leaves);

  // path recomputes the root exactly like merkleProof.circom
  for (let idx = 0; idx < leaves.length; idx++) {
    const { pathElements, pathIndices } = t.path(idx);
    assert.equal(pathIndices, idx);
    let cur = leaves[idx];
    for (let i = 0; i < LEVELS; i++) {
      const bit = (pathIndices >> i) & 1;
      cur = bit === 0 ? poseidon([cur, pathElements[i]]) : poseidon([pathElements[i], cur]);
    }
    assert.equal(cur, t.root());
  }
});

test("hashExtData / calculatePublicAmount match the Solidity formulas", () => {
  const ext = {
    recipient: RECIPIENT,
    extAmount: -5n,
    relayer: RELAYER,
    fee: 1n,
    encryptedOutput1: "0x0102",
    encryptedOutput2: "0x",
  };
  const encoded = AbiCoder.defaultAbiCoder().encode(
    ["tuple(address,int256,address,uint256,bytes,bytes)"],
    [[RECIPIENT, -5n, RELAYER, 1n, "0x0102", "0x"]],
  );
  // abi.encode of a struct with dynamic members starts with the 0x20 head offset
  assert.equal(encoded.slice(2, 66), "0".repeat(62) + "20");
  assert.equal(hashExtData(ext), BigInt(keccak256(encoded)) % FIELD_SIZE);
  assert.equal(calculatePublicAmount(10n, 3n), 7n);
  assert.equal(calculatePublicAmount(-10n, 3n), FIELD_SIZE - 13n);
  assert.equal(calculatePublicAmount(0n, 0n), 0n);
});

test("scanNotes finds our notes and classifies spent ones", () => {
  const me = key("scan-me");
  const other = key("scan-other");
  const mine = new Utxo({ amount: 5n, keypair: me, blinding: 1n, index: 0 });
  const theirs = new Utxo({ amount: 6n, keypair: other, blinding: 2n, index: 1 });
  const spentMine = new Utxo({ amount: 7n, keypair: me, blinding: 3n, index: 2 });
  const commitments = [mine, theirs, spentMine].map((u) => ({
    commitment: u.commitment(),
    index: u.index,
    encryptedOutput: "0x" + Buffer.from(u.encrypt()).toString("hex"),
  }));
  const depositsFor = [
    { pubKey: me.pubkey, amount: 8n, blinding: 4n, index: 3 },
    { pubKey: other.pubkey, amount: 9n, blinding: 5n, index: 4 },
  ];
  const { unspent, spent } = scanNotes({
    keypair: me,
    commitments,
    depositsFor,
    nullifiers: new Set([spentMine.nullifier()]),
  });
  assert.deepEqual(unspent.map((u) => [u.index, u.amount]), [[0, 5n], [3, 8n]]);
  assert.deepEqual(spent.map((u) => [u.index, u.amount]), [[2, 7n]]);
});

test("real proofs: deposit, private transfer, withdraw, depositFor spend", { skip: !existsSync(ZKEY) && "run `npm run build` first" }, async () => {
  const vkey = JSON.parse(readFileSync(VKEY, "utf8"));
  const { steps, tree } = await runScenario({ wasm: WASM, zkey: ZKEY });
  assert.equal(steps.map((s) => s.name).join(","), "deposit,transfer,withdraw,depositFor,spendDepositFor");

  for (const step of steps.filter((s) => s.kind === "transact")) {
    const { proof, extData, publicSignals, snarkProof } = step.tx;
    assert.equal(await groth16.verify(vkey, publicSignals, snarkProof), true, step.name);
    // public signal order: root, publicAmount, extDataHash, nullifiers[2], commitments[2]
    assert.deepEqual(publicSignals.map(BigInt), [
      proof.root,
      proof.publicAmount,
      BigInt(proof.extDataHash),
      ...proof.inputNullifiers,
      ...proof.outputCommitments,
    ]);
    assert.equal(proof.publicAmount, calculatePublicAmount(extData.extAmount, extData.fee));
    assert.equal(BigInt(proof.extDataHash), hashExtData(extData));
    // the Solidity-layout proof converts back to a verifiable snarkjs proof
    assert.equal(await groth16.verify(vkey, publicSignals, proofFromSolidity(proof)), true);
    // tampered public input fails
    const bad = publicSignals.slice();
    bad[1] = (BigInt(bad[1]) + 1n).toString();
    assert.equal(await groth16.verify(vkey, bad, snarkProof), false);
  }

  const [a, b, c, d, e] = steps;
  assert.equal(a.tx.extData.extAmount, ETH);
  assert.equal(a.tx.proof.root, new MerkleTree().root());
  assert.equal(b.tx.extData.extAmount, 0n);
  assert.equal(b.tx.proof.root, a.rootAfter);
  assert.equal(c.tx.extData.extAmount, -(39n * ETH / 100n));
  assert.equal(c.tx.extData.fee, ETH / 100n);
  assert.equal(c.tx.extData.recipient, RECIPIENT);
  assert.equal(c.tx.extData.relayer, RELAYER);
  assert.equal(d.commitment, poseidon([d.value, d.pubKey, 12345n]));
  assert.equal(d.index, 6);
  assert.equal(e.tx.extData.extAmount, -d.value);
  assert.equal(e.rootAfter, tree.root());
  assert.equal(tree.length, 9);

  // the receivers can find their notes from the emitted data
  const bob = key("bob");
  const found = scanNotes({
    keypair: bob,
    commitments: steps
      .filter((s) => s.kind === "transact")
      .flatMap((s) =>
        s.tx.outputs.map((u, i) => ({
          commitment: u.commitment(),
          index: u.index,
          encryptedOutput: i === 0 ? s.tx.extData.encryptedOutput1 : s.tx.extData.encryptedOutput2,
        })),
      ),
    depositsFor: [{ pubKey: d.pubKey, amount: d.value, blinding: d.blinding, index: d.index }],
    nullifiers: new Set(steps.filter((s) => s.kind === "transact").flatMap((s) => s.tx.proof.inputNullifiers)),
  });
  assert.deepEqual(found.unspent, []);
  assert.deepEqual(found.spent.map((u) => [u.index, u.amount]), [[2, 4n * ETH / 10n], [6, d.value]]);

  // unbalanced / unknown-leaf transactions are rejected before proving
  await assert.rejects(
    prepareTransaction({ tree, inputs: [dummyIn("x")], outputs: [new Utxo({ amount: 1n, keypair: bob })], wasm: WASM, zkey: ZKEY }),
    /unbalanced/,
  );
  await assert.rejects(
    prepareTransaction({
      tree,
      inputs: [new Utxo({ amount: 1n, keypair: bob, blinding: blind("nope"), index: 0 })],
      extAmount: -1n,
      recipient: RECIPIENT,
      wasm: WASM,
      zkey: ZKEY,
    }),
    /not found/,
  );
  assert.equal(dummyOut("z").amount, 0n);
  assert.equal(ZeroAddress, "0x0000000000000000000000000000000000000000");
});
