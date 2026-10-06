// Deterministic end-to-end scenario shared by test/zk.test.mjs and scripts/fixtures.mjs.
// Keys and blindings are derived from labels so commitments, nullifiers and roots are
// reproducible; only the Groth16 randomness and the note encryption (ephemeral key + nonce)
// differ between runs.
import { keccak256, toUtf8Bytes } from "ethers";
import { Keypair, Utxo, MerkleTree, prepareTransaction, poseidon, FIELD_SIZE } from "../lib/grove-zk.mjs";

export const RECIPIENT = "0x1111111111111111111111111111111111111111";
export const RELAYER = "0x2222222222222222222222222222222222222222";
export const ETH = 10n ** 18n;

export const label = (s) => BigInt(keccak256(toUtf8Bytes(s))) % FIELD_SIZE;
export const key = (s) => Keypair.fromPrivkey(label("grove-key:" + s));
export const blind = (s) => label("grove-blinding:" + s);
/** zero-amount padding UTXO with a deterministic keypair (unique nullifier per label) */
export const dummyIn = (s) => new Utxo({ amount: 0n, keypair: key("dummy-in:" + s), blinding: blind("dummy-in:" + s), index: 0 });
export const dummyOut = (s) => new Utxo({ amount: 0n, keypair: key("dummy-out:" + s), blinding: blind("dummy-out:" + s) });

export const DEPOSIT_FOR_AMOUNT = 25n * ETH / 100n; // 0.25 BNB
export const DEPOSIT_FOR_BLINDING = 12345n;

/**
 * Runs the whole scenario against a fresh MerkleTree.
 * @param {{wasm: string|Uint8Array, zkey: string|Uint8Array, onStep?: (step) => void}} o
 * @returns {Promise<{steps: object[], tree: MerkleTree, alice: Keypair, bob: Keypair}>}
 */
export async function runScenario({ wasm, zkey, onStep = () => {} }) {
  const alice = key("alice");
  const bob = key("bob");
  const tree = new MerkleTree();
  const steps = [];

  const insertOutputs = (tx) => {
    for (const u of tx.outputs) u.index = tree.insert(u.commitment());
  };
  const record = (step) => {
    steps.push(step);
    onStep(step);
    return step;
  };

  // (a) Alice deposits 1 BNB
  const aliceNote = new Utxo({ amount: ETH, keypair: alice, blinding: blind("a-out0") });
  const a = await prepareTransaction({
    tree,
    inputs: [dummyIn("a0"), dummyIn("a1")],
    outputs: [aliceNote, dummyOut("a1")],
    extAmount: ETH,
    fee: 0n,
    wasm,
    zkey,
  });
  insertOutputs(a);
  record({ name: "deposit", kind: "transact", tx: a, value: ETH, rootAfter: tree.root() });

  // (b) Alice -> Bob 0.4 BNB privately, 0.6 change
  const bobNote = new Utxo({ amount: 4n * ETH / 10n, keypair: bob, blinding: blind("b-out0") });
  const aliceChange = new Utxo({ amount: 6n * ETH / 10n, keypair: alice, blinding: blind("b-out1") });
  const b = await prepareTransaction({
    tree,
    inputs: [aliceNote, dummyIn("b1")],
    outputs: [bobNote, aliceChange],
    extAmount: 0n,
    fee: 0n,
    wasm,
    zkey,
  });
  insertOutputs(b);
  record({ name: "transfer", kind: "transact", tx: b, value: 0n, rootAfter: tree.root() });

  // (c) Bob withdraws his 0.4 BNB: 0.39 to RECIPIENT, 0.01 fee to RELAYER (extAmount = -(0.4 - fee))
  const fee = ETH / 100n;
  const withdrawAmount = bobNote.amount - fee;
  const c = await prepareTransaction({
    tree,
    inputs: [bobNote, dummyIn("c1")],
    outputs: [dummyOut("c0"), dummyOut("c1")],
    extAmount: -withdrawAmount,
    fee,
    recipient: RECIPIENT,
    relayer: RELAYER,
    wasm,
    zkey,
  });
  insertOutputs(c);
  record({
    name: "withdraw",
    kind: "transact",
    tx: c,
    value: 0n,
    recipientGets: withdrawAmount,
    relayerGets: fee,
    rootAfter: tree.root(),
  });

  // (d) depositFor(bobPubkey, 12345) with 0.25 BNB: commitment computed on-chain
  const bobDeposit = new Utxo({ amount: DEPOSIT_FOR_AMOUNT, keypair: bob, blinding: DEPOSIT_FOR_BLINDING });
  const expected = poseidon([DEPOSIT_FOR_AMOUNT, bob.pubkey, DEPOSIT_FOR_BLINDING]);
  if (expected !== bobDeposit.commitment()) throw new Error("commitment mismatch");
  bobDeposit.index = tree.insert(bobDeposit.commitment());
  record({
    name: "depositFor",
    kind: "depositFor",
    pubKey: bob.pubkey,
    blinding: DEPOSIT_FOR_BLINDING,
    value: DEPOSIT_FOR_AMOUNT,
    commitment: bobDeposit.commitment(),
    index: bobDeposit.index,
    rootAfter: tree.root(),
  });

  // Bob spends the depositFor note: withdraw everything to RECIPIENT, no fee
  const d = await prepareTransaction({
    tree,
    inputs: [bobDeposit, dummyIn("d1")],
    outputs: [dummyOut("d0"), dummyOut("d1")],
    extAmount: -DEPOSIT_FOR_AMOUNT,
    fee: 0n,
    recipient: RECIPIENT,
    wasm,
    zkey,
  });
  insertOutputs(d);
  record({
    name: "spendDepositFor",
    kind: "transact",
    tx: d,
    value: 0n,
    recipientGets: DEPOSIT_FOR_AMOUNT,
    relayerGets: 0n,
    rootAfter: tree.root(),
  });

  return { steps, tree, alice, bob, aliceNote, bobNote, aliceChange, bobDeposit };
}
