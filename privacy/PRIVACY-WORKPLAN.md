# Privacy launchpad (stage 2) — work plan

Spec: `privacy/PRIVACY-SPEC.md` (authority; its Appendix A constants, §3 signal orders and §4 ABIs are frozen
interfaces). Five work packages run **in parallel** in separate agent sessions; each owns the paths listed and
touches nothing else. Shared files that two packages would both need are split by *ownership of edits* below;
where a package must consume another's output before it exists, it builds against the hand-written interface in
this file and the integrator swaps in the generated one.

**Before any package starts** (review finding 20): the working tree still holds the uncommitted dark-pool stage
(`Deploy.s.sol`, `deploy.sh`, `IGrove.sol`, `relay.ts`, `route.ts`, `addresses.ts`, `useZkbnb.ts`, `TradePanel.tsx`,
`MoveBnb.tsx`, the untracked `DarkPool*.sol`/tests). The integrator **commits stage 1 on `main` first** (with its
attribution line), then creates one worktree per package — `git worktree add ../zkbnb-wp-<name> -b wp/<name>` for
`circuits`, `contracts`, `web`, `keeper`, `docs` — and each session works only in its worktree. Merging back is the
integrator's job (§6), which also makes "additions only below the dark-pool block" for `IGrove.sol` a mechanical
diff check. Agents must never run `git checkout -- <file>` or `git stash` in a shared tree.

Rules for every package: do not commit (the integrator commits); do not edit `privacy/DARKPOOL-*`, any deployed
contract (`Launchpad.sol`, `GroveCoin.sol`, `FeeRouter.sol`, `Roots.sol`, `HolderRewards.sol`, `DonationRotator.sol`,
`FlapBuyback.sol`, `ShieldedPool.sol`, `MerkleTreeWithHistory.sol`, `Groth16Verifier.sol`), `DarkPool.sol`,
`DarkVault.sol` or `DarkPool.t.sol`; keep the stage-1 relayer kinds working; never read or print `keys.txt` or any
`.env`. Baseline that must stay green: `forge test` (152 + the dark-pool suite), `circuits npm test`, web
`typecheck` / `lint` / `test` / `build` (build from the `zkBNB`-cased path, see `HANDOFF.md`), keeper `vitest`.

| WP | Owns | Done when |
|---|---|---|
| **WP-circuits** | `circuits/` except `circuits/CEREMONY.md` (adds `circuits/CEREMONY-v2.md`) | §1 acceptance |
| **WP-contracts** | `contracts/src/{GrovePool,DarkCurve,Planter,CreatorStub,MerkleTreeWithHistoryV2}.sol`, `contracts/src/libraries/{BabyJubjub,GroveConstants}.sol`, `contracts/src/poseidon/{PoseidonT3,PoseidonT4}.sol` (vendored Yul `poseidon-solidity`, licence header kept), `contracts/src/verifiers/Groth16Verifier{Transfer,Intent,Claim,Open}.sol` (dev-key placeholders until the ceremony — never deployed to 56), `contracts/src/interfaces/IGrove.sol` (**additions only**, below the dark-pool block; `ILaunchpadFull` is extended in place), `contracts/test/{GrovePool,DarkCurve,Planter,BabyJubjub,PoseidonParity,PrivacyInvariants}.t.sol`, `contracts/test/fork/PrivacyFork.t.sol`, `contracts/test/mocks/MockVerifierN.sol`, `contracts/scripts/gas-v2.mjs` → `contracts/gas-v2.json`, `contracts/script/DeployPrivacy.s.sol`, `contracts/script/Deploy.s.sol` (add the privacy stack to `_deployStack`, `Deployment`, JSON, log), `deploy.sh` (`VERIFY_MODULES`, `check_deployed`, the `DeployPrivacy` step, the chain-56 ceremony gate) | §2 acceptance |
| **WP-web** | `web/src/lib/zk/{keys,store,sync,artifacts,prefetch,elgamal-client,notes2,claimScheduler}.ts`, `web/src/lib/zk/prove.worker.ts`, `web/src/lib/zk/index.ts`, `web/public/sw.js` (artifact Service Worker), `web/src/lib/relay.ts`, `web/src/app/api/relay/route.ts` (stage-2 kinds refused, fail closed), `web/src/abi/{GrovePool,DarkCurve,Planter,CreatorStub}.ts` (hand-written `as const` from spec §4), `web/scripts/sync-abis.mjs` (`NAMES` += the four), `web/scripts/sync-zk.mjs` (three artifact sets + lib v2), `web/src/config/addresses.ts`, `web/src/hooks/{useShielded2,useGrovePool,useEpochs,useIntents,useClaims,usePrivatePlant,useRelayer}.ts`, `web/src/hooks/useZkbnb.ts`, `web/src/components/coin/{TradePanel,PrivateTradePanel,EpochFeed}.tsx`, `web/src/components/{Wallet,MoveBnb,PlantForm,KeyManager,RelayerPicker}.tsx`, `web/src/app/wallet/page.tsx`, `web/public/relayers.json`, `web/test/{relay2,keys,elgamal,store,denominations2,claimScheduler}.test.mjs`, `web/test/fixtures/keys.json` (copied from circuits), `web/package.json` (test list only), `web/.env.example` | §3 acceptance |
| **WP-keeper-relayer** | `keeper/src/commands/{coordinator,rotateKey,poolFeed,dividends,flush}.ts`, `keeper/src/commands/rewards.ts` (pool inclusion only), `keeper/src/relayer/**`, `keeper/src/{elgamal,babyjub,bsgs,checkpoint,abis,config,index}.ts` (additions), `keeper/test/{coordinator,rotateKey,bsgs,poolFeed,relayer,dividends}.test.ts`, `keeper/test/fixtures/keys.json` (copied from circuits), `keeper/ecosystem.config.cjs`, `keeper/package.json`, `keeper/.env.example`, `keeper/README.md` (incl. "Coordinator key rotation"), `keeper/deployments.example.json` | §4 acceptance |
| **WP-docs** | `web/src/app/docs/privacy/page.tsx`, `web/src/app/docs/{shielded,risk,trust,darkpool}/page.tsx`, `web/src/app/docs/nav.ts`, `web/src/app/docs/page.tsx`, `SPEC.md` (§3.10–3.13, §4.2, §5, §6, §7 additions), `HANDOFF.md` ("Privacy stage 2" paragraph), `README.md` | §5 acceptance |
| **Integrate** (after all land) | everything, inline | §6 |

Boundary between the two web-side packages: WP-web does **not** touch `web/src/app/docs/**`; WP-docs does
**not** touch anything outside `web/src/app/docs/**`, `SPEC.md`, `HANDOFF.md` and `README.md`.
WP-web and WP-keeper-relayer share the relayer protocol: `web/src/lib/relay.ts` is the type source (WP-web owns
it); the keeper imports nothing from web — WP-keeper-relayer re-declares the same shapes in
`keeper/src/relayer/protocol.ts` from spec §5.3 / Appendix C, and the integrator diff-checks the two.

---

## 1. WP-circuits (`circuits/`)

### 1.1 Deliverables

- `circuits/lib/note.circom`: `NoteCommitment()` (in: amount, pubkey, assetId, rpt0, blinding; out: commitment,
  inner), `Nullifier()` (in: commitment, pathIndices, nk).
- `circuits/keypair.circom`: add `NullifierKey()` (`nk = Poseidon(ask, 1)`), `OwnerKey()` (`ovk = Poseidon(OWNER_TAG, ask)`
  — the **only** definition of `ovk`; spec §2.2, §3.1 and Appendix A agree); keep `Keypair()` and `Signature()`
  (v1 circuit still compiles).
- `circuits/lib/elgamal.circom`: `ElGamalEncrypt(uBits)` (in: u, k, pk[2]; out: c1[2], c2[2]; uses
  `EscalarMulFix` on `Base8`, `EscalarMulAny`, `BabyAdd`, `BabyCheck`, `Num2Bits(251)` on k),
  `ElGamalDecryptCheck(uBits)` (in: sk, pk[2], c1[2], c2[2], u).
- `circuits/lib/constants.circom`: every Appendix A field constant as a function.
- `circuits/transfer.circom`, `circuits/intent.circom`, `circuits/claim.circom`, `circuits/epochOpen.circom`
  with **exactly** the public-signal order of spec §3.1–3.4 in `component main { public [...] }`. Transfer:
  `handleSalt` is a **private** input and `claimAmount` a public one (`IsZero(handle)·claimAmount == 0`,
  `Num2Bits(128)(claimAmount)`, `claimAmount` is already inside `publicAmount`). Claim: the two divisions use
  intermediate signals (`qt <== q·totalIn; a·totalOut === qt + r`, same for the refund) — a direct
  `a·totalOut === q·totalIn + r` is rejected by circom (T3001, two products of private signals); `Num2Bits(96)(a)`
  once. Compile at `−O2` (`setup-v2.sh` passes `--O2`; record the flag in `setup-v2.log`).
- `circuits/lib/grove-zk-v2.mjs` (ESM, browser-safe, no Node-only top-level imports; same style as
  `grove-zk.mjs`): `init()`, `poseidon`, constants, `Keys` (`fromSeed(bytes32)`, `fromSignatureAndPassphrase(sigHex,
  passphrase)`, `random()`, `ask/pk/nk/ovk/encPub`, `address()` `zkbnb2…`, `fvk()`/`Keys.fromFvk`, `salt(n)`,
  `handle(n)` — one-shot handles, `n ≥ 1`, no special salt), `elgamalK(ask, nullifier0)` (spec §2.7 derivation),
  `Note` (`assetId, amount, rpt0, blinding, keys`, `commitment()`, `nullifier(index)`, `encrypt()`, `Note.decrypt`),
  `intentAsset(coin, dir)`, `epochKey(coin, seq, dir)`, `intentLeaf(commitment, epochKey)`,
  `resultLeaf(epochKey, totals)`, `MerkleTree(23)`, `hashExtData2`, `hashIntentExt`, `hashClaimExt`,
  `elgamalEncrypt(u, pk, k)` (k from `elgamalK`, never random), `elgamalAddCiphertexts`,
  `bsgsTable(bits = 20 | 24, truncate = 8)` (8-byte truncated x, candidates re-verified), `bsgsSolve(point, table,
  maxBits)`, `MerkleTree(23)` with `insertChunk([4])` and `checkpoint()` semantics mirrored (the browser tree
  must know which roots are checkpoints: `scanBundle` reads `manifest.checkpoints`),
  `prepareTransfer({tree, root (a checkpoint), inputs, outputs, extData, accRpt, handle?, handleSalt?, claimAmount?, handleKeys?, wasm, zkey})`,
  `prepareIntent({tree, inputs, coin, dir, u, changeOutputs, ecPk, accRpt, extData, wasm, zkey})`,
  `prepareClaim({tree, intent: {note, leafIndex, coin, seq, dir}, result: {totals, leafIndex}, outputs, extData, wasm, zkey})`,
  `prepareOpen({ecSk, ecPk, c1, c2, u, wasm, zkey})`, `scanBundle({keys, chunks, coins})` → `{notes, intents, spent}`,
  `proofToSolidity` / `proofFromSolidity` (reuse).
- `circuits/scripts/setup-v2.sh`: pot16 download (Hermez `_16`), compile the four circuits, dev zkeys, export
  `verification_key_<name>.json`, export verifiers to
  `../contracts/src/verifiers/Groth16Verifier{Transfer,Intent,Claim,Open}.sol` (contract names renamed in the
  file), write `build/setup-v2.log` with constraint counts, write `build/CEREMONY-HASHES-v2.txt`.
- `circuits/scripts/fixtures-v2.mjs`: deterministic scenario → `contracts/test/fixtures/v2/*.json` (see 1.3).
  (Writes into `contracts/test/fixtures/v2/` only — the one cross-boundary write, by agreement.)
- `circuits/scripts/zero-leaf-v2.mjs`: prints every Appendix A constant; CI check that `constants.circom`,
  `grove-zk-v2.mjs` and (at integration) `GroveConstants.sol` agree.
- `circuits/test/zk-v2.test.mjs`.
- `circuits/CEREMONY-v2.md`: procedure (pot16, four zkeys per contributor, drand, verifier export, hash
  publication) — the transcript section is filled during integration.

### 1.2 Interfaces exposed

Signal orders (frozen; the contracts build `pubSignals` arrays in this order):

```
transfer : [root, publicAmount, coin, publicAmountCoin, accRpt, handle, claimAmount, extDataHash, nf0, nf1, out0, out1, out2]       (13)
intent   : [root, publicAmount, coin, accRpt, dir, ecPkX, ecPkY, c1X, c1Y, c2X, c2Y, extDataHash, nf0, nf1, out0, out1, out2]       (17)
claim    : [root, nullifier, out0, out1, extDataHash]                                                                                 (5)
epochOpen: [ecPkX, ecPkY, c1X, c1Y, c2X, c2Y, u]                                                                                      (7)
```

Hashing (must equal the contracts): `hashExtData2 = keccak(abi.encode(ExtData)) % p` with
`ExtData(address recipient,int256 extAmountBnb,int256 extAmountCoin,address relayer,uint256 fee,bytes payload,bytes[3] encryptedOutputs)`;
`hashIntentExt` over `(address relayer,uint256 fee,bytes[3] encryptedOutputs)`; `hashClaimExt` over
`(address relayer,bytes[2] encryptedOutputs)`. `publicAmount` encodes negatives as `p − |x|`.

### 1.3 Fixtures (`contracts/test/fixtures/v2/`)

`scenario.json` with a 23-level tree of known leaves inserted in 4-leaf chunks, the list of checkpoint roots, and,
per case, the full `proof`, public struct and ext struct as decimal strings: `shield`, `transfer_bnb`,
`transfer_coin_with_dividend`, `unshield_denom`, `plant_private` (recipient = planter, amount = 0.005 BNB,
payload `ACTION_PLANT`), `handle_claim_full`, `handle_claim_partial` (`claimAmount < claimable`), `handover`,
`intent_buy`, `intent_sell_with_fee_note`, `intent_harvest`, `claim_buy`, `claim_sell`, `claim_voided_sell`,
`open_buy` (ecSk, ecPk, summed ciphertext of 3 intents, u), plus `elgamal_vectors.json` (10 encryptions with their
deterministic `k`, and their point sums as **affine** `(x, y)` — the contract stores extended coordinates and
normalises with `toAffine` before comparing), `poseidon_vectors.json` (commitment, nullifier, intent leaf, result
leaf, chunk root for fixed inputs) and **`keys.json`** (`seed → ask, pk, nk, ovk, encPub, address, salt(1),
handle(1)`; copied verbatim into `web/test/fixtures/` and `keeper/test/fixtures/` so a derivation mismatch fails
all three suites). Verifiers in the fixtures are the dev-key verifiers from `setup-v2.sh`.

### 1.4 Acceptance

```
cd circuits && npm run build:v2            # bash scripts/setup-v2.sh — all four circuits compile, constraints logged, each < 65,536
cd circuits && npm test                     # v1 suite still green
cd circuits && npm run test:v2              # node --test test/zk-v2.test.mjs
cd circuits && npm run fixtures:v2
```

`zk-v2.test.mjs` must cover: key derivation vectors (`keys.json`: seed → ask/pk/nk/ovk/handle(1), address
round-trip, FVK sees spends; `ovk == Poseidon(OWNER_TAG, ask)`); note commitment/nullifier/chunk root against
`poseidon_vectors.json`; checkpoint bookkeeping of `MerkleTree` (a proof against a non-checkpoint root is refused
by `prepare*`); transfer balance (BNB, coin, mixed with dividend `floor` and `rem < 1e18`), zero-padding, asset
selector rejects a third asset, handle claim with `claimAmount` (full, partial, `claimAmount != 0` with
`handle == 0` rejected), `handleSalt` absent from public signals; intent: `u·unit` exact, `u ≥ minU` enforced
(negative test at 4,999 / 49,999), `dir` ∈ 0..2 (negative), ElGamal ciphertext decrypts to `u`, `elgamalK` is
deterministic and differs across nullifiers, BUY vs SELL balance sides; claim: pro-rata floor, refund path,
voided `(1,0,1)` returns `a` in the escrowed asset, wrong epoch rejected, 96-bit bound on `a`; epochOpen: correct
`u` verifies, wrong `u` fails; **BSGS**: `u < 2^32` recovered in < 300 ms with the 2^20 table, `Σu < 2^40` (sampled,
incl. `2^40 − 1`) recovered in < 5 s with the 2^24 truncated table (build time and memory logged; the first draft's
"< 50 ms up to 2^40 with 2^20" is impossible at ~37 µs per point add); every proof verifies with
`snarkjs.groth16.verify` against its `verification_key_*.json`; stage-2 artifacts' sha256 match
`CEREMONY-HASHES-v2.txt`; `setup-v2.log` records the r1cs sha256, circom version and `--O2`.

### 1.5 Ordering

Independent. Publish `grove-zk-v2.mjs`'s export list and `setup-v2.log` counts as early as possible (WP-web
stubs against the export list; WP-contracts reads fixtures only at integration).

---

## 2. WP-contracts (`contracts/`)

### 2.1 Deliverables

Spec §4 verbatim: `PoseidonT3`/`PoseidonT4` (vendored Yul from `poseidon-solidity`, pinned commit in the file
header), `MerkleTreeWithHistoryV2` (checkpoints, `_insertChunk`), `GrovePool`, `DarkCurve` (per-direction epochs,
`Point` sums, `seenC1`, `dirMask` opens, directional band), `BabyJubjub` (`internal`, inlined — no deployment, no
address), `Planter`, `CreatorStub`, `GroveConstants`, four verifier placeholders (compiled from WP-circuits' dev
export when available; until then a `MockVerifierN` per public-input count that accepts any proof), `IGrove.sol`
additions — `ILaunchpadFull` is **extended in place** (additions only; `DarkVault` keeps compiling) rather than a
new `ILaunchpadPlant`, and there is no `isCoin` on the live Launchpad: coin existence is `info(coin).creator != 0`:

```solidity
interface IVerifier13 { function verifyProof(uint256[2] calldata a, uint256[2][2] calldata b, uint256[2] calldata c, uint256[13] calldata pubSignals) external view returns (bool); }
interface IVerifier17 { … uint256[17] … }   interface IVerifier5 { … uint256[5] … }   interface IVerifier7 { … uint256[7] … }
interface IHolderRewardsClaim { function claim(address coin, uint256 runId, uint256 amount, bytes32[] calldata proof) external; }
interface IFeeRouterFull is IFeeRouter { function handOver(address coin, PayoutMode mode, address payoutWallet, uint256 ringId) external; function withdrawPending() external; function pending(address) external view returns (uint256); }
interface ILaunchpadFull is ILaunchpad {
    function sell(address coin, uint256 tokensIn, uint256 minBnbOut) external returns (uint256);   // existing
    function roots() external view returns (address);                                                // existing
    // privacy stage 2 additions (below this line only):
    function plant(Launchpad.PlantParams calldata p) external payable returns (address);
    function plantFee() external view returns (uint256);
    function price(address coin) external view returns (uint256);
    function info(address coin) external view returns (address creator, uint64 createdAt, uint64 graduatedAt, uint256 realBnb, uint256 soldTokens, uint256 buys, uint256 sells, uint256 volumeBnb, address pair, PayoutMode payoutMode, uint256 ringId);
    function VIRTUAL_BNB() external view returns (uint256);
}
```

Deploy: `DeployPrivacy.s.sol` (chains with an existing `deployments/<id>.json`: reads `launchpad, feeRouter,
roots, holderRewards, shieldedPool, router, poseidonT3, poseidonT4, treasury`; deploys verifiers, library,
`GrovePool`, `DarkCurve`, `Planter`; `setModules`; adds denominations/lots; funds `claimBudget` with
`CLAIM_BUDGET_BNB` env (default 0.1); reads `params.claimGas` from `contracts/gas-v2.json` (fails if absent on
56); writes `grovePool, darkCurve, planter, poseidonT3v2, poseidonT4v2, verifierTransfer, verifierIntent,
verifierClaim, verifierOpen, privacyStartBlock` back (no `babyJubjub`: the library is inlined); env
`COORDINATOR_PK_X`, `COORDINATOR_PK_Y` required). `Deploy.s.sol._deployStack` deploys the same stack for fresh
chains (31337/97) with a dev Coordinator key from `COORDINATOR_PK_X/Y` or a documented default. `deploy.sh`:
`VERIFY_MODULES` += `grovePool:src/GrovePool.sol:GrovePool darkCurve:src/DarkCurve.sol:DarkCurve
planter:src/Planter.sol:Planter poseidonT3v2:src/poseidon/PoseidonT3.sol:PoseidonT3 …
verifierTransfer:src/verifiers/Groth16VerifierTransfer.sol:Groth16VerifierTransfer …`; `check_deployed` list +=
`grovePool darkCurve planter`; a `--privacy` step runs `DeployPrivacy` like the dark-pool step, and **on chain 56
refuses to run** unless the four verifier sources' embedded vkeys hash to the entries in
`circuits/build/CEREMONY-HASHES-v2.txt` (spec §3.5: verifiers are immutable, so dev keys on mainnet would mean a
v3 migration).

### 2.2 Interfaces consumed

Public-signal orders of §1.2 (build the arrays in `verifyTransfer`, `verifyIntent`, `verifyClaim`,
`verifyOpen` exactly so); hashing of §1.2; constants of spec Appendix A in `GroveConstants.sol` with a test that
recomputes each `keccak256("grove-v2/…") % FIELD_SIZE` and compares.

### 2.3 Tests (`forge test`)

`PoseidonParity.t.sol`: deploy the live circomlibjs bytecode from `contracts/poseidon/PoseidonT3.bin` /
`PoseidonT4.bin` and the Yul contracts; 1,000 fuzzed inputs hash identically; log both gas costs.

`GrovePool.t.sol` (on `BaseTest`, MockVerifier13): shield with `msg.value`, `maxShieldPerTx`; unshield requires a
denomination (negative), pays recipient and relayer, emits `Transact` **without a sender**; private transfer;
token shield/unshield in lots (negative on a non-lot); `coin == 0 ⇒ publicAmountCoin == 0 && accRpt == 0`;
`knownAccRpt` (stale value accepted, unknown rejected); handle: `credit` then claim with `claimAmount ==
claimable` zeroes it, partial `claimAmount` leaves the rest, `claimAmount > claimable` reverts `BadClaimAmount`,
**a 1-wei `credit` front-run between proving and execution does not break the claim**, `claimAmount != 0` with
`handle == 0` rejected; `pullRewards` calls a mock HolderRewards and bumps `accRpt` with `knownAccRpt` recorded;
`migrateFromV1` against the real `ShieldedPool` with `MockVerifier` (v1 pool funded by `vm.deal`) credits the
handle, `receive` rejects random senders; **private plant end-to-end through `transact`** with the real
`Launchpad` from `BaseTest`: `extAmountBnb == −plantFee` (0.005 BNB, not a denomination) succeeds, any other
plant amount reverts `BadPlantValue`, a plant payload never reaches `handOver`, a hand-over payload with
`recipient == planter` reverts; tree full ⇒ `CommitmentDropped` but payout; **checkpoints**: `lastRoot` is not
known until a period boundary, `checkpoint()` records it, a root from 300 chunks ago that was a checkpoint is still
known, a non-checkpoint root never is, `_insertChunk` checkpoints the pre-insert root at a boundary, genesis root
known; `nextIndex % 4 == 0` always; `setModules` once; module hooks revert for non-modules.

`DarkCurve.t.sol` (MockVerifier17/5/7, the real `Launchpad`, `Roots`, `FeeRouter` from `BaseTest`, mock router):
`submitIntent` inserts the chunk `[t3(out0, epochKey), out1, out2, ZERO]` (check against `poseidon_vectors.json`),
adds ciphertexts in extended coordinates (normalise with `toAffine`, compare to `elgamal_vectors.json` sums),
`count` per `(coin, dir)`, `refPrice`/`refVb`/`startedAt` on a direction's first intent, `INTENT_FEE` reaches the
treasury and `publicAmount == field(−fee − INTENT_FEE)`, repeated `C1` reverts `ReusedRandomness`, wrong key /
`EpochFull` / `UnknownAccRpt` (and a *stale but known* `accRpt` accepted) / wrong `publicAmount` reverts;
`isOpenable` per direction by `K` and by `T_MAX` (7 BUY + 1 SELL: BUY openable, SELL not); `openEpoch` with
`dirMask` subsets, SELL → HARVEST → BUY order (events order), `WrongSeq`, result leaves equal
`resultLeaf(epochKey, totals)` from the fixtures, `rptAtSettle`, FeeRouter received exactly 2 % of gross on each
side (`FeeCollected` sums), buy refund when the curve completes and **graduation inside the open** (pair created,
LP burned), router path after graduation with the fee-on-transfer swap and 2 % pair tax reaching FeeRouter via
`sweepTax`; **directional band**: a public buy that moves spot +11 % and `vB` by > 0.5 BNB blocks BUY only
(`BandExceeded(BUY)`) while SELL and HARVEST open in the same call with a mask excluding BUY; a +11 % move of
< 0.5 BNB on a fresh coin does **not** block (floor); a −11 % dump blocks SELL only; HARVEST never blocked; a
reverting SELL venue (`ZeroAmount`) leaves state unchanged and BUY opens with the mask without SELL; `voidEpoch`
per direction only after `T_MAX + GRACE`, inserts `(1,0,1,rpt)`; `claim`: marks nullifier, inserts one chunk,
reimburses `min(params.claimGas × gasprice, budget)`, zero budget still succeeds, a claim root must be a
checkpoint; `setParams` bounds incl. `claimGas`, `bandFloorWei`; key rotation overlap (old key rejected after
`switchAt`, new accepted from `switchAt − OVERLAP`, one key per epoch); **gas**: every test that exercises
`transact` (shield, transfer, unshield, plant), `submitIntent`, `openEpoch` (three directions), `voidEpoch`,
`claim`, `migrateFromV1` logs `gasleft()` deltas, and `contracts/scripts/gas-v2.mjs` turns `forge test -vv`
output into `contracts/gas-v2.json` (spec Appendix C) — the relayer's `gasUnits` and `DeployPrivacy`'s `claimGas`
read that file; nothing is typed by hand.

`Planter.t.sol`: `plantFor` from the pool only and only via `transact` in the end-to-end case above (a bare
`vm.prank(pool)` test is not sufficient); stub is `creator` in `FeeRouter.configOf`, `Planted.creator == stub`;
mode `Wallet` refused; curve trades push the deployer share to the stub and `flush` credits the handle (also the
`pending` path by making the stub's receive revert in a mock variant); `handOver` through the pool only and only
with the matching handle; `harvestToHandle` burns and credits.

`BabyJubjub.t.sol`: add/toAffine against `elgamal_vectors.json` (extended in, affine compared); `isOnCurve`;
identity; gas of one add.

`PrivacyInvariants.t.sol` (invariant/fuzz): pool BNB ≥ Σ claimable + escrow accounting; `Σ accRpt` payouts ≤
pulled; `rootIndexAfter` set only at period boundaries and never decreasing; `nextIndex % 4 == 0`; `seenC1` never
unset.

`fork/PrivacyFork.t.sol` (skipped without `BSC_RPC_URL`, as `MainnetFork.t.sol`): deploy the stack on a 56 fork,
`submitIntent`/`openEpoch` against the live Launchpad on a live coin (BUY then SELL), `roots.harvest` path,
`pullRewards` against the live `HolderRewards` with a synthetic run, Yul Poseidon equals the live
`0x5B17…4eF6`/`0xB1FE…685a` on fuzzed inputs, and the **band liveness case**: on a seed coin, 8 BUY intents, one
public 0.3 BNB buy in between, `openEpoch` still settles BUY.

### 2.4 Acceptance

```
cd contracts && forge build          # no new warnings; `forge build --sizes`: GrovePool, DarkCurve, Planter each < 24,576 B, Launchpad unchanged at 21,906 B
cd contracts && forge test           # all green, fork suite skipped without RPC
cd contracts && forge test --match-path 'test/fork/PrivacyFork.t.sol' --fork-url $BSC_RPC_URL   # when available
```

### 2.5 Ordering

Independent of WP-circuits until integration (mock verifiers). The fixture-driven tests (`poseidon_vectors.json`,
`elgamal_vectors.json`, real-proof cases) are written against the schema in §1.3 and read files that
WP-circuits produces; mark them `vm.skip(true)` when the file is absent so the suite is green before integration.

---

## 3. WP-web (`web/`)

### 3.1 Deliverables

- `lib/zk/keys.ts`: generated-seed wallet (WebCrypto AES-GCM at rest, PBKDF2 ≥ 600k iterations, BIP-39 export/import),
  EIP-712 + passphrase derivation (`SHIELDED_KEY_TYPES`, `shieldedKeyDomain(chainId, grovePool)`), legacy v1
  derivation kept for *Migrate* / legacy vaults; `lib/zk/index.ts` exports both libs (`zk()` v1, `zk2()` v2 via
  `./zkbnb-zk-v2.mjs`), `ADDRESS_PREFIX_V2 = "zkbnb2"`, `parseShieldedAddress2`.
- `lib/zk/artifacts.ts`: `{ name, wasm, zkey, sha256 }` for `transfer`, `intent`, `claim`; `lib/zk/prefetch.ts` +
  `public/sw.js`: **all three sets are fetched at key creation** (progress UI "preparing your shielded wallet")
  and re-validated by the Service Worker on every visit; `prove.worker.ts` reads only from CacheStorage (verifies
  sha256 before use) and reports `artifacts-missing` instead of fetching — the UI then runs the prefetch and
  disables every action until all three sets are present, so a fetch never coincides with an action.
- `lib/zk/store.ts` (IndexedDB, encrypted; stores per-claim random delays and the checkpoint list),
  `lib/zk/sync.ts` (bundle manifest + chunks + `checkpoints`, trial decrypt via `scanBundle`, incremental by
  `nextIndex`, falls back to `/api/rpc` log scan of `NewCommitment` **only when the bundle is unavailable**, with a
  visible notice; live state via **one** `DarkCurve.epochsOf(allCoins)` call or the keeper's `epochs.json`, and one
  multicall for `accRpt`/`cur` of all coins — never a per-coin read), `lib/zk/claimScheduler.ts` (lazy claims:
  draws the 1–24 h delay at open time, proves + submits on the next visit after it or from the SW when allowed).
- `lib/relay.ts`: kinds `transfer | plant | intent | claim | v1migrate` added to `RelayKind`; JSON types from spec
  Appendix C incl. `OnChainPolicyInput`; `parseRelayRequest` for each; pure policies `transferPolicy`
  (`recipient != planter`), `plantPolicy` (`recipient == planter`, `−extAmountBnb == onChain.plantFee`, payload is
  `ACTION_PLANT`), `intentPolicy` (`publicAmount == field(−fee − INTENT_FEE)`, `ecPk ∈ onChain.coordinatorKey`,
  `!onChain.seenC1`), `claimPolicy`, `v1MigratePolicy` — every policy is `(req, quote, onChain) → ok | reason` with
  no I/O; `gasUnits` loaded from `contracts/gas-v2.json` at build (`sync-zk.mjs` copies it to
  `src/lib/gasUnits.generated.ts`); `FEE_TIERS`, `tierFor(fee)`; `RelayResponse` gains `{ ok:true, held:true,
  ticket }`; `fetchHeld(ticket)`, `fetchEpochs()` (all coins); `relayerBaseUrl()` from `relayers.json` / user
  choice. Stage-1 kinds untouched; existing tests still pass.
- `app/api/relay/route.ts`: stage-1 kinds unchanged; stage-2 kinds **refused** with `{ ok:false, code:"use-relayer"
  }` (no proxying, no fallback); the client shows "the privacy relayer is unreachable" and retries the relayer URL.
- ABIs hand-written from spec §4 (`as const`), replaced by `sync-abis.mjs` at integration (`NAMES` += `GrovePool`,
  `DarkCurve`, `Planter`, `CreatorStub`). `sync-zk.mjs` copies `transfer|intent|claim.{wasm,zkey}` to
  `public/zk/` and `grove-zk-v2.mjs` to `src/lib/zk/zkbnb-zk-v2.mjs` (stub when missing, same pattern), and
  writes `src/lib/zk/artifacts.generated.ts` with sha256s from `CEREMONY-HASHES-v2.txt`.
- `config/addresses.ts`: optional `grovePool, darkCurve, planter, verifierTransfer, verifierIntent, verifierClaim,
  verifierOpen, privacyStartBlock` (+ `NEXT_PUBLIC_GROVE_POOL`, `NEXT_PUBLIC_DARK_CURVE`, `NEXT_PUBLIC_PLANTER`,
  `NEXT_PUBLIC_PRIVACY_START_BLOCK`); `useZkbnb()` exposes `privacyDeployed`.
- Hooks: `useShielded2` (key state, create/derive/unlock/export, prefetch status), `useGrovePool` (notes,
  balances per asset with accrued dividends, "spendable at next checkpoint" countdown, claimable handles, sync
  status), `useEpochs()` (**all** coins at once: per `(coin, dir)` cur, count, startedAt, openable, from the
  relayer `/epochs` or `epochs.json` or one `epochsOf` call; components select their coin locally), `useIntents`
  (prove + submit with per-direction `hold`, held tickets, status), `useClaims` (lazy: claimable intents whose
  delay has passed → prove → submit now; no `notBefore`), `usePrivatePlant` (held first buy by default, skip
  option), `useRelayer` (multi-relayer, tiers, pseudonym warning; claims always via the default relayer).
  `useShieldedActions` keeps its public API for stage 1.
- Components: `TradePanel` segmented `Public | Private | Instant` (Private default when `privacyDeployed` and a
  stage-2 key exists; Instant = existing `DarkPoolPanel`); `PrivateTradePanel` (spec §5.1 content: the honest
  sentence with "in the same direction", per-direction crowd counter, Private "wait for ≥ 3 others on this side
  (may include bots)" / Fast, no *sell all* / *harvest all*, the `N = 1`-lot warning with a suggested round lot,
  minimum 0.05 BNB / 50,000 tokens, fee tier + `INTENT_FEE`, `ProofProgress`, held/submitted/opened/claimed
  states); `EpochFeed` rows per direction in the trades feed and chart points from `EpochOpened`; `Wallet` page
  (`/wallet`) and `MoveBnb` (shield/unshield only: unshield denominations mandatory, "shields since yours",
  subset-sum warning, *Spend from v1* recommended and *Migrate slowly* with the sum warning, legacy vaults
  section); `RelayerPicker` (default shared relayer; the pseudonym warning when another is chosen); `PlantForm`
  *Launch privately* (fresh per-coin handle, held first buy + skip, the §2.6.6 sentence; image path unchanged:
  local re-encode to an on-chain data URL); `KeyManager`.
- `public/relayers.json` with the site relayer (URL from `NEXT_PUBLIC_RELAYER_URL` at build, onion optional).
- CSP/SRI in `next.config` headers (no third-party origins; `/api/rpc`, relayer URLs allow-listed).

### 3.2 Interfaces consumed

`grove-zk-v2.mjs` export list (§1.1; stub until synced), ABIs of spec §4, relayer protocol of spec §5.3 (served
by WP-keeper-relayer; the web talks to it by URL), bundle schema of Appendix C, deployment JSON keys of §2.1.

### 3.3 Tests

`test/relay2.test.mjs`: parse/policy for the five new kinds (positive and each negative, incl. `plant` with a
wrong amount, `transfer` to the planter, `intent` with a seen `C1` or a wrong `publicAmount`), `tierFor`,
`gasUnits` come from the generated file, the Vercel route refuses stage-2 kinds, stage-1 cases still pass;
`test/keys.test.mjs`: `keys.json` vectors (seed → ask/pk/nk/ovk/handle(1)) shared with `circuits/test`, EIP-712
digest for a fixed signature + passphrase, BIP-39 round trip, `handle(n)` enumeration; `test/elgamal.test.mjs`:
client encryption with deterministic `k` matches `elgamal_vectors.json`, `k` differs across nullifiers;
`test/store.test.mjs`: note store encrypt/decrypt, claim-status transitions, checkpoint list; `test/claimScheduler.test.mjs`:
delay drawn once, claim proved only when due; `test/denominations2.test.mjs`: lots, subset-sum warning, the
`N = 1`-lot steering check against `EpochOpened` totals. Playwright smoke (existing harness): create key → artifacts
prefetched → shield (anvil) → wait for checkpoint → Private buy shows "held"/"submitted".

### 3.4 Acceptance

```
cd web && npm run typecheck && npm run lint && npm test && npm run build     # from the zkBNB-cased path
```

### 3.5 Ordering

Independent (stub lib + hand-written ABIs). Needs the real `grove-zk-v2.mjs` and artifacts only for the Playwright
smoke, which runs at integration.

---

## 4. WP-keeper-relayer (`keeper/`)

### 4.1 Deliverables

- `src/babyjub.ts` (field arithmetic, add, mul, `Base8`, affine/extended), `src/elgamal.ts` (decrypt a **summed**
  ciphertext to a point, add ciphertexts — there is deliberately no per-intent decrypt helper), `src/bsgs.ts`
  (2^24 table of 8-byte truncated x built once and persisted to `snapshots/bsgs-24.bin` (128 MB), candidate
  re-verification, solve ≤ 2^40 in ≤ 2^16 giant steps; a 2^20 variant for tests), `src/checkpoint.ts`
  (`pool.checkpoint()` once per period when the chain shows no insert in it; used by coordinator and relayer),
  `src/zkprove.ts` (snarkjs `groth16.fullProve` for `epochOpen` with `circuits/build/epochOpen.{wasm,zkey}`
  paths from env `OPEN_WASM`, `OPEN_ZKEY`).
- `src/commands/coordinator.ts`: per spec §5.2 — per `(coin, dir)` openability, sum-only decryption, `dirMask`
  opens of every openable direction of a coin, drop a reverting or band-blocked direction from the mask and
  retry, `voidEpoch` per direction; `COORDINATOR_SK` (decimal or hex field element), `PRIVATE_TX_RPC`,
  `SLIPPAGE_BPS`; logs only aggregates and tx hashes; `--dry-run` prints the would-be `openEpoch` args with `u`
  redacted to magnitude. `src/commands/rotateKey.ts`: daily — generate the next key, propose
  `setCoordinatorKey(pk, now + 1 h)` to the Safe (or send directly on 97), and once the last epoch under the old
  key is opened or voided overwrite the old key file and log `KeyDestroyed(pk)`; the procedure is written up in
  `README.md` ("Coordinator key rotation") for `HANDOFF.md` to reference.
- `src/commands/poolFeed.ts`: bundle writer per Appendix C (chunk size 4096 leaves, sha256 per chunk,
  `checkpoints` from `Checkpoint` events, epochs per `(coin, dir, seq)`, atomic manifest update, Blob via
  `@vercel/blob` as `feed.ts` does; local file output with `--out`), plus `epochs.json` (all active coins, every
  15 s, identical to the relayer's `/epochs`).
- `src/commands/dividends.ts`: after `postRun` for Holders coins, compute the pool's leaf from the snapshot and
  call `grovePool.pullRewards`; idempotent (`isClaimed`).
- `src/commands/flush.ts`: enumerate `PlantedPrivately` → `CreatorStub.flush()` when `balance + pending ≥ MIN_FLUSH_WEI`.
- `src/commands/rewards.ts`: `grovePool` eligible (not in `excluded`), `darkCurve`, `planter`, stubs excluded;
  snapshot JSON lists the pool's leaf like any holder.
- `src/relayer/{server,protocol,policy,queue,held,epochs,onchain}.ts`: standalone HTTP (Node `http`, no framework),
  routes of spec §5.3 incl. the `plant` kind, CORS allow-list, per-IP token bucket, nullifier in-flight locks,
  serialised sends, `gasUnits` from `GAS_UNITS_FILE` (`contracts/gas-v2.json`), `onchain.ts` fills the
  `OnChainPolicyInput` (`coordinatorKey`, `keySwitchAt`, `plantFee`, `seenC1`) with one `eth_call` batch so the
  policies in `policy.ts` stay pure, held store encrypted at rest (AES-GCM with `RELAYER_HELD_KEY`), poller for
  per-direction holds (release **individually with 0–20 s jitter**, never as a burst) and for `v1migrate`
  `notBefore`; **no hold for claims**; `/epochs` for all active coins (no coin parameter) from a cache; calls
  `checkpoint()` when due; **no access log** (one structured line per send: kind, hash); stage-1 kinds
  (`transact`, `fill`, `vault`) implemented too so the Vercel route can be retired later.
- `src/index.ts`: commands `coordinator`, `pool-feed`, `dividends`, `flush`, `relayer`; `all` runs everything
  **except** `coordinator` and `relayer` (they are separate pm2 apps); `ecosystem.config.cjs` adds `grove-relayer`
  and `grove-coordinator` with a comment that they must run on different hosts in production.
- `src/abis.ts`: `GrovePool`, `DarkCurve`, `Planter`, `CreatorStub` ABIs (hand-written minimal from spec §4,
  replaced at integration by the compiled ones via a `scripts/sync-abis.mjs` equivalent if the keeper has one;
  otherwise keep hand-written and diff at integration). `config.ts`: new addresses optional, new env.
- `README.md`, `.env.example`, `deployments.example.json` updated.

### 4.2 Interfaces consumed / exposed

Consumes: contract ABIs and events of spec §4 (`IntentSubmitted`, `EpochOpened`, `EpochVoided`, `NewCommitment`,
`NewNullifier`, `Credited`, `HandleClaimed`, `RewardsPulled`, `PlantedPrivately`); `epochOpen` public-signal
order `[ecPkX, ecPkY, c1X, c1Y, c2X, c2Y, u]`; the browser-facing protocol of spec §5.3 and Appendix C (exposed).

### 4.3 Tests (`vitest`)

`bsgs.test.ts` (random sums < 2^40 recovered with the 2^24 table in < 5 s each, `u < 2^32` with 2^20 in < 300 ms,
truncation collisions handled; table build time and memory logged), `coordinator.test.ts` (per-direction
openable logic, `dirMask` composition, minOut quoting from mocked reserves, dropping a band-blocked direction and
retrying, void timing per direction, redaction of amounts in logs, **no per-intent decryption anywhere**: the
module under test is given individual ciphertexts and must never call `elgamal.decrypt` on one — assert via a
spy), `rotateKey.test.ts` (proposal timing, destruction only after the last epoch under the key closes),
`poolFeed.test.ts` (chunking, manifest integrity incl. `checkpoints`, incremental append, `epochs.json` shape),
`relayer.test.ts` (quote tiers from the gas file, parse negatives incl. `plant`, per-direction hold lifecycle
submit/drop with jitter, claims never held, `v1migrate` `notBefore`, `onChain` input fill, nullifier locks, no
body logging), `dividends.test.ts` (pool leaf computation equals `HolderRewards.leaf`), `keys.json` vectors
reproduced by the keeper's `babyjub`/poseidon helpers. Existing tests stay green.

### 4.4 Acceptance

```
cd keeper && npm test && npm run build
cd keeper && npm run keeper -- coordinator --once --dry-run      # against anvil with DeployLocal; prints a redacted plan
cd keeper && npm run keeper -- relayer --dry-run                 # starts, answers GET /relay?kind=intent with a tiered quote
```

### 4.5 Ordering

Independent (hand-written ABIs, mocked chain). The real `epochOpen.zkey` is needed only for the end-to-end run at
integration.

---

## 5. WP-docs

### 5.1 Deliverables

- `web/src/app/docs/privacy/page.tsx` "Private trading": what a per-direction epoch is, how an intent/open/claim
  works in plain words, the hidden/public lists from spec §1.2 and the full table of §6.1 **verbatim in meaning**
  (incl. rows 11b, 11c, the checkpoint window and the relayer pseudonym), the anonymity arithmetic of §6.2
  (including the honest sybil price and "others may include bots"), the trust statement of §6.4 verbatim (the
  revised one that names linkability and daily key rotation), the honest quiet-coin sentence ("in the same
  direction"), the Private/Fast modes, the held first buy of a private launch, why v1 notes should be spent rather
  than migrated, stage 1 vs stage 2 (§0.3), addresses from the deployment like `/docs/trust`, ceremony link.
  Added to `DOCS_GROUPS` under *Using zkBNB* after "The shielded pool".
- `/docs/shielded`: notes are multi-asset, keys v2 (generated seed default, EIP-712 + passphrase alternative, the
  phishing warning), handles replace `depositFor`, viewing keys, unshield denominations enforced (and the plant-fee
  exception), checkpoint roots ("spendable in a few minutes"), migration from v1 and why spending from v1 is
  recommended, the v1 `depositFor` endpoints that remain public by contract design.
- `/docs/darkpool`: re-titled "Instant dark pools (stage 1)", first paragraph says it is superseded for new buys
  and links `/docs/privacy`; claims unchanged otherwise.
- `/docs/risk`: Coordinator trust (stage 2), relayer IP, ceremony v2, quiet-coin amount leak, sybil cost.
- `/docs/trust`: admin can/cannot list from spec §4.6; "Admin cannot spend or freeze any note or escrow".
- `/docs` overview: "Private people" idea mentions batch-private trading.
- `SPEC.md`: §3.10 `GrovePool`, §3.11 `DarkCurve`, §3.12 `Planter/CreatorStub`, §3.13 trust statement; §4.2–4.5
  the four circuits (signal orders); §5 web additions; §6 keeper + relayer commands; §7 deployment order adds the
  privacy stack; §8 `grove-zk-v2.mjs`. 10–30 lines per section, pointing to `privacy/PRIVACY-SPEC.md` as authority.
- `HANDOFF.md`: "Privacy stage 2" paragraph (deploy with `DeployPrivacy.s.sol`, the chain-56 ceremony gate, env
  vars, two hosts, the daily Coordinator key rotation and where its attestation is written, `contracts/gas-v2.json`
  as the source of `claimGas`/`gasUnits`, and that v1 `setMaxDeposit(0)` is deferred per spec §7 step 10).
  `README.md`: one paragraph and the docs link.

### 5.2 Acceptance

```
cd web && npm run typecheck && npm run lint          # pages compile; no other web files touched
```
Plus a review checklist: every row of spec §6.1 appears on `/docs/privacy`; the trust statement is verbatim; no
page says amounts are hidden from zkBNB itself; no page says the hold knob protects against a targeted attacker;
no page says "every root stays valid" (it is "every checkpoint").

### 5.3 Ordering

Independent. Uses only deployment keys named in §2.1 (render "not deployed" when absent, as `/docs/trust` does).

---

## 6. Integration (after all five land; one agent, inline)

0. Merge the five worktrees into the integrator's tree (`git merge wp/<name>` in order circuits, contracts, web,
   keeper, docs); verify `IGrove.sol` changed only below the dark-pool block and the deployed contracts are
   byte-identical to `main`.
1. `cd circuits && npm run build:v2 && npm run fixtures:v2` → verifiers land in `contracts/src/verifiers/`,
   fixtures (incl. `keys.json`) in `contracts/test/fixtures/v2/`; copy `keys.json` to `web/test/fixtures/` and
   `keeper/test/fixtures/`.
2. `cd contracts && forge build && forge test -vv | node scripts/gas-v2.mjs` with real verifiers; un-skip the
   fixture tests; `forge build --sizes`; **`contracts/gas-v2.json` is now the source of `params.claimGas` and the
   relayer's `gasUnits`** — check that every kind is present and that `claim` lies inside the `[300k..3M]` bound.
3. `cd web && npm run sync` (ABIs incl. the four new names, three artifact sets, lib v2, generated hashes, gas
   units); `npm run typecheck && npm run lint && npm test && npm run build`.
4. Keeper: replace hand-written ABIs with compiled ones (diff first), `npm test && npm run build`.
5. Constants check: `node circuits/scripts/zero-leaf-v2.mjs` vs `GroveConstants.sol` vs `web/src/lib/zk` vs
   `keeper/src` (a small script compares all four; add it to `circuits/package.json` as `check:constants`).
6. Protocol check: diff `web/src/lib/relay.ts` types against `keeper/src/relayer/protocol.ts`.
7. Local end-to-end on anvil (`CHECKPOINT_PERIOD` is a constant, so use `evm_increaseTime`): `DeployLocal` (now
   with the privacy stack and a dev Coordinator key) → keeper `relayer` + `coordinator --interval 5` → Playwright:
   create key (artifacts prefetched), shield 1 BNB, wait for the checkpoint, Private buy (Fast) on the seed coin,
   wait for open, lazy claim, Private sell, Launch privately with a held first buy (release it with two more
   buys), flush + claim creator fees (partial `claimAmount`), unshield 0.5, spend a v1 note from v1 and migrate
   another slowly, rotate the Coordinator key once and open an epoch under the new key.
8. Review round, three independent reviewers told to refute: (a) circuit soundness (under-constrained signals,
   selectors, division witnesses, field wrap, ElGamal randomness bounds), (b) contract security (escrow
   accounting across `moveOut`/venue calls/refunds, reentrancy, graduation inside open, key rotation, band
   bypass, claim-budget griefing, Planter/stub authorisation), (c) privacy claims in docs/UI versus events and
   calldata (no sender, no leafIndex, no body logs, bundle has no per-user shape). Fixes per area.
9. Ceremony (`circuits/CEREMONY-v2.md`) — **a hard gate before any chain-56 deployment**, since verifiers are
   immutable: publish the r1cs sha256s, circom version and `--O2` flag first; pot16, ≥ 5 outside contributors ×
   4 zkeys each running `snarkjs zkey verify`, drand beacon, export the four verifiers, record sha256s in
   `CEREMONY-HASHES-v2.txt`, `npm run sync` in web (pins hashes). Chain 97 is redeployed with the ceremony
   verifiers (its dev-key stack is abandoned).
10. Deploy: `./deploy.sh 97 --privacy` (dev keys allowed) → testnet e2e with the VPS relayer and a separate
    Coordinator host → after the ceremony `./deploy.sh 56 --privacy` (refuses without matching vkey hashes);
    `web`: `npm run sync && vercel --prod` + **promote**; keeper pm2 apps on two hosts plus the daily
    `rotate-key` cron; `HANDOFF.md` addresses and the key-rotation attestation. `ShieldedPool v1.setMaxDeposit(0)`
    is **not** part of this step (spec §7 step 10: deferred until v1's unspent set is small).
11. Commit in this order: circuits, contracts, web, keeper, docs, integration fixes (attribution lines per the
    repo's current rule).
