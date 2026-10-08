import { describe, it, expect, afterAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { elgamal } from "../src/elgamal.js";
import { openArtifacts, openPublicSignals, proveOpen, verifyOpen, shutdownProver } from "../src/zkprove.js";

/**
 * One real epochOpen proof with the circuits/build artifacts (DEV proving keys from setup-v2.sh), against the
 * `open_buy` case of contracts/test/fixtures/v2/scenario.json — the same sum the forge fixture test verifies.
 */
const here = dirname(fileURLToPath(import.meta.url));
const build = join(here, "..", "..", "circuits", "build");
const art = {
  wasm: join(build, "epochOpen_js", "epochOpen.wasm"),
  zkey: join(build, "epochOpen.zkey"),
  vkey: join(build, "verification_key_epochOpen.json"),
};
const scenario = JSON.parse(readFileSync(join(here, "..", "..", "contracts", "test", "fixtures", "v2", "scenario.json"), "utf8"));
const openBuy = scenario.cases.find((c: { name: string }) => c.name === "open_buy");
const big = (e: Record<string, string>) => ({ x: BigInt(e.x), y: BigInt(e.y), t: BigInt(e.t), z: BigInt(e.z) });

afterAll(async () => {
  await shutdownProver();
});

describe("zkprove: epochOpen", () => {
  it("artifact paths come from OPEN_WASM / OPEN_ZKEY and must exist", () => {
    expect(() => openArtifacts({}, {})).toThrow(/OPEN_WASM and OPEN_ZKEY/);
    expect(openArtifacts({}, { OPEN_WASM: art.wasm, OPEN_ZKEY: art.zkey })).toEqual({ wasm: art.wasm, zkey: art.zkey, vkey: undefined });
    expect(() => openArtifacts({}, { OPEN_WASM: art.wasm, OPEN_ZKEY: join(build, "missing.zkey") })).toThrow(/OPEN_ZKEY not found/);
  });

  it.runIf(existsSync(art.wasm) && existsSync(art.zkey))(
    "proves the fixture sum, verifies with the vkey, signals in the frozen order, matches the fixture",
    async () => {
      const ecSk = BigInt(openBuy.ecSk);
      const u = BigInt(openBuy.u);
      const sum = elgamal.onChainSum(big(openBuy.sumExtended.c1), big(openBuy.sumExtended.c2), openBuy.ciphertexts.length);
      // the on-chain sum equals the sum of the published per-intent ciphertexts
      const recomputed = elgamal.sumCiphertexts(
        openBuy.ciphertexts.map((c: { c1: string[]; c2: string[] }) => ({ c1: c.c1.map(BigInt), c2: c.c2.map(BigInt) })),
      );
      expect(recomputed.c1).toEqual(sum.c1);

      const minOut = BigInt(openBuy.pub.minOut);
      const r = await proveOpen({ ecSk, sum, u, minOut }, openArtifacts(art));
      const ecPk = elgamal.publicKey(ecSk);
      expect(r.publicSignals).toEqual(openPublicSignals(ecPk, sum, u, minOut));
      // [ecPkX, ecPkY, c1X, c1Y, c2X, c2Y, u, minOut] as the contract fixture records them
      expect(r.publicSignals).toEqual([...openBuy.pub.ecPk, ...openBuy.pub.c1, ...openBuy.pub.c2, openBuy.pub.u, openBuy.pub.minOut].map(String));
      expect(await verifyOpen(art.vkey, r.publicSignals, r.snarkProof)).toBe(true);
      // a different u does not verify with this proof
      const tampered = [...r.publicSignals.slice(0, 6), (u + 1n).toString(), minOut.toString()];
      expect(await verifyOpen(art.vkey, tampered, r.snarkProof)).toBe(false);
      // review N2: nor does a copy with the slippage floor removed
      expect(await verifyOpen(art.vkey, [...r.publicSignals.slice(0, 7), "0"], r.snarkProof)).toBe(false);
      // Solidity layout: b coordinates swapped
      expect(r.proof.b[0][0]).toBe(BigInt(r.snarkProof.pi_b[0][1]));
      console.log(`epochOpen fullProve: ${r.ms} ms`);
    },
    120_000,
  );

  it("refuses to prove a wrong u (checked before proving)", async () => {
    const sum = elgamal.onChainSum(big(openBuy.sumExtended.c1), big(openBuy.sumExtended.c2), openBuy.ciphertexts.length);
    await expect(proveOpen({ ecSk: BigInt(openBuy.ecSk), sum, u: BigInt(openBuy.u) + 1n, minOut: 1n }, { wasm: art.wasm, zkey: art.zkey })).rejects.toThrow(
      /does not decrypt to u/,
    );
  });
});
