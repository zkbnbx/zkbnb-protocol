/**
 * Chain reads and calls of the relayer — privacy/PRIVACY-SPEC.md §5.3.
 *
 * `readPolicyInput` fills `OnChainPolicyInput` (Coordinator keys, keySwitchAt, plantFee, seenC1) plus the chain time
 * with ONE batch of eth_calls: the keeper's transport batches JSON-RPC (`http(url, { batch: true })`), so the reads
 * issued together below travel as one HTTP request. `keyGen` is cached between requests (it changes once a day);
 * when the batch shows it moved, the batch is re-issued once with the new generation.
 *
 * `callOf` maps a parsed request to the contract call the relayer sends (stage-2 ABIs are the generated ones,
 * stage-1 fragments are hand-written from contracts/src/{ShieldedPool,DarkPool,DarkVault}.sol).
 */
import { parseAbi, type Abi, type Address, type PublicClient } from "viem";
import { darkCurveAbi, grovePoolAbi } from "../abis.js";
import type { Hex, OnChainPolicyInput, ParsedRequest } from "./protocol.js";
import type { HoldEpochState } from "./policy.js";
import { stateKey } from "./held.js";

export const launchpadPlantFeeAbi = parseAbi(["function plantFee() view returns (uint256)"]);

const PROOF1 = "(uint256[2] a, uint256[2][2] b, uint256[2] c, uint256 root, uint256 publicAmount, bytes32 extDataHash, uint256[2] inputNullifiers, uint256[2] outputCommitments)";
const EXT1 = "(address recipient, int256 extAmount, address relayer, uint256 fee, bytes encryptedOutput1, bytes encryptedOutput2)";
const ORDER = "(address coin, uint256 bnbIn, uint256 minTokensOut, address owner, uint64 deadline, bytes32 nonce)";

/** ShieldedPool.transact (stage 1, v1 pool). */
export const shieldedPoolAbi = parseAbi([`function transact(${PROOF1} p, ${EXT1} extData) payable`]);
/** DarkPool (stage 1). */
export const darkPoolAbi = parseAbi([
  `function transactAndFill(${PROOF1} p, ${EXT1} e, ${ORDER} o) returns (address vault)`,
  `function fill(${ORDER} o) returns (address vault)`,
  `function vaultFor(${ORDER} o) view returns (address)`,
  "function isVault(address) view returns (bool)",
]);
/** DarkVault.relay (stage 1). */
export const darkVaultAbi = parseAbi(["function relay(bytes data, uint256 fee, uint256 deadline, bytes sig)"]);

export interface RelayerAddresses {
  shieldedPool: Address;
  darkPool?: Address;
  launchpad: Address;
  grovePool?: Address;
  darkCurve?: Address;
  planter?: Address;
}

type Reader = Pick<PublicClient, "readContract" | "getBlock">;

export interface PolicyInputResult {
  onChain: OnChainPolicyInput;
  /** chain time (latest block timestamp), seconds */
  now: number;
}

/** keyGen cache shared across requests. */
export interface KeyGenCache {
  gen?: number;
}

/**
 * One eth_call batch: keyGen, keySwitchAt, keyByGen(gen, 0..1), keyByGen(gen + 1, 0..1), plantFee, seenC1(c1x),
 * latest block. `c1x` is the request's C1.x (intents); 0 otherwise.
 */
export async function readPolicyInput(pub: Reader, a: { darkCurve: Address; launchpad: Address }, c1x: bigint, cache: KeyGenCache): Promise<PolicyInputResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const gen = BigInt(cache.gen ?? 0);
    const dc = { address: a.darkCurve, abi: darkCurveAbi as unknown as Abi };
    const [keyGen, keySwitchAt, k0x, k0y, k1x, k1y, plantFee, seen, block] = await Promise.all([
      pub.readContract({ ...dc, functionName: "keyGen" }),
      pub.readContract({ ...dc, functionName: "keySwitchAt" }),
      pub.readContract({ ...dc, functionName: "keyByGen", args: [gen, 0n] }),
      pub.readContract({ ...dc, functionName: "keyByGen", args: [gen, 1n] }),
      pub.readContract({ ...dc, functionName: "keyByGen", args: [gen + 1n, 0n] }),
      pub.readContract({ ...dc, functionName: "keyByGen", args: [gen + 1n, 1n] }),
      pub.readContract({ address: a.launchpad, abi: launchpadPlantFeeAbi, functionName: "plantFee" }),
      pub.readContract({ ...dc, functionName: "seenC1", args: [c1x] }),
      pub.getBlock({ blockTag: "latest" }),
    ]);
    if (Number(keyGen) !== Number(gen) && attempt === 0) {
      cache.gen = Number(keyGen);
      continue;
    }
    cache.gen = Number(keyGen);
    const s = (x: unknown) => BigInt(x as bigint).toString();
    return {
      onChain: {
        coordinatorKey: [
          [s(k0x), s(k0y)],
          [s(k1x), s(k1y)],
        ],
        keySwitchAt: Number(keySwitchAt),
        plantFee: s(plantFee),
        seenC1: Boolean(seen),
      },
      now: Number(block.timestamp),
    };
  }
  throw new Error("unreachable");
}

/** The watched epoch of each held (coin, dir) plus params.tMax and chain time, in one batch. */
export async function readHoldStates(pub: Reader, darkCurve: Address, keys: readonly { coin: Hex; dir: number }[]): Promise<{ now: number; states: Map<string, HoldEpochState> }> {
  const dc = { address: darkCurve, abi: darkCurveAbi as unknown as Abi };
  const [block, params, ...seqs] = await Promise.all([
    pub.getBlock({ blockTag: "latest" }),
    pub.readContract({ ...dc, functionName: "params" }),
    ...keys.map((k) => pub.readContract({ ...dc, functionName: "cur", args: [k.coin, BigInt(k.dir)] })),
  ]);
  const tMax = Number((params as readonly unknown[])[1]);
  const eps = await Promise.all(keys.map((k, i) => pub.readContract({ ...dc, functionName: "epochOf", args: [k.coin, k.dir, Number(seqs[i])] })));
  const states = new Map<string, HoldEpochState>();
  keys.forEach((k, i) => {
    const e = eps[i] as { startedAt: bigint; status: number; count: number };
    states.set(stateKey(k.coin, k.dir), { seq: Number(seqs[i]), status: Number(e.status), count: Number(e.count), startedAt: Number(e.startedAt), tMax });
  });
  return { now: Number(block.timestamp), states };
}

export interface Call {
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
}

/** The transaction a stage-2 request becomes (stage-1 calls are built by the server, which also reads vault state). */
export function callOf(r: ParsedRequest, a: RelayerAddresses): Call {
  const gp = (fn: string, args: readonly unknown[]): Call => {
    if (!a.grovePool) throw new Error("grovePool not deployed");
    return { address: a.grovePool, abi: grovePoolAbi as unknown as Abi, functionName: fn, args };
  };
  const dc = (fn: string, args: readonly unknown[]): Call => {
    if (!a.darkCurve) throw new Error("darkCurve not deployed");
    return { address: a.darkCurve, abi: darkCurveAbi as unknown as Abi, functionName: fn, args };
  };
  switch (r.kind) {
    case "transfer":
    case "plant":
      return gp("transact", [r.proof, r.pub, r.extData]);
    case "v1migrate":
      return gp("migrateFromV1", [r.proof, r.extData, r.handle]);
    case "intent":
      return dc("submitIntent", [r.proof, r.pub, r.extData]);
    case "claim":
      return dc("claim", [r.proof, r.pub, r.extData]);
    case "transact":
      return { address: a.shieldedPool, abi: shieldedPoolAbi as unknown as Abi, functionName: "transact", args: [r.proof, r.extData] };
    default:
      throw new Error(`callOf: ${r.kind} is built by the server`);
  }
}
