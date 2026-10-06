/**
 * Integration check: a snapshot built by the keeper's Merkle code must be claimable through the
 * real HolderRewards contract. Deploys HolderRewards on a running anvil, tips a pot, posts a run
 * with a TS-built root, then claims for every leaf.
 *
 *   anvil --port 8599 &
 *   npx tsx scripts/anvil-merkle-check.ts [rpcUrl]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, parseEther, getAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { holderRewardsAbi } from "../src/abis.js";
import { allocate } from "../src/allocation.js";
import { buildSnapshot, verifySnapshot } from "../src/snapshot.js";

const rpc = process.argv[2] ?? "http://127.0.0.1:8599";
const here = path.dirname(fileURLToPath(import.meta.url));
const artifact = path.resolve(here, "..", "..", "contracts", "out", "HolderRewards.sol", "HolderRewards.json");
const { abi, bytecode } = JSON.parse(fs.readFileSync(artifact, "utf8")) as { abi: unknown[]; bytecode: { object: Hex } };

// anvil's default keys
const KEYS: Hex[] = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
];
const accounts = KEYS.map((k) => privateKeyToAccount(k));
const pub = createPublicClient({ chain: foundry, transport: http(rpc) });
const wallet = (i: number) => createWalletClient({ chain: foundry, transport: http(rpc), account: accounts[i] });

async function main() {
  const keeper = accounts[0];
  const hash = await wallet(0).deployContract({ abi: abi as never, bytecode: bytecode.object, args: [keeper.address, keeper.address, keeper.address] });
  const rc = await pub.waitForTransactionReceipt({ hash });
  const hr = rc.contractAddress!;
  console.log("HolderRewards deployed", hr);

  const coin = getAddress("0x000000000000000000000000000000000000c01f");
  const pot = parseEther("1");
  await pub.waitForTransactionReceipt({ hash: await wallet(3).writeContract({ address: hr, abi: holderRewardsAbi, functionName: "tip", args: [coin], value: pot }) });

  const holders = [1, 2, 3].map((i, k) => ({ account: accounts[i].address as Address, balance: parseEther(String((k + 1) * 10)) }));
  const shares = allocate(pot, holders);
  const runId = await pub.readContract({ address: hr, abi: holderRewardsAbi, functionName: "runCount", args: [coin] });
  const snap = buildSnapshot({ coin, runId, shares, snapshotBlock: rc.blockNumber, takenAt: Math.floor(Date.now() / 1000), minHoldingWei: 0n, excluded: [] });
  if (!verifySnapshot(snap.json)) throw new Error("local verify failed");

  // leaf() on-chain must equal our leafHash
  for (const l of snap.json.leaves) {
    const onchain = await pub.readContract({ address: hr, abi: holderRewardsAbi, functionName: "leaf", args: [coin, runId, l.account, BigInt(l.amount)] });
    const { leafHash } = await import("../src/merkle.js");
    if (onchain !== leafHash(coin, runId, l.account, BigInt(l.amount))) throw new Error("leaf layout mismatch");
  }

  const post = await wallet(0).writeContract({ address: hr, abi: holderRewardsAbi, functionName: "postRun", args: [coin, snap.root, snap.amount, BigInt(snap.json.holders), "anvil://check"] });
  await pub.waitForTransactionReceipt({ hash: post });
  console.log("run posted", { runId, root: snap.root, amount: snap.amount.toString() });

  for (const l of snap.json.leaves) {
    const idx = accounts.findIndex((a) => a.address.toLowerCase() === l.account.toLowerCase());
    const before = await pub.getBalance({ address: l.account });
    const h = await wallet(idx).writeContract({ address: hr, abi: holderRewardsAbi, functionName: "claim", args: [coin, runId, BigInt(l.amount), l.proof] });
    const r = await pub.waitForTransactionReceipt({ hash: h });
    if (r.status !== "success") throw new Error(`claim reverted for ${l.account}`);
    const after = await pub.getBalance({ address: l.account });
    const gas = r.gasUsed * r.effectiveGasPrice;
    if (after + gas - before !== BigInt(l.amount)) throw new Error(`claim paid wrong amount for ${l.account}`);
    console.log("claimed", l.account, l.amount, "proof length", l.proof.length);
  }
  // a wrong amount must be rejected
  const bad = snap.json.leaves[0];
  try {
    await pub.simulateContract({ address: hr, abi: holderRewardsAbi, functionName: "claim", args: [coin, runId, BigInt(bad.amount) + 1n, bad.proof], account: accounts[1] });
    throw new Error("tampered claim did not revert");
  } catch (e) {
    const msg = String(e);
    if (!msg.includes("BadProof") && !msg.includes("0x646cf558")) throw e;
    console.log("tampered claim reverted with BadProof as expected");
  }
  console.log("OK: every TS proof verified on-chain through HolderRewards.claim");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
