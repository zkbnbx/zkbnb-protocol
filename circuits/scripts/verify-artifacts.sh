#!/usr/bin/env bash
# Check the proving key, verification key and Solidity verifier against build/CEREMONY-HASHES.txt.
# Downloads build/transaction.zkey if it is missing. Run from circuits/.
set -euo pipefail
ZKEY_URL=${ZKEY_URL:-https://zkbnbx.com/zk/transaction.zkey}
sha() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -c1-64; else shasum -a 256 "$1" | cut -c1-64; fi; }
want() { grep "$1\$" build/CEREMONY-HASHES.txt | cut -c1-64; }
check() { # check <label> <file> <expected>
  local got; got=$(sha "$2")
  if [ "$got" = "$3" ]; then echo "ok    $1  $got"; else echo "FAIL  $1  got $got, want $3"; exit 1; fi
}

if [ ! -f build/transaction.zkey ]; then
  echo "downloading $ZKEY_URL"
  curl -fL --retry 3 -o build/transaction.zkey "$ZKEY_URL"
fi

check "transaction.zkey         " build/transaction.zkey "$(want build/transaction.zkey)"
check "verification_key.json    " build/verification_key.json "$(want build/verification_key.json)"
check "Groth16Verifier.sol      " ../contracts/src/Groth16Verifier.sol "$(want ../contracts/src/Groth16Verifier.sol)"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
npx snarkjs zkey export verificationkey build/transaction.zkey "$tmp/verification_key.json" >/dev/null
npx snarkjs zkey export solidityverifier build/transaction.zkey "$tmp/Groth16Verifier.sol" >/dev/null
check "re-exported vkey         " "$tmp/verification_key.json" "$(want build/verification_key.json)"
check "re-exported verifier     " "$tmp/Groth16Verifier.sol" "$(want ../contracts/src/Groth16Verifier.sol)"
echo "all artifacts match the ceremony transcript"
