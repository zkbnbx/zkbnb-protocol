import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decodeFunctionData, getAddress, type Address } from "viem";
import { destroyableGens, OVERLAP, proposalDecision, rotateKey, rotationStatePath, safeBatch } from "../src/commands/rotateKey.js";
import { darkCurveAbi } from "../src/abis.js";
import { elgamal } from "../src/elgamal.js";
import { keyFileName, loadCoordinatorKeys, pkId, writeKeyFile } from "../src/coordinatorKeys.js";
import type { Ctx, TxResult } from "../src/chain.js";
import type { Deployments, KeeperConfig } from "../src/config.js";
import type { Point } from "../src/babyjub.js";

const DAY = 86_400;
const CFG = { rotateEverySec: DAY, rotateLeadSec: 3600 };
const DARK = getAddress("0xdc00000000000000000000000000000000000001");
const POOL = getAddress("0x9001000000000000000000000000000000000001");
const LAUNCHPAD = getAddress("0x1a00000000000000000000000000000000000001");
const SAFE = getAddress("0x5afe000000000000000000000000000000000001");
const KEEPER = getAddress("0xcee9000000000000000000000000000000000001");
const COIN = getAddress("0xa000000000000000000000000000000000000001");

describe("proposal timing (pure)", () => {
  const T = 1_800_000_000;
  it("proposes once a day, switchAt = now + 1 h", () => {
    expect(proposalDecision({ now: T, keySwitchAt: 0 }, { lastProposedAt: 0 }, CFG)).toEqual({ action: "propose", switchAt: T + 3600 });
    expect(proposalDecision({ now: T, keySwitchAt: 0 }, { lastProposedAt: T - DAY + 1 }, CFG)).toEqual({ action: "wait", reason: "not-due" });
    expect(proposalDecision({ now: T, keySwitchAt: 0 }, { lastProposedAt: T - DAY }, CFG)).toMatchObject({ action: "propose" });
  });
  it("never proposes while a key is pending on-chain", () => {
    expect(proposalDecision({ now: T, keySwitchAt: T + 10 }, { lastProposedAt: 0 }, CFG)).toEqual({ action: "wait", reason: "pending-on-chain" });
    // once switchAt has passed the pending key is the active one and the next rotation may be proposed
    expect(proposalDecision({ now: T, keySwitchAt: T }, { lastProposedAt: T - DAY }, CFG)).toMatchObject({ action: "propose" });
  });
  it("waits for the Safe until the proposal can no longer execute, then discards it", () => {
    const pending = { pk: ["1", "2"] as [string, string], switchAt: T + 3600, proposedAt: T, via: "safe" as const };
    expect(proposalDecision({ now: T + 100, keySwitchAt: 0 }, { lastProposedAt: T, pending }, CFG)).toEqual({ action: "wait", reason: "awaiting-safe" });
    expect(proposalDecision({ now: T + 3600 - OVERLAP, keySwitchAt: 0 }, { lastProposedAt: T, pending }, CFG)).toEqual({ action: "wait", reason: "awaiting-safe" });
    expect(proposalDecision({ now: T + 3600 - OVERLAP + 1, keySwitchAt: 0 }, { lastProposedAt: T, pending }, CFG)).toEqual({ action: "discard-stale" });
  });
});

describe("destruction rule (pure)", () => {
  const ep = (keyId: number, status: number, count: number) => ({ keyId, status, count });
  it("only below the active generation and only when no collecting epoch uses the key", () => {
    expect(destroyableGens(1, [0], [ep(0, 1, 3)])).toEqual([]); // last epoch under gen 0 still collecting
    expect(destroyableGens(1, [0], [ep(0, 2, 3), ep(1, 1, 1)])).toEqual([0]); // opened: destroy
    expect(destroyableGens(1, [0], [ep(0, 3, 1)])).toEqual([0]); // voided: destroy
    expect(destroyableGens(1, [1], [])).toEqual([]); // the active key is never destroyed
    expect(destroyableGens(2, [0, 1], [ep(1, 1, 2)])).toEqual([0]);
  });
});

describe("rotate-key pass", () => {
  let dir: string;
  let snap: string;
  beforeEach(() => {
    snap = fs.mkdtempSync(path.join(os.tmpdir(), "rotate-"));
    dir = path.join(snap, "keys");
  });
  afterEach(() => {
    fs.rmSync(snap, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  interface Chain {
    now: number;
    keyGen: number;
    keySwitchAt: number;
    keys: Record<number, Point>;
    epochs: { status: number; count: number; keyId: number }[];
  }

  function makeCtx(chain: Chain, chainId: number, owner: Address) {
    const readContract = vi.fn(async (p: { functionName: string; args?: readonly unknown[] }) => {
      switch (p.functionName) {
        case "keySwitchAt":
          return BigInt(chain.keySwitchAt);
        case "keyGen":
          return chain.keyGen;
        case "activeCoordinatorKey": {
          const g = chain.keySwitchAt !== 0 && chain.now >= chain.keySwitchAt ? chain.keyGen + 1 : chain.keyGen;
          return [[...chain.keys[g]], g];
        }
        case "keyByGen": {
          const k = chain.keys[Number(p.args![0])] ?? [0n, 0n];
          return k[Number(p.args![1])];
        }
        case "owner":
          return owner;
        case "allCoins":
          return [COIN];
        case "epochsOf":
          return [chain.epochs.map((e) => ({ ...e, startedAt: 1n, refPrice: 0n, refVb: 0n, c1: { x: 0n, y: 1n, t: 0n, z: 1n }, c2: { x: 0n, y: 1n, t: 0n, z: 1n } }))];
        default:
          throw new Error(`unexpected read ${p.functionName}`);
      }
    });
    const dep = { launchpad: LAUNCHPAD, grovePool: POOL, darkCurve: DARK, startBlock: 1 } as Deployments;
    const cfg = { chainId, dryRun: false, snapshotDir: snap } as KeeperConfig;
    return { cfg, dep, pub: { readContract, getBlock: async () => ({ timestamp: BigInt(chain.now) }) }, account: { address: KEEPER }, txLock: Promise.resolve() } as unknown as Ctx;
  }

  const env = () => ({ COORDINATOR_KEY_DIR: dir }) as NodeJS.ProcessEnv;

  it("chain 56: writes a 0600 key file and a Safe batch; destroys the old key only after its last epoch closes", async () => {
    const T = 1_800_000_000;
    const oldSk = 42_424_242n;
    const old = writeKeyFile(dir, oldSk, T - 2 * DAY);
    const chain: Chain = { now: T, keyGen: 0, keySwitchAt: 0, keys: { 0: old.pk }, epochs: [{ status: 1, count: 2, keyId: 0 }, { status: 0, count: 0, keyId: 0 }, { status: 0, count: 0, keyId: 0 }] };
    const send = vi.fn();
    const newSk = 987_654_321_123n;

    // pass 1: propose through the Safe (chain 56, keeper is not the owner)
    const r1 = await rotateKey(makeCtx(chain, 56, SAFE), env(), { newSecret: () => newSk, send });
    expect(send).not.toHaveBeenCalled();
    expect(r1.proposed).toMatchObject({ via: "safe", switchAt: T + 3600 });
    const newPk = elgamal.publicKey(newSk);
    const keyFile = path.join(dir, keyFileName(newPk));
    expect(fs.existsSync(keyFile)).toBe(true);
    if (process.platform !== "win32") expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
    const batch = JSON.parse(fs.readFileSync(r1.proposed!.file!, "utf8")) as ReturnType<typeof safeBatch>;
    expect(batch.chainId).toBe("56");
    expect(batch.transactions[0].to).toBe(DARK);
    const call = decodeFunctionData({ abi: darkCurveAbi, data: batch.transactions[0].data as `0x${string}` });
    expect(call.functionName).toBe("setCoordinatorKey");
    expect(call.args).toEqual([[newPk[0], newPk[1]], BigInt(T + 3600)]);
    // the secret never appears in the proposal or the state file
    expect(fs.readFileSync(r1.proposed!.file!, "utf8")).not.toContain(newSk.toString());
    expect(fs.readFileSync(rotationStatePath(dir), "utf8")).not.toContain(newSk.toString());

    // pass 2 (an hour later, the Safe executed; switch passed): old key still has a collecting epoch -> kept
    chain.now = T + 3700;
    chain.keys[1] = newPk;
    chain.keySwitchAt = T + 3600;
    const r2 = await rotateKey(makeCtx(chain, 56, SAFE), env(), { newSecret: () => 1n, send });
    expect(r2.decision).toBe("wait"); // not a day since the last proposal
    expect(r2.kept).toEqual([0]);
    expect(r2.destroyed).toEqual([]);
    expect(fs.existsSync(old.file)).toBe(true);

    // pass 3: the old key's epoch was opened -> the old key file is overwritten and removed, KeyDestroyed logged
    chain.epochs[0] = { status: 2, count: 2, keyId: 0 };
    chain.epochs[1] = { status: 1, count: 1, keyId: 1 };
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
    const r3 = await rotateKey(makeCtx(chain, 56, SAFE), env(), { newSecret: () => 1n, send });
    expect(r3.destroyed).toHaveLength(1);
    expect(fs.existsSync(old.file)).toBe(false);
    expect(fs.existsSync(keyFile)).toBe(true);
    expect(lines.join("\n")).toMatch(new RegExp(`KeyDestroyed gen=0 pk=\\["${old.pk[0]}","${old.pk[1]}"\\]`));
    expect(lines.join("\n")).not.toContain(oldSk.toString());
    const keys = loadCoordinatorKeys(dir, {});
    expect([...keys.keys()]).toEqual([pkId(newPk)]);
  });

  it("chain 97 with the keeper as owner: sends setCoordinatorKey directly", async () => {
    const T = 1_800_000_000;
    const old = writeKeyFile(dir, 777n, T - DAY);
    const chain: Chain = { now: T, keyGen: 0, keySwitchAt: 0, keys: { 0: old.pk }, epochs: [] };
    const send = vi.fn(async () => ({ dryRun: false, status: "success", hash: "0xabc", result: undefined }) as TxResult);
    const r = await rotateKey(makeCtx(chain, 97, KEEPER), env(), { newSecret: () => 31337n, send });
    expect(r.proposed).toMatchObject({ via: "direct", hash: "0xabc" });
    const p = (send.mock.calls[0] as unknown[])[1] as { functionName: string; args: unknown[] };
    expect(p.functionName).toBe("setCoordinatorKey");
    const pk = elgamal.publicKey(31337n);
    expect(p.args).toEqual([[pk[0], pk[1]], BigInt(T + 3600)]);
  });

  it("is inert without darkCurve", async () => {
    const ctx = { dep: { startBlock: 1 }, cfg: { snapshotDir: "x" }, pub: { readContract: vi.fn() } } as unknown as Ctx;
    expect(await rotateKey(ctx, env())).toMatchObject({ inert: true });
    expect((ctx.pub.readContract as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });
});
