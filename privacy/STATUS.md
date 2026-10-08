# Privacy stage 2 ("Dark Curve") — status

Last verified: **2026-10-06**, on the shared working tree (all stage-2 files uncommitted). Authority for the
design: `privacy/PRIVACY-SPEC.md` and `privacy/PRIVACY-WORKPLAN.md`; context: `privacy/HANDOFF-STAGE2.md`.
This file is the source of truth for what `/docs/privacy` and any announcement may say. Update it whenever a
command below is rerun with a different result.

## Headline, stated plainly

- **Nothing from stage 2 is deployed** — not on chain 56, not on testnet 97. No address exists for `GrovePool`,
  `DarkCurve`, `Planter`, `CreatorStub` or the four v2 verifiers.
- **Proving keys are development keys.** One local contribution by the operator (`circuits/scripts/setup-v2.sh`).
  They must never be deployed to chain 56.
- **No trusted-setup ceremony has been run** (`circuits/CEREMONY-v2.md`: "Status: not run").
- **No audit**, internal or external. Two internal review passes have been done: section "Review" (circuits and
  contracts: 5 findings fixed, 5 open) and section "Implementation review" (keeper, relayer, web, deploy tooling:
  8 fixed with tests, 5 open). Neither is an audit.
- **No user can use any of it.** Nothing is deployed, so the stage-2 web UI (section "Web components") is hidden on every
  chain: it renders only when a deployment file has `grovePool` / `darkCurve` / `planter`, and none does. The keeper commands
  (Epoch Coordinator, key rotation, pool feed, dividends, flush) exist and are tested against mocks and a local
  anvil only (section "Keeper commands"); they are not running anywhere. The web *library* layer (keys, note store,
  sync, claim scheduler, artifact prefetch, stage-2 relay types and policies) exists and is unit-tested (section "Web
  library layer"), and the stage-2 React hooks built on it exist (section "Web hooks"; their pure parts are
  unit-tested, the hooks themselves only typechecked). The components and the `/wallet` page that use them exist but
  show nothing stage-2 while `privacyDeployed` is false (true on no chain today); `/wallet` then shows only "not
  deployed on this chain". No component has been run in a browser. One scripted end-to-end run on a **local anvil
  chain** (section "Integration") drove the keeper relayer, Coordinator and pool feed with the web library and dev keys
  through shield, a batched private buy, its open, a claim, a private sell, an unshield and one Coordinator key
  rotation; that is a local test, not a deployment.
- The live product is unchanged: v1 shielded pool and the stage-1 dark pools (`DarkPool`
  `0xade2c2E6F0edB8bc8d19ECc7BBcA466A9f60e3AF`) are what users can use today.

## Legend

- **Built-and-tested** — the code exists and a test suite that exercises it passed in the run recorded here.
- **Built-untested** — the code exists but nothing has tested it (or only part of its acceptance list is tested;
  the gap is named).
- **Not built** — no code.

"Tested" means tested against **mocks and dev keys in a local EVM / Node**, never against the live chain-56
contracts (the `PrivacyFork.t.sol` fork suite does not exist yet).

## Commands run for this file (one at a time)

| # | Command | Result |
|---|---|---|
| 1 | `cd circuits && npm run test:v2` (`node --test --test-force-exit test/zk-v2.test.mjs`) | **13 pass, 0 fail**, 0 skipped, 25.1 s. The `ERROR: 4 Error in template …` lines in the output are the expected witness failures of the negative tests |
| 2 | `cd contracts && forge test --match-path 'test/{GrovePool,DarkCurve,Planter,BabyJubjub,PrivacyInvariants,PrivacyFixtures}.t.sol'` | **63 pass, 0 fail, 0 skipped**, 6 suites, 824 s wall clock (the invariant suite dominates): Planter 7, BabyJubjub 11, DarkCurve 16, PrivacyFixtures 5, GrovePool 19, PrivacyInvariants 5 |

Not rerun for this file (earlier steps of the same chain, logs in the session scratchpad, not reproduced here):
`npm run build:v2` (heavy; artifacts unchanged — test 13 of run 1 re-checks every artifact's sha256 against
`build/CEREMONY-HASHES-v2.txt`), a compile-only `circom2 transfer.circom --r1cs --O2` whose r1cs sha256
`e4eda044…e4fa` equals `build/setup-v2.log` (confirms the `keypair-v2.circom` re-point did not change the
circuit), `forge build --sizes` (sizes below), the full `forge test` (last recorded: 262 passed, 0 failed,
2 skipped across 17 suites, taken before the final `PrivacyFixtures.t.sol` edit). The v1 circuit suite
(`cd circuits && npm test`) passed in chain step 2: 7 passed, 0 failed, including the real-proof
deposit / transfer / withdraw / depositFor test (workplan §1.4 "v1 suite still green" holds).

## Components

### Circuits (`circuits/`)

Compiled with circom2 0.2.23 (wasm), `--O2`, snarkjs 0.7.6, Hermez PoT 2^16. Constraint counts and public-input
counts from `circuits/build/setup-v2.log`.

| Component | State | Evidence |
|---|---|---|
| `lib/note.circom`, `lib/elgamal.circom`, `lib/constants.circom`, `keypair-v2.circom` | Built-and-tested | Exercised through the four circuits in run 1; constants test 1 (Appendix A keccak derivations) |
| `transfer.circom` — `Transfer(23,2,3)`, 17,026 constraints, 13 public inputs | Built-and-tested | Run 1 tests 6–8: shield, BNB send with fee, zero padding, signal order; coin spend with dividend floor/remainder and asset selector; handle claim full/partial, `handleSalt` private, `claimAmount` without handle rejected. Real Groth16 proofs, verified with snarkjs |
| `intent.circom` — `Intent(23)`, 19,752 constraints, 17 public inputs | Built-and-tested | Run 1 test 12: BUY and SELL proofs verify; `u = 4999` rejected client side and by the circuit (`MIN_U`); ciphertext decrypts to `u` (test 9) |
| `claim.circom` — `Claim(23)`, 16,202 constraints (16,230 before the N3 fix), 5 public inputs | Built-and-tested | Run 1 test 12: pro-rata, refund and voided claims verify; wrong epoch rejected; 96-bit bound on `a` |
| `epochOpen.circom` — `EpochOpen()`, 3,191 constraints, 8 public inputs (`minOut` bound since the N2 fix) | Built-and-tested | Run 1 test 11: correct `u` verifies, wrong `u` fails, signal order |
| `lib/grove-zk-v2.mjs` (client library: keys, notes, tree with checkpoints, ElGamal, BSGS, provers) | Built-and-tested | Run 1 tests 2–5, 9–10. The former §1.4 gap (`Σu < 2^40` in < 5 s with the 2^24 table) is now test 11 of `zk-v2.test.mjs`, gated behind `BSGS_FULL=1` (heavy); run once, K-6 below: pass, worst solve 708 ms. Without the flag it is reported as skipped (K-7) |
| Build artifacts (`build/*.r1cs/.wasm/.zkey`, `verification_key_*.json`) | Built-and-tested (**dev keys**) | Run 1 test 13: sha256 of every artifact matches `build/CEREMONY-HASHES-v2.txt`; `setup-v2.log` records r1cs sha256, compiler version and `--O2` |
| Circuit soundness review (`<--` without constraints, `Num2Bits`, `BabyCheck`, selector ranges, the divisions in `claim.circom`) | Done (internal, not an audit) | Section "Review": no exploitable circuit finding; one latent bound (N3) left for the next rebuild |

### Contracts (`contracts/`)

Sizes from `forge build --sizes` (runtime bytes; limit 24,576): `GrovePool` 11,940 · `DarkCurve` 21,064 ·
`Planter` 6,572 · `CreatorStub` 2,167 · `Groth16VerifierTransfer` 3,126 · `Groth16VerifierIntent` 3,788 ·
`Groth16VerifierClaim` 1,752 · `Groth16VerifierOpen` 2,070. All under the limit. After the review fixes: `DarkCurve`
21,294, `GrovePool` 12,520; GrovePool and DarkCurve tests are now 22 and 19 (section "Review", R-a / R-d).

| Component | State | Evidence |
|---|---|---|
| `MerkleTreeWithHistoryV2.sol` (depth 23, chunked inserts, 10-minute checkpoints) | Built-and-tested | `GrovePool.t.sol` `test_tree_*` (genesis root, chunk insert vs single-leaf reference, checkpoints, full tree) |
| `GrovePool.sol` (multi-asset pool, denominations, lots, handles, v1 migration, rewards `accRpt`) | Built-and-tested | `GrovePool.t.sol`: 19 passed, 0 failed (run 2), against `MockVerifierN`; plus real-proof replay in `PrivacyFixtures.t.sol` |
| `DarkCurve.sol` (per-direction epochs, intents, open SELL→HARVEST→BUY, claims, void/refund, key rotation, band) | Built-and-tested | `DarkCurve.t.sol`: 16 passed, 0 failed (run 2), against `MockVerifierN` and mock Launchpad/router; plus `test_openEpochSell_realProof` |
| `Planter.sol`, `CreatorStub.sol` (private planting, creator fees to handles) | Built-and-tested | `Planter.t.sol`: 7 passed, 0 failed (run 2); private-plant end-to-end in `GrovePool.t.sol` |
| `libraries/BabyJubjub.sol` (twisted-Edwards add/mul for ElGamal sums) | Built-and-tested | `BabyJubjub.t.sol`: 11 passed, 0 failed (run 2), incl. 256-run fuzz and the `elgamal_vectors.json` fixture |
| `libraries/GroveConstants.sol` | Built-and-tested | `test_constants_tagsMatchKeccak`, and test 1 of run 1 on the JS side |
| `interfaces/IGroveV2.sol` | Built-and-tested | Compiles; used by every contract above. `IGrove.sol` untouched |
| Verifiers `verifiers/Groth16Verifier{Transfer,Intent,Claim,Open}.sol` | Built-and-tested (**dev keys**) | `PrivacyFixtures.t.sol` `test_everyFixtureProofVerifies` and `test_tamperedPublicInputFails` (run 2). Exported from the dev zkeys; must be re-exported after the ceremony |
| Invariants (`PrivacyInvariants.t.sol`: BNB solvency, claimable covered, nullifier uniqueness, checkpoint monotonic, relayer paid) | Built-and-tested | 5 passed, 0 failed (run 2), each 256 runs × 128,000 calls, 0 reverts, against `MockVerifierN`. The review should confirm the handlers are not vacuous (0 reverts across 128,000 calls suggests they pre-filter inputs) |
| Fork test against live chain-56 contracts (`test/fork/PrivacyFork.t.sol`) | Not built | — |
| Contract security review (per-asset solvency, replay, checkpoint bypass, reentrancy, signal order, affine ElGamal comparison, denomination bypass, vacuous mock tests) | Done (internal, not an audit) | Section "Review": R1–R5 fixed with tests, N1, N2, N4 open |

### Fixtures (`contracts/test/fixtures/v2/`)

| Component | State | Evidence |
|---|---|---|
| `scenario.json`, `keys.json`, `poseidon_vectors.json`, `elgamal_vectors.json` (from `npm run fixtures:v2`) | Built-and-tested | `PrivacyFixtures.t.sol` (run 2): 5 passed — every fixture proof verifies on the dev verifiers, metadata matches the contracts, a real-proof SELL epoch opens, the scenario replays with the expected state effects, a tampered public input fails. Poseidon and ElGamal vectors checked by `DarkCurve.t.sol` / `BabyJubjub.t.sol` |

### Deploy, off-chain services, product

| Component | State | Evidence |
|---|---|---|
| `contracts/script/DeployPrivacy.s.sol` (+ `Deploy.s.sol._deployStack` / `DeployLocal` privacy stack on fresh chains ≠ 56, dev Coordinator key) | Built-and-tested (local anvil only) | Section "Deployment tooling" D-3..D-6: deployed on anvil 31337 to scratch JSON files, wiring checked with `cast` |
| `contracts/gas-v2.json` + `contracts/scripts/gas-v2.mjs` | Built-and-tested | D-1: every kind present, `claim` 1,475,000 (inside [300k..3M]) |
| `deploy.sh --privacy` and the chain-56 ceremony gate (`contracts/scripts/ceremony-gate.mjs`) | Built-and-tested (gate script and in-script refusal); `deploy.sh` itself **not run** | D-2, D-7, D-8. Chain 56 is refused today (dev keys) |
| Deployment (testnet 97 or chain 56) | Not done | No stage-2 entry in `contracts/deployments/` (all test runs wrote scratch copies, deleted afterwards; `31337.json` sha256 unchanged) |
| Web library layer (WP-web §3.1 library bullets): `lib/zk/{keys,elgamal-client,store,sync,claimScheduler,artifacts,prefetch,denominations2}.ts`, `zk2()` in `lib/zk/index.ts`, `prove.worker.ts` v2 jobs, `public/sw.js`, `lib/relay.ts` stage-2 kinds / types / pure policies / client, `/api/relay` refusing stage-2 kinds (`use-relayer`), `sync-zk.mjs` + `sync-abis.mjs` additions and their generated files, `config/addresses.ts` optional keys + `privacyDeployed`, `public/relayers.json` | Built-and-tested (chain step 5; Node unit tests only) | Section "Web library layer" below, W-1..W-5. Prefetch, Service Worker, IndexedDB backend, `sync.ts` and the worker's v2 path are typechecked but have no automated test (browser-only APIs) |
| Web hooks: `useShielded2` (+ `useProver2`, `useArtifacts2`), `useGrovePool`, `useEpochs` (+ `useEpochParams`), `useIntents`, `useClaims`, `usePrivatePlant`, `useRelayer` multi-relayer additions (`useRelayers2`, `useRelayQuote2`); pure helpers `lib/zk/wallet2.ts`; `store.ts` additions (pending requests, `setHandleCoin`) | Built-untested (chain step 6); pure parts Built-and-tested | Section "Web hooks" below, H-1..H-4. `wallet2.ts` and the store additions are unit-tested (`test/wallet2.test.mjs`, 16 tests); the hooks themselves are typechecked and linted only (React + worker + IndexedDB + network: no browser run yet). No page or component imports them, so the live site is unaffected |
| Web UI: components (`PrivateTradePanel`, `EpochFeed`, `Wallet`, `GroveMove` in `MoveBnb`, `PlantForm` *Launch privately* via `PrivatePlant`, `KeyManager`, `RelayerPicker`, `TradePanel` segments), `/wallet` page, CSP headers; pure helpers `lib/zk/ui2.ts`; hooks `useEpochFeed`, `useGroveTransfer` | Built-untested (chain step 7, web components); pure helpers Built-and-tested | Section "Web components" below, U-1..U-5. Gated on `privacyDeployed` (false everywhere), so the live pages render as before. Typechecked, linted, built; `test/ui2.test.mjs` 6 pass. No browser run |
| SRI (`experimental.sri`) | Built, **off by default** (`NEXT_ENABLE_SRI=1`) | U-5: a build with it on wrote sha256 `integrity` attributes; never loaded in a browser, so it is not enabled for the live build |
| Playwright smoke (create key, prefetch, shield on anvil, Private buy held/submitted) | Not built | Needs anvil + the relayer + a browser. Chain step 8 ran a browserless Node end-to-end instead (next row); the React components, prefetch, Service Worker and IndexedDB are still untested in a browser |
| Local end-to-end without a browser: `web/scripts/e2e-anvil-v2.mjs` (`npm run e2e:anvil` in `web/`) | Built-and-tested (local anvil only, dev keys) | Section "Integration" I-7: 13 steps pass. DeployLocal with the privacy stack; keeper `relayer` + `coordinator --interval 5` + `pool-feed` + `rotate-key`; web `syncWallet` / `planIntent` / relay client; real Groth16 proofs |
| Integration checks: `circuits` `npm run check:constants` (`scripts/check-constants.mjs`), `web` `npm run check:protocol` (`scripts/check-protocol.mjs`) | Built-and-tested | Section "Integration" I-3, I-4: constants agree in all four places (83 comparisons); 39 shared protocol types assignable, 20 shared constants equal |
| Docs page `web/src/app/docs/privacy/page.tsx` + nav entry | Built (chain step 7); refreshed in chain step 9 | States only "What we can truthfully tell users today"; nav entry after "Dark pools". Chain step 9 (section "Implementation review", D1): the page no longer says the app screens / relayer / Coordinator do not exist (they exist, run nowhere, are hidden), adds §6.1 row 9 and the key-leak clause of row 10. IR-4: `npm run build` OK, `/docs/privacy` prerendered static |
| Updates to `/docs/shielded`, `/docs/darkpool`, `/docs/risk`, `/docs/trust`, `SPEC.md`, `README.md` | Not built | — |
| Keeper crypto core: `keeper/src/{babyjub,elgamal,bsgs,checkpoint,zkprove,grove2}.ts` (workplan §4.1 first bullet) | Built-and-tested (chain step 2) | Section "Keeper crypto core" below, K-1..K-5. Used by the keeper commands of chain step 3 |
| Keeper commands: `coordinator` (openability, sum-only decryption, `dirMask` opens, band / revert drop-and-retry, void), `rotate-key` (daily rotation, Safe proposal file, key destruction), `pool-feed` (sync bundle + `epochs.json`), `dividends`, `flush`, `rewards` pool inclusion, `index.ts` / `ecosystem.config.cjs` wiring, generated ABIs | Built-and-tested (chain step 3; mocks + local anvil only) | Section "Keeper commands" below, C-1..C-9. Every new command is inert while `grovePool` / `darkCurve` / `planter` are absent from the deployment file (tested with the live `56.json`); `all` never runs `coordinator` / `rotate-key`. Not run against testnet 97 or chain 56. The former gap (no intent ever submitted on anvil, C-7) is closed by the local end-to-end of chain step 8 (section "Integration" I-7): three real `openEpoch` transactions landed on anvil, one under a rotated key. That run found an integration bug in `pool-feed`, now fixed (I-6) |
| Relayer for stage-2 actions: `keeper/src/relayer/{server,protocol,policy,queue,held,epochs,onchain}.ts`, `relayer` command, `grove-relayer` pm2 app (opt-in `ENABLE_RELAYER=1`) | Built-and-tested (chain step 4; mocked chain + local anvil dry run only) | Section "Relayer" below, R-1..R-3. Not deployed anywhere: the live relayer (Vercel `/api/relay`) still serves stage 1 only, and no stage-2 request has been relayed on any public chain. On a local anvil (chain step 8, I-7) it relayed 4 intents (one held, then released), 2 claims and 1 unshield built by the web library; no browser has built one yet |
| Design docs (`PRIVACY-SPEC.md`, `PRIVACY-WORKPLAN.md`, `designs/`) | Done | 20 adversarial-review findings, 19 folded in (spec "Review log") |
| `circuits/CEREMONY-v2.md` (procedure) | Written | Procedure only; the ceremony itself has not run |
| Trusted-setup ceremony (phase 2, four circuits) | **Not done** | `CEREMONY-v2.md`: "Status: not run" |
| External audit | **Not done** | — |
| Stage 3 (threshold committee replacing the Coordinator key) | Not built | Design only (spec §8) |

## What we can truthfully tell users today

Only in these words or narrower ones:

1. "We have **built and tested** the building blocks of private trading — **with development proving keys, on a
   test chain only. None of it is deployed or usable yet. A trusted-setup ceremony and a security audit are still
   pending.**" That sentence, or its meaning, must accompany every statement below.
2. The circuits exist and pass their tests with real zero-knowledge proofs: multi-asset notes (BNB and coins in one
   shielded pool), hidden-amount trade intents, unlinkable claims, and the epoch-opening proof that reveals only a
   batch total.
3. The contracts exist and pass their tests against mocks and the dev verifiers: a multi-asset shielded pool with
   checkpointed roots and one-shot handles, per-direction batch auctions that trade against the live curve as one
   account (so fees, pair tax and the $ZKBNB buyback are unchanged), and private planting.
4. The software around them exists and passes its unit tests: the relayer, the Epoch Coordinator (batch opener),
   the pool feed wallets sync from, and the in-app wallet code. One scripted run on a **local test chain** with
   development keys took two test wallets through shield, a batched private buy, its opening, a claim, a private
   sell, an unshield and a Coordinator key rotation. **None of it runs anywhere public; the app screens are hidden
   and have not been tried in a browser.**
5. How it is designed to work (as design, not as a running product): your buy or sell joins a batch for that coin
   and direction; the chain sees the batch total, not your share; a relayer submits it so your wallet is not on it;
   your claim later does not reveal which coin, batch, direction or amount it came from.
6. What it will **not** hide, from spec §6.1: shields and unshields (wallet, amount, recipient, denomination,
   time), batch totals and counts per coin and direction, the timing of every transaction and the 10-minute
   window each proof was made in, relayer addresses, coin creation, the pool's total holdings per coin, which coin
   an in-pool coin transfer moves (row 9), and amounts credited in the open (row 5).
7. Who can see more (spec §6.1 rows 10–11, §6.4): the Epoch Coordinator run by zkBNB holds a key that could read
   each private intent's amount and link a person's private trades to each other (never to a wallet); ciphertexts
   stay on chain, so anyone who ever obtains a Coordinator key could read every intent sent under it. The relayer
   used sees the IP address, timing and public inputs. Item 7 must accompany any statement about hidden amounts.

## What we must NOT claim yet

- **Not** that anything is live, deployed, launched or available. Nothing from stage 2 is deployed; the
  verifiers use **dev keys**; **no ceremony**; **no audit**.
- **Not** "nobody can see your amount", "amounts are private from zkBNB", or anything equivalent. In stage 2 a
  single Epoch Coordinator run by zkBNB holds the key that **could decrypt each private intent's amount and link
  private trades belonging to the same person** (spec §6.1 row 10, §6.4). Its software decrypts only batch totals
  and the key rotates daily, but until the stage-3 threshold committee ships we do not call amounts private from
  zkBNB itself. When stage 2 does ship, the §6.4 trust statement is published verbatim.
- **Not** that amounts are hidden on quiet coins. A batch with one participant on a side publishes that amount
  exactly, and a later lone exit of the same lot links to it (§6.1 row 1, §6.2). Amounts are only hidden among
  *honest* participants in the same direction; the crowd counter may include bots, and an attacker can isolate
  one intent for about 0.015 BNB (§6.2). Never say the "wait for others" setting "protects" you.
- **Not** that shields and unshields are private. The wallet, amount and time of every shield and the recipient,
  denomination, time and relayer of every unshield are public by nature; denominations only mitigate (§6.1 row 4).
- **Not** that timing is hidden: every transaction's time and the 10-minute checkpoint window of each proof are
  public (§6.1 row 6, §6.3).
- **Not** that the relayer cannot see you: the relayer used sees your IP, timing and public inputs (§6.1 row 11);
  the web host sees request logs (row 11b).
- **Not** that known-amount credits are hidden: creator-fee flushes, public-wallet harvests, v1 migrations and
  ring payouts publish their amounts (§6.1 row 5), and the v1 endpoints still used by the live contracts publish
  `pubKey + amount` (row 11c).
- **Not** "audited", "ceremony complete", "trustless" or "fully private".
- **Not** that stage 1 (the live dark pools) hides amounts: it hides the wallet, not the amount, coin or timing.

## Deployment tooling (chain step "deploy", 2026-10-06)

Files: `contracts/script/DeployPrivacy.s.sol` (`PrivacyDeployBase` + `DeployPrivacy`), additive edits to
`contracts/script/Deploy.s.sol` (`Deployment.privacy`, privacy stack in `_deployStack` when `chainid != 56` and not
`SKIP_PRIVACY=true`, JSON keys, log) and `DeployLocal.s.sol` (optional `DEPLOYMENT_FILE`),
`contracts/scripts/gas-v2.mjs` → `contracts/gas-v2.json`, `contracts/scripts/ceremony-gate.mjs` (+ `.test.mjs`),
`deploy.sh` (`[97|56] --privacy` arguments, ceremony gate before anything is loaded, `DeployPrivacy` step,
`check_deployed` and `VERIFY_MODULES` additions), `contracts/foundry.toml` (read access to `./gas-v2.json` and
`./src/verifiers`), and one new test `test_gas_realVerifierAndCalldata` in `PrivacyFixtures.t.sol` (now 6 tests).

| # | Command (one at a time) | Result |
|---|---|---|
| D-1 | `cd contracts && node scripts/gas-v2.mjs` (runs 9 named tests in GrovePool/DarkCurve/PrivacyFixtures with `-vv`) | Wrote `gas-v2.json`: transfer 1,394,000 · plant 3,754,000 · intent 2,099,000 · claim 1,475,000 · v1migrate 2,200,000 · openEpoch3 3,032,000 · voidEpoch 1,177,000. Formula `roundUp1000((exec + proofs×verifyDelta + 21000 + calldata) × 1.2)`; breakdown in the file's `detail`. Exec is from mock-verifier tests, the real-verifier delta (≈217–296k per proof) and calldata from the fixture proofs |
| D-2 | `node --test contracts/scripts/ceremony-gate.test.mjs` | **4 pass, 0 fail** |
| D-3 | anvil (31337) + `SKIP_PRIVACY=true DEPLOYMENT_FILE=deployments/.scratch-step1/31337-stage1.json forge script script/DeployLocal.s.sol:DeployLocal --broadcast` | Stage-1 stack deployed, 16 keys written to the scratch file (same keys as before this change) |
| D-4 | `COORDINATOR_PK_X/Y=<dev key> CLAIM_BUDGET_BNB=0.25 DEPLOYMENT_FILE=<copy of D-3> forge script script/DeployPrivacy.s.sol:DeployPrivacy --broadcast` | OK. Every stage-1 key kept; added `grovePool darkCurve planter poseidonT3v2 poseidonT4v2 verifierTransfer verifierIntent verifierClaim verifierOpen privacyStartBlock`. `cast`: `pool.darkCurve/planter` set, denominations 0.01 and 10 BNB true (0.03 false), lots 1e5 and 1e8 tokens true, `params.claimGas` 1,475,000, `claimBudget` 0.25 BNB, `v1` = the shieldedPool, treasury = the file's treasury |
| D-5 | the same `DeployPrivacy` again (simulation) | Refused: `grovePool already deployed` |
| D-6 | `DEPLOYMENT_FILE=deployments/.scratch-step1/31337-fresh.json forge script script/DeployLocal.s.sol:DeployLocal --broadcast` | Fresh chain: stage 1 + privacy stack, dev Coordinator key logged as DEV, 26 keys. Scratch files copied to the session scratchpad, then the scratch dir was deleted; `deployments/31337.json` sha256 verified unchanged |
| D-7 | `node contracts/scripts/ceremony-gate.mjs 56` | **REFUSED, exit 1**: all four embedded vkeys hash equal to `verification_key_*.json`, whose sha256 and the `.sol` sha256 match `CEREMONY-HASHES-v2.txt`, but the four sources carry "DEV KEY", the hashes file is the "DEV KEYS" set and records no drand round. `... 97` → ALLOWED with warnings |
| D-8 | anvil `--chain-id 56` (local, no real chain) + `forge script script/DeployPrivacy.s.sol:DeployPrivacy` **without `--broadcast`** | Refused: `chain 56: run through deploy.sh 56 --privacy (ceremony gate not passed)`; with `PRIVACY_CEREMONY_GATE=passed` forced: `chain 56: Groth16VerifierTransfer is a DEV KEY verifier` |
| D-9 | `FOUNDRY_INVARIANT_RUNS=16 forge test` (full suite) | **274 pass, 0 fail, 2 skipped**, 18 suites (PrivacyInvariants at 16 runs, **reduced depth**) |

Not run: `bash deploy.sh 56 --privacy` (the session's permission classifier blocked running deploy.sh, which counts as a
production deploy; its gate step only runs D-7's script before loading anything). Not done: `safe-accept.sh` does not
yet accept GrovePool / DarkCurve ownership on 56; the Yul `poseidon-solidity` hashers are not vendored, so
`poseidonT3v2/T4v2` are fresh copies of the v1 circomlibjs bytecode (checked equal to v1 on `hash(1,2)` / `hash(1,2,3)`).

## Keeper crypto core (chain step 2, 2026-10-06)

New files, all in `keeper/` (nothing existing was edited except `package.json` / `package-lock.json` through one
`npm install snarkjs@^0.7.6 poseidon-lite@^0.3.0 @noble/curves@^1.9.1`, recorded as `^0.7.6`, `^0.3.0`, `^1.9.7`;
`snapshots/` is git-ignored, so the 128 MB table is never committed):

- `src/babyjub.ts`: field and twisted-Edwards arithmetic, extended coordinates, subgroup check, conversion to and
  from the contract's `Point {x, y, t, z}`.
- `src/elgamal.ts`: `publicKey`, `parseSecretKey` (`COORDINATOR_SK`, decimal or hex, never echoed), `encrypt` (tests
  only), `addCiphertexts`, `sumCiphertexts`, `onChainSum` (from DarkCurve's extended running sum), and
  `decrypt`, which accepts **only** a sum produced by those two functions (module-private `WeakSet`; a copied or
  hand-made `{c1, c2}` is refused). There is no per-intent decrypt helper. A spy-able `elgamal` facade is exported for
  the coordinator test. Note: a "sum" of one intent (count 1) is accepted; openability (minimum intents) is the
  coordinator's rule, still to be built.
- `src/bsgs.ts`: 2^24 table of 8-byte truncated x, persisted to `snapshots/bsgs-24.bin` (header + keys only: **128 MB**;
  in memory about 196 MB with the bucket index built at load), candidates re-verified by a full scalar multiplication,
  ≤ 2^16 giant steps for 2^40; corrupt or foreign files are detected (header, size, 19 spot checks) and rebuilt;
  written atomically. A 2^20 variant (12 MB) is used by the tests.
- `src/checkpoint.ts`: `checkpointDecision` (due iff the chain is in a later period than `lastCheckpointPeriod` and
  `isKnownRoot(getLastRoot())` is false) and `maybeCheckpoint(ctx, pool)`, which is a no-op when `pool` is undefined.
- `src/zkprove.ts`: `proveOpen` (snarkjs `groth16.fullProve`, artifacts from `OPEN_WASM` / `OPEN_ZKEY`, optional
  `OPEN_VKEY`), checks `M == u·B8` before proving and the public-signal order `[ecPkX, ecPkY, c1X, c1Y, c2X, c2Y, u]`
  after; `verifyOpen`, `proofToSolidity`, `shutdownProver`.
- `src/grove2.ts`: Appendix A constants, Poseidon (poseidon-lite, circomlib parameters), seed → keys, address, FVK,
  salt/handle, `elgamalK`, commitment, nullifier, intent/epoch/result leaves, zeros, chunk root.
- `src/types/snarkjs.d.ts`; tests `test/{v2vectors,bsgs,elgamal,checkpoint,zkprove}.test.ts`;
  `test/fixtures/keys.json` (verbatim copy, checked byte-equal to `contracts/test/fixtures/v2/keys.json`).

| # | Command | Result |
|---|---|---|
| K-1 | `cd keeper && npx vitest run test/bsgs.test.ts` | 5 pass, 1 skipped (the gated 2^24 test). 2^20 build 10.5 s, 12 MB; 14 solves of `u < 2^32` (incl. 0, 2^32 − 1), **worst 49 ms** (< 300 ms); 1-byte truncation produces false candidates that re-verification rejects; save/load round trip; corrupt file rejected and rebuilt |
| K-2 | `cd keeper && BSGS_FULL=1 npx vitest run test/bsgs.test.ts -t "2\^24"` (first run: builds the table) | **pass**. Baby steps **168 s**, index 0.7 s; table 196 MB in memory, rss 277 MB (+224 MB), `snapshots/bsgs-24.bin` **128 MB**. 10 solves of `Σu < 2^40` incl. 2^40 − 1, 0, 2^39: **worst 762 ms** (< 5 s) |
| K-3 | the same, second run (loads the file) | **pass**. Load + spot check + index 0.75 s, rss 254 MB; worst solve 775 ms |
| K-4 | `cd keeper && npx vitest run test/zkprove.test.ts` | **3 pass**. One real `epochOpen` proof of the `open_buy` scenario sum with `circuits/build` DEV artifacts: fullProve 534 ms, verifies against `verification_key_epochOpen.json`, a tampered `u` does not verify, public signals equal the fixture's |
| K-5 | `cd keeper && npm test -- --no-file-parallelism` then `npm run build` | **95 pass, 0 fail, 1 skipped** (12 files: the 7 existing files unchanged and green, 5 new). `tsc` build clean; `dist/grove2.js` smoke-imported under plain Node |
| K-6 | `cd circuits && BSGS_FULL=1 node --test --test-force-exit --test-name-pattern="2\^24 truncated" test/zk-v2.test.mjs` | **1 pass**. `grove-zk-v2.mjs` `bsgsTable(24, 8)`: build 167 s, arrays 384 MB, rss 616 MB (+448 MB); 10 solves incl. 2^40 − 1, worst 708 ms. Closes the workplan §1.4 gap |
| K-7 | `cd circuits && npm run test:v2` | **13 pass, 0 fail, 1 skipped** (the new gated test 11) |

## Keeper commands (chain step 3, 2026-10-06)

New in `keeper/`: `src/commands/{coordinator,rotateKey,poolFeed,dividends,flush}.ts`, `src/coordinatorKeys.ts` (key
files 0600, overwrite-then-unlink destruction), `src/stubs.ts` (CreatorStubs from `PlantedPrivately`, snapshot
exclusion rule), `src/abis-v2.ts` (GENERATED from `contracts/out` by the new `scripts/sync-abis.mjs`, `npm run
sync:abis`), tests `test/{coordinator,rotateKey,poolFeed,dividends,rewardsPrivacy,abis2}.test.ts`. Additive edits:
`src/config.ts` (optional `grovePool` / `darkCurve` / `planter` / `privacyStartBlock`, `loadPrivacyConfig`),
`src/abis.ts` (re-exports + three small fragments), `src/commands/rewards.ts` (8 lines: the stage-2 exclusion rule,
skipped without stage-2 addresses), `src/index.ts` (commands `coordinator`, `rotate-key`, `pool-feed`, `dividends`,
`flush`; `all` adds `dividends`, `flush`, `pool-feed`, never `coordinator` / `rotate-key`; snarkjs workers shut down
on exit), `ecosystem.config.cjs` (`grove-coordinator` only with `ENABLE_COORDINATOR=1`, reserved `grove-relayer` slot,
different-hosts comment), `package.json` (scripts only), `README.md` ("Privacy stage 2", "Coordinator key rotation"),
`.env.example`, `deployments.example.json`.

Behaviour that matters for the trust statement: the coordinator reads only each epoch's on-chain running sum and
passes it to `elgamal.decrypt` as a `SummedCiphertext`; it never reads an individual ciphertext. Logs carry coin,
direction, seq, count, the sum's magnitude `2^a..2^b` and tx hashes; `--dry-run` prints `openEpoch` arguments with `u`
redacted the same way. Retired keys are overwritten and unlinked once no collecting epoch uses them (`KeyDestroyed`
log line with the public point). On chain 56 `rotate-key` writes a Safe Transaction Builder file instead of sending.

| # | Command (one at a time) | Result |
|---|---|---|
| C-1 | `cd keeper && npx vitest run test/coordinator.test.ts` | **16 pass, 0 fail**: openability per direction (K at T_MIN, any count at T_MAX), void strictly after T_MAX + GRACE and only for directions not opened, `dirMask` composition, one `openEpoch` for BUY + SELL with exact sums from a 2^12 BSGS table, `minOut` from mocked pair reserves (incl. the 2 % pair tax) and curve / Roots quotes, a `BandExceeded(0)` revert dropping BUY and retrying SELL, a reverting HARVEST isolated by per-direction simulation, `--dry-run` redaction (no exact sum, amount, key or wei amount in any log line), inert without addresses. **Spy:** `elgamal.decrypt` is called once per opened direction, always on a summed ciphertext with the epoch's count, never on any of the individual ciphertexts the test built the sums from |
| C-2 | `cd keeper && npx vitest run test/rotateKey.test.ts` | **7 pass**: proposals at most daily, `switchAt = now + 1 h`, none while a key is pending on-chain, stale Safe proposals discarded after `switchAt − OVERLAP`; chain 56 → Safe batch file decoding to `setCoordinatorKey(pk, switchAt)` with no secret in it; the old key file survives while its last epoch is collecting and is destroyed (file gone, `KeyDestroyed` logged with the public point only) once that epoch is opened; chain 97 with the keeper as owner sends directly |
| C-3 | `cd keeper && npx vitest run test/poolFeed.test.ts` | **4 pass**: leaf kinds (intent / note / result / zero), zero-slot filling, epochs with recomputed result leaves (opened and voided, voided stamped with the tracked `accRpt`), credits, `accRpt`, checkpoints; 4,132 leaves → chunk 0 = 4,096 leaves, chunk 1 the rest; incremental passes rewrite only the open chunk (chunk 0 sha256 and mtime unchanged); manifest sha256 verified, tampering detected; `epochs.json` shape |
| C-4 | `cd keeper && npx vitest run test/dividends.test.ts` | **7 pass**: the pool's leaf equals `HolderRewards.leaf` (vector computed independently with `cast keccak (cast abi-encode ...)`), `pullRewards` only for unclaimed runs, skipped below `MIN_REWARD_SUPPLY`; `flush` threshold and stub enumeration from `PlantedPrivately` logs |
| C-5 | `cd keeper && npx vitest run test/rewardsPrivacy.test.ts test/abis2.test.ts` | **3 + 5 pass**. With the live `contracts/deployments/56.json` (read only): snapshot exclusions, contract reads (`pairOf`, `price`, `runCount`) and holders are exactly as before, no log scan, no stub cache. With stage-2 addresses: GrovePool is a holder even if `EXCLUDE_ADDRESSES` names it; DarkCurve, Planter, the stub are excluded. `abis-v2.ts` equals a fresh render from `contracts/out`; the hand-written Launchpad / Roots / FeeRouter fragments match the artifacts |
| C-6 | local anvil (port 8597, chain 31337) + `DEPLOYMENT_FILE=deployments/.scratch-step3/31337.json forge script script/DeployLocal.s.sol:DeployLocal --broadcast` (anvil's public test key), one coin planted with `cast send`, then `npm run keeper -- coordinator --once --dry-run` (dev Coordinator key from `fixtures/v2`, keeper `.env` not loaded) | Deploy OK. Pass: `coins=2 active=0 opened=0`, an empty plan (no epoch has intents) |
| C-7 | anvil only: the fixture `open_buy` sum (3 intents under the DEV key, Σu = 18,000) written into `DarkCurve.epochs[(coin, BUY, 0)]` with `anvil_setStorageAt` (age 400 s) and GrovePool funded with `anvil_setBalance`; the same dry run with `BSGS_PATH=keeper/snapshots/bsgs-24.bin`, `OPEN_WASM` / `OPEN_ZKEY` = `circuits/build/epochOpen.*` | Table loaded in 633 ms; `direction ready dir=BUY seq=0 count=3 u=2^14..2^15`; Groth16 proof made; **`openEpoch` simulation OK** (DarkCurve verified the keeper's proof against its stored sum and executed the BUY on the local curve, in simulation only). Printed plan: `{"dirMask":1,"dirs":["BUY"],"seq":[0,0,0],"u":["2^14..2^15","-","-"],"minOut":["43961039172493056220668517","0","0"],"proofs":["groth16","-","-"]}` |
| C-8 | the same anvil: `npm run keeper -- pool-feed --once --dry-run --out <scratchpad>` | `manifest.json` (no leaves yet, one genesis checkpoint) and `epochs.json` (both coins; the injected BUY epoch with `count 3`, `openableAt = startedAt + T_MAX`) written. Then anvil stopped and the scratch deployment file deleted; `contracts/deployments/` unchanged |
| C-9 | `cd keeper && npm test -- --no-file-parallelism` then `npm run build` | **137 pass, 0 fail, 1 skipped** (18 files; the 12 earlier files unchanged and green). `tsc` build clean; `dist/commands/coordinator.js` smoke-imported |

Not done in this step: the stage-2 relayer (`keeper/src/relayer/**`, `relayer.test.ts`, the `relayer` command; later
chain step); `feed` per-epoch rows (spec §5.2 last bullet, not in the workplan §4.1 list); an `openEpoch` that lands
on any chain (C-7 is a simulation against a storage-injected sum); `PRIVATE_TX_RPC` was not exercised (the
coordinator sends through a wallet client on that URL, so the endpoint must accept standard JSON-RPC for gas price
and estimation, not only `eth_sendRawTransaction`).

## Relayer (chain step 4, 2026-10-06)

`keeper/src/relayer/`: `protocol.ts` (Appendix C shapes re-declared, parser for all kinds incl. stage-1
`transact` / `fill` / `vault` / `recover`), `policy.ts` (pure: fee tiers, `transfer` / `plant` / `intent` / `claim` /
`v1migrate` policies, stage-1 policies copied from `web/src/lib/relay.ts`, hold decision, jitter), `queue.ts`
(serialised sends, nullifier in-flight locks, per-IP token bucket), `held.ts` (AES-256-GCM store keyed by ticket,
indexed by nullifier; per-request jittered release), `epochs.ts` (15 s cache of pool-feed's `buildEpochsJson`),
`onchain.ts` (one eth_call batch for `OnChainPolicyInput`, hold-state reads, contract calls), `server.ts` (Node
`http`, routes of spec §5.3, CORS allow-list, no access log, one `sent kind= hash=` line per send). `index.ts` gains
`relayer` (uses `RELAYER_PRIVATE_KEY`, never `KEEPER_PRIVATE_KEY`); `config.ts` gains optional `darkPool`;
`ecosystem.config.cjs` adds `grove-relayer` behind `ENABLE_RELAYER=1`; README, `.env.example` updated.

Contract rules mirrored: fees are tiers ≤ `MAX_RELAYER_FEE` (0.01 BNB; the largest tier is 0.005); intents need
`publicAmount == p − (fee + INTENT_FEE)` and the key `DarkCurve._keyIdOf` accepts (current, the pending one inside
the 600 s overlap, only the new one after `switchAt`); `v1migrate` needs `encryptedOutput2 == abi.encode(handle)`
and recipient = GrovePool; `plant` needs recipient = planter, `−extAmountBnb == plantFee`, `ACTION_PLANT` payload.

| # | Command | Result |
|---|---|---|
| R-1 | `cd keeper && npx vitest run test/relayer.test.ts` | **26 pass, 0 fail**: quote tiers from `contracts/gas-v2.json`, negative amounts incl. `plant`, every policy, per-direction hold lifecycle (individual jitter 2 s / 18 s, re-check on fire, drop at `T_MAX − 30 s`), claims never held, `v1migrate` `notBefore`, `OnChainPolicyInput` from 9 reads in flight together (re-issued once when `keyGen` moved), nullifier locks, held store unreadable at rest, CORS / rate limit / epochs cache, and no body logging over real HTTP (exactly one `sent kind=transfer hash=…` line; no nullifier, recipient, ciphertext or IP in any line) |
| R-2 | local anvil (port 8598) + `DEPLOYMENT_FILE=deployments/.scratch-step4/31337.json forge script script/DeployLocal.s.sol:DeployLocal --broadcast` (anvil's public test key), then `npm run keeper -- relayer --dry-run` (env `KEEPER_PRIVATE_KEY=` empty, `RPC_URL`/`CHAIN_ID=31337`/`DEPLOYMENTS_PATH` = the scratch file, no `RELAYER_PRIVATE_KEY`: ephemeral key) | Listening on 127.0.0.1:8799, `stage2=true held=on`. `GET /relay?chainId=31337&kind=intent` → `{"ok":true,"kind":"intent","fee":"5000000000000000","feeTier":4,"gasPrice":"1677248250","gasUnits":"2099000","tiers":["5000000000000000"],…}` (anvil gas price 1.68 gwei → the 0.005 tier); `kind=claim` → `fee "0"`; `/relay/epochs` → the planted coin's three directions; a claim with `hold` → `hold: claims are never held`; a foreign Origin → 403. The log has 3 lines (ready, low-balance warning, listening), no request lines. Relayer and anvil stopped; scratch file copied to the session scratchpad and deleted; `deployments/31337.json` sha256 verified unchanged |
| R-3 | `cd keeper && npm test -- --no-file-parallelism` then `npm run build` | **163 pass, 0 fail, 1 skipped** (19 files; the skip is the existing one in `bsgs.test.ts`). `tsc` build clean |

Not done / known limits: no stage-2 request was relayed on any chain (needs the web prover, WP-web); the relayer
quotes, simulates and holds against mocks and a local anvil only. A finished ticket's status lives in memory (a
restart forgets submitted/dropped tickets; held ones are restored from disk). Behind a single reverse proxy or the
Tor hidden service every client shares one rate-limit bucket unless `RELAYER_TRUST_PROXY=1`. `gas-v2.json` units
already include a 1.2 margin and the quote applies the spec's ×1.2 again (fees err high by ~20 %; set
`RELAY_MARGIN_BPS=0` to drop the second margin). `web/src/lib/relay.ts` has no stage-2 types yet, so the
integrator's protocol diff (workplan §6 step 6) has nothing to compare against until WP-web adds them.
(Chain step 5 added them; see "Web library layer": `test/relay2.test.mjs` now runs the keeper's parser and policies
beside the web's on the same inputs.)

## Web library layer (chain step 5, 2026-10-06)

New in `web/` (no page, hook or component uses any of it yet):

- `src/lib/zk/keys.ts`: generated wallet (16 bytes entropy → 12-word BIP-39 backup, seed = keccak256("zkbnb2/seed" ‖
  entropy); a 24-word phrase carries a 32-byte seed as is), at rest AES-256-GCM under PBKDF2-SHA256 ≥ 600,000
  iterations (fewer refused both ways), wallet-derived mode (`SHIELDED_KEY_TYPES`, `shieldedKeyDomain(chainId,
  grovePool)`, seed = keccak256(sig ‖ keccak256(passphrase))), keys / handles through the v2 lib, FVK export and FVK /
  IVK import, legacy v1 key on demand. `src/lib/zk/elgamal-client.ts`: deterministic `k`, `u` bounds, (C1, C2), key check.
- `src/lib/zk/index.ts`: `zk2()` (lazy, `./zkbnb-zk-v2.mjs`), `ADDRESS_PREFIX_V2`, `parseShieldedAddress2` (refuses a
  `zkbnb2view` key and v1 addresses), `isStub2`; `zkbnb-zk-v2.d.ts` types the synced lib.
- `src/lib/zk/{artifacts,prefetch}.ts` + `public/sw.js`: three sets pinned by sha256 (`artifacts.generated.ts`),
  CacheStorage keyed by `url?sha256=`, verified on every read; the worker's new `v: 2` jobs read only the cache and
  answer `artifacts-missing`. The Service Worker has no fetch handler, re-validates on every visit, and refills only a
  browser that already holds a prefetched set. Nothing registers it yet (`registerArtifactServiceWorker()` is for key
  creation, a later step), so the live site is unaffected.
- `src/lib/zk/store.ts` (encrypted per collection under an HKDF key from the seed; IndexedDB or memory backend),
  `claimScheduler.ts` (delay uniform 1–24 h drawn once; proof only when due), `sync.ts` (bundle + sha256 + index checks,
  trial decrypt from the cursor, RPC fallback only without a bundle with `FALLBACK_NOTICE`, live state by one `epochsOf`
  and one multicall, or the relayer / `epochs.json`), `denominations2.ts` (lots, minimums, subset-sum, N = 1 steering).
- `src/lib/relay.ts` (additive section at the end; every stage-1 export unchanged): stage-2 kinds, Appendix C types,
  `parseRelayRequest2`, pure policies with the keeper's names and signatures plus `stage2Policy(req, env, onChain)`,
  `FEE_TIERS`, `tierFor`, `tieredQuote`, gas units from `src/lib/gasUnits.generated.ts`, `RelayResponse2` (held
  ticket), `fetchHeld`, `fetchEpochs`, `relayers.json` parsing, `relayerBaseUrl` (no relayer ⇒ null ⇒ fail closed;
  never `/api/relay`). `src/app/api/relay/route.ts`: GET and POST refuse the five stage-2 kinds with
  `{ ok:false, code:"use-relayer" }` before anything else.
- `scripts/sync-zk.mjs` (copies `transfer|intent|claim.{wasm,zkey}` to `public/zk/`, the v2 lib, writes
  `artifacts.generated.ts` + `public/zk/artifacts-v2.json` from `CEREMONY-HASHES-v2.txt` after checking the copies,
  `gasUnits.generated.ts` from `contracts/gas-v2.json`, `public/relayers.json` from `NEXT_PUBLIC_RELAYER_URL` /
  `_ADDRESS` / `_ONION`; keeps or stubs each output when its source is missing), `scripts/sync-abis.mjs` (`NAMES` +=
  GrovePool, DarkCurve, Planter, CreatorStub). `config/addresses.ts`: optional stage-2 keys (undefined, never zero, when
  absent) + `NEXT_PUBLIC_GROVE_POOL` / `_DARK_CURVE` / `_PLANTER` / `_PRIVACY_START_BLOCK`, `privacyDeployed(dep)`;
  `useZkbnb()` exposes `privacyDeployed` (false on 56 / 97 / 31337 today). `.env.example` documents the new variables.
- Tests: `test/{relay2,keys,elgamal,store,claimScheduler,denominations2}.test.mjs`, `test/fixtures/keys.json`
  (byte-equal to the contracts and keeper copies, checked by a test); `test/resolve-ts.mjs` gains a `.js`→`.ts` fallback
  (to load `keeper/src/relayer/*.ts`), a JSON load hook (to import the real route) and a narrower extension check.

| # | Command (from `zkBNB/web`, one at a time) | Result |
|---|---|---|
| W-1 | `node scripts/sync-abis.mjs` | Wrote `src/abi/{GrovePool,DarkCurve,Planter,CreatorStub}.ts` (92 / 82 / 24 / 15 entries). The 9 existing ABIs were checked byte-identical to a fresh render **before** the run and show no diff after; `deployments/*.json` identical to `contracts/deployments` (no change) |
| W-2 | `node scripts/sync-zk.mjs` | Copied the three DEV-key sets (transfer 2.5 + 10.7 MB, intent 2.6 + 12.0 MB, claim 2.5 + 9.3 MB) and `grove-zk-v2.mjs`; `artifacts.generated.ts` pins all three (`ARTIFACTS_V2_DEV_KEYS = true`), every copy matched its pinned hash; `gasUnits.generated.ts` transfer 1,394,000 / plant 3,754,000 / intent 2,099,000 / claim 1,475,000 / v1migrate 2,200,000; `public/relayers.json` = `[]` (no `NEXT_PUBLIC_RELAYER_URL`). Stage-1 `transaction.*` and `zkbnb-zk.mjs` unchanged |
| W-3 | `npm run typecheck` | clean (exit 0) |
| W-4 | `npm run lint` | 0 errors, 1 warning: `src/lib/zk/zkbnb-zk-v2.mjs` 237:30 `'ovk' is defined but never used` (the synced copy of the circuits-owned `circuits/lib/grove-zk-v2.mjs`; not edited here) |
| W-5 | `npm test` | **83 pass, 0 fail** (the 48 existing tests unchanged and green + 35 new: relay2 12, keys 7, elgamal 5, store 5, claimScheduler 3, denominations2 3). Includes: the real `route.ts` GET / POST answering `use-relayer` for all five kinds and stage-1 answers unchanged; 35 request vectors where the web and `keeper/src/relayer/{protocol,policy}.ts` give deep-equal verdicts (and equal `tieredQuote`s and constants); every `keys.json` value incl. `handle1/2`, FVK and `elgamalK_nullifier1`; all 10 `elgamal_vectors.json` ciphertexts and `sum_first3` reproduced; BIP-39 reference vectors |

Not built / not tested in this step: hooks, components, pages, CSP/SRI and the Playwright smoke (later steps); `npm run
build` (not run, per the step); no automated test for `prefetch.ts`, `public/sw.js`, `idbBackend`, `sync.ts` or the
worker's v2 jobs (browser APIs; typechecked only); no Service Worker claim job (claims run on the next visit only).
Choices to fold into the spec: the 12-word backup needs 16-byte entropy, so a generated seed is keccak256("zkbnb2/seed"
‖ entropy) (spec §2.2 says "32 random bytes"); the IVK string prefix `zkbnb2ivk` is the web's own (Appendix A defines
only `zkbnb2view`); `RelayKind` stays the stage-1 set the Vercel route serves and the stage-2 union is `RelayKind2`
(Appendix C's name) rather than widening `RelayKind`. The route now reads the body before its "no relayer configured"
check (so stage 2 is refused even without a key); the only stage-1 effect is that a malformed body on an unconfigured
server gets 400 `invalid` instead of 503. A claim's delay starts when the wallet first sees the epoch result (bundle rows
carry no timestamp). The DEV-key artifacts now sit in `web/public/zk/` (zkeys are git-ignored; the three `.wasm` and
`artifacts-v2.json` are untracked): they must not ship to production before the ceremony.

## Web hooks (chain step 6, 2026-10-06)

New in `web/src/hooks/` (no page or component imports any of them yet; the stage-1 `useRelayer()`,
`useShieldedKey` and `useShieldedActions` APIs are unchanged):

- `useShielded2.ts`: the stage-2 key session (memory only, per tab, closed on a chain switch). `create(passphrase)`
  (returns the 12-word backup once), `importPhrase`, `deriveFromWallet` (EIP-712 + passphrase; stores only a "derived"
  marker), `unlock`, `importViewOnly` (FVK / IVK; in-memory store, cannot spend), `lock`, `forgetDevice`,
  `backupPhrase(passphrase)`, `exportFvk` / `exportIvk`. The encrypted key file lives in IndexedDB (`keyfile:v1`); the
  note store is opened per chain (`<chainId>:<walletIdOf(pk)>`) under the seed's store key. `ensureArtifacts()` /
  `useArtifacts2()`: all three proving sets are prefetched at creation and re-checked (and refetched) on every unlock;
  `ready` stays false until they are present, and every action hook refuses to start before. `useProver2()`: the
  worker's `v: 2` jobs; `artifacts-missing` rejects with `ArtifactsMissingError` and restarts the prefetch.
- `useGrovePool.ts`: `syncWallet` against the keeper bundle; the `/api/rpc` log scan (`scanLogs` of GrovePool +
  DarkCurve from `privacyStartBlock`, reduced by `logsToChunk`) only when the bundle is unavailable, with
  `FALLBACK_NOTICE` exposed as `notice`. Notes with `spendableAt` (next checkpoint boundary) and `locked`, balances per
  asset with dividends at the newest synced `accRpt`, incoming handle credits, intents, epoch results, pending relayer
  requests. After each sync: requests whose inputs the bundle shows spent are removed; a submitted request not
  confirmed within 2 h is marked failed (its notes unlock).
- `useEpochs.ts`: `liveEpochs` for all coins at once (relayer `/relay/epochs`, then `epochs.json`, then one
  `epochsOf(allCoins)` + one multicall); `crowd(coin, dir)` / `crowds(coin)` select locally; `useEpochParams()` reads
  `DarkCurve.params()` once (no coin in it).
- `useRelayer.ts` (additive; `useRelayer()` untouched): `useRelayers2()` (relayers.json entries of the chain, the
  user's choice in localStorage, `base` / `defaultBase` / `claimBase`, the pseudonym warning, `quote(kind)`; claims are
  always quoted from and sent to the default relayer), `useRelayQuote2(kind)` for display.
- `useIntents.ts`: `submit({ coin, dir, amount, mode: "private" | "fast", submitByEpochEnd?, hold?, feeTier? })`:
  quote, `planIntent` (at most 2 checkpointed, unlocked notes; SELL / HARVEST fees from BNB and / or the coin notes'
  dividends), Coordinator key (`epochsOf(allCoins)` + `activeCoordinatorKey` / `keyByGen(epoch.keyId)`, checked on
  curve and in the subgroup), prove, post with `hold` (Private: `minOthers 3`; Fast: none). The posted body is kept
  (encrypted) as a pending record that locks its input notes; `resubmit(id, hold?)` re-posts a dropped / failed one with
  the same proof to the same relayer; held tickets are polled at their relayer every 20 s. No receipt is ever polled
  through `/api/rpc`.
- `useClaims.ts`: lazy claims; after every sync (and when the next delay ends while the page is open) `runDueClaims`
  proves and submits each due claim through the default relayer, one at a time; `claimNow(leafIndex)`; automatic runs
  pause 5 min after a failure.
- `usePrivatePlant.ts`: `plant({ params, firstBuyWei, skipFirstBuy?, feeTier? })`: plant fee from shielded BNB via
  kind `plant` (payload `abi.encode(ACTION_PLANT, PlantParams, handle)`, payout wallet refused), a fresh handle `n`
  recorded before proving, the coin found in the public coin list (not via a receipt), then the first buy as a held BUY
  intent (`minOthers 2`, `submitByEpochEnd false`) from other notes; the section 2.6.6 sentence is exported.
- `src/lib/zk/wallet2.ts` (pure, no React): asset ids, dividends, checkpoint countdown, balances, pending-request
  locking / settlement / expiry / held updates, all-coins crowd selection and labels, Coordinator-key choice, BNB and
  intent input planning, holds and fee tiers, relayer selection, relay request bodies, claim inputs, plant payload, coin
  lookup. `src/lib/zk/store.ts` (additive): a `pending` collection (`PendingRecord`, `putPending` / `patchPending` /
  `removePending`; old stores open with it empty) and `setHandleCoin(n, coin)`.

| # | Command (from `zkBNB/web`, one at a time) | Result |
|---|---|---|
| H-1 | `node --experimental-strip-types --no-warnings --import ./test/resolve-ts.mjs --test test/wallet2.test.mjs` | **16 pass, 0 fail** (first version; the stale-request assertions were added afterwards and ran in H-4) |
| H-2 | `npm run typecheck` | clean (exit 0) |
| H-3 | `npm run lint` | 0 errors, 1 warning: the same pre-existing `src/lib/zk/zkbnb-zk-v2.mjs` 237:30 `'ovk'` (circuits-owned synced copy) |
| H-4 | `npm test` (now includes `test/wallet2.test.mjs`) | **99 pass, 0 fail** (the 83 of W-5 unchanged and green + 16 new) |

Not built / not tested in this step: the hooks have no automated test (they need React, a worker, IndexedDB,
CacheStorage and a relayer: a browser / Playwright run with anvil and the relayer belongs to the UI steps); no
component, page or CSP change; `npm run build` not run. Known limits: the RPC fallback goes through `scanLogs`, whose
localStorage cache keeps only the last 20,000 logs of a key, so a fallback scan of a pool with more logs than that can
rebuild a wrong tree (the proof then fails against the checkpoint roots; the bundle is the normal path); a request
released by the relayer after its 2 h expiry window can be marked failed while it lands (its notes are then offered
again and a second proof spending them reverts on the nullifier); the private plant finds its coin by name, symbol and
creation time in the public list (two identical plants within minutes would be ambiguous; the newest is taken).

## Web components (chain step 7, 2026-10-06)

New in `web/`. Every stage-2 part renders only when `useZkbnb().privacyDeployed` is true. On 56 / 97 / 31337 today it is
false, so the coin page, `/move` and `/create` render exactly what they rendered before.

- `components/coin/TradePanel.tsx` (additive): when privacy is not deployed, `TradePanel` returns the old panel, now
  named `PublicTradePanel`. Otherwise it returns `TradeSegments` = `Public | Private | Instant`. Private is enabled only
  with a stage-2 key file or session on this device, and is then the default. Instant is the stage-1 `DarkPoolPanel`,
  labelled "amount public". `PublicTradePanel` takes an optional `header` that replaces the stage-1 Wallet / Dark pool
  switch.
- `components/coin/PrivateTradePanel.tsx`: the honest sentence (`HONEST_SENTENCE`) always shown; Buy / Sell / Harvest; a
  per-direction crowd counter ("n buy intents in this epoch, opens in m:ss", noting that it counts bot intents too);
  *Private (wait for ≥ 3 others on this side — may include bots)* with an opt-in "send anyway near the end", or *Fast*
  ("alone in the batch, your amount is public"); no all / max / percentage buttons; minimum 0.05 BNB / 50,000 tokens;
  the N = 1 lot warning with a round-lot button; a fee tier select plus the flat `INTENT_FEE`; the price band (this
  intent alone, up to this intent plus the coin's 95th-percentile batch of the last 50, from curve maths on the coin
  list; no band for graduated coins or harvests); `ProofProgress2`; held / submitted / dropped / failed states with
  *Send again* / *Dismiss*. The panel reads nothing that names the coin: `useEpochs` covers all coins, and
  `useEpochFeed` is one log scan of all coins.
- `components/coin/EpochFeed.tsx` + `hooks/useEpochFeed.ts`: "Private batch (n buys)" rows from one DarkCurve scan of
  `IntentSubmitted` / `EpochOpened` / `EpochVoided` for all coins. A batch with one intent says that its amount is
  public. Shown under Trades on the coin page. The open's own curve trade already appears in the trades feed and the
  chart (trader = DarkCurve).
- `components/Wallet.tsx` + `app/wallet/page.tsx` (`noindex`, not in the navigation): `KeyManager`, `RelayerPicker`,
  balances per asset (spendable / not yet in a checkpoint with a countdown / in a request / dividends), requests at a
  relayer, lazy claims (`useClaims({ auto: true })`, *Claim now*), incoming handle credits with *Claim into my wallet*,
  and "Older balances": *Spend from v1* (the v1 pool on `/move`) and dark vaults. *Migrate slowly* is stated as not
  available.
- `components/GroveMove.tsx` + `hooks/useGroveTransfer.ts`, shown at the top of `/move` (`MoveBnb.tsx`, additive):
  - stage-2 shield: a wallet `GrovePool.transact{value}` call, standard-size chips, `maxShieldPerTx`;
  - unshield in an on-chain denomination through the chosen relayer (kind `transfer`);
  - "shields of this size since yours: n", from a pool-wide `Transact` scan; the block of your last shield of each
    size is kept in localStorage;
  - the subset-sum warning on the notes the unshield would spend;
  - `claimIncoming(n, amount)`, which folds a handle credit into one existing BNB note (spec §2.4).
- `components/KeyManager.tsx`: create (12 words shown once, with an acknowledgement), restore, derive from wallet (with
  `DERIVED_KEY_WARNING`), view only; unlock (passphrase or signature); proving-key preparation progress; backup phrase
  (needs the passphrase); FVK / IVK export; lock; forget device.
- `components/RelayerPicker.tsx`: the default relayer, a listed one or a typed URL; the pseudonym warning; what the
  relayer sees.
- `components/PrivatePlant.tsx` + `PlantForm.tsx` (additive): `Launch privately | Launch publicly` (private is the
  default with a key), payout wallet refused, `PLANT_FIRST_BUY_SENTENCE`, *Skip the first buy*.
  `components/ProofProgress2.tsx`.
- `next.config.ts` headers:
  - enforced on every route: `object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'`,
    `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`;
  - the full allow-list CSP is **Report-Only** everywhere and **enforced only on `/wallet`**. It allows self, the
    Binance / CoinGecko price APIs, `*.public.blob.vercel-storage.com`, ipfs.io, the rings / bundle / RPC-override
    origins, and every `relayers.json` + `NEXT_PUBLIC_RELAYER_URL` origin, with `'unsafe-inline'` scripts,
    `'wasm-unsafe-eval'`, `data:` / `blob:` workers and any `https:` image;
  - this is not yet a "no third-party origins" CSP, because the live site loads the price APIs and the Blob feeds.

| # | Command (from `zkBNB/web`, one at a time) | Result |
|---|---|---|
| U-1 | `node --experimental-strip-types --no-warnings --import ./test/resolve-ts.mjs --test test/ui2.test.mjs` | **6 pass, 0 fail** (segments, private amounts, epoch rows, N = 1 on feed rows, price band, shields since yours) |
| U-2 | `npm run typecheck` | clean (exit 0) |
| U-3 | `npm run lint` | 0 errors, 1 warning: the same pre-existing `src/lib/zk/zkbnb-zk-v2.mjs` 237:30 `'ovk'` |
| U-4 | `npm test` (now includes `test/ui2.test.mjs`) | **105 pass, 0 fail** (the 99 of H-4 + 6) |
| U-5 | `npm run build` (with SRI on at the time) | exit 0; 31 routes, `/wallet` static (14.5 kB); `.next/server/app/index.html` carries `integrity="sha256-…"`; `routes-manifest.json` has the headers above. SRI was then made opt-in (`NEXT_ENABLE_SRI=1`): no browser could load the build in this step (no background server allowed). `tsc` / `eslint` of `next.config.ts` are clean after that edit; no rebuild |

Not built or not tested:
- No component has been rendered in a browser. That needs a deployment with stage-2 addresses, the relayer and anvil:
  the Playwright smoke at integration.
- Not built: token (coin) shield / unshield in lots, in-pool send to a zkbnb2 address, *Migrate slowly* (v1migrate),
  the creator page's *Claim creator fees* (flush) and *Hand over* (owner proof), and the Service Worker claim job.
- A relayer URL typed into the picker that is not in `relayers.json` is blocked by the enforced CSP on `/wallet`
  (elsewhere it is only reported).
- The price band is a local curve estimate, not a quote.

## Integration (chain step 8, 2026-10-06)

Workplan §6 steps 2–7, without the parts that need a ceremony or a real deployment, and without Playwright (too heavy
for this PC). New files: `circuits/scripts/check-constants.mjs` (+ `check:constants` in `circuits/package.json`),
`web/scripts/check-protocol.mjs` and `web/scripts/e2e-anvil-v2.mjs` (+ `check:protocol`, `e2e:anvil` in
`web/package.json`). Fix: `keeper/src/commands/poolFeed.ts` (I-6), with a regression test appended to
`keeper/test/poolFeed.test.ts`.

| # | Command (one at a time) | Result |
|---|---|---|
| I-1 | `contracts/gas-v2.json` read back (node) | Every kind present: transfer 1,394,000 · plant 3,754,000 · intent 2,099,000 · claim 1,475,000 · v1migrate 2,200,000 · openEpoch3 3,032,000 · voidEpoch 1,177,000; `claim` inside [300k..3M]. Not re-measured: `forge build` printed "No files changed, compilation skipped", so D-1 still holds. Real `openEpoch` gas in I-7 (one direction each): 1,714,593 (BUY), 1,569,606 (SELL), 1,550,601 (BUY, new key) |
| I-2 | ABIs, diffed first. keeper: a fresh `render()` of `scripts/sync-abis.mjs` vs `src/abis-v2.ts`. web: outputs copied to the scratchpad, `npm run sync` (from `zkBNB/web`), `diff -r` | keeper `abis-v2.ts` is **identical** to a fresh render from `contracts/out`, so it was not rewritten. web: `sync:abis` (13 ABIs, 3 deployment files) and `sync:zk` (v1 plus the three v2 DEV artifact sets, both libs, `artifacts.generated.ts`, `gasUnits.generated.ts`, `relayers.json`) produced **no diff** against the snapshot. The keeper's hand-written stage-1 ABIs in `abis.ts` were **not** replaced: they serve the live keeper, and `abis2.test.ts` keeps checking its Launchpad / Roots / FeeRouter fragments against the artifacts |
| I-3 | `cd circuits && npm run check:constants` | **pass**. `zero-leaf-v2.mjs` (keccak tags, `constants.circom`, `GroveConstants.sol`) agrees; 50 numeric constants parsed from `GroveConstants.sol`; 19 constants in 15 `web/src/lib/zk` + `relay.ts` files and 30 in 39 `keeper/src` files compared; `web/src/lib/zk/zkbnb-zk-v2.mjs` byte-identical to `circuits/lib/grove-zk-v2.mjs`; the lib's `EPOCH_PARAMS` equal the contract defaults. 83 comparisons, 0 mismatches. Each file has a list of names it must declare, so a rename fails the check instead of passing it vacuously |
| I-4 | `cd web && npm run check:protocol` | **pass**. 39 shared type names of `web/src/lib/relay.ts` and `keeper/src/relayer/protocol.ts`, 69 assignability checks under `tsc --strict` (wire and parsed shapes both ways; requests web → keeper; responses keeper → web), and 20 shared exported constants deep-equal at runtime. One known one-way difference, accepted by design: the web's `RelayFailCode` also has `use-relayer` (the Vercel route's answer), which the keeper never sends. A negative run of the same tsc construction detected that difference when compared both ways |
| I-5 | anvil end-to-end, early runs (`web/scripts/e2e-anvil-v2.mjs`) | Run 1 stopped at the held intent: the relayer refuses holds without `RELAYER_HELD_KEY`, which is correct; the driver now gives it a random key. Run 3 found I-6. One later run stalled in `forge script --broadcast` waiting for receipts (26 of the deploy transactions mined, then forge waited until the 600 s limit); the driver now broadcasts with `--slow` and a 300 s limit, and every run since has passed |
| I-6 | **Bug fixed** in `keeper/src/commands/poolFeed.ts` | `DarkCurve.openEpoch` emits `EpochOpened` **before** `pool.insertChunk` emits the result leaves' `NewCommitment`. pool-feed checked each epoch row only against the result leaves seen earlier in the transaction, so every opened epoch got `resultLeaf: null` (counted as a mismatch) and **no wallet could ever claim**: the web's `syncWallet` never marks an intent claimable without the leaf. The mock test had the events in the opposite order. Fix: the check now runs after the whole transaction group. New test `pool-feed result leaves in contract event order`: contract order, two directions in one open, and a row whose leaf is absent still counted as a mismatch. `npx vitest run test/poolFeed.test.ts`: 5 pass. The web's RPC-fallback `logsToChunk` does not have the bug (it does no cross-check) |
| I-7 | `cd web && npm run e2e:anvil -- <scratch dir>` (final run) | **E2E PASSED: 13 steps, 102 s.** anvil 31337 → `DeployLocal` with the privacy stack (DEV Coordinator key, 26 keys; scratch file in `contracts/deployments/.scratch-e2e-v2/`, deleted afterwards) → seed coin planted → keeper `relayer` (anvil account 1) and `coordinator --interval 5` (account 2, `COORDINATOR_SK` = DEV key, 2^24 BSGS table) started as child processes, with the keeper `.env` never loaded → two wallets (web `NoteStore` in memory, `syncWallet` over the keeper's `pool-feed --once --out` bundle) each **shield 1 BNB** → `evm_increaseTime` 600 + `checkpoint()` → Alice **BUY Fast** 0.2 BNB and Bob **BUY Private** 0.1 BNB (`hold {minOthers:1}`: held ticket, released by the relayer after Alice's intent) → T_MAX → the **Coordinator opened BUY#0** with u = 30,000 = 20,000 + 10,000 (decrypted as a sum) → checkpoint → Alice **claimed** through the relayer (fee 0, reimbursed from the claim budget; the 1–24 h claim delay was bypassed by calling the prover directly) and holds 48,977,177.46 tokens = 0.2/0.3 of totalOut → Alice **SELL Fast**, 24,488,588 tokens → **SELL#0 opened** → Alice claimed the SELL (0.1006 BNB) and **unshielded 0.5 BNB** through the relayer (the recipient received exactly 0.5 BNB) → **`rotate-key --once`** (owner key; `setCoordinatorKey` sent directly, switchAt = now + 3,594 s, new key file) → time moved past switchAt, active key gen 0 → 1 → Bob **BUY under the new key** (epoch keyId 1) → **opened by the Coordinator with the rotated key file** → conservation: GrovePool holds 1.1706 BNB = 2 − 0.028 fees − 0.4 bought + 0.1006 sold − 0.5 − 0.002, and Alice's spendable BNB = before − 0.5 − fee + SELL claim. Every relayed transaction came from the relayer's address and every `openEpoch` from the Coordinator's. Relayer log: one `sent kind= hash=` line per send plus one `held released=1` line, no request bodies. Coordinator log: magnitudes only (`u=2^14..2^15`). After the run, anvil, the relayer and the Coordinator were stopped (ports free) and `contracts/deployments/` was unchanged (`31337.json` sha256 equals `HEAD`) |
| I-8 | `cd keeper && npm test -- --no-file-parallelism` then `npm run build` | **164 pass, 0 fail, 1 skipped** (19 files; the skip is the existing `BSGS_FULL` one); `tsc` clean |
| I-9 | from `zkBNB/web`: `npm run typecheck`, `npm run lint`, `npm test` | typecheck clean; lint 0 errors, 1 warning (the existing `ovk` one in the synced `zkbnb-zk-v2.mjs`); **105 pass, 0 fail** |

Not run / not done in this step:
- Playwright (browser) smoke: not built. The React components, `prefetch.ts`, `public/sw.js`, the IndexedDB store
  backend and the prove worker are still untested in a browser; the e2e drives the same library functions from Node.
- Not exercised in the e2e: *Launch privately* (plant through the Planter with a held first buy), flush + claim of
  creator fees, spending a v1 note and *Migrate slowly* (v1migrate), token shield / unshield in lots, a
  three-direction open, `voidEpoch`, key destruction after rotation (the DEV key came from `COORDINATOR_SK`, not a
  key file), and `PRIVATE_TX_RPC`.
- The claim scheduler's random 1–24 h delay was bypassed (the driver proves the claim as soon as the result is
  checkpointed); the scheduler itself is unit-tested (W-5).
- The Coordinator also called `GrovePool.checkpoint()` during the run (its own behaviour); the driver calls it too
  after each `evm_increaseTime`.
- `web` `npm run build` was not rerun: no file under `web/src` changed in this step (`npm run sync` rewrote its
  outputs byte-identically). Contracts and circuits were not rebuilt or retested (no source change; `forge build`
  had nothing to compile).
- Workplan §6 steps 0–1 (worktree merge, `build:v2`), 8 (three-reviewer round), 9 (ceremony) and 10–11 (deploy,
  commit) were not part of this step.

## Review

One internal review pass (chain step 6, 2026-10-06) over the stage-2 circuits and contracts. **This is not an
audit.** It does not change anything in "What we must NOT claim yet". No `.circom` file changed, so the circuits,
dev zkeys, exported verifiers and `fixtures/v2` are unchanged and were not rebuilt.

### Commands run for this section (one at a time, `contracts/`)

| # | Command | Result |
|---|---|---|
| R-a | `forge test --match-path 'test/{GrovePool,DarkCurve}.t.sol'` | **41 pass, 0 fail**, 0 skipped: GrovePool 22 (19 + 3 new), DarkCurve 19 (16 + 3 new) |
| R-b | `forge test --match-path 'test/{PrivacyFixtures,Planter,BabyJubjub}.t.sol'` | **23 pass, 0 fail**, 0 skipped: PrivacyFixtures 5 (real proofs, dev verifiers), Planter 7, BabyJubjub 11 |
| R-c | `FOUNDRY_INVARIANT_RUNS=32 forge test --match-path 'test/PrivacyInvariants.t.sol'` | **5 pass, 0 fail**, 32 runs x 16,000 calls, 0 reverts. **Reduced runs** (the configured 256 runs took 824 s in run 2); rerun at full depth before relying on it |
| R-d | `forge build --sizes` | `DarkCurve` 21,294 B (was 21,064), `GrovePool` 12,520 B (was 11,940); both under 24,576 |

Not rerun: `npm run test:v2` (no circuit or `grove-zk-v2.mjs` change), `npm run build:v2`, the full `forge test`
(only stage-2 files import the changed contracts; every suite that imports them was rerun above).

### Findings fixed

| # | Severity | Finding | Fix | Test that would have caught it |
|---|---|---|---|---|
| R1 | **High** | `GrovePool.migrateFromV1(vp, ve, handle)`: `handle` was not bound to the v1 proof (v1 `ExtData` has no handle field). The relayer holding a `v1migrate` request (spec §5.3 holds them for days) or any mempool watcher could replay the same v1 proof with **its own handle** and take the BNB. Variant: front-running with a direct `v1.transact` (recipient = pool) made the BNB land in the pool on no handle, stranded forever, because `receive` accepted v1 unconditionally | The handle is bound into the v1 proof: `ve.encryptedOutput2 == abi.encode(handle)` (output 2 of a migration is the zero-value dummy note, so its ciphertext slot is free), else `MigrationNotBound()`. `receive` accepts BNB from v1 only while `migrateFromV1` runs (`_migrating` flag) | `GrovePool.t.sol` `test_review_R1_migrateFromV1_handleBound_noDirectV1Payout` (replay with another handle, unbound request, direct v1 front-run, v1 payout after the migration); `test_migrateFromV1_creditsHandle` updated to bind its handle |
| R2 | Medium | Denomination bypass: `transact` and `submitIntent` paid an **uncapped** relayer fee to an arbitrary `relayer` address, i.e. an exit of any size to any address that skips the "denominations enforced on-chain" rule (spec §6.1 row 4) | `GroveConstants.MAX_RELAYER_FEE = 0.01 BNB` (= the smallest BNB denomination). `transact` reverts `OverLimit()`, `submitIntent` reverts `FeeTooHigh()` above it. Fixture fees (at most 0.001 BNB) are unaffected | `test_review_R2_relayerFeeCapped_noDenominationBypass` (GrovePool), `test_review_R2_intentFeeCapped` (DarkCurve) |
| R3 | Medium | `DarkCurve.keyGen` and `Epoch.keyId` were `uint8` (as in spec §4.3). With the daily key rotation of spec §6.4, the 256th rotation (about 8.5 months) made `keyGen += 1` panic: `submitIntent` and `setCoordinatorKey` would revert forever (escrow stayed safe: open, void and claim do not promote) | `keyGen`, `Epoch.keyId`, `_keyIdOf` and `activeCoordinatorKey().gen` are `uint32` (the `Epoch` struct still packs into one slot; `cur` stays at storage slot 5). **Deviation from spec §4.3**; fold it into the spec | `test_review_R3_keyRotation_pastUint8` (300 rotations, then an intent and an open) |
| R4 | Low | `setCoordinatorKey` and the constructor accepted any on-curve point. The identity `(0, 1)` makes every ciphertext `C2 = u*B8`, silently publishing every intent's amount; a point outside the prime-order subgroup can never satisfy `epochOpen` (`pk == sk*B8`), so every epoch would void | `_isValidKey`: on curve, `x != 0` (rejects the identity and `(0, -1)`), and `l*pk == O`. Costs about 0.5 M gas per (owner-only, daily) `setCoordinatorKey` | `test_review_R4_coordinatorKeyMustBeInSubgroup` (identity, order-2 point, `pk + (0,-1)` of order 2l, constructor) |
| R5 | Low | `pullRewards` divided by the pool's coin balance with only `supply > 0`. Over rounding dust (a few wei left after claims and unshields) one run sets `accRpt += amount*1e18/dust` (about 3e35 for 1 BNB over 3 wei); accumulated, `accRpt - rpt0` passes the circuits' `Num2Bits(128)` and coin notes with an older `rpt0` become unspendable, and `inAmount*delta` approaches the field size | `require(supply >= MIN_REWARD_SUPPLY)` with `MIN_REWARD_SUPPLY = 1e18` (one token). Then `accRpt` never exceeds the BNB ever pulled (< 2^87), so `inAmount*delta < 2^215 < p` in `transfer` / `intent`. A refused run stays claimable in HolderRewards until its window ends | `test_review_R5_pullRewards_refusesDustSupply` |

Client impact of R1: the not-yet-built `v1migrate` builder (WP-web, spec §5.3) must put `abi.encode(handle)` in
`encryptedOutput2` of the v1 proof and keep the change note in output 1. Spec §4.2 ("`receive` accepts from `v1`")
and §4.3 (`uint8 keyId`) should be updated to match R1 and R3; R2, R4 and R5 add checks the spec does not list.

### Real but not fixed

| # | Severity | Finding | Why not fixed here / what fixing needs |
|---|---|---|---|
| N1 | Medium | **Reward sniping / double dip.** `pullRewards` spreads the pool's run share over the coin notes in the pool **at pull time**, not at the HolderRewards snapshot. A wallet counted at the snapshot can shield its tokens before the keeper's pull and be paid again through the pool; anyone can shield lots just before a visible pull and take a share of rewards earned by earlier shielded holders | **Fixed 2026-10-07** (owner decision: atomic post + pull). New `contracts/src/RewardPoster.sol` (no owner, immutable operator = keeper wallet) is HolderRewards' keeper and calls `postRun` then `GrovePool.pullRewards` in one transaction; a failed pull reverts the post. The keeper posts through it when the deployment file has `rewardPoster`, and leaves a pool under `MIN_REWARD_SUPPLY` out of the run. Activation: the Safe calls `HolderRewards.setKeeper(rewardPoster)`. Residual: a shield between the (unannounced) snapshot block and the post still shares that run. Tests: `RewardPoster.t.sol` 5/5 (real HolderRewards Merkle proofs), keeper `rewardsPrivacy.test.ts` 5/5 |
| N2 | Medium (operational) | `openEpoch` is permissionless and `minOut` is not bound by the open proof. If the Coordinator's open transaction is ever visible before inclusion, anyone can copy its proofs and `u` with `minOut = 0` and sandwich the batch within the band | **Fixed 2026-10-07** (owner decision). `minOut` is now the 8th public signal of `epochOpen.circom` (bound with a square constraint), `DarkCurve.verifyOpen` takes it, `openEpoch` passes `minOut[d]`, the keeper proves with the floor it quoted. A copied open with any other `minOut` fails `InvalidProof`; opening stays permissionless. Tests: circuits test 12, `PrivacyFixtures.t.sol` (`test_openEpochSell_realProof` replays the open with `minOut = 0`: reverts), `DarkCurve.t.sol` signal order, keeper `coordinator.test.ts` / `zkprove.test.ts`. A floor from `refPrice` was considered and rejected: it must allow the 10% band, so it adds nothing over `_checkBand` |
| N3 | Low (latent) | `claim.circom`: `q*totalIn` and `qr*totalIn` can reach 2^256 > p under the declared bounds (`q`, `qr`, `totalIn` < 2^128), so the "field-wrap guard" comment is incomplete | **Fixed 2026-10-07**: `Num2Bits(100)` on `totalIn` (16,202 constraints, was 16,230); `claim` dev zkey, verifier and `fixtures:v2` rebuilt (`CIRCUITS="claim epochOpen" bash scripts/setup-v2.sh`) |
| N4 | Low | Tree full (2^21 chunks): `DarkCurve` inserts revert `TreeFull`, so claims and voids of the last epochs cannot land; `GrovePool.transact` drops its outputs while still spending inputs and taking shield value (same as v1) | Far off at current volume; needs a decision (refuse shields when `chunksLeft() == 0`, reserve chunks for claims) |
| N5 | Info | Test hygiene: `invariant_nullifierUniqueness`'s `spentTotal == spentUnique` is tautological (the handler makes its own fresh nullifiers); the real property is `reuseLanded == 0` from the `doubleSpend` handler. "0 reverts" is because handlers pre-filter. There is no invariant handler for intents, opens or claims (covered by unit tests and the real-proof fixture replay only) | Add a DarkCurve handler (per-asset solvency across escrow, opens, voids and claims) when the suite is next extended |

### Checked, no finding

- **Circuits.** No `<--` in any stage-2 source (`grep "<--"` over `transfer`, `intent`, `claim`, `epochOpen`,
  `keypair-v2`, `merkleProof`, `lib/*.circom`: no match). Range checks: output amounts 128 bits, `claimAmount` 128,
  `delta` / `inQ` 128, `inR` 64 with `inR < 1e18`, `u` 32 with `u >= MIN_U`, `k` / `sk` 251, opened `u` 40, claim
  `a` 96, path indices 23 (one nullifier per leaf). Input amounts are not range-checked in-circuit, but a non-zero
  input must be in the tree and every leaf source range-checks its amount. `BabyCheck` on `ecPk` (encrypt) and on
  `C1`, `C2` (decrypt), with `pk == sk*B8` constrained. Selectors: `dir*(dir-1)*(dir-2) = 0`, asset
  `a*(a - coin) = 0`, `IsZero` flags. Claim divisions: `a*totalOut < 2^224` and remainders bounded (see N3 for the
  quotient side). Leaf domains: a result leaf cannot be minted as a note (its amount slot would be `RESULT_TAG`,
  above 2^128); intent leaves are `Poseidon(2)`, notes `Poseidon(3)`; a zero-amount padding input cannot alias an
  intent note (`a >= MIN_U*UNIT`) or burn a claim nullifier.
- **Public-signal order** of all four verifiers vs the contract wrappers: real proofs verify through the wrappers
  and every single-signal tamper fails (`PrivacyFixtures`, R-b). The exported verifiers `checkField` every input,
  so a nullifier `n` and `n + p` cannot both pass.
- **Nullifier replay**: one `nullifierHashes` map for transfers, intents (`markSpent` reverts on reuse) and claims.
- **Checkpointed roots**: `transact`, `submitIntent` and `claim` all use `isKnownRoot`, which only knows
  checkpoints; `checkpoint()` records at most one root per period.
- **Per-asset solvency** (by reasoning plus the BNB invariant): coin notes stay at or below the pool's coin balance
  (only proven `u*UNIT` amounts leave through `moveOut`; BUY proceeds and SELL refunds are in the pool before their
  notes exist, stamped `rpt0 = rptAtSettle`); pro-rata floors keep claims within totals; owed dividends stay within
  the BNB pulled per coin (given R5). Handles are BNB-only on both sides.
- **Reentrancy**: every external entry that moves value is `nonReentrant`; payouts come after state updates; a
  relayer reentering the pool from `moveOut` sees consistent state.
- **ElGamal points**: ciphertexts arrive affine and canonical (verifier field check, `isOnCurve`), sums are kept
  projective and compared / verified only after `toAffine`; `seenC1` on the affine x covers both signs of y.
- **Access control**: `setModules` once, module hooks `onlyModule`, `Planter.handOver` only through a pool proof
  over the stub's handle, owner powers bounded to the spec's list (plus R4's key validation).

## Implementation review

Second internal review pass (chain step 9, 2026-10-06) over what chain steps 1–8 built: keeper crypto, `coordinator`,
`rotate-key`, `pool-feed`, the relayer, the web library / hooks / UI, and the deploy tooling. **This is not an audit**
and changes nothing in "What we must NOT claim yet". No `.circom`, contract or deployment file changed in this step.
Focus: privacy leaks, relayer abuse, key handling, the chain-56 deploy gate, live-site safety, and docs / UI claims
against spec §6.1.

### Commands run for this section (one at a time)

| # | Command | Result |
|---|---|---|
| IR-1 | `cd keeper && npx vitest run test/relayer.test.ts` (after each fix) | **30 pass, 0 fail** (26 earlier + 4 new: K1, K2, K3, K4) |
| IR-2 | `cd keeper && npm test -- --no-file-parallelism` then `npm run build` | **168 pass, 0 fail, 1 skipped** (19 files; the skip is the existing `BSGS_FULL` one); `tsc` clean |
| IR-3 | from `zkBNB/web`: `node --experimental-strip-types --no-warnings --import ./test/resolve-ts.mjs --test test/review2.test.mjs` | **3 pass, 0 fail** (W1, W2, W3) |
| IR-4 | from `zkBNB/web`, one at a time: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` | typecheck clean; lint 0 errors, 1 warning (the existing `ovk` one in the synced `zkbnb-zk-v2.mjs`); **108 pass, 0 fail** (105 + 3); build exit 0, 31 routes, `/docs/privacy` and `/wallet` static. Prebuild sync left the tracked ABIs and deployment files unchanged |
| IR-5 | `cd contracts && forge test --no-match-path 'test/PrivacyInvariants.t.sol'` | **269 pass, 0 fail, 2 skipped**, 17 suites |
| IR-6 | `cd contracts && FOUNDRY_INVARIANT_RUNS=16 forge test --match-path 'test/PrivacyInvariants.t.sol'` | **5 pass, 0 fail**, 16 runs × 8,000 calls, 0 reverts (**reduced depth**) |

Not rerun: `npm run test:v2` / `check:constants` / `check:protocol` (no circuit, constant or protocol type changed),
the anvil end-to-end `npm run e2e:anvil` (heavy; it does not call any function changed here).

### Findings fixed (each with a test)

| # | Severity | Finding | Fix | Test |
|---|---|---|---|---|
| K1 | Medium | Relayer rate limit keyed on the **first** `X-Forwarded-For` hop when `RELAYER_TRUST_PROXY=1`. Behind nginx (`proxy_add_x_forwarded_for`) the first hop is whatever the client wrote, so one client got a fresh token bucket per request: unlimited quotes and POSTs | `clientIpOf`: the **last** hop (the one the single trusted proxy appends); the header is still ignored without `RELAYER_TRUST_PROXY` | `relayer.test.ts` "K1": pure cases, and over HTTP four POSTs rotating a spoofed first hop get `400 400 429 429` |
| K2 | Medium | Unbounded send queue. Every POST that passes the cheap policies (a well-formed body with an invalid proof is enough) waits for one serialised `eth_estimateGas`, so a flood starves real sends | `RELAYER_MAX_QUEUE` (default 32): POSTs get `503 busy` while that many sends are queued; held releases bypass it | "K2": with a gated send and `RELAYER_MAX_QUEUE=2`, the third and fourth POSTs get 503 `busy`, later ones go through |
| K3 | Medium (key handling) | `keeper/src/config.ts` loads one `keeper/.env` for every command, so a host with both roles configured gives the relayer process `COORDINATOR_SK` (and the Coordinator the relayer key), against spec §2.10 / §6.4 "different machine" | `keeper/src/roles.ts` + `index.ts`: `relayer` refuses to start on chain 56 when `COORDINATOR_SK` / `COORDINATOR_KEY_DIR` are set; `coordinator` / `rotate-key` refuse when `RELAYER_PRIVATE_KEY` / `RELAYER_HELD_KEY` are; elsewhere a warning (variable names only). Stage-1 commands and `all` unaffected | "K3": role mapping, refusal on 56, warning on 97, names never values |
| K4 | Low (timing) | Held-release jitter drawn from `Math.random` (xorshift128+), whose state can in principle be modelled from many observed release times | default `rng` = `crypto.randomInt` | "K4": jitter in range, `Math.random` never called |
| W1 | Medium (privacy, web host) | `readCoordinatorKey` read `keyByGen(epoch.keyId)` **only when the target direction already had intents**, and skipped `epochsOf(allCoins)` when the coin was missing from the cached list. The `/api/rpc` request pattern minutes before an `IntentSubmitted` therefore told the web host "joins a collecting epoch" (on a quiet chain: one or two coins) or "a coin newer than my list" (spec §5.1, §6.1 row 11b) | `coordinatorKeyByReads`: always reads the previous, active and next generations, whatever the coin; `epochsOf(allCoins)` always read; an out-of-window `keyId` (not reachable under the daily rotation) is the only extra read | `review2.test.mjs` "W1": five epoch shapes give the identical read list `[g−1, g, g+1]` and the right key; the hook goes through the helper |
| W2 | Medium (live-site safety) | `privacyDeployed` was true on chain 56 as soon as `NEXT_PUBLIC_GROVE_POOL` / `_DARK_CURVE` / `_PLANTER` were set, even with development proving artifacts synced, so one env-var mistake on Vercel could show the stage-2 UI to mainnet users before the ceremony | `privacyDeployed(dep, devArtifacts = ARTIFACTS_V2_DEV_KEYS)` is false on chain 56 while the artifacts are dev keys (sync-zk's stub also says dev keys) | "W2" |
| W3 | Low (claims vs §6.1 row 10) | The private trade panel showed only "Your amount is hidden only if others trade …" (spec §5.1), with nothing about the Coordinator, which in stage 2 could read every amount | `COORDINATOR_SENTENCE` rendered under it, with a link to `/docs/privacy#trust` | "W3" |
| D1 | Low (docs) | `/docs/privacy` said there was "no app screen, relayer support or batch coordinator" (now built, unused, hidden) and its "will not hide" list lacked §6.1 row 9 (the coin of an in-pool coin transfer) and row 10's key-leak clause | Page updated (status bullets, a "Software around them" item, row 9, the key-leak sentence, the to-do list); every new sentence is backed by this file | IR-4 build (static page); no automated text test |

### Real but not fixed

| # | Severity | Finding | What fixing needs |
|---|---|---|---|
| N6 | Low (relayer cost) | The nullifier in-flight lock is released 15 s after a send, not at inclusion. A duplicate POST while the first transaction is still pending passes `eth_estimateGas` against `latest` and is sent; it reverts on the spent nullifier at the relayer's expense | Hold the lock until the receipt (or estimate against `pending`). Only matters if a relayed transaction stays pending > 15 s |
| N7 | Low (spec, liveness) | `v1migrate` with `notBefore` may be held 14 days, but the v1 pool remembers only its last 100 roots (`MerkleTreeWithHistory.ROOT_HISTORY_SIZE`). After 100 v1 transactions the held proof is dropped at release (funds stay safe in v1; the user must prove again) | Spec §7 / the not-yet-built *Migrate slowly* builder: warn, or keep `notBefore` short relative to v1 activity |
| N8 | Low (privacy, timing) | A held release (or any intent) can land just after its watched epoch was opened (K reached and `T_MIN` passed during the 0–20 s jitter plus inclusion). It then starts a new epoch alone and, unless others join, opens at `T_MAX` with N = 1 (amount public). The relayer re-checks when the jitter fires, not at inclusion | **Fixed 2026-10-07** (owner decision: hold for the next batch). `holdDecision` releases only into an epoch that cannot become openable within `RELEASE_LAND_SEC` (30 s: jitter + inclusion), using `tMin`, `tMax` and `k`; otherwise the intent waits for the next epoch. The `submitByEpochEnd` release moved to `T_MAX − 60 s` so it still lands inside the epoch. Test: keeper `relayer.test.ts` "review N8" (31/31) |
| N9 | Info | Held requests are AES-256-GCM at rest under `RELAYER_HELD_KEY` from the same host's environment: this protects copies of the directory (backups, a stolen disk image without the env), not a compromised host | Keep the key out of backups; document in the relayer runbook |
| N10 | Info | `decryptSecret` (browser key file) has no upper bound on PBKDF2 iterations; a tampered local key file can hang the tab | Local tampering only; a cap (e.g. 10,000,000) when the key file format next changes |

### Checked, no finding

- **Per-intent decryption.** The only `decrypt` path is `elgamal.decrypt` on a `SummedCiphertext` built from an epoch's
  on-chain running sum (`coordinator.ts`, spy test C-1). An epoch with one intent is decrypted as a "sum" of one, which
  the spec accepts (§6.1 row 1: that amount is published by `openEpoch` anyway). The web has no Coordinator secret.
- **Logs.** Relayer: no access log, one `sent kind= hash=` line per send, errors through `shortError` (R-1 test).
  Coordinator: coin, direction, seq, count and the sum's magnitude only; the dry-run plan redacts `u`. `sendTx`'s
  nonce-collision warning prints the full viem error (which contains the `openEpoch` arguments), but only after a real
  send, when `u` is public calldata. Key files are named, never printed; `COORDINATOR_SK` / `RELAYER_PRIVATE_KEY` /
  `RELAYER_HELD_KEY` parse errors never echo the value.
- **Bundle and `epochs.json`.** Only chain data (leaves, nullifiers, intents, epochs, credits, `accRpt`, checkpoints),
  the same bytes for everyone; no relayer- or wallet-side field.
- **Web reads.** Stage-2 hooks read `epochsOf(allCoins)`, one all-coin multicall, the bundle and the relayer; claims
  go to the default relayer after a CSPRNG 1–24 h delay; no receipt or nullifier is polled through `/api/rpc` (the one
  receipt read is the user's own shield, sent from their wallet). After W1 the key reads name no coin either.
- **Relayer policies.** Stage-2 fees must be a tier ≤ `MAX_RELAYER_FEE` and cover gas at send time; shields are never
  relayed; `plant` / `v1migrate` / intent key checks mirror the contracts; concurrent holds of one note are refused
  synchronously in `HeldManager.add`; a held release re-runs every policy and the simulation. Stage-1 kinds through
  the keeper relayer keep the Vercel route's rules (no fee cap there, as on the live route).
- **Browser keys.** AES-256-GCM under PBKDF2-SHA256 ≥ 600,000 iterations (refused below on both encrypt and decrypt),
  passphrase ≥ 8 characters (also in wallet-derived mode), BIP-39 checksum and reference vectors (W-5), CSPRNG entropy.
- **Coordinator keys.** Files `0600` in a `0700` directory, written atomically, destroyed by overwrite + fsync + unlink
  once no collecting epoch uses them; the contract refuses keys outside the subgroup (R4).
- **Deploy gate.** `deploy.sh 56 --privacy` runs `ceremony-gate.mjs` before loading any `.env` and exits on refusal;
  `DeployPrivacy` refuses chain 56 without `PRIVACY_CEREMONY_GATE=passed`, refuses any verifier source marked
  `DEV KEY` and the public dev Coordinator key; `Deploy.s.sol` never adds the privacy stack on 56. Bypassing it takes a
  deliberate manual `forge script` run with a forged env var **and** edited verifier sources.
- **Live site.** Every stage-2 component renders only with `privacyDeployed` (false on 56 / 97 / 31337; after W2 it
  cannot be true on 56 with dev artifacts); `PlantForm` defaults to the public launch. Enforced on every route:
  `object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'` (nothing the site loads uses
  plugins, `<base>`, cross-origin forms or being framed; note that `frame-ancestors 'none'` stops any third party
  embedding the site). The full allow-list is Report-Only except on `/wallet`; wallets connect through the injected
  connector only, so no WalletConnect origin is needed. On a local `next start` against anvil (chain 31337, default
  RPC `127.0.0.1:8545`) the enforced `/wallet` policy would block the RPC unless `NEXT_PUBLIC_RPC_URL` is set.
- **Live keeper.** With the live `56.json`, `pool-feed`, `dividends` and `flush` return before any read or write and
  `rewards` behaves as before (C-5); `all` never runs `coordinator`, `rotate-key` or `relayer`; K3 only affects those
  three commands.

Files changed in this step: `keeper/src/relayer/server.ts`, `keeper/src/relayer/held.ts`, `keeper/src/roles.ts` (new),
`keeper/src/index.ts` (additive), `keeper/.env.example` (additive), `keeper/test/relayer.test.ts` (appended),
`web/src/hooks/useIntents.ts`, `web/src/lib/zk/wallet2.ts` (additive), `web/src/config/addresses.ts`,
`web/src/components/coin/PrivateTradePanel.tsx` (one line + import), `web/src/app/docs/privacy/page.tsx`,
`web/test/review2.test.mjs` (new), `web/package.json` (test list), this file, `privacy/HANDOFF-STAGE2.md`.
