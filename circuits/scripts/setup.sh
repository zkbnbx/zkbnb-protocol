#!/usr/bin/env bash
# Compile + Groth16 setup + export Solidity verifier. Run from circuits/.
set -euo pipefail
PTAU=build/pot15.ptau
mkdir -p build
if [ ! -f "$PTAU" ] || [ "$(stat -c %s "$PTAU")" -lt 1000000 ]; then
  rm -f "$PTAU"
  echo "downloading powersOfTau28_hez_final_15.ptau (Hermez ceremony)"
  if ! curl -fL --retry 3 --max-time 900 -o "$PTAU" https://circom.info/powersOfTau28_hez_final_15.ptau; then
    echo "download failed; generating a LOCAL dev powers-of-tau (NOT a real ceremony, dev only)"
    npx snarkjs powersoftau new bn128 15 build/pot15_0000.ptau -v
    npx snarkjs powersoftau contribute build/pot15_0000.ptau build/pot15_0001.ptau --name="grove dev" -v -e="$(head -c 64 /dev/urandom | base64)"
    npx snarkjs powersoftau prepare phase2 build/pot15_0001.ptau "$PTAU" -v
    rm -f build/pot15_0000.ptau build/pot15_0001.ptau
    echo "LOCAL_DEV_PTAU=1" > build/PTAU_IS_DEV_ONLY
  fi
fi
# circom2 (wasm build) sometimes never exits when stdout is not a TTY; bound it and check the outputs instead
rm -f build/transaction.r1cs build/transaction_js/transaction.wasm
timeout 300 npx circom2 transaction.circom --r1cs --wasm --sym -o build < /dev/null || true
test -s build/transaction.r1cs && test -s build/transaction_js/transaction.wasm || { echo "circom compile failed"; exit 1; }
npx snarkjs groth16 setup build/transaction.r1cs "$PTAU" build/transaction_0000.zkey
npx snarkjs zkey contribute build/transaction_0000.zkey build/transaction.zkey --name="grove dev contribution" -e="$(head -c 64 /dev/urandom | base64)"
npx snarkjs zkey export verificationkey build/transaction.zkey build/verification_key.json
npx snarkjs zkey export solidityverifier build/transaction.zkey ../contracts/src/Groth16Verifier.sol
cp build/transaction_js/transaction.wasm build/transaction.wasm
rm -f build/transaction_0000.zkey
echo "done: build/transaction.wasm build/transaction.zkey build/verification_key.json contracts/src/Groth16Verifier.sol"
