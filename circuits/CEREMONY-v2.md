# Stage-2 trusted setup (transfer, intent, claim, epochOpen)

Status: **not run.** The artifacts in `build/` and the verifiers in `contracts/src/verifiers/` are **dev keys**
produced by `scripts/setup-v2.sh` (one local contribution by the operator). They are fine for tests and for
testnet 97, which is thrown away. **They must never be deployed to chain 56**: every verifier is `immutable` in
`GrovePool` / `DarkCurve` and nothing is upgradeable, so a pool behind dev-key verifiers can only be replaced by a
new pool, a new tree and a v2→v3 migration. `deploy.sh 56 --privacy` refuses to run unless
`build/CEREMONY-HASHES-v2.txt` matches the verifiers' embedded keys (it recomputes the vkey hash from the
Solidity source). Spec: `privacy/PRIVACY-SPEC.md` §3.5.

## What a contribution binds

Contributions bind one exact constraint system. Before the first outside contribution the operator publishes
here, from `build/setup-v2.log`:

| circuit | file | compile flags | constraints (non-linear, `--O2`) | r1cs sha256 |
|---|---|---|---|---|
| transfer | `transfer.circom` `Transfer(23, 2, 3)` | `--O2 --r1cs --wasm --sym` | 17,026 | `e4eda044c0f421aa8e8dfc314dedee4d1b47026ad9112d25bb9708a1b2e3e4fa` |
| intent | `intent.circom` `Intent(23)` | same | 19,752 | `b154deb40b370eba66ca306de58a96a3ec015ab335851d656e4c0eb42e3e667a` |
| claim | `claim.circom` `Claim(23)` | same | 16,230 | `1758ac5b6e9dec9af2780add933a805e2d4fcaa71bfbd6231dd35cb26d596db8` |
| epochOpen | `epochOpen.circom` `EpochOpen()` | same | 3,190 | `39477109fbb62694534d85e5bc800ebca1d2e156665d38ce89fe43695f4f3ba4` |

Compiler: `circom2` **0.2.23** (wasm build of circom 2.1.x, pinned in `circuits/package.json`), `snarkjs` 0.7.6,
`circomlib` 2.0.5. The optimisation level changes the r1cs (v1 has 14,094 linear constraints because `setup.sh`
compiles at the default `−O1`); a contribution against a differently compiled r1cs is void. Every circuit is under
the PoT 16 limit (65,536), with headroom for a last constraint fix before the ceremony; **any change to a
`.circom` file after the table above is published restarts the ceremony.**

## Phase 1

Hermez `powersOfTau28_hez_final_16.ptau` for all four circuits (`build/pot16.ptau`,
sha256 `1c401abb57c9ce531370f3015c3e75c0892e0f32b8b1e94ace0f6682d9695922`, downloaded by `setup-v2.sh` from
`https://circom.info/powersOfTau28_hez_final_16.ptau`). Each contributor verifies it:

```
sha256sum build/pot16.ptau
npx snarkjs powersoftau verify build/pot16.ptau
```

## Phase 2 — one open round, four zkeys per contributor

Target: **at least 5 outside contributors** (recruit from week 1). Each contributor, in sequence (the coordinator
hands over `*_<n>.zkey`, the contributor returns `*_<n+1>.zkey`):

```
git clone <repo> && cd circuits && npm ci
npm run build:v2                      # recompiles; the r1cs sha256 in build/setup-v2.log MUST equal the table above
for c in transfer intent claim epochOpen; do
  npx snarkjs zkey verify build/$c.r1cs build/pot16.ptau in/${c}_<n>.zkey   # verifies every previous contribution
  npx snarkjs zkey contribute in/${c}_<n>.zkey out/${c}_<n+1>.zkey --name="<handle>, <date>" -e="<lots of entropy>"
done
sha256sum out/*.zkey
```

The contributor publishes (signed, from an account people recognise): the four `zkey verify` outputs, the four
contribution hashes printed by `zkey contribute`, and the four sha256 sums. Contributions should be made on a
machine that is wiped afterwards or at least never reused for the operator's keys; the entropy string is never
written down. The coordinator records every transcript in the table below as it arrives.

### Final beacon

After the last contribution, the coordinator applies a **fresh drand beacon** (the first round published after
the last contribution's timestamp; `https://api.drand.sh/public/latest`) and exports the final keys:

```
for c in transfer intent claim epochOpen; do
  npx snarkjs zkey beacon out/${c}_<last>.zkey build/$c.zkey <drand randomness hex> 10 -n="drand round <r>"
  npx snarkjs zkey verify build/$c.r1cs build/pot16.ptau build/$c.zkey
  npx snarkjs zkey export verificationkey build/$c.zkey build/verification_key_$c.json
done
```

Then the four verifiers are exported exactly as `setup-v2.sh` does (contract names `Groth16VerifierTransfer`,
`Groth16VerifierIntent`, `Groth16VerifierClaim`, `Groth16VerifierOpen`; the "DEV KEY" header is **removed**),
`build/CEREMONY-HASHES-v2.txt` is rewritten with the drand round and the sha256 of every `.zkey`,
`verification_key_*.json` and `.sol`, the zkey hashes are pinned in `web/src/lib/zk/artifacts.ts` (the browser
verifies them before proving), and the transcript section below is completed. Only then may `deploy.sh 56 --privacy`
run.

## What each key protects (blast radius)

- transfer / claim: a compromised key forges withdrawals of any asset in the pool (`maxShieldPerTx` is the brake).
- intent: forges an intent (steals from its epoch's escrow).
- epochOpen: lets the Coordinator misstate an epoch sum — bounded by that epoch's escrow and detectable, since
  anyone can recompute `(Σu)·B8` from the public ciphertexts and the claimed `u`.

## Transcript (filled during integration)

| # | contributor | date | transfer hash | intent hash | claim hash | epochOpen hash | `zkey verify` |
|---|---|---|---|---|---|---|---|
| 0 | operator (dev key, `setup-v2.sh`) | see `build/CEREMONY-HASHES-v2.txt` | — | — | — | — | — |

Final beacon: drand round —, randomness —.
Final artifact sha256: see `build/CEREMONY-HASHES-v2.txt` (dev set until the ceremony runs).
