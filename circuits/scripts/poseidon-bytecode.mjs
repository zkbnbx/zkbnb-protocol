import { poseidonContract } from "circomlibjs";
import { writeFileSync, mkdirSync } from "node:fs";
mkdirSync("../contracts/poseidon", { recursive: true });
for (const n of [2, 3]) {
  const code = poseidonContract.createCode(n);
  writeFileSync(`../contracts/poseidon/PoseidonT${n + 1}.bin`, code.replace(/^0x/, ""));
  console.log(`PoseidonT${n + 1}: ${(code.length - 2) / 2} bytes`);
}
