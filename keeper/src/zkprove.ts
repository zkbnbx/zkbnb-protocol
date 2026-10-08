/**
 * epochOpen proofs for the Epoch Coordinator — privacy/PRIVACY-SPEC.md §3.4, workplan §4.1.
 *
 * Public signals, in this order (frozen; DarkCurve.verifyOpen builds the same array):
 *   [ecPkX, ecPkY, c1X, c1Y, c2X, c2Y, u]        private: ecSk
 * Artifacts: `OPEN_WASM` / `OPEN_ZKEY` (circuits/build/epochOpen.{wasm,zkey}); optional `OPEN_VKEY` for a local
 * verify before sending. Proving keys in circuits/build are DEV keys until the ceremony (circuits/CEREMONY-v2.md).
 */
import { existsSync, readFileSync } from "node:fs";
import { groth16, type Groth16Proof } from "snarkjs";
import { BASE8, eq, mul, type Point } from "./babyjub.js";
import { elgamal, SUM_BITS, type SummedCiphertext } from "./elgamal.js";

/** GrovePool.Proof: b coordinates swapped as the Solidity verifier expects. */
export interface SolidityProof {
  a: [bigint, bigint];
  b: [[bigint, bigint], [bigint, bigint]];
  c: [bigint, bigint];
}

export interface OpenArtifacts {
  wasm: string;
  zkey: string;
  vkey?: string;
}

export interface OpenProof {
  proof: SolidityProof;
  /** decimal strings, order above */
  publicSignals: string[];
  snarkProof: Groth16Proof;
  ms: number;
}

/** Artifact paths: explicit > env (OPEN_WASM, OPEN_ZKEY, OPEN_VKEY). Throws if a required file is missing. */
export function openArtifacts(over: Partial<OpenArtifacts> = {}, env: NodeJS.ProcessEnv = process.env): OpenArtifacts {
  const wasm = over.wasm ?? env.OPEN_WASM;
  const zkey = over.zkey ?? env.OPEN_ZKEY;
  const vkey = over.vkey ?? env.OPEN_VKEY;
  if (!wasm || !zkey) throw new Error("OPEN_WASM and OPEN_ZKEY must point to circuits/build/epochOpen.{wasm,zkey}");
  for (const [name, p] of [["OPEN_WASM", wasm], ["OPEN_ZKEY", zkey], ["OPEN_VKEY", vkey]] as const) {
    if (p && !existsSync(p)) throw new Error(`${name} not found: ${p}`);
  }
  return { wasm, zkey, vkey };
}

export function proofToSolidity(p: Groth16Proof): SolidityProof {
  return {
    a: [BigInt(p.pi_a[0]), BigInt(p.pi_a[1])],
    b: [
      [BigInt(p.pi_b[0][1]), BigInt(p.pi_b[0][0])],
      [BigInt(p.pi_b[1][1]), BigInt(p.pi_b[1][0])],
    ],
    c: [BigInt(p.pi_c[0]), BigInt(p.pi_c[1])],
  };
}

/** The public-signal vector the contract will verify against. */
export function openPublicSignals(ecPk: Point, sum: Pick<SummedCiphertext, "c1" | "c2">, u: bigint): string[] {
  return [ecPk[0], ecPk[1], sum.c1[0], sum.c1[1], sum.c2[0], sum.c2[1], u].map((x) => BigInt(x).toString());
}

/**
 * Proves that the summed ciphertext decrypts to u under ecSk. Checks M == u·B8 first (cheap) so a wrong u never
 * costs a proving run, and checks that snarkjs returned the public signals in the frozen order.
 */
export async function proveOpen(
  args: { ecSk: bigint; sum: SummedCiphertext; u: bigint },
  artifacts: OpenArtifacts = openArtifacts(),
): Promise<OpenProof> {
  const { ecSk, sum, u } = args;
  if (u < 0n || u >= 1n << BigInt(SUM_BITS)) throw new Error("u out of range (< 2^40)");
  const ecPk = elgamal.publicKey(ecSk);
  if (!eq(elgamal.decrypt(sum, ecSk), mul(u, BASE8))) throw new Error("the summed ciphertext does not decrypt to u");
  const input = {
    ecPk: ecPk.map(String),
    C1: sum.c1.map(String),
    C2: sum.c2.map(String),
    u: u.toString(),
    ecSk: ecSk.toString(),
  };
  const t0 = Date.now();
  const { proof, publicSignals } = await groth16.fullProve(input, artifacts.wasm, artifacts.zkey);
  const expected = openPublicSignals(ecPk, sum, u);
  if (publicSignals.length !== 7 || publicSignals.some((s, i) => s !== expected[i])) {
    throw new Error("epochOpen public signals are not in the frozen order [ecPkX, ecPkY, c1X, c1Y, c2X, c2Y, u]");
  }
  return { proof: proofToSolidity(proof), publicSignals, snarkProof: proof, ms: Date.now() - t0 };
}

/** Local Groth16 verification against a verification_key_epochOpen.json. */
export async function verifyOpen(vkeyPath: string, publicSignals: string[], proof: Groth16Proof): Promise<boolean> {
  const vkey = JSON.parse(readFileSync(vkeyPath, "utf8"));
  return groth16.verify(vkey, publicSignals, proof);
}

/** Releases snarkjs' bn128 worker threads (call once when the process is done proving). */
export async function shutdownProver(): Promise<void> {
  const g = globalThis as { curve_bn128?: { terminate?: () => Promise<void> } };
  if (g.curve_bn128?.terminate) await g.curve_bn128.terminate();
}
