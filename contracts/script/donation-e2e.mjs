// Helper for script/DonationE2E.s.sol (BNB testnet only).
//
//   node script/donation-e2e.mjs key
//     -> prints the deterministic test cause key as env lines (CAUSE_A_PUBKEY / CAUSE_A_ENCKEY / CAUSE_A_ADDRESS).
//        privkey = keccak256("zkbnb donation e2e cause A") mod p. Test key, testnet only: do not reuse.
//
//   node script/donation-e2e.mjs notes [rpcUrl] [fromBlock]
//     -> scans the ShieldedPool's DepositFor / NewNullifier events for that key with grove-zk scanNotes and prints
//        every note it owns (amount, leaf index, nullifier, spent or not). Proves a shielded payout is visible to
//        the cause's key and spendable by it (the nullifier can only be computed with the private key).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonRpcProvider, Contract, keccak256, toUtf8Bytes, formatEther, zeroPadValue, toBeHex } from "../../circuits/node_modules/ethers/lib.esm/index.js";
import { init, Keypair, FIELD_SIZE, scanNotes } from "../../circuits/lib/grove-zk.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const dep = JSON.parse(readFileSync(join(here, "..", "deployments", "97.json"), "utf8"));
const cmd = process.argv[2] ?? "key";

await init();
const privkey = BigInt(keccak256(toUtf8Bytes("zkbnb donation e2e cause A"))) % FIELD_SIZE;
const kp = Keypair.fromPrivkey(privkey);
const encKey = "0x" + Buffer.from(kp.encPub).toString("hex");

if (cmd === "key") {
  console.log(`CAUSE_A_PUBKEY=${kp.pubkey.toString()}`);
  console.log(`CAUSE_A_ENCKEY=${encKey}`);
  console.log(`CAUSE_A_ADDRESS=${kp.address()}`);
  process.exit(0);
}

if (cmd === "notes") {
  const rpc = process.argv[3] ?? "https://bsc-testnet-rpc.publicnode.com";
  const provider = new JsonRpcProvider(rpc, 97, { staticNetwork: true });
  const pool = new Contract(
    dep.shieldedPool,
    ["event DepositFor(uint256 indexed pubKey, uint256 amount, uint256 blinding, uint256 index, address indexed from)", "event NewNullifier(uint256 nullifier)"],
    provider,
  );
  const latest = BigInt(await provider.getBlockNumber());
  const fromBlock = BigInt(process.argv[4] ?? dep.startBlock);
  const depositsFor = [];
  const nullifiers = new Set();
  const STEP = 45_000n;
  const pubTopic = zeroPadValue(toBeHex(kp.pubkey), 32);
  for (let b = fromBlock; b <= latest; b += STEP) {
    const to = b + STEP - 1n > latest ? latest : b + STEP - 1n;
    const [d, n] = await Promise.all([pool.queryFilter(pool.filters.DepositFor(pubTopic), b, to), pool.queryFilter(pool.filters.NewNullifier(), b, to)]);
    for (const l of d) depositsFor.push({ pubKey: l.args.pubKey, amount: l.args.amount, blinding: l.args.blinding, index: l.args.index, tx: l.transactionHash });
    for (const l of n) nullifiers.add(l.args.nullifier);
  }
  const { unspent, spent } = scanNotes({ keypair: kp, depositsFor, nullifiers });
  const out = {
    pubKey: kp.pubkey.toString(),
    depositsFor: depositsFor.map((d) => ({ amount: d.amount.toString(), index: Number(d.index), tx: d.tx })),
    unspent: unspent.map((u) => ({ amount: u.amount.toString(), bnb: formatEther(u.amount), index: u.index, commitment: u.commitment().toString(), nullifier: u.nullifier().toString() })),
    spent: spent.map((u) => ({ amount: u.amount.toString(), index: u.index })),
  };
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

console.error(`unknown command ${cmd}`);
process.exit(1);
