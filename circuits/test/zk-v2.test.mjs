// Stage-2 circuits + grove-zk-v2.mjs. Run from circuits/:  npm run test:v2
// Needs build/{transfer,intent,claim,epochOpen}.{wasm,zkey} + verification_key_*.json (npm run build:v2).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { groth16 } from "snarkjs";
import { keccak256, AbiCoder, toUtf8Bytes, concat, toBeHex, ZeroAddress } from "ethers";
import * as Z from "../lib/grove-zk-v2.mjs";

const {
  init, poseidon, Keys, Note, MerkleTree, dummyNote,
  FIELD_SIZE, ZERO_LEAF, INTENT_TAG, HANDLE_TAG, OWNER_TAG, RESULT_TAG, LEVELS, UNIT_BNB, UNIT_TOKEN, MIN_U_BNB, MIN_U_TOKEN, INTENT_FEE, RPT_SCALE, DIR, BABYJUB, BASE8,
  intentAsset, epochKey, intentLeaf, resultLeaf, voidTotals, hashExtData2, hashIntentExt, hashClaimExt, fieldAmount,
  elgamalK, elgamalKeypair, elgamalEncrypt, elgamalAddCiphertexts, elgamalSum, elgamalDecryptPoint, babyMul, babyAdd, babyEq, isOnCurve, inSubgroup,
  bsgsTable, bsgsSolve, prepareTransfer, prepareIntent, prepareClaim, prepareOpen, proofFromSolidity, claimShares, dividendOwed, scanBundle, assetOf,
} = Z;

const here = dirname(fileURLToPath(import.meta.url));
const build = join(here, "..", "build");
const art = (n) => ({ wasm: join(build, `${n}.wasm`), zkey: join(build, `${n}.zkey`) });
const vkey = (n) => JSON.parse(readFileSync(join(build, `verification_key_${n}.json`), "utf8"));
const verify = (n, r) => groth16.verify(vkey(n), r.publicSignals, r.snarkProof);
const abi = AbiCoder.defaultAbiCoder();
const label = (s) => BigInt(keccak256(toUtf8Bytes(s))) % FIELD_SIZE;
const keysOf = (s) => Keys.fromSeed(keccak256(toUtf8Bytes("grove-v2-test-seed:" + s)));
const ETH = 10n ** 18n;
const COIN = "0x3333333333333333333333333333333333333333";
const RELAYER = "0x2222222222222222222222222222222222222222";
const RECIPIENT = "0x1111111111111111111111111111111111111111";
const expectCircuitReject = (p) => assert.rejects(p, /Assert Failed|Error in template|assert/i);

before(async () => {
  await init();
});
after(async () => {
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
});

// ----------------------------------------------------------------- constants and hashes

test("Appendix A constants are the keccak derivations", () => {
  const k = (s) => BigInt(keccak256(toUtf8Bytes(s))) % FIELD_SIZE;
  assert.equal(ZERO_LEAF, k("grove-v2"));
  assert.equal(INTENT_TAG, k("grove-v2/intent"));
  assert.equal(HANDLE_TAG, k("grove-v2/handle"));
  assert.equal(OWNER_TAG, k("grove-v2/owner"));
  assert.equal(RESULT_TAG, k("grove-v2/result"));
  assert.equal(LEVELS, 23);
  assert.equal(UNIT_BNB, 10n ** 13n);
  assert.equal(UNIT_TOKEN, 10n ** 18n);
  assert.equal(BABYJUB.SUBORDER * 8n, BABYJUB.ORDER);
  assert.ok(isOnCurve(BASE8) && inSubgroup(BASE8));
  // circomlib Poseidon(1, 2) reference value
  assert.equal(poseidon([1n, 2n]), 7853200120776062878684798364095072458815029376092732009249414926327459813530n);
  // constants.circom holds the same numbers
  const circ = readFileSync(join(here, "..", "lib", "constants.circom"), "utf8");
  for (const [name, val] of Object.entries(Z.constantsTable())) {
    const m = circ.match(new RegExp(`function ${name.replace(/^BABYJUB_/, "")}\\(\\)\\s*\\{\\s*return\\s+(\\d+);`));
    if (m) assert.equal(m[1], val, name);
  }
});

test("key derivation: seed -> ask/pk/nk/ovk/handle, address and FVK round trips", () => {
  const seed = "0x" + "ab".repeat(32);
  const k = Keys.fromSeed(seed);
  assert.equal(k.ask, BigInt(keccak256(concat([seed, toUtf8Bytes("zkbnb2/ask")]))) % FIELD_SIZE);
  assert.equal(k.pk, poseidon([k.ask]));
  assert.equal(k.nk, poseidon([k.ask, 1n]));
  assert.equal(k.ovk, poseidon([OWNER_TAG, k.ask]));
  assert.deepEqual(Array.from(k.encPriv), Array.from(Buffer.from(keccak256(concat([seed, toUtf8Bytes("zkbnb2/enc")])).slice(2), "hex")));
  assert.equal(k.salt(1), poseidon([k.ovk, 1n]));
  assert.equal(k.handle(1), poseidon([HANDLE_TAG, k.ovk, k.salt(1)]));
  assert.notEqual(k.handle(1), k.handle(2));
  assert.throws(() => k.salt(0));

  const addr = k.address();
  assert.ok(addr.startsWith("zkbnb2") && addr.length === 6 + 128);
  const v = Keys.fromAddress(addr);
  assert.equal(v.pk, k.pk);
  assert.equal(v.ask, null);
  assert.equal(v.nk, null);
  assert.equal(v.address(), addr);

  const fvk = Keys.fromFvk(k.fvk());
  assert.ok(k.fvk().startsWith("zkbnb2view"));
  assert.equal(fvk.pk, k.pk);
  assert.equal(fvk.nk, k.nk);
  assert.equal(fvk.ask, null);
  assert.ok(fvk.canView && !fvk.canSpend);
  // FVK sees spends: same nullifier as the owner, and can decrypt incoming notes
  const n = new Note({ assetId: 0n, amount: 5n, keys: k, blinding: 7n, index: 12 });
  const seen = Note.decrypt(fvk, n.encrypt(), 12);
  assert.equal(seen.commitment(), n.commitment());
  assert.equal(seen.nullifier(), n.nullifier());
  assert.throws(() => Note.decrypt(keysOf("other"), n.encrypt(), 12));

  const w1 = Keys.fromSignatureAndPassphrase("0x" + "cd".repeat(65), "hunter2");
  const w2 = Keys.fromSignatureAndPassphrase("0x" + "cd".repeat(65), "hunter2");
  const w3 = Keys.fromSignatureAndPassphrase("0x" + "cd".repeat(65), "hunter3");
  assert.equal(w1.ask, w2.ask);
  assert.notEqual(w1.ask, w3.ask);
  assert.notEqual(Keys.random().ask, Keys.random().ask);
});

test("note commitment, nullifier, leaf kinds and chunk root", () => {
  const k = keysOf("alice");
  const n = new Note({ assetId: COIN, amount: 123n, rpt0: 9n, blinding: 77n, keys: k, index: 4 });
  const inner = poseidon([assetOf(COIN), 9n, 77n]);
  assert.equal(n.assetId, BigInt(COIN));
  assert.equal(n.commitment(), poseidon([123n, k.pk, inner]));
  assert.equal(n.nullifier(), poseidon([n.commitment(), 4n, k.nk]));
  const ek = epochKey(COIN, 3, DIR.SELL);
  assert.equal(ek, poseidon([BigInt(COIN), 3n, 1n]));
  assert.equal(intentAsset(COIN, DIR.SELL), poseidon([INTENT_TAG, BigInt(COIN), 1n]));
  assert.equal(intentLeaf(n.commitment(), ek), poseidon([n.commitment(), ek]));
  const totals = { totalIn: 10n, totalOut: 20n, totalRefund: 30n, rptAtSettle: 40n };
  assert.equal(resultLeaf(ek, totals), poseidon([RESULT_TAG, ek, poseidon([10n, 20n, poseidon([30n, 40n])])]));
  // chunk root: 4 leaves, padded, hashed up 23 levels
  const t = new MerkleTree();
  t.insertChunk([1n, 2n]);
  let l0 = poseidon([1n, 2n]);
  let l1 = poseidon([ZERO_LEAF, ZERO_LEAF]);
  let cur = poseidon([l0, l1]);
  for (let lvl = 2; lvl < LEVELS; lvl++) cur = poseidon([cur, t.zeros(lvl)]);
  assert.equal(t.root(), cur);
  assert.throws(() => new Note({ assetId: 0n, amount: 1n << 128n, keys: k }));
});

test("ext data hashes match abi.encode(struct) mod p", () => {
  const e = { recipient: RECIPIENT, extAmountBnb: -5n, extAmountCoin: 0n, relayer: RELAYER, fee: 1n, payload: "0x02", encryptedOutputs: ["0x01", "0x02", "0x03"] };
  const enc = abi.encode(
    ["tuple(address,int256,int256,address,uint256,bytes,bytes[3])"],
    [[RECIPIENT, -5n, 0n, RELAYER, 1n, "0x02", ["0x01", "0x02", "0x03"]]],
  );
  assert.equal(hashExtData2(e), BigInt(keccak256(enc)) % FIELD_SIZE);
  assert.equal(hashIntentExt({ relayer: RELAYER, fee: 2n, encryptedOutputs: ["0x", "0x", "0x"] }), BigInt(keccak256(abi.encode(["tuple(address,uint256,bytes[3])"], [[RELAYER, 2n, ["0x", "0x", "0x"]]]))) % FIELD_SIZE);
  assert.equal(hashClaimExt({ relayer: RELAYER, encryptedOutputs: ["0xaa", "0xbb"] }), BigInt(keccak256(abi.encode(["tuple(address,bytes[2])"], [[RELAYER, ["0xaa", "0xbb"]]]))) % FIELD_SIZE);
  assert.equal(fieldAmount(-7n), FIELD_SIZE - 7n);
  assert.equal(fieldAmount(7n), 7n);
});

// ----------------------------------------------------------------- tree checkpoints

test("MerkleTree: chunks, checkpoints, paths against an old checkpoint", async () => {
  const t = new MerkleTree();
  assert.equal(t.checkpoints.length, 1);
  assert.ok(t.isKnownRoot(t.root()));
  const k = keysOf("alice");
  const n = new Note({ assetId: 0n, amount: ETH, keys: k, blinding: 1n });
  n.index = t.insertChunk([n.commitment()]);
  assert.equal(n.index, 0);
  assert.equal(t.nextIndex, 4);
  assert.ok(!t.isKnownRoot(t.root()), "a fresh root is not known until a checkpoint");
  const c1 = t.checkpoint();
  assert.equal(c1.indexAfter, 4);
  t.insertChunk([5n, 6n, 7n]);
  t.insertChunk([8n]);
  assert.equal(t.rootAt(4), c1.root);
  // the path for leaf 0 against checkpoint 1 hashes to the checkpoint root, not the current root
  const p = t.pathAt(0, 4);
  let cur = n.commitment();
  for (let l = 0; l < LEVELS; l++) cur = poseidon([cur, p.pathElements[l]]);
  assert.equal(cur, c1.root);
  assert.notEqual(c1.root, t.root());
  assert.throws(() => t.pathAt(5, 4), /not yet/);
  assert.throws(() => t.insertChunk([1n, 2n, 3n, 4n, 5n]));
  // manifest checkpoints are verified against the tree's history
  const t2 = new MerkleTree(LEVELS, t.elements);
  t2.addCheckpoints([{ root: c1.root.toString(), indexAfter: 4 }]);
  assert.ok(t2.isKnownRoot(c1.root));
  assert.throws(() => t2.addCheckpoints([{ root: 123n, indexAfter: 8 }]), /mismatch/);
  // prepare* refuse a root that is not a checkpoint
  await assert.rejects(prepareTransfer({ tree: t, root: t.root(), inputs: [n], outputs: [new Note({ assetId: 0n, amount: ETH, keys: k })], ...art("transfer") }), /not a checkpoint/);
});

// ----------------------------------------------------------------- transfer

test("transfer: shield, BNB send with fee, zero padding, signal order, verifies", async () => {
  const alice = keysOf("alice");
  const bob = keysOf("bob");
  const tree = new MerkleTree();
  // shield 1 BNB (no inputs: both padded)
  const a1 = new Note({ assetId: 0n, amount: ETH, keys: alice, blinding: label("b1") });
  const shield = await prepareTransfer({ tree, outputs: [a1], extData: { extAmountBnb: ETH }, ...art("transfer") });
  assert.equal(shield.publicSignals.length, 13);
  assert.equal(shield.publicSignals[0], tree.root().toString());
  assert.equal(shield.publicSignals[1], ETH.toString());
  assert.equal(shield.publicSignals[2], "0");
  assert.equal(shield.publicSignals[7], BigInt(shield.pub.extDataHash).toString());
  assert.equal(shield.publicSignals[10], a1.commitment().toString());
  assert.ok(await verify("transfer", shield));
  assert.ok(await groth16.verify(vkey("transfer"), shield.publicSignals, proofFromSolidity(shield.proof)));
  const start = tree.insertChunk(shield.pub.outputCommitments);
  shield.outputs.forEach((o, i) => (o.index = start + i));
  tree.checkpoint();

  // send 0.3 to bob, 0.001 fee, change back — one real input, one padding
  const toBob = new Note({ assetId: 0n, amount: 3n * ETH / 10n, keys: Keys.fromAddress(bob.address()), blinding: label("b2") });
  const change = new Note({ assetId: 0n, amount: ETH - 3n * ETH / 10n - ETH / 1000n, keys: alice });
  const send = await prepareTransfer({ tree, inputs: [a1], outputs: [toBob, change], extData: { relayer: RELAYER, fee: ETH / 1000n }, ...art("transfer") });
  assert.equal(send.pub.publicAmount, FIELD_SIZE - ETH / 1000n);
  assert.equal(send.publicSignals[8], a1.nullifier().toString());
  assert.ok(await verify("transfer", send));
  // bob can find and decrypt his note from the ext data
  const found = Note.decrypt(bob, send.extData.encryptedOutputs[0], start + 4);
  assert.equal(found.commitment(), toBob.commitment());
  // unbalanced is refused client side
  await assert.rejects(prepareTransfer({ tree, inputs: [a1], outputs: [toBob], extData: { relayer: RELAYER, fee: 1n }, ...art("transfer") }), /unbalanced/);
});

test("transfer: coin spend with dividend floor and remainder, asset selector", async () => {
  const alice = keysOf("alice");
  const tree = new MerkleTree();
  const amount = 1_000_000n * ETH;
  const c0 = new Note({ assetId: COIN, amount, rpt0: 0n, keys: alice, blinding: label("c0") });
  const shield = await prepareTransfer({ tree, outputs: [c0], coin: COIN, accRpt: 0n, extData: { extAmountCoin: amount }, ...art("transfer") });
  assert.equal(shield.pub.publicAmountCoin, amount);
  assert.ok(await verify("transfer", shield));
  c0.index = tree.insertChunk(shield.pub.outputCommitments);
  tree.checkpoint();

  const accRpt = 123_456_789_012_345n; // wei per 1e18 tokens, 1e18-scaled
  const { q, r } = dividendOwed(c0, accRpt);
  assert.equal(q, (amount * accRpt) / RPT_SCALE);
  assert.ok(r < RPT_SCALE);
  const coinOut = new Note({ assetId: COIN, amount: amount - 1000n * ETH, rpt0: accRpt, keys: alice });
  const coinOut2 = new Note({ assetId: COIN, amount: 1000n * ETH, rpt0: accRpt, keys: keysOf("bob") });
  const bnbOut = new Note({ assetId: 0n, amount: q, keys: alice });
  const spend = await prepareTransfer({ tree, inputs: [c0], outputs: [coinOut, coinOut2, bnbOut], coin: COIN, accRpt, ...art("transfer") });
  assert.equal(spend.publicSignals[2], BigInt(COIN).toString());
  assert.equal(spend.publicSignals[4], accRpt.toString());
  assert.ok(await verify("transfer", spend));

  // a coin output must carry rpt0 = accRpt
  await assert.rejects(prepareTransfer({ tree, inputs: [c0], outputs: [new Note({ assetId: COIN, amount, rpt0: 0n, keys: alice }), bnbOut], coin: COIN, accRpt, ...art("transfer") }), /rpt0/);
  // a third asset is refused client side and by the selector constraint
  await assert.rejects(prepareTransfer({ tree, inputs: [c0], outputs: [new Note({ assetId: "0x4444444444444444444444444444444444444444", amount, rpt0: accRpt, keys: alice }), bnbOut], coin: COIN, accRpt, ...art("transfer") }), /neither/);
  const w = { ...spend.witness, outAsset: spend.witness.outAsset.slice() };
  const third = BigInt("0x4444444444444444444444444444444444444444");
  w.outAsset[0] = third.toString();
  w.outputCommitment = w.outputCommitment.slice();
  w.outputCommitment[0] = poseidon([coinOut.amount, alice.pk, poseidon([third, accRpt, coinOut.blinding])]).toString();
  await expectCircuitReject(groth16.fullProve(w, art("transfer").wasm, art("transfer").zkey));
  // accRpt must be a known value >= rpt0: a note newer than accRpt is refused
  const st2 = tree.insertChunk(spend.pub.outputCommitments);
  spend.outputs.forEach((o, i) => (o.index = st2 + i));
  tree.checkpoint();
  await assert.rejects(prepareTransfer({ tree, inputs: [coinOut], outputs: [], coin: COIN, accRpt: 1n, ...art("transfer") }), /newer/);
});

test("transfer: handle claim (full / partial), handleSalt private, claimAmount without handle rejected", async () => {
  const alice = keysOf("alice");
  const tree = new MerkleTree();
  const handle = alice.handle(1);
  const salt = alice.salt(1);
  const claimable = ETH / 4n;
  const out = new Note({ assetId: 0n, amount: claimable, keys: alice, blinding: label("h1") });
  const full = await prepareTransfer({ tree, outputs: [out], handle, handleSalt: salt, claimAmount: claimable, handleKeys: alice, ...art("transfer") });
  assert.equal(full.publicSignals[5], handle.toString());
  assert.equal(full.publicSignals[6], claimable.toString());
  assert.equal(full.publicSignals[1], claimable.toString(), "claimAmount is inside publicAmount");
  assert.ok(!full.publicSignals.includes(salt.toString()), "handleSalt never appears in the public signals");
  assert.ok(!full.publicSignals.includes(alice.ovk.toString()));
  assert.ok(await verify("transfer", full));

  const partial = await prepareTransfer({ tree, outputs: [new Note({ assetId: 0n, amount: claimable / 2n, keys: alice })], handle: alice.handle(2), handleSalt: alice.salt(2), claimAmount: claimable / 2n, handleKeys: alice, ...art("transfer") });
  assert.ok(await verify("transfer", partial));

  await assert.rejects(prepareTransfer({ tree, outputs: [out], claimAmount: claimable, ...art("transfer") }), /needs a handle/);
  await assert.rejects(prepareTransfer({ tree, outputs: [out], handle, handleSalt: alice.salt(2), claimAmount: claimable, handleKeys: alice, ...art("transfer") }), /does not match/);
  // circuit: handle == 0 with claimAmount != 0
  const w = { ...full.witness, handle: "0", handleAsk: "0", handleSalt: "0" };
  await expectCircuitReject(groth16.fullProve(w, art("transfer").wasm, art("transfer").zkey));
  // circuit: wrong salt for a non-zero handle
  const w2 = { ...full.witness, handleSalt: alice.salt(2).toString() };
  await expectCircuitReject(groth16.fullProve(w2, art("transfer").wasm, art("transfer").zkey));
});

// ----------------------------------------------------------------- ElGamal + BSGS

test("ElGamal: deterministic k, homomorphic sum, decrypts to u", () => {
  const { sk, pk } = elgamalKeypair(label("coordinator") % BABYJUB.SUBORDER);
  const alice = keysOf("alice");
  const k1 = elgamalK(alice.ask, 111n);
  assert.equal(k1, elgamalK(alice.ask, 111n));
  assert.notEqual(k1, elgamalK(alice.ask, 112n));
  assert.notEqual(k1, elgamalK(keysOf("bob").ask, 111n));
  assert.ok(k1 > 0n && k1 < BABYJUB.SUBORDER);
  assert.equal(k1, BigInt(keccak256(concat([toUtf8Bytes("zkbnb2/elgamal"), toBeHex(alice.ask, 32), toBeHex(111n, 32)]))) % BABYJUB.SUBORDER);
  const c1 = elgamalEncrypt(5000n, pk, k1);
  const c2 = elgamalEncrypt(7000n, pk, elgamalK(alice.ask, 112n));
  assert.ok(isOnCurve(c1.c1) && isOnCurve(c1.c2));
  assert.ok(babyEq(elgamalDecryptPoint(c1, sk), babyMul(5000n, BASE8)));
  const sum = elgamalAddCiphertexts(c1, c2);
  assert.ok(babyEq(elgamalDecryptPoint(sum, sk), babyMul(12000n, BASE8)));
  assert.ok(babyEq(elgamalSum([c1, c2]).c2, sum.c2));
  assert.throws(() => elgamalEncrypt(5000n, pk, 0n));
  assert.ok(babyEq(babyAdd(BASE8, [0n, 1n]), BASE8));
});

test("BSGS: 2^20 table solves u < 2^32 in < 300 ms (build time logged)", () => {
  const table = bsgsTable(20);
  console.log(`    bsgs 2^20 table: ${table.buildMs} ms, ${(table.keys.byteLength + table.vals.byteLength) / 1e6} MB`);
  for (const u of [0n, 1n, 5000n, 123_456_789n, (1n << 31n) + 12345n, (1n << 32n) - 1n]) {
    const t0 = Date.now();
    const got = bsgsSolve(babyMul(u, BASE8), table, 32);
    const ms = Date.now() - t0;
    assert.equal(got, u);
    assert.ok(ms < 300, `u=${u} took ${ms} ms`);
  }
  // a sum above 2^32 (several intents) with the same table, searched over 40 bits
  const t0 = Date.now();
  assert.equal(bsgsSolve(babyMul((1n << 33n) + 777n, BASE8), table, 40), (1n << 33n) + 777n);
  console.log(`    bsgs 2^33+777 over 40 bits with the 2^20 table: ${Date.now() - t0} ms`);
  assert.equal(bsgsSolve(babyMul(5n, BASE8), table, 2), null);
});

// Workplan §1.4: Σu < 2^40 (sampled, incl. 2^40 − 1) in < 5 s with the 2^24 truncated table, build time and memory
// logged. Heavy (~384 MB table, minutes to build), so gated: BSGS_FULL=1 npm run test:v2
test("BSGS: 2^24 truncated table solves Σu < 2^40 in < 5 s (BSGS_FULL=1)", { skip: process.env.BSGS_FULL !== "1" && "set BSGS_FULL=1" }, () => {
  const m0 = process.memoryUsage();
  const table = bsgsTable(24, 8);
  const m1 = process.memoryUsage();
  const MB = (n) => Math.round(n / 1048576);
  console.log(
    `    bsgs 2^24 table: build ${table.buildMs} ms, arrays ${MB(table.keys.byteLength + table.vals.byteLength)} MB, ` +
      `rss ${MB(m1.rss)} MB (+${MB(m1.rss - m0.rss)}), arrayBuffers ${MB(m1.arrayBuffers)} MB`,
  );
  const samples = [(1n << 40n) - 1n, 0n, 1n << 39n, (1n << 24n) - 1n];
  for (let i = 0; i < 6; i++) samples.push(BigInt(keccak256(toUtf8Bytes(`bsgs-sample-${i}-${Date.now()}`))) % (1n << 40n));
  let worst = 0;
  for (const u of samples) {
    const t0 = Date.now();
    const got = bsgsSolve(babyMul(u, BASE8), table, 40);
    const ms = Date.now() - t0;
    worst = Math.max(worst, ms);
    assert.equal(got, u);
    assert.ok(ms < 5000, `u=${u} took ${ms} ms`);
  }
  console.log(`    bsgs 2^24 / Σu < 2^40: ${samples.length} solves, worst ${worst} ms`);
});

// ----------------------------------------------------------------- epochOpen

test("epochOpen: correct u verifies, wrong u fails, signal order, minOut bound", async () => {
  const { sk, pk } = elgamalKeypair(label("coordinator") % BABYJUB.SUBORDER);
  const alice = keysOf("alice");
  const cts = [5000n, 6000n, 7000n].map((u, i) => elgamalEncrypt(u, pk, elgamalK(alice.ask, BigInt(i + 1))));
  const sum = elgamalSum(cts);
  const minOut = 123_456_789n;
  const r = await prepareOpen({ ecSk: sk, c1: sum.c1, c2: sum.c2, u: 18000n, minOut, ...art("epochOpen") });
  assert.deepEqual(r.publicSignals.map(BigInt), [pk[0], pk[1], sum.c1[0], sum.c1[1], sum.c2[0], sum.c2[1], 18000n, minOut]);
  assert.ok(await verify("epochOpen", r));
  // review N2: the same proof with another minOut (a copied open with the floor removed) does not verify
  for (const other of [0n, minOut - 1n]) {
    const sig = [...r.publicSignals.slice(0, 7), other.toString()];
    assert.equal(await groth16.verify(vkey("epochOpen"), sig, r.snarkProof), false, `minOut ${other} must not verify`);
  }
  await assert.rejects(prepareOpen({ ecSk: sk, c1: sum.c1, c2: sum.c2, u: 18000n, ...art("epochOpen") }), /minOut is required/);
  await assert.rejects(prepareOpen({ ecSk: sk, c1: sum.c1, c2: sum.c2, u: 18001n, minOut, ...art("epochOpen") }), /does not decrypt/);
  await expectCircuitReject(groth16.fullProve({ ...r.witness, u: "18001" }, art("epochOpen").wasm, art("epochOpen").zkey));
  await expectCircuitReject(groth16.fullProve({ ...r.witness, ecSk: (sk + 1n).toString() }, art("epochOpen").wasm, art("epochOpen").zkey));
});

// ----------------------------------------------------------------- intent + claim (one epoch end to end)

test("intent (BUY, SELL) and claim (pro-rata, refund, voided): proofs verify; bounds enforced", async () => {
  const alice = keysOf("alice");
  const bob = keysOf("bob");
  const coord = elgamalKeypair(label("coordinator") % BABYJUB.SUBORDER);
  const tree = new MerkleTree();
  const accRpt = 5_000_000_000n;

  // fund: alice 1 BNB, bob 1e6 coin (rpt0 = accRpt) + 0.1 BNB
  const aBnb = new Note({ assetId: 0n, amount: ETH, keys: alice, blinding: label("i1") });
  const bCoin = new Note({ assetId: COIN, amount: 1_000_000n * ETH, rpt0: accRpt, keys: bob, blinding: label("i2") });
  const bBnb = new Note({ assetId: 0n, amount: ETH / 10n, keys: bob, blinding: label("i3") });
  const f1 = await prepareTransfer({ tree, outputs: [aBnb], extData: { extAmountBnb: ETH }, ...art("transfer") });
  let st = tree.insertChunk(f1.pub.outputCommitments);
  aBnb.index = st;
  const f2 = await prepareTransfer({ tree, outputs: [bCoin, bBnb], coin: COIN, accRpt, extData: { extAmountBnb: ETH / 10n, extAmountCoin: 1_000_000n * ETH }, ...art("transfer") });
  st = tree.insertChunk(f2.pub.outputCommitments);
  bCoin.index = st;
  bBnb.index = st + 1;
  tree.checkpoint();

  // BUY intent: u = 5000 (0.05 BNB), fee 0.0005
  const fee = ETH / 2000n;
  const aChange = new Note({ assetId: 0n, amount: ETH - 5000n * UNIT_BNB - fee - INTENT_FEE, keys: alice });
  const buy = await prepareIntent({ tree, inputs: [aBnb], coin: COIN, dir: DIR.BUY, u: 5000n, changeOutputs: [aChange], ecPk: coord.pk, accRpt, extData: { relayer: RELAYER, fee }, ...art("intent") });
  assert.equal(buy.publicSignals.length, 17);
  assert.equal(buy.publicSignals[2], BigInt(COIN).toString());
  assert.equal(buy.publicSignals[4], "0");
  assert.deepEqual(buy.publicSignals.slice(5, 11).map(BigInt), [coord.pk[0], coord.pk[1], buy.pub.c1[0], buy.pub.c1[1], buy.pub.c2[0], buy.pub.c2[1]]);
  assert.equal(buy.pub.publicAmount, FIELD_SIZE - fee - INTENT_FEE);
  assert.equal(buy.intentNote.amount, 5000n * UNIT_BNB);
  assert.equal(buy.intentNote.assetId, intentAsset(COIN, DIR.BUY));
  assert.equal(buy.k, elgamalK(alice.ask, aBnb.nullifier()));
  assert.ok(babyEq(elgamalDecryptPoint(buy.pub, coord.sk), babyMul(5000n, BASE8)));
  assert.ok(await verify("intent", buy));
  // the contract stamps the intent leaf with the epoch key
  const buySeq = 0;
  const buyLeaf = tree.insertChunk([intentLeaf(buy.intentNote.commitment(), epochKey(COIN, buySeq, DIR.BUY)), ...buy.pub.outputCommitments.slice(1)]);

  // SELL intent: u = 50000 tokens, coin input + BNB fee note; owed = 0 since rpt0 == accRpt
  const bCoinChange = new Note({ assetId: COIN, amount: 1_000_000n * ETH - 50_000n * UNIT_TOKEN, rpt0: accRpt, keys: bob });
  const bBnbChange = new Note({ assetId: 0n, amount: ETH / 10n - fee - INTENT_FEE, keys: bob });
  const sell = await prepareIntent({ tree, inputs: [bCoin, bBnb], coin: COIN, dir: DIR.SELL, u: 50_000n, changeOutputs: [bCoinChange, bBnbChange], ecPk: coord.pk, accRpt, extData: { relayer: RELAYER, fee }, ...art("intent") });
  assert.equal(sell.publicSignals[4], "1");
  assert.ok(await verify("intent", sell));
  const sellSeq = 0;
  const sellLeaf = tree.insertChunk([intentLeaf(sell.intentNote.commitment(), epochKey(COIN, sellSeq, DIR.SELL)), ...sell.pub.outputCommitments.slice(1)]);
  tree.checkpoint();

  // bounds (client side) and dir (circuit)
  await assert.rejects(prepareIntent({ tree, inputs: [aBnb], coin: COIN, dir: DIR.BUY, u: 4999n, ecPk: coord.pk, accRpt, ...art("intent") }), /MIN_U/);
  await assert.rejects(prepareIntent({ tree, inputs: [bCoin], coin: COIN, dir: DIR.SELL, u: 49_999n, ecPk: coord.pk, accRpt, ...art("intent") }), /MIN_U/);
  await assert.rejects(prepareIntent({ tree, inputs: [aBnb], coin: COIN, dir: 3, u: 5000n, ecPk: coord.pk, accRpt, ...art("intent") }), /dir/);
  await assert.rejects(prepareIntent({ tree, inputs: [aBnb], coin: COIN, dir: DIR.BUY, u: 1n << 32n, ecPk: coord.pk, accRpt, ...art("intent") }), /too large/);
  await expectCircuitReject(groth16.fullProve({ ...buy.witness, dir: "3" }, art("intent").wasm, art("intent").zkey));
  await expectCircuitReject(groth16.fullProve({ ...buy.witness, u: "4999" }, art("intent").wasm, art("intent").zkey));

  // open the BUY direction (one intent): result leaf (B, tokensOut, refund, rpt)
  const open = await prepareOpen({ ecSk: coord.sk, ecPk: coord.pk, c1: buy.pub.c1, c2: buy.pub.c2, u: 5000n, minOut: 1n, ...art("epochOpen") });
  assert.ok(await verify("epochOpen", open));
  const buyTotals = { totalIn: 5000n * UNIT_BNB, totalOut: 123_456_789_012_345_678_901_234n, totalRefund: 10n ** 15n, rptAtSettle: accRpt };
  const sellTotals = { totalIn: 50_000n * UNIT_TOKEN, totalOut: 3n * 10n ** 16n, totalRefund: 0n, rptAtSettle: accRpt };
  const resStart = tree.insertChunk([resultLeaf(epochKey(COIN, buySeq, DIR.BUY), buyTotals), resultLeaf(epochKey(COIN, sellSeq, DIR.SELL), sellTotals)]);
  tree.checkpoint();

  // claim BUY: coin share with rpt0 = rptAtSettle, BNB refund share
  const cb = await prepareClaim({ tree, intent: { note: buy.intentNote, leafIndex: buyLeaf, coin: COIN, seq: buySeq, dir: DIR.BUY }, result: { totals: buyTotals, leafIndex: resStart }, extData: { relayer: RELAYER }, ...art("claim") });
  assert.equal(cb.publicSignals.length, 5);
  assert.equal(cb.publicSignals[1], buy.intentNote.nullifier(buyLeaf).toString());
  const sh = claimShares(buy.intentNote.amount, buyTotals);
  assert.equal(cb.outputs[0].amount, sh.q);
  assert.equal(cb.outputs[0].assetId, BigInt(COIN));
  assert.equal(cb.outputs[0].rpt0, accRpt);
  assert.equal(cb.outputs[1].amount, sh.qr);
  assert.equal(cb.outputs[1].assetId, 0n);
  assert.equal(cb.outputs[1].rpt0, 0n);
  assert.equal(sh.q, buyTotals.totalOut); // a == totalIn: full share, floor exact
  assert.ok(await verify("claim", cb));

  // claim SELL: BNB out, no refund
  const cs = await prepareClaim({ tree, intent: { note: sell.intentNote, leafIndex: sellLeaf, coin: COIN, seq: sellSeq, dir: DIR.SELL }, result: { totals: sellTotals, leafIndex: resStart + 1 }, ...art("claim") });
  assert.equal(cs.outputs[0].assetId, 0n);
  assert.equal(cs.outputs[0].amount, 3n * 10n ** 16n);
  assert.equal(cs.outputs[1].assetId, BigInt(COIN));
  assert.equal(cs.outputs[1].amount, 0n);
  assert.ok(await verify("claim", cs));

  // pro-rata floor with a partial share: a = 1/3 of totalIn
  const t3 = { totalIn: 3n * sell.intentNote.amount, totalOut: 10n ** 18n + 1n, totalRefund: 7n, rptAtSettle: accRpt };
  const s3 = claimShares(sell.intentNote.amount, t3);
  assert.equal(s3.q, (10n ** 18n + 1n) / 3n);
  assert.equal(s3.qr, 2n);
  assert.ok(s3.r < t3.totalIn && s3.rr < t3.totalIn);

  // voided SELL epoch: result (1, 0, 1, rpt) returns a in the escrowed asset
  const voided = voidTotals(accRpt);
  const seq1 = 1;
  const sell2 = await prepareIntent({ tree, inputs: [bCoinChange, bBnbChange], coin: COIN, dir: DIR.SELL, u: 50_000n, changeOutputs: [new Note({ assetId: COIN, amount: bCoinChange.amount - 50_000n * UNIT_TOKEN, rpt0: accRpt, keys: bob }), new Note({ assetId: 0n, amount: bBnbChange.amount - INTENT_FEE, keys: bob })], ecPk: coord.pk, accRpt, ...art("intent") }).catch((e) => e);
  // bCoinChange/bBnbChange were never inserted with indices in this test tree -> client refuses before proving
  assert.ok(sell2 instanceof Error);
  // use the original SELL intent note against a voided result at seq 1 (same note, different stamping)
  const vLeaf = tree.insertChunk([intentLeaf(sell.intentNote.commitment(), epochKey(COIN, seq1, DIR.SELL))]);
  const vRes = tree.insertChunk([resultLeaf(epochKey(COIN, seq1, DIR.SELL), voided)]);
  tree.checkpoint();
  const cv = await prepareClaim({ tree, intent: { note: sell.intentNote, leafIndex: vLeaf, coin: COIN, seq: seq1, dir: DIR.SELL }, result: { totals: voided, leafIndex: vRes }, ...art("claim") });
  assert.equal(cv.outputs[0].amount, 0n);
  assert.equal(cv.outputs[1].assetId, BigInt(COIN));
  assert.equal(cv.outputs[1].amount, sell.intentNote.amount);
  assert.equal(cv.outputs[1].rpt0, accRpt);
  assert.ok(await verify("claim", cv));

  // wrong epoch: client refuses (leaf mismatch) and the circuit refuses (Merkle path)
  await assert.rejects(prepareClaim({ tree, intent: { note: sell.intentNote, leafIndex: sellLeaf, coin: COIN, seq: 7, dir: DIR.SELL }, result: { totals: sellTotals, leafIndex: resStart + 1 }, ...art("claim") }), /not found/);
  await expectCircuitReject(groth16.fullProve({ ...cs.witness, epoch: "7" }, art("claim").wasm, art("claim").zkey));
  // 96-bit bound on a
  const big = new Note({ assetId: intentAsset(COIN, DIR.SELL), amount: 1n << 96n, rpt0: 0n, keys: bob });
  await assert.rejects(prepareClaim({ tree, intent: { note: big, leafIndex: sellLeaf, coin: COIN, seq: sellSeq, dir: DIR.SELL }, result: { totals: sellTotals, leafIndex: resStart + 1 }, ...art("claim") }), /96 bits/);
  // totalIn = 0 refused
  assert.throws(() => claimShares(1n, { totalIn: 0n, totalOut: 1n, totalRefund: 0n }), /totalIn/);

  // scanBundle: bob's FVK sees his notes, the intent, and spends
  const fvk = Keys.fromFvk(bob.fvk());
  const leaves = tree.elements.map((leaf, i) => ({ i, leaf: leaf.toString(), enc: "", kind: "note" }));
  const place = (res, start) => res.extData.encryptedOutputs.forEach((e, j) => (leaves[start + j].enc = e));
  place(f2, bCoin.index);
  place(sell, sellLeaf);
  leaves[sellLeaf].kind = "intent";
  const chunk = { leaves, nullifiers: [bCoin.nullifier(), bBnb.nullifier()].map(String), intents: [{ leaf: leaves[sellLeaf].leaf, coin: COIN, dir: DIR.SELL, seq: sellSeq }] };
  const scan = scanBundle({ keys: fvk, chunks: [chunk], coins: [COIN] });
  assert.equal(scan.spent.length, 2);
  assert.deepEqual(scan.notes.map((n) => n.amount), [bCoinChange.amount, bBnbChange.amount]);
  assert.equal(scan.intents.length, 1);
  assert.equal(scan.intents[0].leafIndex, sellLeaf);
  assert.equal(scan.intents[0].note.commitment(), sell.intentNote.commitment());
});

// ----------------------------------------------------------------- artifacts

test("artifacts: sha256 match CEREMONY-HASHES-v2.txt; setup-v2.log records r1cs sha256, circom version and --O2", () => {
  const hashes = readFileSync(join(build, "CEREMONY-HASHES-v2.txt"), "utf8");
  let n = 0;
  for (const line of hashes.split("\n")) {
    const m = line.match(/^([0-9a-f]{64}) \*(.+)$/);
    if (!m) continue;
    const file = join(here, "..", m[2]);
    assert.ok(existsSync(file), file);
    assert.equal(createHash("sha256").update(readFileSync(file)).digest("hex"), m[1], m[2]);
    n++;
  }
  assert.equal(n, 20);
  const log = readFileSync(join(build, "setup-v2.log"), "utf8");
  assert.match(log, /compile flags: --O2/);
  assert.match(log, /circom2 \d+\.\d+\.\d+/);
  for (const c of ["transfer", "intent", "claim", "epochOpen"]) {
    const sec = log.slice(log.indexOf(`=== ${c} `));
    const total = Number(sec.match(/total constraints \(r1cs info\): (\d+)/)[1]);
    assert.ok(total > 0 && total < 65536, `${c}: ${total}`);
    assert.match(sec, /r1cs sha256: [0-9a-f]{64}/);
  }
});
