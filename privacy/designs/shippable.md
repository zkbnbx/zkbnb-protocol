# zkBNB full-privacy launchpad: the shippable design

Status: design, 2026-10-05. Angle: **shippable in 4-6 weeks** by one engineer plus Claude agents,
on the existing circom / snarkjs / Foundry / Next.js stack, reusing the live Launchpad, FeeRouter,
Roots, HolderRewards and DonationRotator **unchanged** (they are immutable and one-shot wired, so
they could not change anyway), and reusing the v1 keypair / nullifier / Merkle scheme wherever it
is not the thing leaking.

Owner's goal, verbatim: "full full full real privacy, the first real privacy launchpad". This
document closes every leak that cryptography plus batching *can* close on a public bonding curve,
and says in section 6, without hedging, what stays public and why.

The one-sentence design: **the shielded pool becomes multi-asset (BNB *and* every GroveCoin), all
launchpad actions become shielded transactions inside that pool, and the only thing that ever
touches the public curve is a per-coin batch executed at one uniform clearing price.** Users shield
BNB once (the one unavoidable public edge), then plant, buy, sell, hold, harvest, earn holder
rewards and donate with no wallet, no per-user amount and no link between any two of their actions
on chain. The flywheel (2% fee → roots / rootstock buyback / treasury / deployer choice) is untouched
because the batch trades on the public `Launchpad` like any other trader.

---

## 0. What is reused, what is new, what is rejected

| | |
|---|---|
| **Reused as is** | `Launchpad.sol`, `GroveCoin.sol`, `FeeRouter.sol`, `Roots.sol`, `HolderRewards.sol`, `DonationRotator.sol`, `FlapBuyback.sol`, deployed PoseidonT3 / PoseidonT4 bytecode, `MerkleTreeWithHistory` (one change: O(1) root lookup), the keypair scheme `pubKey = Poseidon(sk)`, the nullifier shape, x25519 encrypted outputs, `zkbnb1…` addresses, the Web Worker prover, the `/api/relay` relayer, the keeper process, the denominations helper. |
| **New contracts** | `ShieldedPoolV2` (multi-asset notes, two verifiers, dividend accumulator), `EpochSwap` (per-coin batches against curve / PancakeSwap / Roots), `Planter` (shielded coin creation), two generated verifiers. |
| **New circuits** | `transaction2.circom` (multi-asset 2-in-3-out join-split with intent output and dividend accrual) and `swapclaim.circom` (pro-rata claim of a settled batch). One ceremony round covers both. |
| **Rejected: Pedersen + Bulletproofs** | Not needed on this stack. A Groth16 note already hides the amount inside `Poseidon(…amount…)` and range-checks it with `Num2Bits(248)`; Bulletproofs are the range-proof tool for systems *without* a SNARK (Monero). Pedersen's one advantage, additive homomorphism to sum hidden amounts on chain, would need either non-native BN254-G1 arithmetic inside the circuit (hundreds of thousands of constraints) or babyjubjub commitments plus someone who can open the sum, i.e. a threshold-decryption or MPC relayer set. That is a research project, not a 6-week deliverable. Section 2.6 shows what we do instead and what it costs in privacy. |
| **Rejected: ring signatures** | Merkle membership + nullifier (what v1 already does) is a ring signature over the *entire* note set (2^20), strictly better than a Monero ring of 16. |
| **Rejected: moving the curve into the shielded domain** | A bonding curve with hidden reserves has no public price, and a curve with public reserves reveals every trade's amount as a reserve delta. Sequential proofs against a hidden state also serialise all traders behind the holder of that state. The only way to hide an individual amount on a public curve is to never execute an individual amount: batch. |
| **Rejected: stealth addresses for in-pool payments** | In a UTXO pool the recipient `pubKey` is *inside* the commitment; reusing a `zkbnb1` address is unlinkable on chain. One-time keys are used only where a `pubKey` must appear in calldata (section 2.2). |

---

## 1. Threat model and privacy goals

### 1.1 Adversary

Anyone with a BSC archive node and the public code: reads every tx, event, calldata, storage diff
and timestamp; runs the keeper's snapshot code; can be a relayer operator (sees IPs and the bytes
it submits, which are public anyway); can trade on the curve to probe; cannot break Poseidon, BN254
or the Groth16 setup (assumed sound after the public ceremony in section 3.5); does not control
both the user's browser and their wallet. The RPC provider the browser talks to is a separate,
weaker adversary (section 6.3).

### 1.2 Properties, per action

Legend: **A** amount hidden, **S** sender/owner hidden, **L** unlinkable to the user's other actions.
"Batch" means hidden inside the epoch's aggregate, see section 6.2 for the anonymity-set numbers.

| Action | Today | Target (this design) | Residual |
|---|---|---|---|
| **Shield** (wallet → pool) | A ✗ S ✗ L ✗ | A: denomination only · S ✗ · L: the shield links to nothing afterwards | The wallet, the denomination and the time are public. Inherent to any shielded pool (Zcash t→z). Denominations enforced on chain so every shield is one of 10 shapes. |
| **Unshield** (pool → wallet) | A ✗ S(relayer) ✓ L ✗ | A: denomination · S ✓ · L ✓ | Recipient address, denomination, time. Relayer pays gas. |
| **Plant** | creator wallet, fee, first buy all public | S ✓ (creator is the `Planter` contract, payouts go to a one-time shielded key) · L ✓ | Coin metadata (it is a coin), plant fee, first-buy BNB amount (a denomination), that it was planted privately, the per-coin creator-fee stream (already public in `FeeSplit`). |
| **Buy** (curve or Pancake) | all public | A: batch · S ✓ · L ✓ | Per-intent denomination, coin, direction, epoch; batch total; curve price (inherent). |
| **Sell** | all public | A: batch · S ✓ · L ✓ | Same as buy, in token lots. |
| **Hold** | `balanceOf` public | S ✓ A ✓ L ✓ | Pool's aggregate custody per coin (`balanceOf(pool)`). |
| **Harvest** (burn → roots BNB) | wallet, tokens, BNB public; shielded variant leaks pubKey+amount+blinding | A: batch · S ✓ · L ✓ | Batch total burned and paid (aggregate). |
| **Holder-reward claim** | wallet + amount; shielded variant leaks pubKey | **No claim tx at all**: rewards accrue inside coin notes and surface as BNB when the note is spent | Pool-level share per run (keeper JSON lists the pool as one holder). |
| **Donation** | public donor+amount; private in-pool transfer ok; settlement leaks cause pubKey + amount | Private donation: A ✓ S ✓ L ✓ (in-pool transfer, as today). Public `donate(ringId)` stays public by choice. | Ring settlement amount + cause (DonationRotator v1 is immutable, pays into the v1 pool; a cause is a public charity anyway, and pots are public state). |
| **Post-graduation trade** | public Pancake swap | A: batch · S ✓ · L ✓ (same intents, venue = router) | Pair reserves, batch total, 2% pair tax. |
| **Timing** | shield → unshield / harvest timing correlates | Batches quantise time; claims can be submitted any time later (root history unbounded); UI randomises | Block timestamps of every tx. |
| **Gas payer** | user wallet | relayer for everything except shield | Relayer address, relayer fee. |

---

## 2. Cryptographic design

### 2.1 Notes

Every value in the pool is a note:

```
note        = { assetId, amount, pubKey, blinding, rpt0 }
assetId     = 0 for BNB
            = uint160(coin)                       for a GroveCoin balance
            = keccak(coin, batchId, dir) mod p    for a swap ticket (section 2.5)
rpt0        = dividend index at creation (coin notes only, 0 otherwise), section 2.7
commitment  = PoseidonT4( amount, pubKey, PoseidonT4(assetId, rpt0, blinding) )
```

Two nested Poseidon-3 hashes instead of one Poseidon-5 so the **deployed** `PoseidonT4` contract
can compute a commitment on chain where that is still needed (`Planter` fee flush, legacy bridge),
without a new Poseidon-6 bytecode. In circuit it costs ~250 extra constraints per note.

Field element bounds: `amount < 2^248` (range-checked), `assetId < p`, `rpt0 < 2^128`.

Encrypted output: `encrypt(abi(assetId, amount, blinding, rpt0))` to the recipient's x25519 key,
emitted in `NewCommitment` as today. Scanning = decrypt every output with your viewing key.

### 2.2 Key hierarchy

```
seed   = keccak(wallet signature of "zkBNB shielded key v2")           (browser, never stored)
sk     = seed mod p                            spending key
nk     = Poseidon(sk, 1)                       nullifier key
pubKey = Poseidon(sk)                          (unchanged from v1: Keypair template)
encPriv= x25519 from keccak(sk)                incoming viewing (unchanged)
```

Keys you can hand out:

| Key | Holder can | Holder cannot |
|---|---|---|
| **Address** `zkbnb1 ‖ pubKey ‖ encPub` | receive | see anything |
| **Incoming viewing key** `(pubKey, encPriv)` | decrypt incoming notes and amounts | tell spent from unspent, spend |
| **Full viewing key** `(pubKey, encPriv, nk)` | everything above + compute every nullifier, so a complete, provable statement of balance and history (auditors, DAOs, causes) | spend |
| **Spending key** `sk` | spend | |

`nk` changes the nullifier from v1's `Poseidon(commitment, index, Poseidon(sk, commitment, index))`
to `Poseidon(commitment, index, nk)`; the circuit proves `nk = Poseidon(sk, 1)` and
`pubKey = Poseidon(sk)` (one extra Poseidon-2 per input). This is the Zcash viewing-key split and
the reason to touch the key scheme at all.

**One-time keys.** Where a `pubKey` has to appear in calldata, the wallet derives
`sk_i = Poseidon(sk, 2, tag, i)` and uses `Poseidon(sk_i)`. Used for: the creator payout key of a
planted coin (tag = coin address), the legacy bridge destination (tag = 3, counter). The wallet
re-derives them deterministically when scanning (it knows which coins it planted; the bridge
counter is small). A one-time key cannot be linked to the master address.

### 2.3 Nullifiers, tree, roots

Unchanged tree: depth 20, Poseidon-2, zero leaf `keccak("grove") mod p`, append-only. Capacity is
fine (v1 has used a few dozen leaves). One change: `MerkleTreeWithHistory` keeps
`mapping(uint256 root => uint32 indexAfter)` instead of a 100-slot ring buffer, so **every root
ever produced stays valid** (`isKnownRoot` is O(1)). Append-only tree + nullifiers make old roots
safe, and it is what lets a user prove now and let the relayer submit hours later (timing
decorrelation) without `UnknownRoot`.

Nullifier set: `mapping(uint256 => bool)` as today; both circuits emit `NewNullifier`.

### 2.4 Coin balances in the shielded domain

A GroveCoin balance is a note with `assetId = coin`. The ERC-20 tokens themselves sit in
`ShieldedPoolV2`'s custody (`balanceOf(pool)`), one public aggregate per coin. Tokens enter custody
from batch buys, token shields (public edge, in lots) and the Planter's first buy; they leave via
batch sells, batch harvests (burned by Roots) and token unshields.

The pool and `EpochSwap` are **not** tax-exempt on GroveCoins: after graduation the batch's router
trades pay the 2% pair tax exactly like a public trader, so the flywheel is identical for private
and public volume.

### 2.5 Shielded buy / sell / harvest: intents and batches

Everything that must touch public state is a **swap** executed per coin, per batch, at one uniform
clearing price, with pro-rata settlement. Three directions:

| dir | asset in → out | venue |
|---|---|---|
| `BUY` | BNB → coin | `Launchpad.buy` while on the curve, PancakeSwap router after graduation |
| `SELL` | coin → BNB | `Launchpad.sell` / router |
| `HARVEST` | coin → BNB | `Roots.harvest` (burn, pro-rata roots) |

**Step by step (a buy of 0.3 BNB of coin C):**

1. **Browser splits the amount into denominations**: 0.2 + 0.1 (two intents). Denominations are
   enforced on chain (section 2.6), so an intent's amount carries no identity.
2. **For each intent, the browser proves a `Transaction2`** that spends BNB notes and creates:
   output 0: a **swap ticket** note `{assetId = keccak(C, batchId, BUY), amount = 0.2, pubKey = mine}`
   output 1: BNB change to myself
   output 2: zero
   with `publicAmountBnb = -(0.2 + relayerFee)` and `swapAmount = 0.2` as public inputs. The
   circuit forces output 0's assetId to equal the public `swapAssetId` and its amount to equal
   `swapAmount`. The relayer and fee are bound through `extDataHash` as in v1.
3. **The relayer submits `ShieldedPoolV2.transact`.** The contract: checks the root, the
   nullifiers, `publicAmountBnb == -(swapAmount + fee)`, that `swapAssetId` is the id of coin C's
   **currently open** batch for `BUY`, that `swapAmount` is an allowed denomination; verifies the
   proof; inserts the three commitments; calls `EpochSwap.record(C, BUY, 0.2)` which does
   `batch.totalIn += 0.2`, `batch.count += 1` and stores the current curve price as the batch's
   reference price (last writer wins); pays the relayer fee. The user's wallet is nowhere.
4. **The batch closes** when `count >= kMin && age >= minAge` or `age >= maxAge` (defaults
   kMin = 4, minAge = 30 s, maxAge = 5 min, owner-settable within [10 s, 30 min]). The next intent
   for C opens batch n+1.
5. **Anyone calls `EpochSwap.settle(C, n)`** (the keeper does, within one block of closing).
   It asks the pool to release `totalIn` BNB, calls `Launchpad.buy{value: totalIn}(C, 0)` (or the
   router), measures `tokensOut` and any refund (the curve refunds what exceeds its end, and may
   graduate inside this call), sends the tokens and the refund back to the pool, stores
   `{totalIn, totalUsed, totalOut, rptAtSettle, settled}` and pays the settler a bounty
   (`min(totalIn * 10 bps, 0.005 BNB)`, taken from `totalIn`). Price protection: the settle
   reverts if the realised average price deviates from the reference price by more than
   `maxDeviationBps` (300) **unless** `msg.sender == keeper` with an explicit `minOut`, which is the
   same pattern the live `FeeRouter.buybackAndBurn` uses. A sandwich that moves the curve 3% makes
   the settle revert and leaves the attacker holding the bag.
6. **The user claims.** Browser proves `SwapClaim`: spends the ticket (nullifier), reads the
   batch's public totals, and creates output 0: a coin note of `floor(0.2 × totalOut / totalIn)`
   with `rpt0 = rptAtSettle`, and output 1: a BNB refund note of `floor(0.2 × (totalIn − totalUsed) / totalIn)`.
   The relayer submits `ShieldedPoolV2.claim(proof, batchKey, extData)`; the contract reads the
   batch struct, passes its numbers as public inputs, verifies, nullifies, inserts. The claim
   reveals *which batch* and that *one of its k tickets* was claimed, not which ticket, not the
   owner. Claims can be submitted any time (unbounded root history); the UI defaults to "claim
   when I'm next online" and a randomised delay is one toggle.

Sell and harvest are the same with `assetIn = coin`, intent amounts in **token lots**, and the
relayer fee paid from a BNB note in the same join-split (input 1), which is why the circuit is
multi-asset. Dividends owed on the spent coin notes (section 2.7) land in the BNB change output.

**Price fixing.** Everyone in a batch gets the same price: `totalOut / totalIn`. There is no
ordering inside a batch, so there is nothing to front-run inside a batch. Buys and sells of the
same coin settle in one `settleBoth` call (sells first, then buys) so that neither side can be
sandwiched by the other.

**Failure and refund path.** `settle` can revert (price deviation, Roots `Dust`, venue failure).
If a closed batch is still unsettled after `settleTimeout` (30 min), anyone calls `cancel(C, n)`:
the batch is marked settled with `totalUsed = totalOut = 0`. The same `SwapClaim` circuit then
pays `refund = D × totalIn / totalIn = D` and `out = 0`: full refund, no special case. Tickets
are never lost; nothing is ever stuck on an admin.

**Slippage.** There is no per-intent limit price (it would make batch inclusion data-dependent and
iterative). The user sees the open batch's pending total and the curve state, so the clearing
price is predictable within the deviation band; the band (3%) is the effective max slippage, and
the keeper's explicit `minOut` path is only for liveness when the band cannot be met and the
alternative is a cancel.

**Anti-front-running summary.** (a) Uniform clearing price: no intra-batch ordering advantage.
(b) Reference-price band on settle: sandwiching the settle tx fails. (c) Cross-batch
"join-and-dump" (buy alongside a big pending batch, sell in the next): bounded by the batch's own
price impact and identical to what any mempool watcher can already do on the public curve; a
commit-reveal variant (intent reveals amount only at settle) is a listed upgrade, not in scope.
(d) Settle bounty is permissionless, so no keeper can hold a batch hostage.

### 2.6 Why per-intent amounts are denominations, and what that buys

The contract **must** learn the batch total to trade it, so each intent contributes a public
amount. Making that amount a fixed denomination is what makes it carry no information:

* BNB side (shield, unshield, BUY intents): `0.01 · 0.02 · 0.05 · 0.1 · 0.2 · 0.5 · 1 · 2 · 5` BNB
  (the existing `denominations.ts` set minus 10; the browser splits anything else; dust < 0.01 BNB
  stays as a private note and is spendable privately, just not at a public edge).
* Token side (SELL, HARVEST intents, token shield/unshield): lots
  `0.1M · 0.2M · 0.5M · 1M · 2M · 5M · 10M · 20M · 50M · 100M` tokens (1-2-5 series; 0.1M tokens is
  < 0.006 BNB at the end of the curve). Up to ~8 intents express any holding; the remainder below
  0.1M tokens stays private and is still harvestable in a later lot once consolidated.

What an observer sees per batch: a multiset like `{0.2, 0.1, 0.1, 0.05}` for coin C. What they
cannot see: how many users that is, which tickets belong together, who owns them, or what else
those owners did. The user's *total* is hidden whenever the batch holds more than one user; the
browser also spreads large orders across consecutive batches by default.

The upgrade path if the owner later wants per-intent amounts hidden from the chain too:
babyjubjub Pedersen commitments per intent, summed on chain (~15k gas per add), opened by a
2-of-2 relayer pair holding additive shares of `(amount, blinding)`, with Groth16 proving each
commitment is well formed. Honest cost: a non-collusion assumption on two operators, ~2 extra
weeks, and a third circuit. Not in this plan.

### 2.7 Holder rewards without a claim: dividend-bearing notes

The keeper snapshots `Transfer` logs; with shielded holdings it sees `ShieldedPoolV2` as one big
holder. So the pool *is* a holder: the keeper includes the pool address with its full balance in
every `Holders`-mode run (it is removed from `EXCLUDE_ADDRESSES`; the per-holder $20 floor does
not apply to the aggregate). After `postRun`, the keeper calls `ShieldedPoolV2.pullRewards(coin,
runId, amount, proof)`; the pool calls `HolderRewards.claim` as itself and receives the BNB.

The pool then does Synthetix-style accounting:

```
accRpt[coin] += amount * 1e18 / IERC20(coin).balanceOf(pool)
```

Every coin note stores `rpt0 = accRpt[coin]` at creation (batch claims use `rptAtSettle`, so there
is no rush to claim). When a coin note is spent, `Transaction2` is given `accRpt[coin]` as a public
input and adds `owed = amount × (accRpt − rpt0) / 1e18` to the BNB side of the balance equation.
The dividend simply appears in the spender's BNB change note. No claim transaction, no Merkle
leaf per holder, no `depositFor`, nothing per-user on chain. The pool is solvent by construction
(`Σ amount ≤ balanceOf(pool)` and floor division). Edge: notes created between a snapshot and
the keeper's `pullRewards` a minute later accrue a share they did not hold for; the keeper pulls
in the same loop iteration as `postRun`, so this is a rounding-level effect and documented as such.

### 2.8 Private planting

`Planter` is the on-chain creator of privately planted coins. The user's `Transaction2` is an
unshield of `plantFee + firstBuy` (a denomination) with `recipient = Planter` and a `payload` in
`ExtData` (bound by `extDataHash`): `abi(PlantParams, creatorPubKeyOneTime, authHash)`. The pool
sees `recipient == planter` and calls `Planter.plantFor{value}(payload)` instead of a bare send.
`Planter` calls `Launchpad.plant` (so `info[coin].creator = Planter`, and `FeeRouter` pushes
Creator-mode fees to `Planter`), forwards the first-buy tokens to the pool as a coin note for
`creatorPubKeyOneTime` (amount is public in the `Trade` event anyway), and records
`creatorKey[coin]`, `authHash[coin]`.

* `Planter.flush(coin)`: anyone; deposits accumulated creator fees into the pool as a note for
  `creatorKey[coin]` via the pool's `depositFor`-style insert (the amount is the public fee stream;
  the key is one-time per coin, so it links to nothing).
* `Planter.handOver(coin, secret, mode, wallet, ringId)`: `keccak(secret) == authHash[coin]`;
  one-shot, so a hash preimage is sufficient authorisation; the relayer submits.

### 2.9 Relayer economics

Fee = `gasPrice × gasUnits(method) × (1 + marginBps) + flatFee`, quoted by `GET /api/relay`
exactly as today, paid in BNB out of the spent notes, bound in `extDataHash`. New: a method
field (`transact`, `claim`), both chains, and a published `relayers.json` so third parties can run
the same code (`RELAYER_PRIVATE_KEY` + RPC) and users can pick any relayer in the UI. Two relayers
at launch: the Vercel route and the keeper VPS. At BSC's ~0.1 gwei a 900k-gas transact costs
~0.00009 BNB; a 20% margin plus 0.00005 BNB flat makes the service self-funding at ~0.00016 BNB
per action, below the 0.01 BNB smallest denomination by 60×.

Settlement is paid by the batch bounty (10 bps of the BNB side, capped), so settlers (keeper or
anyone) are not out of pocket.

---

## 3. Circuits

Both circuits share `keypair.circom` (extended with `nk`), `merkleProof.circom` (unchanged) and a
new `note.circom` (the nested commitment). Groth16 on BN254, circom 2.1, snarkjs 0.7.

### 3.1 `transaction2.circom` — `Transaction2(levels=20, nIns=2, nOuts=3)`

Public inputs (13):

```
root, publicAmountBnb, coin, publicAmountCoin, accRpt,
swapAssetId, swapAmount, extDataHash,
inputNullifier[2], outputCommitment[3]
```

Private inputs per input note: `inAssetId, inAmount, inRpt0, inBlinding, inSk, inPathIndices,
inPathElements[20]`. Per output note: `outAssetId, outAmount, outRpt0, outPubkey, outBlinding`.

Constraints:

1. For each input: `pubKey = Poseidon(sk)`, `nk = Poseidon(sk, 1)`, commitment recomputed,
   `nullifier = Poseidon(commitment, pathIndices, nk)` matches, Merkle root matches **if
   `inAmount ≠ 0`** (zero-amount padding, as v1), `inAssetId ∈ {0, coin}` (`(a)(a − coin) = 0`).
2. For each output: commitment recomputed, `Num2Bits(248)` on amount, `outAssetId ∈ {0, coin,
   swapAssetId}`, `outRpt0 = isCoin × accRpt` (BNB and ticket notes carry 0).
3. Dividends: for each input, `isCoin_i = (inAssetId == coin) × (coin ≠ 0)`,
   `delta_i = accRpt − inRpt0` range-checked to 128 bits (so `accRpt ≥ rpt0`),
   `owed_i = floor(inAmount × delta_i / 1e18)` via witness quotient/remainder with `rem < 1e18`.
4. Balance, two equations. A ticket is paid for in the swap's *input* asset, so the public bit
   `ticketOnBnbSide` (1 for BUY, 0 for SELL / HARVEST, set by the contract from `swapDir`) moves
   the ticket amount to the matching side:
   `Σ_{in,asset=0} amount + Σ owed_i + publicAmountBnb == Σ_{out,asset=0} amount + ticketOnBnbSide × swapAmount`
   `Σ_{in,asset=coin} amount + publicAmountCoin == Σ_{out,asset=coin} amount + (1 − ticketOnBnbSide) × swapAmount`
5. `swapAmount == Σ_{out,asset=swapAssetId} amount`, and at most one output may carry the ticket
   asset (`swapAmount = 0` ⟹ no ticket output). 14 public inputs in total (Appendix A).
6. Nullifiers distinct; `extDataHash` squared (binding only), as v1.

Estimate: inputs 2 × (Merkle 20 × ~240 + 4 Poseidon ≈ 1.2k + 248-bit div ≈ 0.8k) ≈ 14k; outputs
3 × (2 Poseidon ≈ 0.5k + 248 bits) ≈ 2.3k; selectors and sums < 1k. **≈ 18k non-linear, ~36k total
constraints** (v1: 12.9k / 27k). Needs **pot16** (65k). zkey ≈ 16 MB, wasm ≈ 3 MB. Browser proving
(snarkjs wasm, current worker): **~5-8 s desktop, 15-25 s mid-range phone**, vs ~3-5 s today.

### 3.2 `swapclaim.circom` — `SwapClaim(levels=20)`

Public inputs (13): `root, ticketAssetId, totalIn, totalUsed, totalOut, outAssetId,
refundAssetId, rptAtSettle, extDataHash, ticketNullifier, feeNullifier, outputCommitment[2]`.

Private: ticket `{D, sk, blinding, pathIndices, pathElements[20]}`; optional BNB fee note
`{amount, blinding, pathIndices, pathElements[20]}` (zero-amount padding allowed, as in
`Transaction2`); output blindings and pubkeys.

Constraints: ticket commitment recomputed with `assetId = ticketAssetId`, Merkle membership
(always enforced for the ticket, enforced for the fee note iff its amount ≠ 0), both nullifiers
via `nk`; `out = floor(D × totalOut / totalIn)` and `refund = floor(D × (totalIn − totalUsed) /
totalIn)` with quotient/remainder witnesses and `rem < totalIn`; output 0 = `{outAssetId, out,
rpt0 = isCoin(outAssetId) × rptAtSettle}`; output 1 = `{refundAssetId, refund + feeNote.amount −
fee, rpt0 = isCoin(refundAssetId) × rptAtSettle}` when `refundAssetId = 0`, otherwise the fee
change is a third zero-or-BNB output (the contract passes `fee` through `extDataHash` and the
circuit checks `feeNote.amount ≥ fee`); 248-bit range checks; `extDataHash` binding.

Estimate: **≈ 12k non-linear, ~20k total** (two Merkle paths). zkey ≈ 8 MB. **~2-3 s** in the
browser.

### 3.3 Why not one circuit

Folding claim into `Transaction2` saves one ceremony artifact but adds the claim's public inputs
and division to every transfer, and makes every claim pay for a 3-output join-split. Two circuits
proved in one ceremony round are cheaper for users and simpler to audit.

### 3.4 Public-input gas

Groth16 verify ≈ 200k + ~7k per public input: **~300k** for `Transaction2`, **~290k** for
`SwapClaim`. BSC gas is ~0.1 gwei, so verification is ~0.00003 BNB.

### 3.5 Ceremony

* Phase 1: Hermez `powersOfTau28_hez_final_16.ptau` (public, 72 MB).
* Phase 2: one round, two zkeys. Each contributor runs `snarkjs zkey contribute` on
  `transaction2` **and** `swapclaim`, publishes both hashes. Target **≥ 5 outside contributors**
  (the v1 CEREMONY.md already flags that both v1 contributions were the same operator). Final drand
  beacon. Transcript appended to `circuits/CEREMONY.md` with sha256 of both zkeys, both vkeys, both
  verifiers.
* The v1 pool keeps its v1 verifier; nothing about v1 changes.
* Compromise blast radius, as in v1: a forged proof can drain the **pool's** BNB and custodied
  tokens, nothing in Launchpad / Roots / FeeRouter / pots.

---

## 4. Contracts

All new contracts are non-upgradeable, `Ownable2Step`, with one-shot module wiring; the owner has
no path to funds. `solc 0.8.26`, `via_ir`, same profile as today.

### 4.1 `ShieldedPoolV2` (est. 11-12 KB runtime)

Storage:

```
MerkleTreeWithHistory (v2: mapping root => uint32)        tree
mapping(uint256 => bool)                                   nullifierHashes
mapping(address coin => uint256)                           accRpt
IVerifier14 verifierTx; IVerifier11 verifierClaim; IPoseidonT4 hasher
IEpochSwap epochSwap; address planter; address legacyPool  (one-shot setModules)
uint256[] bnbDenoms; uint256[] tokenLots                   (owner can only ADD denominations)
```

Functions:

* `transact(Proof14 p, ExtData e) payable` — `ExtData { address recipient; int256 extAmountBnb;
  address coin; int256 extAmountCoin; address relayer; uint256 fee; uint8 swapDir;
  bytes payload; bytes[3] encryptedOutputs }`. Checks: `msg.value == extAmountBnb` if > 0 and it is
  a denomination; if `extAmountBnb < 0` it is a denomination (relayer fee is separate);
  `extAmountCoin` likewise in lots (ERC-20 `transferFrom` for shields, `transfer` for unshields);
  `publicAmountBnb == extAmountBnb − fee − (dir==BUY ? swapAmount : 0)` and the coin-side
  equivalent; `p.coin == uint160(e.coin)`; `p.accRpt == accRpt[e.coin]`; if `p.swapAmount > 0`:
  `p.swapAssetId == epochSwap.openTicketId(e.coin, e.swapDir)` and `swapAmount` is a
  denomination/lot for that side; root known; nullifiers unspent and distinct; `extDataHash`;
  verify. Effects: mark nullifiers, insert 3 commitments, `epochSwap.record(coin, dir, amount)`,
  pay recipient (or `planter.plantFor{value}(payload)` when `recipient == planter`), pay relayer.
  Emits `NewCommitment ×3`, `NewNullifier ×2`, `Intent(coin, dir, batchId, amount)`.
* `claim(Proof13 p, bytes32 batchKey, ExtData e)` — reads `epochSwap.batch(batchKey)`, requires
  `settled`, forms the public inputs from the struct (`totalIn, totalUsed, totalOut, rptAtSettle`
  plus the ticket / out / refund asset ids derived from `(coin, dir)`), verifies, marks the ticket
  nullifier and the fee-note nullifier, inserts 2 commitments, pays the relayer. The relayer fee
  is paid from a **BNB note of the user consumed in the same proof** (`SwapClaim`'s optional
  `feeNote` input, zero-padded when the user submits from their own wallet), so fees are always
  BNB from the user's own notes, uniformly across both circuits, and a BUY claim (coin out, no
  BNB out) needs no special case.
* `release(address asset, uint256 amount)` — `onlyEpochSwap`; moves BNB / tokens to `EpochSwap`
  for a batch it is settling (EpochSwap returns outputs with `IERC20.transfer` / `receive`).
* `pullRewards(coin, runId, amount, proof[])` — anyone; calls `holderRewards.claim`; bumps
  `accRpt[coin]`. Emits `DividendsPulled`.
* `insertFor(assetId, amount, pubKey, blinding)` — `onlyPlanter` or `legacy bridge`; commitment
  computed on chain with the deployed `PoseidonT4`; replaces v1 `depositFor` for the two remaining
  contract-side inserts. `rpt0 = accRpt[asset]`.
* `bridgeFromLegacy(ProofV1, ExtDataV1, pubKey, blinding)` — calls `legacyPool.transact` with
  `recipient = this`, receives the BNB in `receive()` (guarded on `msg.sender == legacyPool`),
  `insertFor(0, amount, pubKey, blinding)`. Amount public (it is a v1 unshield), key one-time.
* Views: `isKnownRoot`, `isSpent`, `accRpt`, denominations.

Gas (BSC, 0.1 gwei; Poseidon-2 via external call ≈ 8.5k, one insert ≈ 170k from the v1 test
numbers: v1 transact ≈ 692k with 2 inserts):

| Action | Gas | BNB @0.1 gwei |
|---|---|---|
| Shield (transact, 3 inserts) | ~900k | 0.00009 |
| Unshield / private send / intent | ~930k (+record) | 0.00009 |
| Claim (2 nullifiers, 2 inserts, verify 13 inputs) | ~720k | 0.00007 |
| Token shield/unshield (+ERC-20) | ~960k | 0.0001 |
| pullRewards | ~120k | |
| bridgeFromLegacy (v1 verify + 1 insert) | ~1.1M | 0.00011 |

The 3-output insert cost is the one thing that could be trimmed later (queued leaves with a
subtree insert); not needed at BSC prices.

### 4.2 `EpochSwap` (est. 9-10 KB)

Storage:

```
struct Batch { uint128 totalIn; uint128 totalUsed; uint128 totalOut; uint128 rptAtSettle;
               uint64 openedAt; uint32 count; uint256 refPrice; bool closed; bool settled; }
mapping(bytes32 key => Batch) batches;       key = keccak(coin, batchId, dir)
mapping(address coin => uint64[3]) openBatchId;
uint32 kMin = 4; uint32 minAge = 30; uint32 maxAge = 300; uint16 maxDeviationBps = 300;
uint16 bountyBps = 10; uint256 bountyCap = 0.005 ether; uint32 settleTimeout = 1800;
ILaunchpad launchpad; IRoots roots; IPancakeRouter02 router; ShieldedPoolV2 pool; address keeper
```

Functions:

* `openTicketId(coin, dir) → uint256` — `keccak(coin, openBatchId[coin][dir], dir) mod p`; rolls
  the open batch forward if the current one is closed by time/count (view-consistent with
  `record`).
* `record(coin, dir, amount)` — `onlyPool`; requires `launchpad.isCoin(coin)`; adds to the open
  batch, updates `refPrice` (curve `price(coin)` or pair reserves ratio), `count++`.
* `settle(coin, batchId, dir, minOut)` — anyone (`minOut` honoured only from `keeper`, otherwise
  the deviation band applies). Executes the venue, returns outputs to the pool, writes totals and
  `rptAtSettle = pool.accRpt(coin)`, pays bounty. `settleBoth(coin, batchId)` does SELL then BUY.
  HARVEST uses `roots.harvest(coin, totalIn, 0)` after `approve(roots)`; `Dust` → revert → cancel path.
* `cancel(coin, batchId, dir)` — anyone after `settleTimeout`; marks settled with zero outputs.
* Admin (owner, within bounds): `setWindow(kMin, minAge, maxAge)`, `setDeviation`,
  `setBounty`, `setKeeper`. No admin over funds: the only BNB/tokens here are in flight inside
  one `settle` call.

Gas per settle: curve buy ≈ 130k + transfers ≈ 50k + storage ≈ 60k → **~250k**; with graduation
inside: up to ~1.6M (pair creation + mint); router path ≈ 200k; harvest ≈ 120k.

### 4.3 `Planter` (est. 5 KB)

`plantFor(bytes payload) payable onlyPool`, `flush(coin)`, `handOver(coin, secret, …)`,
`creatorKey[coin]`, `authHash[coin]`, `receive()` (fee pushes from FeeRouter). Gas: plant through
the pool ≈ 930k (transact) + Launchpad.plant ≈ 2.2M (coin deployment) → **~3.2M** in one tx.

### 4.4 Verifiers

`Groth16VerifierTx` (14 public inputs) and `Groth16VerifierClaim` (13), generated by snarkjs,
~2.3 KB each.

### 4.5 Unchanged live contracts, and how they are used

| Contract | Used by | Note |
|---|---|---|
| `Launchpad` (21.9 KB, no room, immutable) | `EpochSwap.buy/sell`, `Planter.plant` | `Trade.trader` = EpochSwap for every private trade; the chart code reads price/volume as before. |
| `FeeRouter` | untouched | 2% fee flows from the batch trades exactly as from public trades. |
| `Roots` | `EpochSwap.harvest` | `harvest` (public variant) with EpochSwap as burner/payee. `harvestShielded` becomes unused. |
| `HolderRewards` | `ShieldedPoolV2.pullRewards` → `claim` | Pool is a Merkle leaf like any holder. |
| `DonationRotator` | unchanged | Settles into the **v1** pool (immutable `pool`). Causes bridge v1→v2 or keep spending from v1. |
| `ShieldedPool` v1 | legacy lane | Keeps working; UI shows "legacy notes → bridge". |

---

## 5. Web and keeper / relayer changes

### 5.1 Shared zk library (`circuits/lib/grove-zk.mjs` → v2 module alongside)

`Keypair` gains `nk`, `deriveOneTime(tag, i)`, `fullViewingKey()`; `Utxo` gains `assetId`,
`rpt0`, nested commitment, `nullifier(nk)`; new `Ticket` (a `Utxo` with ticket assetId);
`prepareTransaction2({ tree, inputs, outputs, extData, accRpt, swap })`,
`prepareClaim({ tree, ticket, feeNote, batch, extData })`; `scanNotes` decrypts the 4-field
payload and groups by asset / ticket. Export both artifact sets; `scripts/sync-zk.mjs` copies
`transaction2.{wasm,zkey}` and `swapclaim.{wasm,zkey}` to `web/public/zk/`.

### 5.2 Web (Next.js)

* **Worker**: one worker, two artifact sets, same progress protocol; `zkey` cache in Cache
  Storage so the 16 MB download happens once.
* **`/move` → "Shielded wallet"**: BNB notes, per-coin notes with accrued dividends (computed
  locally from `accRpt`), pending tickets with batch status (open / closed / settled / cancelled)
  and a **Claim** button (also "claim all when settled" while the tab is open, and "claim later
  with a random delay"), legacy v1 notes with **Bridge**. Shield/unshield with on-chain
  denominations (the existing picker becomes mandatory). Export full viewing key.
* **`/coin/[address]`**: trade panel defaults to **Private**: amount → denomination split preview
  ("2 intents: 0.2 + 0.1"), open-batch panel (pending total, count, closes in …, expected clearing
  price band), "spread across batches" toggle, relayer picker. Harvest box: private harvest (lots)
  via HARVEST intent. Public buy/sell kept behind a toggle with a plain warning. Holders card:
  "n public holders + shielded supply X".
* **`/plant`**: "Plant privately" (default when a shielded key is loaded): funds from shielded
  BNB, one-time creator key, handover secret shown once; "Plant publicly" as today.
* **`/rings`**: batches appear as rows (coin, dir, totals, settle tx); claims/intents counted,
  never attributed.
* **`/docs/shielded`, `/docs/risk`**: rewrite from section 6 of this document, verbatim table.
* **`/api/relay`**: method-aware quotes and submission for `transact` and `claim`; `relayers.json`.
* Hooks: `useShieldedActions` → intents/claims/bridge; new `useBatches(coin)`.

### 5.3 Keeper

New commands in `keeper/src/commands/`: `settle` (poll open batches, `settleBoth` when closable,
`cancel` after timeout, with quoted `minOut` when the band fails and the market has moved
persistently), `dividends` (after each `postRun` for a Holders coin, `pullRewards`), `flush`
(Planter creator fees above `minFlush`). `rewards`: include `shieldedPoolV2` as an eligible
holder, exclude `EpochSwap` and `Planter`; publish the pool's aggregate in the snapshot JSON.
`all` loops everything. A second relayer process (`keeper relay`) runs the same code as the Vercel
route with the keeper's RPC.

---

## 6. What is still public

### 6.1 The table

| # | Still public | Why it cannot be hidden here | Mitigation |
|---|---|---|---|
| 1 | **Shield edge**: wallet, denomination, timestamp | BNB enters from a public wallet; `msg.value` is public (Zcash t→z has the same edge). | On-chain denominations; "shield once, stay inside" UX; wait before first intent (UI nudge). |
| 2 | **Unshield edge**: recipient, denomination, timestamp, relayer | A public address receives public BNB. | Denominations, relayer, fresh recipient address advice, random delay. |
| 3 | **Per-intent denomination/lot, coin, direction, batch; batch totals; curve/pair state** | The contract must know what it trades; the curve's reserves are public by construction. | Batching (uniform price, k-anonymity), splitting across batches, denominations. |
| 4 | **Pool's aggregate custody per coin** (`balanceOf(pool)`), tree size, nullifier count, tx count | ERC-20 and tree are public state. | None needed: aggregates only. |
| 5 | **Coin metadata, that a coin was planted via `Planter`, plant fee, first-buy size, per-coin creator-fee stream, the coin's one-time creator pubKey** | A coin is a public object; fees are public in `FeeSplit` already. | One-time key per coin; fee flushes batched by the keeper. |
| 6 | **Donation ring settlement (cause, amount) into the v1 pool; public `donate(ringId)`; ring pots** | `DonationRotator` and `FeeRouter` wiring are immutable; pots are public state; causes are public charities. | Private donations are in-pool transfers (fully hidden); causes can bridge to v2 (amount public, key one-time). |
| 7 | **Holder-reward run amounts and the pool's aggregate share** (keeper JSON) | Allocation is keeper-computed and published, as today. | Individual shares never appear anywhere. |
| 8 | **Public `Launchpad.buy/sell` by users who opt out; `FeeRouter` buybacks; Flap rootstock trades** | By choice / out of scope. | Private is the default in the UI. |
| 9 | **Relayer sees your IP and the bytes it submits** | Someone must pay gas. | Multiple relayers, Tor/VPN advice, relayer cannot redirect funds (`extDataHash`). |
| 10 | **Legacy v1 pool edges and bridge amounts** | v1 is immutable. | Bridge uses one-time keys; denominations advised. |
| 11 | **Block timestamps of every tx; number of claims per batch** | Chain is a public log. | Batches quantise time; claims deferrable indefinitely (unbounded roots). |
| 12 | **Graduation event and the pool's router trades (aggregate)** | Pancake pair is public. | Aggregate only. |
| 13 | **Proof-system trust**: Groth16 setup soundness | Trusted setup. | Public multi-party ceremony, ≥ 5 outside contributors, drand beacon. |

### 6.2 Anonymity-set analysis

Three different sets matter.

**Sender / owner set** = all unspent notes in the tree at proof time (every user of the pool, every
coin). A spend proves membership among *all* leaves, and the nullifier is unlinkable. With N
active users holding ~5 notes each, an observer's prior on "who sent this intent" is 1/N over
users, regardless of the coin or batch. This is already true for v1 transfers and does not depend
on batching. Target: N ≥ 200 within the first month (shield-edge count is the public proxy).

**Amount set (per batch)**: with k tickets in a batch and denominations d₁…d_k, an observer knows
the multiset but not the partition into users. Probability that a batch is a single user is what
matters:

| Coin activity (private intents / hour) | kMin=4, maxAge=5 min | Share of batches with k=1 | User total exposed? |
|---|---|---|---|
| 2 | mostly maxAge closes | ~85% | yes (total, not identity) |
| 10 | ~half close on k | ~40% | often |
| 30 | close on k in ~1 min | ~8% | rarely |
| 100+ | close in seconds | <1% | no |

Even with k=1 the identity is hidden (sender set above); only "someone bought 0.3 BNB of C at
14:02" is visible, which the public curve already shows for everyone today. Users wanting amount
privacy on cold coins get it by spreading intents across batches (the default for ≥ 3
denominations) and by waiting: the UI shows the current batch's `count` live so a user can choose
to join a batch that already has others. Owner knobs: raising `kMin` to 8 and `maxAge` to 15 min
roughly halves the k=1 share at the cost of latency.

**Edge set (shield/unshield)**: a shield of denomination d at time t is linkable to an unshield of
d at t' only through timing. With `r_d` shields per day of denomination d and a user who waits w
days, the candidate set is ~`r_d × w`. v1 mainnet has had tens of shields total; at 100 users
shielding weekly, `r_0.1 ≈ 5/day`, so a one-week wait gives ~35 candidates. The design makes
unshields rare (trading, harvesting and rewards all stay inside), which is the real win: the
anonymity set that matters for *launchpad actions* is the sender set, not the edge set.

**Timing**: intents reveal "a ticket for C was bought at block b"; the sender set is the pool.
A user who shields at t and submits their first intent at t+10 s is correlated by timing (edge 1 →
intent). The UI nudges a minimum 10-minute gap and offers "schedule". Claims are deferrable with
no deadline.

### 6.3 Side channels

* **RPC**: the browser scans all `NewCommitment` events (not per-note queries), through the site's
  RPC proxy; a user's own RPC is one setting. Proving is local.
* **Relayer**: sees IP + public bytes; cannot alter anything (all bound by `extDataHash`); can
  censor → multiple relayers plus the wallet fallback.
* **Browser storage**: `sk` lives in memory for the tab, re-derived by signature (as today).
* **Keeper**: computes holder allocations off chain (as today); sees nothing about shielded
  individuals because there is nothing to see.

---

## 7. Migration from the live mainnet contracts (chain 56)

Live (web/src/config/deployments/56.json): Launchpad `0x6dF7…95B5`, FeeRouter `0xd480…1748`,
Roots `0x3124…7d93`, HolderRewards `0x16b5…5B13`, DonationRotator `0xB33b…A580`, ShieldedPool v1
`0x9fd2…d055`, Verifier v1 `0xF926…2282`, PoseidonT3 `0x5B17…4eF6`, PoseidonT4 `0xB1FE…685a`,
$ZKBNB on Flap `0xe3E9…7777` via FlapBuyback `0x6DEc…F795`.

**Nothing live is redeployed.** Additive deployment, in `Deploy.s.sol` as a new `DeployPrivacy`
script:

1. `Groth16VerifierTx`, `Groth16VerifierClaim` (after the ceremony; testnet first with dev keys).
2. `ShieldedPoolV2(verifierTx, verifierClaim, poseidonT3, poseidonT4, legacyPool=v1, owner=multisig)`.
3. `EpochSwap(pool, launchpad, roots, router, keeper, owner)`.
4. `Planter(pool, launchpad, feeRouter)`.
5. `pool.setModules(epochSwap, planter)` — one-shot.
6. `forge verify-contract` for each (as `deploy.sh` does today).
7. `56.json` += `shieldedPoolV2`, `epochSwap`, `planter`, `verifierTx`, `verifierClaim`,
   `privacyStartBlock`. `shieldedPool` stays and is labelled legacy in `useZkbnb`.
8. Keeper: `EXCLUDE_ADDRESSES` − v2 pool + EpochSwap + Planter; new commands enabled;
   `RELAYER_PRIVATE_KEY` funded on both relayers.
9. Web: `npm run sync` (ABIs + both artifact sets), deploy, **promote** (the vercel promote gotcha
   from the handoff notes applies).

**Existing coins** keep trading publicly on the same curve and gain private trading immediately:
`EpochSwap.record` only requires `launchpad.isCoin(coin)`. Already-graduated coins get private
trading via the router path.

**Existing v1 notes**: users bridge (amount public, one-time key) or unshield as today; v1 stays
live indefinitely. Roots `harvestShielded` and HolderRewards `claimShielded` keep paying into v1
for anyone still using them; the UI stops offering them.

**Donate-mode coins**: unchanged, settle into v1; causes get a "bridge to v2" button and the
option to keep their v1 key.

**Rollback**: v2 is additive; if a bug is found before funds are large, the UI flips back to v1
and `maxDeposit`-style limits (v2 has `maxShieldPerTx`, owner-settable, withdrawals never gated)
bound exposure. No admin path exists to move v2 funds, so there is nothing to "pause" except the
UI; a pool bug is handled by withdrawal (always permitted) not by an admin.

---

## 8. Effort estimate by work package

One engineer plus Claude agents; agents parallelise WP1-WP4 after the interface freeze in week 1.

| WP | Scope | Effort | Depends on |
|---|---|---|---|
| **WP0 Interface freeze** | This doc → `SPEC.md` 3.9-3.11 and 4.2-4.3: structs, public-input order, denominations, batch rules, ABI | 2 days | — |
| **WP1 Circuits + lib** | `note.circom`, `keypair` (nk), `transaction2.circom`, `swapclaim.circom`, dev setup with pot16, `grove-zk` v2 (Utxo/Ticket/Keypair/prepare*/scan), fixtures generator, circuit tests (balance, asset selectors, dividend division, claim rounding, zero-padding, negative cases) | 1.5 weeks | WP0 |
| **WP2 Contracts** | `MerkleTreeWithHistory` v2, `ShieldedPoolV2`, `EpochSwap`, `Planter`, interfaces, Foundry tests from fixtures (shield/unshield/transfer/intent/claim/refund/cancel/dividends/bridge/plant/handover), fork tests against mainnet Launchpad+Roots+HolderRewards (graduation inside a settle, pre-seeded pair, Roots dust), invariant tests (pool solvency per asset, Σclaims ≤ totals), size + gas report | 1.5 weeks | WP0 (fixtures from WP1 by mid-week) |
| **WP3 Web** | Worker (two artifact sets, cache), wallet page (notes by asset, tickets, dividends, claim, bridge, viewing key export), private trade panel + batch panel, private harvest, private plant, relayer picker, docs rewrite, `useBatches`, relay route v2, Playwright flows on anvil | 1.5 weeks | WP1 lib, WP2 ABIs |
| **WP4 Keeper + relayer** | `settle`, `dividends`, `flush`, rewards inclusion, second relayer, `relayers.json`, vitest | 4 days | WP2 |
| **WP5 Ceremony** | pot16, ≥ 5 outside contributors × 2 zkeys, drand, transcript, verifier export, hash pinning in `sync-zk` | 1 week calendar (mostly waiting), 2 days effort | WP1 final circuits |
| **WP6 Review + testnet + mainnet** | Security pass (this repo's SECURITY-REVIEW style: reentrancy on `release`/`settle`, rounding, selector soundness in circuits, denomination bypass, batch id rollover, bridge `receive` guard), chain-97 e2e with real relayer, mainnet deploy + verify + promote, `HANDOFF.md` | 1 week | all |

**Total: ~6 weeks calendar, ~4.5 weeks if WP1-WP3 run in parallel with agents from day 3.**
Critical path: WP0 → WP1 circuits (final by end of week 2) → WP5 ceremony (week 3-4, overlaps WP3)
→ WP6 (week 5-6).

Risks to the estimate: (1) circuit selector bugs are the classic failure; the fixture-driven
Foundry tests plus negative circuit tests are the control. (2) Browser proving time on phones for
a 36k-constraint circuit; fallback is a 2-in-2-out variant (drop output 2; fee change and dividend
share one BNB output) at ~30k. (3) Outside ceremony contributors: start recruiting in week 1.

---

## Appendix A. Public-input order (freeze in WP0)

```
Transaction2: [root, publicAmountBnb, coin, publicAmountCoin, accRpt, swapAssetId, swapAmount,
               ticketOnBnbSide, extDataHash, nullifier0, nullifier1, commitment0, commitment1, commitment2]
SwapClaim:    [root, ticketAssetId, totalIn, totalUsed, totalOut, outAssetId, refundAssetId,
               rptAtSettle, extDataHash, ticketNullifier, feeNullifier, commitment0, commitment1]
```

## Appendix B. Denominations (on chain, owner may only add)

BNB: 0.01 0.02 0.05 0.1 0.2 0.5 1 2 5. Token lots (×1e18): 1e5 2e5 5e5 1e6 2e6 5e6 1e7 2e7 5e7 1e8.

## Appendix C. Glossary

*Intent*: a `Transaction2` whose output 0 is a ticket. *Ticket*: a note whose assetId names a
(coin, batch, dir). *Batch*: all tickets of one (coin, batch id, dir), executed together.
*Claim*: a `SwapClaim` turning a settled ticket into coin/BNB notes. *accRpt*: cumulative BNB
reward per token of a coin inside the pool, 1e18-scaled. *Edge*: a transaction where value crosses
between a public address and the pool.
