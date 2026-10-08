// Minimal typings for the parts of snarkjs the keeper uses (snarkjs ships no .d.ts).
declare module "snarkjs" {
  export interface Groth16Proof {
    pi_a: string[];
    pi_b: string[][];
    pi_c: string[];
    protocol: string;
    curve: string;
  }
  export const groth16: {
    fullProve(
      input: Record<string, unknown>,
      wasm: string | { type: "mem"; data: Uint8Array },
      zkey: string | { type: "mem"; data: Uint8Array },
      logger?: unknown,
    ): Promise<{ proof: Groth16Proof; publicSignals: string[] }>;
    verify(vkey: unknown, publicSignals: (string | bigint)[], proof: Groth16Proof, logger?: unknown): Promise<boolean>;
  };
}
