#!/usr/bin/env bash
# Stage-2 circuits: compile (--O2) + Groth16 DEV setup + verification keys + Solidity verifiers.
# Run from circuits/:  npm run build:v2   (bash scripts/setup-v2.sh)
#
# Produces, per circuit <name> in {transfer, intent, claim, epochOpen}:
#   build/<name>.r1cs  build/<name>.wasm  build/<name>.zkey  build/verification_key_<name>.json
#   ../contracts/src/verifiers/Groth16Verifier<Name>.sol      (DEV KEY, never deploy to chain 56)
# plus build/setup-v2.log (constraint counts, flags, r1cs sha256, circom version) and
# build/CEREMONY-HASHES-v2.txt (sha256 of every artifact). The zkeys here are dev keys: the real phase-2
# ceremony is described in CEREMONY-v2.md and replaces build/<name>.zkey and the verifiers.
set -euo pipefail
cd "$(dirname "$0")/.."

PTAU=build/pot16.ptau
PTAU_URL=https://circom.info/powersOfTau28_hez_final_16.ptau
LOG=build/setup-v2.log
HASHES=build/CEREMONY-HASHES-v2.txt
VERIFIERS_DIR=../contracts/src/verifiers
CIRCUITS="transfer intent claim epochOpen"
OPT_FLAG="--O2"
CIRCOM_VERSION="$(node -p "require('./node_modules/circom2/package.json').version")"
SNARKJS_VERSION="$(node -p "require('./node_modules/snarkjs/package.json').version")"
mkdir -p build "$VERIFIERS_DIR"

solname() {  # transfer -> Transfer, epochOpen -> Open
  case "$1" in
    transfer) echo Transfer ;; intent) echo Intent ;; claim) echo Claim ;; epochOpen) echo Open ;;
    *) echo "unknown circuit $1" >&2; exit 1 ;;
  esac
}

{
  echo "setup-v2 $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "circom2 $CIRCOM_VERSION (wasm build)  snarkjs $SNARKJS_VERSION  node $(node --version)"
  echo "compile flags: $OPT_FLAG --r1cs --wasm --sym"
  echo "powers of tau: $PTAU_URL (Hermez, 2^16)"
} > "$LOG"

# ---- phase 1: Hermez powers of tau 2^16 (~72 MB); dev fallback if the download fails
if [ ! -f "$PTAU" ] || [ "$(stat -c %s "$PTAU")" -lt 50000000 ]; then
  rm -f "$PTAU"
  echo "downloading powersOfTau28_hez_final_16.ptau (Hermez ceremony)"
  if ! curl -fL --retry 3 --max-time 1800 -o "$PTAU" "$PTAU_URL"; then
    echo "download failed; generating a LOCAL dev powers-of-tau (NOT a real ceremony, dev only)" | tee -a "$LOG"
    npx snarkjs powersoftau new bn128 16 build/pot16_0000.ptau -v
    npx snarkjs powersoftau contribute build/pot16_0000.ptau build/pot16_0001.ptau --name="grove dev" -v -e="$(head -c 64 /dev/urandom | base64)"
    npx snarkjs powersoftau prepare phase2 build/pot16_0001.ptau "$PTAU" -v
    rm -f build/pot16_0000.ptau build/pot16_0001.ptau
    echo "LOCAL_DEV_PTAU=1" > build/PTAU16_IS_DEV_ONLY
  fi
fi
echo "ptau sha256: $(sha256sum "$PTAU" | cut -d' ' -f1)" >> "$LOG"

for name in $CIRCUITS; do
  echo "=== $name"
  echo "" >> "$LOG"
  echo "=== $name ($name.circom, $OPT_FLAG)" >> "$LOG"
  rm -f "build/$name.r1cs" "build/$name.sym" "build/${name}_js/$name.wasm"
  # circom2 (wasm build) sometimes never exits when stdout is not a TTY; bound it and check the outputs instead
  timeout 900 npx circom2 "$name.circom" $OPT_FLAG --r1cs --wasm --sym -o build < /dev/null 2>&1 \
    | sed 's/\x1b\[[0-9;]*m//g' | grep -E "constraints|inputs|outputs|wires|labels|template instances|error|Error" | tee -a "$LOG" || true
  test -s "build/$name.r1cs" && test -s "build/${name}_js/$name.wasm" || { echo "circom compile failed: $name"; exit 1; }
  # PoT 16 hard limit: 65,536 constraints
  TOTAL=$(npx snarkjs r1cs info "build/$name.r1cs" 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g' | grep -i "# of Constraints" | grep -oE "[0-9]+$")
  echo "total constraints (r1cs info): $TOTAL" | tee -a "$LOG"
  if [ -n "$TOTAL" ] && [ "$TOTAL" -gt 65536 ]; then echo "$name exceeds PoT 16"; exit 1; fi
  echo "r1cs sha256: $(sha256sum "build/$name.r1cs" | cut -d' ' -f1)" >> "$LOG"

  npx snarkjs groth16 setup "build/$name.r1cs" "$PTAU" "build/${name}_0000.zkey"
  npx snarkjs zkey contribute "build/${name}_0000.zkey" "build/$name.zkey" --name="grove dev contribution ($name)" -e="$(head -c 64 /dev/urandom | base64)"
  npx snarkjs zkey export verificationkey "build/$name.zkey" "build/verification_key_$name.json"

  SOL="$VERIFIERS_DIR/Groth16Verifier$(solname "$name").sol"
  npx snarkjs zkey export solidityverifier "build/$name.zkey" "$SOL"
  # rename the contract and mark the key as a dev key
  sed -i "s/contract Groth16Verifier /contract Groth16Verifier$(solname "$name") /" "$SOL"
  sed -i "1a\\
// DEV KEY, never deploy to chain 56. Exported by circuits/scripts/setup-v2.sh from build/$name.zkey\\
// ($name.circom, circom2 $CIRCOM_VERSION, $OPT_FLAG). The phase-2 ceremony (circuits/CEREMONY-v2.md) replaces this file." "$SOL"
  grep -q "contract Groth16Verifier$(solname "$name")" "$SOL" || { echo "verifier rename failed: $SOL"; exit 1; }

  cp "build/${name}_js/$name.wasm" "build/$name.wasm"
  rm -f "build/${name}_0000.zkey"
done

# ---- hashes of every artifact (the dev-key set; the ceremony rewrites this file)
{
  echo "# DEV KEYS from setup-v2.sh $(date -u +%Y-%m-%dT%H:%M:%SZ) - not a ceremony. See CEREMONY-v2.md."
  for name in $CIRCUITS; do
    sha256sum "build/$name.r1cs" "build/$name.wasm" "build/$name.zkey" "build/verification_key_$name.json" "$VERIFIERS_DIR/Groth16Verifier$(solname "$name").sol"
  done
} > "$HASHES"

echo "" >> "$LOG"
echo "done $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$LOG"
echo "done: build/{transfer,intent,claim,epochOpen}.{wasm,zkey} build/verification_key_*.json $VERIFIERS_DIR/Groth16Verifier{Transfer,Intent,Claim,Open}.sol"
echo "log: $LOG   hashes: $HASHES"
