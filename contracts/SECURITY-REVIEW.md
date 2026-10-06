# zkBNB pre-launch security review

Scope: `contracts/src/*` (Launchpad, GroveCoin, FeeRouter, Roots, HolderRewards, DonationRotator,
ShieldedPool, MerkleTreeWithHistory, interfaces), `circuits/transaction.circom` (+ keypair,
merkleProof) and `circuits/lib/grove-zk.mjs`, against SPEC.md. Reviewed as an attacker with real
BNB at stake. Every confirmed issue is fixed in `src/` with a regression test in
`test/Security.t.sol`. `forge test`: **152 passed, 0 failed** (131 before + 21 new).
`Groth16Verifier.sol` and `test/fixtures/pool.json` were not touched (ceremony in flight).

## 1. Findings

| # | Sev | Where | What | Fix / status |
|---|-----|-------|------|--------------|
| F1 | **High** (DoS of graduation; drain if "fixed" naively) | `Launchpad._graduate` | Anyone can `factory.createPair(coin, WBNB)` before graduation and seed it: transfer dust tokens + 1 wei WBNB and `sync()` (or `mint()` LP). `addLiquidityETH(min = LP_TOKENS, min = bnb)` then reverts forever (`INSUFFICIENT_*_AMOUNT`, or `INSUFFICIENT_LIQUIDITY` for a one-sided sync): the last buy of every curve reverts, the coin can never graduate. Cost to attack: one `createPair` + a few wei. The naive fix (mins = 0) is worse: the router adds our 11.3 BNB at the attacker's price, and the pool then opens up to 18x above the curve end price, so holders dump into it and the raised BNB is drained (this is the four.meme March-2025 exploit class). With LP pre-minted by the attacker (20M tokens bought for ~0.08 BNB + 1 wei), a plain "mint at our ratio" gives his LP a claim on ~1 BNB of the raised BNB (`bnb * rT/(rT+LP)`). | Rewrote graduation. No router liquidity math: (1) if the pair has reserves **and** LP supply, the launchpad first arbitrages the pair to the ratio the final pool will have anyway, `(theirTokens+ours):(theirBNB+ours)` (buys the cheap side with the coin's own BNB/tokens, capped at 90% of either side); (2) it then transfers everything it holds to the pair and calls `pair.mint(DEAD)`. By conservation the pool opens at `(rT+LP):(rB+bnb)`: a donation can only lower the price or gift BNB to the pool, never let anyone take the raised BNB, and a pre-minted LP position is worth at most what was put in (AM-GM: arbitrage against an LP never increases its value). Refund to the buyer moved after graduation so there is no callback while the pair is half built. Tests: `test_graduation_survivesPreSeededPair_*` (sync-only, one-sided tokens, one-sided BNB, empty pair), `..._preSeededLp_tokenHeavy_attackerGainsNothing`, `..._bnbHeavy_mispricingCapturedByPool`, `testFuzz_graduation_preSeededLp` (any ratio with LP: graduates, pool keeps >= raised BNB after being arbed to the end price, attacker LP <= deposit value). |
| F2 | Medium (MEV on fees) | `GroveCoin.sweepTax`, `FeeRouter.buybackAndBurn` | `minBnbOut` / `minGroveOut` are caller-supplied and anyone may call: `sweepTax(0)` on a big tax pile can be sandwiched (front-run sell, sweep dumps at the low price, back-run buy), same for a pot-sized public buyback. An in-tx quote floor does **not** help (the quote is taken after the front-run). | Bounded the sandwichable size instead: non-keeper `sweepTax` sells at most `PUBLIC_SWEEP_BPS` = 1% of the pair's token reserve, once per block (price impact ~2%, MEV take well under 1% of the swept amount); non-keeper `buybackAndBurn` spends at most `publicBuybackCap` (0.05 BNB, owner-settable) once per block. The keeper (`FeeRouter.keeper`, new, set by owner; the keeper already passes an off-chain-quoted min) is uncapped. Liveness stays permissionless. Tests: `test_sweepTax_publicCallerIsCappedAndRateLimited_keeperIsNot`, `test_sweepTax_keeperSweepsAboveTheCap`, `test_buybackAndBurn_publicCallerIsCappedAndRateLimited_keeperIsNot`. |
| F3 | Medium (trust model) | `ShieldedPool.setLimits` | Owner could set `maxExtAmount = 0` and freeze every withdrawal (or `maxFee = 0`), contradicting SPEC 3.8 "no admin over funds". | `maxExtAmount` / `maxFee` are now constants (2^248, the field bound already enforced by `calculatePublicAmount`); the only knob is `setMaxDeposit` (deposit cap). **ABI change**, see 4. Test: `test_setMaxDeposit_onlyKnob_withdrawLimitsAreConstants`. |
| F4 | Medium (trust model) | `DonationRotator.updateCause` | Contract owner could call `updateCause` on any cause and change its `shieldedPubKey` / `fallbackWallet`: future donations of every cause redirectable by the admin key. | `updateCause` is cause-owner only; new `setCauseActive(causeId, bool)` for cause owner or contract owner (moderation only). Test: `test_updateCause_causeOwnerOnly_adminCanOnlyToggle`. |
| F5 | Medium (trust model) | `FeeRouter.setModules`, `Roots.setHolderRewards` | Re-pointing `roots` / `holderRewards` / `donationRotator` later would let the owner redirect 25-65% of every future fee (and the cap overflow) to an arbitrary contract, contradicting "admin cannot take roots BNB". | Both are one-shot (and zero-address checked). Tests: `test_setModules_isOneShot`, `test_roots_setHolderRewards_isOneShot`. |
| F6 | Medium (stuck funds) | `DonationRotator.settle` / `_payCause` | A cause without a shielded key whose `fallbackWallet` reverts makes `settle` revert: the ring (and every coin bound to it, irrevocably) is stuck until that cause is deactivated. Same if the pool refuses the note (tree full). | `_payCause` never reverts on the payee's account: pool failure falls back to the wallet (or the cause owner if none), a failed push lands in `pending[to]` (new `withdrawPending()`), `PayoutDeferred` event. Tests: `test_settle_revertingFallbackWalletDoesNotBlockTheRing`, `test_settle_poolFailureFallsBackToWalletOrOwner`. |
| F7 | Medium (DoS with locked funds) | `ShieldedPool.transact` | The tree has 2^20 leaves and `transact` always inserts 2. Once full, `_insert` reverts and **withdrawals are impossible forever**. Filling costs 2^20 x ~692k gas ~ 7e11 gas (~70 BNB at 0.1 gwei, ~700 BNB at 1 gwei) via 1-wei `depositFor`/`transact` deposits: expensive but a credible griefing/ransom attack against a pool holding more than that. Legit capacity is also only ~500k transactions. | When fewer than 2 slots remain, `transact` still verifies, spends the nullifiers and pays out, but emits `CommitmentDropped` instead of inserting the outputs (the sender must withdraw fully with zero-value outputs; clients should refuse to build non-zero outputs when `nextIndex + 2 > 2^20`). Pool becomes withdraw-only instead of locked. Test: `test_transact_whenTreeIsFull_withdrawsAndDropsOutputs` (storage-forced full tree). **Recommend** depth >= 23 if the ceremony can still be redone (see 3). |
| F8 | Low | `FeeRouter.buybackAndBurn` | Leftover accounting used raw balance; a `_push` that fails *during* the buyback (rootstock fee -> reverting treasury) was booked both as `pending` and as curve refund into `rootstockPot` (same BNB twice; later withdrawals could fail). | `totalPending` counter; leftover = free balance delta. Test: `test_buybackAndBurn_failedPushDuringBuybackIsNotDoubleCounted`. |
| F9 | Low | `DonationRotator.createRing` | `epochLength = 2^256-1` makes `lastSettled + epochLength` overflow: the ring can never settle, fees of every coin bound to it are stranded. | `MAX_EPOCH = 365 days`. Test: `test_createRing_rejectsAbsurdEpoch`. |
| F10 | Low (footgun) | `ShieldedPool.depositFor`, `transact` | `pubKey = 0` creates an unspendable note (no key hashes to 0); `fee > 0` with `relayer = 0` burns the fee to address(0). | Both rejected (`"field"` / `BadValue`). Tests: `test_depositFor_rejectsZeroPubKey`, `test_transact_feeNeedsRelayer`. |

## 2. Non-issues explicitly verified

**Launchpad curve math.** `quoteBuy` is the exact function `_buy` executes, so quote == execution.
Buy: `tokens = floor(vT*net/(vB+net))`; sell of the same tokens: `gross = floor((vB+net)*tokens/vT) <= net`,
so a buy/sell round trip never returns more than paid (fuzzed + `test_roundTrip_losesExactlyTheFees`).
Invariant `(VIRTUAL_BNB+realBnb)*(VIRTUAL_TOKENS-sold) >= k0` is preserved by floor rounding in both
directions, which implies `gross <= realBnb` for any sell, so the `gross > realBnb` cap never binds
and `soldTokens` cannot be left > 0 with `realBnb = 0`. 1-wei buys: fee rounds to 0 below 50 wei;
the buyer gets ~2.7e8 token-wei and can only sell them back for <= 1 wei (no extraction; only
inflates `buys`, which is cosmetic). `grossMax = ceil-ish(netMax/0.98)+1`: `net = grossMax - floor(grossMax/50) >= netMax`
so the final buy always clears the curve exactly (`sold == CURVE_TOKENS`), overpaying by at most a
few wei. `price()` cannot overflow (vB <= ~16e18, vT >= 2.8e26) nor divide by zero. `remainingCost`
is 0 after graduation. Sells can only be paid from the coin's own `realBnb` (tokens outside the
launchpad == `soldTokens`, so `soldTokens -= tokensIn` cannot underflow). First buy inside `plant`
uses `_buy` under the same `nonReentrant` lock and can graduate the coin in the same tx.

**Reentrancy.** `buy`/`sell`/`plant` are `nonReentrant` and update state before any BNB leaves;
`FeeRouter.collect` is `nonReentrant`; `buybackAndBurn` debits the pot first and any reentrant
`collect`/`withdrawPending` reverts on the guard; a creator wallet reverting (or burning its 50k gas)
only lands in `pending`. `Roots.harvest*`, `HolderRewards.claim*`, `DonationRotator.settle/donateToCause`,
`ShieldedPool.transact/depositFor` are all `nonReentrant` and effects-before-interactions.

**GroveCoin pair-tax.** Tax is applied in `_update` whenever `from == pair || to == pair`, so direct
`pair.swap` from a contract bypassing the router is taxed, as are router swaps (the router uses the
`SupportingFeeOnTransfer` variants). Exempt set is fixed at creation (launchpad, feeRouter, the coin)
plus `roots` (set once by `plant`); `setExempt` is launchpad-only and the Launchpad exposes no
passthrough, so there is no admin path to exempt arbitrary addresses. Burns (`to == 0`) are untaxed by
construction, which is what Roots needs. No external calls in `_update`.

**FeeRouter.** Shares sum to BPS (enforced), `toDeployer = amount - others` so split == amount.
`registerCoin` launchpad-only; ring existence checked on both `registerCoin` and `handOver`; handover
is one-way and `isRootstock` coins cannot be handed over. 50k gas on `_push` is enough for a Gnosis
Safe `receive` (~25k); failed pushes are pull-able.

**Roots.** `harvestValue = balance*tokens/totalSupply`, `tokens <= totalSupply` always, so
`balance -= bnb` cannot underflow and the share cannot exceed 100%. Supply can only shrink (no mint),
and burning raises everyone's ratio (fuzz invariant). Supply held by launchpad/pair is included by
design and cannot be inflated. Non-field / zero pubKey rejected by the pool.

**HolderRewards.** Leaves are `keccak(abi.encode(coin, runId, account, amount))` = 128-byte
preimages; OZ `MerkleProof` internal nodes are 64-byte preimages, so a node cannot be replayed as a
leaf and no second-preimage shortcut exists. `runId` is in the leaf and in the claimed key; claims
are capped by `run.amount`; after `sweepExpired` the run is fully accounted and late claims revert;
`fund`/`tip` only add to the pot, so `balance == sum(pot) + sum(amount - claimed)` holds.
`postRun` cannot exceed the pot.

**DonationRotator.** All-inactive ring: the loop wraps once and reverts, the pot waits (admin can
re-activate via `setCauseActive`). Cursor is always taken mod `n`. The settlement blinding is public
by design: the note `(amount, pubKey, blinding)` is already public in `DepositFor`; spending needs the
nullifier `Poseidon(c, idx, Poseidon(privKey, c, idx))`, i.e. the private key, so only the cause can
spend. Duplicate commitments (same amount/key/blinding twice) are fine: the leaf index is in the
nullifier. `registerCause`/`createRing` spam is harmless: nothing iterates over causes or rings,
rings are <= 64 causes.

**ShieldedPool + circuit.** Nullifier uniqueness: stored map + in-tx inequality on-chain and
`IsEqual === 0` in-circuit. Zero-amount inputs skip the root check (`ForceEqualIfEnabled`) but
contribute 0 to `sumIns`; their nullifier is bound to the fresh key (forging someone else's
nullifier needs a Poseidon collision). Input amounts are not range-checked in-circuit but every
non-zero input must be a tree leaf, and every leaf was created with `outAmount < 2^248` (circuit) or
`msg.value` (`depositFor`), so `sumIns < 2^249`, `|publicAmount| < 2^248` (on-chain), `sumOuts < 2^249`:
the balance equation cannot wrap mod p. `extDataHash` is a public input (squared in-circuit) and
recomputed on-chain over the full `ExtData`, binding recipient/relayer/fee/encrypted outputs.
Groth16 malleability: a re-randomised proof has the same public inputs, the nullifiers are spent on
first use, so a front-runner only pays the user's gas. The generated verifier `checkField`s all 7
public signals (`< r`), so out-of-field roots/nullifiers/commitments are rejected before anything is
stored (verify runs before the writes). Root history of 100 (= 50 transacts): a stale proof just
needs re-proving; griefing by spamming 50 inserts costs ~35M gas per attempt. `depositFor` is
~692k gas; the capacity consequence is F7. Relayer fee > withdrawal is impossible: inputs must cover
`extAmount + fee`. `depositFor` has no cap on purpose and reverts on zero value.

**Access control vs SPEC 3.8.** No function lacks auth where it should have it (`tip`, `donate`,
`depositFor`, `sweepTax`, `buybackAndBurn`, `settle`, `sweepExpired` are intentionally public and
only move money in the intended direction). After the fixes the admin can: set shares within bounds,
pause roots to the immutable `recoveryAddress`, set keeper/treasury/caps/plant fee, cap pool deposits,
(de)activate causes. Admin cannot: take roots BNB, re-route fee modules, change a payee after
handover, redirect a cause, freeze pool withdrawals, upgrade anything.

**Gas/DoS.** `allCoins()` is a view only (web and keeper should switch to `coinCount()`/`coins(i)`
paging once there are thousands of coins; a reverting view is not a fund risk). `isKnownRoot` <= 100
SLOADs, ring loops <= 64, no other unbounded loops.

**Contract sizes (`forge build --sizes`).** Launchpad **21,906 B runtime (2,670 B headroom)**: it
embeds GroveCoin's creation code; keep that in mind before adding features. All others <= 8.4 KB.

## 3. Residual risks for mainnet (not fixable in code here)

- **Keeper trust.** `HolderRewards.postRun` takes any Merkle root: a compromised or malicious keeper
  can pay the whole holder pot of any Holders-mode coin to itself (by design; roots and the pool
  are not reachable). The keeper is now also the uncapped sweeper/buyback caller. Use a dedicated
  hot key with limited funds and monitor `RunPosted`.
- **Groth16 trusted setup.** Soundness of the pool rests on the zkey ceremony being honest
  (toxic waste destroyed). Publish the contributions and beacon; a single-party setup means that
  party can print BNB out of the pool.
- **Tree depth 20** (~1M leaves, ~500k transactions lifetime, F7). Withdraw-only mode is now the
  worst case, but a long-lived pool wants depth >= 23 (new circuit + ceremony + verifier).
- **No external audit** of contracts or circuit; one internal review only.
- **Pair-tax bypass via a second pool.** Only the canonical PancakeSwap V2 pair is taxed. A V3 pool
  or another DEX pair would avoid the 2% creator fee. Taxing all transfers or an admin-managed
  "taxed pools" list are the options; both have UX/trust costs, left as a product decision.
- **Public sweep/buyback MEV** is bounded (~1% of reserve per block, 0.05 BNB per block), not zero.
- **Treasury must accept BNB**: `Launchpad.plant` and `DonationRotator.registerCause` push the fee
  with `require(ok)`; a reverting treasury blocks planting/registration until the owner changes it.
- **Stray BNB** sent straight to the Launchpad is unrecoverable (accounting is by `realBnb`).
- **Ownable2Step**: a pending transfer to a wrong address can be overwritten but a correct pending
  owner can accept at any time; complete the Safe's acceptance right after deployment.
- **Privacy limits** (documented in SPEC): `depositFor` reveals amount + pubKey; a relayer sees the
  withdrawer's IP; a user who shields and unshields the same amount is linkable.
- **PancakeSwap factory `feeTo`**: if Pancake ever turns on protocol fees, `mint` skims LP for
  them; harmless to graduation.

## 4. ABI changes (web / keeper / deploy must follow)

| Contract | Change |
|----------|--------|
| ShieldedPool | **removed** `setLimits(uint256,uint256,uint256)` -> **added** `setMaxDeposit(uint256)`. `maxExtAmount()` / `maxFee()` still exist (constants = 2^248). New event `CommitmentDropped(uint256 indexed commitment)`: clients must treat these outputs as unspendable and refuse to build non-zero outputs once `nextIndex() + 2 > 2^20`. |
| DonationRotator | `updateCause` now reverts for the contract owner (cause owner only). **Added** `setCauseActive(uint256,bool)`, `withdrawPending()`, `pending(address)`, `MAX_EPOCH()`, events `PayoutDeferred`, `PendingWithdrawn`, `CauseActiveSet`. `Settled.shielded` can be `false` for a keyed cause when the pool refused the note. |
| FeeRouter | **Added** `keeper()`, `setKeeper(address)`, `publicBuybackCap()`, `setPublicBuybackCap(uint256)`, `lastPublicBuybackBlock()`, `totalPending()`, events `KeeperSet`, `PublicBuybackCapSet`. `setModules` reverts if already set. `buybackAndBurn` from a non-keeper spends at most `publicBuybackCap` and once per block. **Deploy must call `feeRouter.setKeeper(KEEPER)`** (added to `script/Deploy.s.sol` `_deployStack`; also wired in `test/Base.t.sol`). |
| GroveCoin | **Added** `PUBLIC_SWEEP_BPS()`, `lastPublicSweepBlock()`. `sweepTax` from a non-keeper sells at most 1% of the pair's token balance, once per block (the keeper's `sweep` command is unaffected as long as it is `FeeRouter.keeper`). |
| Roots | no ABI change; `setHolderRewards` is one-shot. |
| Launchpad | no ABI change; `Graduated.tokens` is now everything the launchpad held (== `LP_TOKENS` unless tokens were donated to it), graduation no longer burns "dust", and `IPancakePair`/`IWETH` were added to `interfaces/IPancake.sol`. Refund of excess BNB on the graduating buy now happens after the pool is created. |

Regenerate `web/src/abi/{ShieldedPool,DonationRotator,FeeRouter,GroveCoin}.ts` and the keeper ABI
strings from `out/` before deploying.
