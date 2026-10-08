// Deterministic stage-2 scenario -> contracts/test/fixtures/v2/{scenario,keys,poseidon_vectors,elgamal_vectors}.json
// Run from circuits/:  npm run fixtures:v2   (needs the build:v2 artifacts; uses the DEV zkeys)
// Keys and blindings derive from labels; only the Groth16 randomness and the note encryption differ between runs.
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { keccak256, AbiCoder, toUtf8Bytes, toBeHex } from "ethers";
import * as Z from "../lib/grove-zk-v2.mjs";

const {
  init, poseidon, Keys, Note, MerkleTree, FIELD_SIZE, ZERO_LEAF, LEVELS, UNIT_BNB, UNIT_TOKEN, INTENT_FEE, DIR, ACTION_PLANT, ACTION_HANDOVER,
  intentAsset, epochKey, intentLeaf, resultLeaf, voidTotals, elgamalK, elgamalKeypair, elgamalEncrypt, elgamalSum, elgamalDecryptPoint, toExtended, babyMul, BASE8,
  prepareTransfer, prepareIntent, prepareClaim, prepareOpen, dividendOwed, claimShares,
} = Z;

const here = dirname(fileURLToPath(import.meta.url));
const build = join(here, "..", "build");
const outDir = join(here, "..", "..", "contracts", "test", "fixtures", "v2");
const art = (n) => ({ wasm: join(build, `${n}.wasm`), zkey: join(build, `${n}.zkey`) });
const abi = AbiCoder.defaultAbiCoder();
const s = (x) => BigInt(x).toString();
const label = (t) => BigInt(keccak256(toUtf8Bytes(t))) % FIELD_SIZE;
const seedOf = (t) => keccak256(toUtf8Bytes("grove-v2-fixture-seed:" + t));
const ETH = 10n ** 18n;

export const COIN = "0x3333333333333333333333333333333333333333";
export const RECIPIENT = "0x1111111111111111111111111111111111111111";
export const RELAYER = "0x2222222222222222222222222222222222222222";
export const PLANTER = "0x4444444444444444444444444444444444444444";
export const HANDOVER_WALLET = "0x5555555555555555555555555555555555555555";
export const PLANT_FEE = 5n * ETH / 1000n; // 0.005 BNB
export const ACC_RPT = 123_456_789_012_345n;

const proofJson = (p) => ({ a: p.a.map(s), b: [p.b[0].map(s), p.b[1].map(s)], c: p.c.map(s) });
const deep = (o) => JSON.parse(JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() : v)));

await init();
mkdirSync(outDir, { recursive: true });
const t0 = Date.now();
const log = (m) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s  ${m}`);

// ----------------------------------------------------------------- keys.json (shared vector: web + keeper copy it)
const seed = seedOf("alice");
const alice = Keys.fromSeed(seed);
const bob = Keys.fromSeed(seedOf("bob"));
const keysJson = {
  seed,
  ask: s(alice.ask),
  pk: s(alice.pk),
  nk: s(alice.nk),
  ovk: s(alice.ovk),
  encPriv: "0x" + Buffer.from(alice.encPriv).toString("hex"),
  encPub: "0x" + Buffer.from(alice.encPub).toString("hex"),
  address: alice.address(),
  fvk: alice.fvk(),
  salt1: s(alice.salt(1)),
  handle1: s(alice.handle(1)),
  salt2: s(alice.salt(2)),
  handle2: s(alice.handle(2)),
  elgamalK_nullifier1: s(elgamalK(alice.ask, 1n)),
  derivation: {
    ask: 'keccak256(seed || "zkbnb2/ask") mod p',
    encPriv: 'keccak256(seed || "zkbnb2/enc")',
    pk: "Poseidon(ask)",
    nk: "Poseidon(ask, 1)",
    ovk: "Poseidon(OWNER_TAG, ask)",
    salt: "Poseidon(ovk, n)",
    handle: "Poseidon(HANDLE_TAG, ovk, salt(n))",
    elgamalK: 'keccak256("zkbnb2/elgamal" || ask || nullifier0) mod l',
  },
};
writeFileSync(join(outDir, "keys.json"), JSON.stringify(keysJson, null, 2) + "\n");
log("keys.json");

// ----------------------------------------------------------------- poseidon_vectors.json
{
  const n = new Note({ assetId: COIN, amount: 123n, rpt0: 9n, blinding: 77n, keys: alice, index: 4 });
  const ek = epochKey(COIN, 3, DIR.SELL);
  const totals = { totalIn: 10n, totalOut: 20n, totalRefund: 30n, rptAtSettle: 40n };
  const t = new MerkleTree();
  const chunkStart = t.insertChunk([1n, 2n]);
  const vec = {
    fieldSize: s(FIELD_SIZE),
    zeroLeaf: s(ZERO_LEAF),
    levels: LEVELS,
    emptyRoot: s(new MerkleTree().root()),
    zeros: Array.from({ length: LEVELS + 1 }, (_, i) => s(t.zeros(i))),
    poseidon2_1_2: s(poseidon([1n, 2n])),
    poseidon3_1_2_3: s(poseidon([1n, 2n, 3n])),
    note: { assetId: s(BigInt(COIN)), amount: "123", rpt0: "9", blinding: "77", pk: s(alice.pk), nk: s(alice.nk), inner: s(n.inner()), commitment: s(n.commitment()), leafIndex: 4, nullifier: s(n.nullifier()) },
    intentAsset_sell: s(intentAsset(COIN, DIR.SELL)),
    epochKey_coin_3_sell: s(ek),
    intentLeaf: s(intentLeaf(n.commitment(), ek)),
    totals: deep(totals),
    totalsHash: s(Z.totalsHash(totals)),
    resultLeaf: s(resultLeaf(ek, totals)),
    voidResultLeaf_rpt40: s(resultLeaf(ek, voidTotals(40n))),
    chunk: { leaves: ["1", "2", s(ZERO_LEAF), s(ZERO_LEAF)], start: chunkStart, root: s(t.root()) },
    handle: { ovk: s(alice.ovk), salt1: s(alice.salt(1)), handle1: s(alice.handle(1)) },
  };
  writeFileSync(join(outDir, "poseidon_vectors.json"), JSON.stringify(vec, null, 2) + "\n");
  log("poseidon_vectors.json");
}

// ----------------------------------------------------------------- elgamal_vectors.json
const coord = elgamalKeypair(label("fixture-coordinator") % Z.BABYJUB.SUBORDER || 1n);
{
  const encs = [];
  const us = [5000n, 6000n, 7000n, 50_000n, 123_456n, 1n, (1n << 32n) - 1n, 999_999n, 4_000_000_000n, 42n];
  for (let i = 0; i < us.length; i++) {
    const nf = label(`elgamal-nullifier-${i}`);
    const k = elgamalK(alice.ask, nf);
    const c = elgamalEncrypt(us[i], coord.pk, k);
    encs.push({ u: s(us[i]), nullifier0: s(nf), k: s(k), c1: c.c1.map(s), c2: c.c2.map(s), c1Extended: deep(toExtended(c.c1)), c2Extended: deep(toExtended(c.c2)) });
  }
  const partial = encs.slice(0, 3).map((e) => ({ c1: e.c1.map(BigInt), c2: e.c2.map(BigInt) }));
  const sum3 = elgamalSum(partial);
  const sumU3 = us.slice(0, 3).reduce((a, b) => a + b, 0n);
  const all = elgamalSum(encs.map((e) => ({ c1: e.c1.map(BigInt), c2: e.c2.map(BigInt) })));
  const sumAll = us.reduce((a, b) => a + b, 0n);
  const vec = {
    curve: { a: s(Z.BABYJUB.A), d: s(Z.BABYJUB.D), subOrder: s(Z.BABYJUB.SUBORDER), base8: BASE8.map(s) },
    coordinator: { ecSk: s(coord.sk), ecPk: coord.pk.map(s) },
    encryptions: encs,
    sum_first3: { u: s(sumU3), c1: sum3.c1.map(s), c2: sum3.c2.map(s), decryptedPoint: elgamalDecryptPoint(sum3, coord.sk).map(s), uTimesB8: babyMul(sumU3, BASE8).map(s) },
    sum_all: { u: s(sumAll), c1: all.c1.map(s), c2: all.c2.map(s), decryptedPoint: elgamalDecryptPoint(all, coord.sk).map(s), uTimesB8: babyMul(sumAll, BASE8).map(s) },
    identityAffine: ["0", "1"],
    note: "sums are affine (x, y); the contract keeps extended coordinates and normalises with toAffine before comparing",
  };
  writeFileSync(join(outDir, "elgamal_vectors.json"), JSON.stringify(vec, null, 2) + "\n");
  log("elgamal_vectors.json");
}

// ----------------------------------------------------------------- scenario.json
const tree = new MerkleTree();
const cases = [];
const notes = {};
const insert = (leaves) => tree.insertChunk(leaves);
const place = (outs, start) => outs.forEach((o, i) => (o.index = start + i));

function transferCase(name, r, extras = {}) {
  const chunk = r.pub.outputCommitments;
  const start = insert(chunk);
  place(r.outputs, start);
  const ck = tree.checkpoint();
  cases.push({ name, kind: "transfer", proof: proofJson(r.proof), pub: deep(r.pub), ext: deep(r.extData), chunk: chunk.map(s), chunkStart: start, checkpointAfter: deep(ck), ...deep(extras) });
  log(`proved ${name}`);
  return start;
}
function intentCase(name, r, seq, extras = {}) {
  const stamped = intentLeaf(r.intentNote.commitment(), epochKey(COIN, seq, r.pub.dir));
  const chunk = [stamped, r.pub.outputCommitments[1], r.pub.outputCommitments[2]];
  const start = insert(chunk);
  place(r.outputs, start);
  const ck = tree.checkpoint();
  cases.push({ name, kind: "intent", proof: proofJson(r.proof), pub: deep(r.pub), ext: deep(r.extData), chunk: chunk.map(s), chunkStart: start, checkpointAfter: deep(ck), seq, intentLeaf: s(stamped), intentCommitment: s(r.intentNote.commitment()), intentAmount: s(r.intentNote.amount), k: s(r.k), ...deep(extras) });
  log(`proved ${name}`);
  return { leafIndex: start, note: r.intentNote };
}
function claimCase(name, r, extras = {}) {
  const chunk = r.pub.outputCommitments;
  const start = insert(chunk);
  place(r.outputs, start);
  const ck = tree.checkpoint();
  cases.push({ name, kind: "claim", proof: proofJson(r.proof), pub: deep(r.pub), ext: deep(r.extData), chunk: chunk.map(s), chunkStart: start, checkpointAfter: deep(ck), shares: deep(r.shares), outputs: r.outputs.map((o) => ({ assetId: s(o.assetId), amount: s(o.amount), rpt0: s(o.rpt0) })), ...deep(extras) });
  log(`proved ${name}`);
}

// 1. shield 1 BNB (alice)
notes.a1 = new Note({ assetId: 0n, amount: ETH, keys: alice, blinding: label("a1") });
transferCase("shield", await prepareTransfer({ tree, outputs: [notes.a1], extData: { extAmountBnb: ETH }, ...art("transfer") }), { extAmountBnb: ETH });

// 2. transfer_bnb: alice -> bob 0.3, fee 0.001, change
notes.b1 = new Note({ assetId: 0n, amount: 3n * ETH / 10n, keys: bob, blinding: label("b1") });
notes.a2 = new Note({ assetId: 0n, amount: ETH - 3n * ETH / 10n - ETH / 1000n, keys: alice, blinding: label("a2") });
transferCase("transfer_bnb", await prepareTransfer({ tree, inputs: [notes.a1], outputs: [notes.b1, notes.a2], extData: { relayer: RELAYER, fee: ETH / 1000n }, ...art("transfer") }));

// 3. shield_coin: alice shields 1e6 tokens (accRpt 0 -> rpt0 0)
notes.ac1 = new Note({ assetId: COIN, amount: 1_000_000n * ETH, rpt0: 0n, keys: alice, blinding: label("ac1") });
transferCase("shield_coin", await prepareTransfer({ tree, outputs: [notes.ac1], coin: COIN, accRpt: 0n, extData: { extAmountCoin: 1_000_000n * ETH }, ...art("transfer") }), { extAmountCoin: 1_000_000n * ETH, knownAccRpt: 0n });

// 4. transfer_coin_with_dividend: accRpt = ACC_RPT; 400k to bob, 600k change, owed BNB to alice
{
  const { q, r } = dividendOwed(notes.ac1, ACC_RPT);
  notes.bc1 = new Note({ assetId: COIN, amount: 400_000n * ETH, rpt0: ACC_RPT, keys: bob, blinding: label("bc1") });
  notes.ac2 = new Note({ assetId: COIN, amount: 600_000n * ETH, rpt0: ACC_RPT, keys: alice, blinding: label("ac2") });
  notes.a3 = new Note({ assetId: 0n, amount: q, keys: alice, blinding: label("a3") });
  transferCase("transfer_coin_with_dividend", await prepareTransfer({ tree, inputs: [notes.ac1], outputs: [notes.bc1, notes.ac2, notes.a3], coin: COIN, accRpt: ACC_RPT, ...art("transfer") }), { knownAccRpt: ACC_RPT, owed: q, remainder: r });
}

// 5. unshield_denom: bob unshields 0.1 BNB to RECIPIENT, fee 0.001, change
notes.b2 = new Note({ assetId: 0n, amount: notes.b1.amount - ETH / 10n - ETH / 1000n, keys: bob, blinding: label("b2") });
transferCase("unshield_denom", await prepareTransfer({ tree, inputs: [notes.b1], outputs: [notes.b2], extData: { recipient: RECIPIENT, extAmountBnb: -(ETH / 10n), relayer: RELAYER, fee: ETH / 1000n }, ...art("transfer") }), { denomination: ETH / 10n });

// 6. plant_private: alice pays plantFee to the planter with ACTION_PLANT payload; creatorHandle = handle(3)
{
  const plantParams = [
    "Dark Fixture",
    "DFX",
    ["A privately planted fixture coin", "ipfs://image", "https://example.invalid", "", ""],
    0, // PayoutMode.Creator
    "0x0000000000000000000000000000000000000000",
    0n,
    0n,
  ];
  const payload = abi.encode(
    ["uint256", "tuple(string name,string symbol,tuple(string description,string image,string website,string twitter,string telegram) metadata,uint8 payoutMode,address payoutWallet,uint256 ringId,uint256 minFirstBuyTokens)", "uint256"],
    [ACTION_PLANT, plantParams, alice.handle(3)],
  );
  notes.a4 = new Note({ assetId: 0n, amount: notes.a2.amount - PLANT_FEE, keys: alice, blinding: label("a4") });
  transferCase("plant_private", await prepareTransfer({ tree, inputs: [notes.a2], outputs: [notes.a4], extData: { recipient: PLANTER, extAmountBnb: -PLANT_FEE, payload }, ...art("transfer") }), { plantFee: PLANT_FEE, creatorHandle: alice.handle(3), creatorSalt: alice.salt(3), payloadFirstWord: ACTION_PLANT });
}

// 7. handle_claim_full: claimable 0.25 == claimAmount, no inputs
{
  const claimable = ETH / 4n;
  notes.a5 = new Note({ assetId: 0n, amount: claimable, keys: alice, blinding: label("a5") });
  transferCase("handle_claim_full", await prepareTransfer({ tree, outputs: [notes.a5], handle: alice.handle(1), handleSalt: alice.salt(1), claimAmount: claimable, handleKeys: alice, ...art("transfer") }), { claimable, handleIndex: 1 });
}
// 8. handle_claim_partial: claimable 0.5, claimAmount 0.2, mixed with a3 (owed BNB)
{
  const claimable = ETH / 2n;
  const claimAmount = ETH / 5n;
  notes.a6 = new Note({ assetId: 0n, amount: notes.a3.amount + claimAmount, keys: alice, blinding: label("a6") });
  transferCase("handle_claim_partial", await prepareTransfer({ tree, inputs: [notes.a3], outputs: [notes.a6], handle: alice.handle(2), handleSalt: alice.salt(2), claimAmount, handleKeys: alice, ...art("transfer") }), { claimable, handleIndex: 2 });
}
// 9. handover: zero-value proof with handle(3), claimAmount 0, payload ACTION_HANDOVER
{
  const payload = abi.encode(["uint256", "address", "uint8", "address", "uint256"], [ACTION_HANDOVER, COIN, 1 /* Wallet */, HANDOVER_WALLET, 0n]);
  transferCase("handover", await prepareTransfer({ tree, handle: alice.handle(3), handleSalt: alice.salt(3), claimAmount: 0n, handleKeys: alice, extData: { recipient: RECIPIENT, payload }, ...art("transfer") }), { handleIndex: 3, payloadFirstWord: ACTION_HANDOVER, mode: 1, wallet: HANDOVER_WALLET, ringId: 0n });
}

// 10. intent_buy: alice BUY u = 5000 from a4, fee 0.0005
const fee = ETH / 2000n;
let buy;
{
  const change = new Note({ assetId: 0n, amount: notes.a4.amount - 5000n * UNIT_BNB - fee - INTENT_FEE, keys: alice, blinding: label("a7") });
  const r = await prepareIntent({ tree, inputs: [notes.a4], coin: COIN, dir: DIR.BUY, u: 5000n, changeOutputs: [change], ecPk: coord.pk, accRpt: ACC_RPT, extData: { relayer: RELAYER, fee }, intentBlinding: label("ib1"), ...art("intent") });
  buy = { ...intentCase("intent_buy", r, 0, { u: 5000n, knownAccRpt: ACC_RPT }), r };
  notes.a7 = change;
}
// 11. intent_sell_with_fee_note: bob SELL u = 50000 from bc1 + b2 (fees)
let sell;
{
  const coinChange = new Note({ assetId: COIN, amount: notes.bc1.amount - 50_000n * UNIT_TOKEN, rpt0: ACC_RPT, keys: bob, blinding: label("bc2") });
  const bnbChange = new Note({ assetId: 0n, amount: notes.b2.amount - fee - INTENT_FEE, keys: bob, blinding: label("b3") });
  const r = await prepareIntent({ tree, inputs: [notes.bc1, notes.b2], coin: COIN, dir: DIR.SELL, u: 50_000n, changeOutputs: [coinChange, bnbChange], ecPk: coord.pk, accRpt: ACC_RPT, extData: { relayer: RELAYER, fee }, intentBlinding: label("ib2"), ...art("intent") });
  sell = { ...intentCase("intent_sell_with_fee_note", r, 0, { u: 50_000n, knownAccRpt: ACC_RPT }), r };
  notes.bc2 = coinChange;
  notes.b3 = bnbChange;
}
// 12. intent_harvest: alice HARVEST u = 50000 from ac2 + a7 (fees)
let harvest;
{
  const coinChange = new Note({ assetId: COIN, amount: notes.ac2.amount - 50_000n * UNIT_TOKEN, rpt0: ACC_RPT, keys: alice, blinding: label("ac3") });
  const bnbChange = new Note({ assetId: 0n, amount: notes.a7.amount - fee - INTENT_FEE, keys: alice, blinding: label("a8") });
  const r = await prepareIntent({ tree, inputs: [notes.ac2, notes.a7], coin: COIN, dir: DIR.HARVEST, u: 50_000n, changeOutputs: [coinChange, bnbChange], ecPk: coord.pk, accRpt: ACC_RPT, extData: { relayer: RELAYER, fee }, intentBlinding: label("ib3"), ...art("intent") });
  harvest = { ...intentCase("intent_harvest", r, 0, { u: 50_000n, knownAccRpt: ACC_RPT }), r };
  notes.ac3 = coinChange;
  notes.a8 = bnbChange;
}
// 13. intent_sell_voided: alice SELL u = 50000 at seq 1 (voided later) from ac3 + a8
let sellVoid;
{
  const coinChange = new Note({ assetId: COIN, amount: notes.ac3.amount - 50_000n * UNIT_TOKEN, rpt0: ACC_RPT, keys: alice, blinding: label("ac4") });
  const bnbChange = new Note({ assetId: 0n, amount: notes.a8.amount - INTENT_FEE, keys: alice, blinding: label("a9") });
  const r = await prepareIntent({ tree, inputs: [notes.ac3, notes.a8], coin: COIN, dir: DIR.SELL, u: 50_000n, changeOutputs: [coinChange, bnbChange], ecPk: coord.pk, accRpt: ACC_RPT, extData: {}, intentBlinding: label("ib4"), ...art("intent") });
  sellVoid = { ...intentCase("intent_sell_voided", r, 1, { u: 50_000n, knownAccRpt: ACC_RPT }), r };
}

// 14. open_buy: the BUY epoch 0 sum = alice's intent + 2 more encryptions (no proofs) = 5000 + 6000 + 7000
const extra = [6000n, 7000n].map((u, i) => elgamalEncrypt(u, coord.pk, elgamalK(bob.ask, label(`extra-nf-${i}`))));
const buySum = elgamalSum([buy.r.pub, ...extra]);
const buyU = 18_000n;
{
  const r = await prepareOpen({ ecSk: coord.sk, ecPk: coord.pk, c1: buySum.c1, c2: buySum.c2, u: buyU, ...art("epochOpen") });
  cases.push({ name: "open_buy", kind: "open", proof: proofJson(r.proof), pub: deep(r.pub), ecSk: s(coord.sk), ciphertexts: [buy.r.pub, ...extra].map((c) => ({ c1: c.c1.map(s), c2: c.c2.map(s) })), sumExtended: { c1: deep(toExtended(buySum.c1)), c2: deep(toExtended(buySum.c2)) }, u: s(buyU), dir: DIR.BUY, seq: 0 });
  log("proved open_buy");
}
// open_sell (SELL epoch 0, only bob's intent)
{
  const r = await prepareOpen({ ecSk: coord.sk, ecPk: coord.pk, c1: sell.r.pub.c1, c2: sell.r.pub.c2, u: 50_000n, ...art("epochOpen") });
  cases.push({ name: "open_sell", kind: "open", proof: proofJson(r.proof), pub: deep(r.pub), ecSk: s(coord.sk), ciphertexts: [{ c1: sell.r.pub.c1.map(s), c2: sell.r.pub.c2.map(s) }], u: "50000", dir: DIR.SELL, seq: 0 });
  log("proved open_sell");
}

// 15. result leaves: BUY 0 (B = 18000 UNIT_BNB, tokensOut, refund), SELL 0, HARVEST 0 in one chunk; SELL 1 voided in another
const buyTotals = { totalIn: buyU * UNIT_BNB, totalOut: 123_456_789_012_345_678_901_234n, totalRefund: 10n ** 15n, rptAtSettle: ACC_RPT };
const sellTotals = { totalIn: 50_000n * UNIT_TOKEN, totalOut: 3n * 10n ** 16n, totalRefund: 0n, rptAtSettle: ACC_RPT };
const harvestTotals = { totalIn: 50_000n * UNIT_TOKEN, totalOut: 2n * 10n ** 16n, totalRefund: 0n, rptAtSettle: ACC_RPT };
const voided = voidTotals(ACC_RPT);
const resStart = insert([resultLeaf(epochKey(COIN, 0, DIR.BUY), buyTotals), resultLeaf(epochKey(COIN, 0, DIR.SELL), sellTotals), resultLeaf(epochKey(COIN, 0, DIR.HARVEST), harvestTotals)]);
const voidStart = insert([resultLeaf(epochKey(COIN, 1, DIR.SELL), voided)]);
const ckResults = tree.checkpoint();
const results = [
  { coin: COIN, dir: DIR.BUY, seq: 0, status: "opened", totals: deep(buyTotals), leafIndex: resStart, leaf: s(tree.leaf(resStart)) },
  { coin: COIN, dir: DIR.SELL, seq: 0, status: "opened", totals: deep(sellTotals), leafIndex: resStart + 1, leaf: s(tree.leaf(resStart + 1)) },
  { coin: COIN, dir: DIR.HARVEST, seq: 0, status: "opened", totals: deep(harvestTotals), leafIndex: resStart + 2, leaf: s(tree.leaf(resStart + 2)) },
  { coin: COIN, dir: DIR.SELL, seq: 1, status: "voided", totals: deep(voided), leafIndex: voidStart, leaf: s(tree.leaf(voidStart)) },
];

// 16. claims
claimCase("claim_buy", await prepareClaim({ tree, intent: { note: buy.note, leafIndex: buy.leafIndex, coin: COIN, seq: 0, dir: DIR.BUY }, result: { totals: buyTotals, leafIndex: resStart }, outputs: [{ blinding: label("cb0") }, { blinding: label("cb1") }], extData: { relayer: RELAYER }, ...art("claim") }), { intentLeafIndex: buy.leafIndex, resultLeafIndex: resStart, seq: 0, dir: DIR.BUY, a: buy.note.amount });
claimCase("claim_sell", await prepareClaim({ tree, intent: { note: sell.note, leafIndex: sell.leafIndex, coin: COIN, seq: 0, dir: DIR.SELL }, result: { totals: sellTotals, leafIndex: resStart + 1 }, outputs: [{ blinding: label("cs0") }, { blinding: label("cs1") }], extData: { relayer: RELAYER }, ...art("claim") }), { intentLeafIndex: sell.leafIndex, resultLeafIndex: resStart + 1, seq: 0, dir: DIR.SELL, a: sell.note.amount });
claimCase("claim_harvest", await prepareClaim({ tree, intent: { note: harvest.note, leafIndex: harvest.leafIndex, coin: COIN, seq: 0, dir: DIR.HARVEST }, result: { totals: harvestTotals, leafIndex: resStart + 2 }, outputs: [{ blinding: label("ch0") }, { blinding: label("ch1") }], extData: { relayer: RELAYER }, ...art("claim") }), { intentLeafIndex: harvest.leafIndex, resultLeafIndex: resStart + 2, seq: 0, dir: DIR.HARVEST, a: harvest.note.amount });
claimCase("claim_voided_sell", await prepareClaim({ tree, intent: { note: sellVoid.note, leafIndex: sellVoid.leafIndex, coin: COIN, seq: 1, dir: DIR.SELL }, result: { totals: voided, leafIndex: voidStart }, outputs: [{ blinding: label("cv0") }, { blinding: label("cv1") }], extData: { relayer: RELAYER }, ...art("claim") }), { intentLeafIndex: sellVoid.leafIndex, resultLeafIndex: voidStart, seq: 1, dir: DIR.SELL, a: sellVoid.note.amount });

const scenario = {
  generatedAt: new Date().toISOString(),
  note: "DEV-KEY proofs (circuits/scripts/setup-v2.sh). Verifiers: contracts/src/verifiers/Groth16Verifier{Transfer,Intent,Claim,Open}.sol",
  fieldSize: s(FIELD_SIZE),
  zeroLeaf: s(ZERO_LEAF),
  levels: LEVELS,
  emptyRoot: s(new MerkleTree().root()),
  coin: COIN,
  recipient: RECIPIENT,
  relayer: RELAYER,
  planter: PLANTER,
  plantFee: s(PLANT_FEE),
  intentFee: s(INTENT_FEE),
  accRpt: s(ACC_RPT),
  alice: { pk: s(alice.pk), address: alice.address(), handle1: s(alice.handle(1)), handle2: s(alice.handle(2)), handle3: s(alice.handle(3)) },
  bob: { pk: s(bob.pk), address: bob.address() },
  coordinator: { ecSk: s(coord.sk), ecPk: coord.pk.map(s) },
  leaves: tree.elements.map(s),
  checkpoints: tree.checkpoints.map(deep),
  finalRoot: s(tree.root()),
  results,
  resultChunks: [{ start: resStart, leaves: [0, 1, 2].map((i) => s(tree.leaf(resStart + i))) }, { start: voidStart, leaves: [s(tree.leaf(voidStart))] }],
  checkpointAfterResults: deep(ckResults),
  cases,
};
writeFileSync(join(outDir, "scenario.json"), JSON.stringify(scenario, null, 2) + "\n");
log(`scenario.json: ${cases.length} cases, ${tree.length} leaves, ${tree.checkpoints.length} checkpoints -> ${outDir}`);

if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
