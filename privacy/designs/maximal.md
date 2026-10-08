# zkBNB "Grove Vault" — maximal-privacy architecture

Design angle: **maximal privacy, cost is no object.** Every launchpad action (plant, buy, sell,
hold, harvest, holder rewards, donate, post-graduation trade) moves into one shielded domain so
that the amount, the sender and the link between actions are hidden; what cannot be hidden is
listed in §6 without euphemism.

Written against the code as of 2026-10-05: `Launchpad.sol` 21,906 bytes deployed (of 24,576),
`ShieldedPool.sol` 5,550 bytes, `transaction.circom` 26,982 constraints (12,888 non-linear) on
Powers of Tau 15, zkey 11.9 MB, browser proving 10–40 s, `transact` measured 0.6–0.8 M gas,
chain-56 deployment in `web/src/config/deployments/56.json`.

---

## 0. The design on one page

| Today (v1) | Vault (v2) |
|---|---|
| BNB-only pool, note = Poseidon(amount, pubKey, blinding) | **Multi-asset pool**: note = Poseidon(tag, asset, amount, pubKey_d, blinding, rptStart). BNB and every GroveCoin are notes in one tree, one anonymity set |
| One key: privKey, pubKey = Poseidon(privKey) | **Key hierarchy**: spend key → nullifier key → full viewing key → incoming viewing key; **diversified one-time addresses** for every contract payout |
| Launchpad buy/sell from your wallet (wallet, amount, coin public) | **Shielded orders**: you spend BNB notes into an *order* whose amount is ElGamal-encrypted to a relayer committee; the Vault executes the **epoch aggregate** on the curve; you later claim your pro-rata coin notes. Your wallet never appears, your amount never appears, only the per-coin per-epoch total does |
| Coins in your wallet (holdings public) | Coin notes in the Vault (the Vault's total per coin is public, nobody's balance is) |
| Harvest from your wallet (wallet + amount public) | Shielded harvest = an order with side HARVEST, executed in aggregate |
| Holder rewards via keeper snapshot + Merkle claim (wallet, amount public) | **Reward accumulator** `rewardPerToken(coin)` inside the Vault: every coin note earns continuously; the reward is rolled into a BNB note whenever the coin note is spent. No action, no event, no amount |
| `depositFor(pubKey, blinding)` reveals a reusable pubKey | `depositFor(asset, pubKey_d, blinding, memo)` with a one-time diversified key; the long-term key is never on-chain |
| Relayer for unshield/send only | **Relayer network** with on-chain registry, in-pool fees, decryption committee, dummy orders, delayed claims |
| Post-graduation trades public on PancakeSwap | Same order flow with venue = PancakeSwap V2; the 2 % pair tax is paid by the Vault so the FeeRouter flywheel is untouched |

**Pedersen commitments + Bulletproofs** (from the owner's table) are **rejected on purpose**: on this
stack Groth16 already hides amounts and enforces range checks inside the circuit (the
`Num2Bits(248)` in `transaction.circom` *is* the range proof). Bulletproofs would add a second
proof system, roughly 10× the verification gas, and no privacy. **Ring signatures** are rejected
for the same reason: the zk-nullifier scheme already in place is the Zcash-style, stronger
primitive. What this design *adds* is (a) Baby Jubjub **ElGamal** homomorphic encryption so the
chain can sum order amounts without seeing them (Penumbra-style "flow encryption") and (b) a
**threshold-decryption committee** so that no single relayer sees an individual amount either.

**The Launchpad contract is not modified.** It is at 21.9 KB of the 24 KB limit, and the Vault is
simply another account calling `buy`, `sell`, `plant`, `Roots.harvest` and the PancakeSwap router.
Every fee the flywheel depends on (2 % curve fee → FeeRouter, 2 % pair tax → `sweepTax`, plant fee,
rootstock buyback of $ZKBNB) is paid by the Vault exactly as a wallet would pay it.

---

## 1. Threat model and privacy goals

### 1.1 Adversaries

| Adversary | Sees | Can do |
|---|---|---|
| **Chain observer** (BscScan, indexers, MEV bots) | every tx, calldata, event, storage, mempool | correlate timing, amounts, addresses; sandwich public trades |
| **Relayer** (one of many) | the proofs/extData it is asked to submit, the submitter's IP and timing | refuse or delay; learn "someone at this IP did a shielded action now" |
| **Decryption committee member** (t-of-n) | its own ElGamal decryption shares | with ≥ t colluding members: decrypt *individual* order amounts (never owners) |
| **Operator / keeper / admin Safe** | everything a relayer and a committee member see, plus keeper logs | set epoch parameters within hard bounds; nothing over funds |
| **Counterparty** (recipient of a private send, cause receiving a donation) | the note they receive and its memo | nothing about the sender |

Out of scope: a compromised browser (proving happens there), a user who publishes the same key
publicly and privately, a global network adversary matching IPs to relayer submissions (use Tor;
the API is cookie-free), and a Groth16 trusted-setup compromise (§3.7).

### 1.2 Goals per action

Legend: **A** amount hidden, **S** sender/holder hidden, **L** unlinkable to the user's other actions.
✔ achieved · ◐ hidden inside an aggregate or a set · ✖ public · — n/a.

| Action | v1 today | v2 A | v2 S | v2 L | Notes |
|---|---|---|---|---|---|
| **Plant** | wallet, first buy public | ◐ first buy hidden in the epoch aggregate; plant fee is a constant | ✔ creator = Vault | ✔ | coin address, name, metadata public by nature |
| **Buy** on curve | ✖ ✖ ✖ | ◐ only the epoch total per coin is public | ✔ | ✔ | the Vault is the one trader in `Trade` events |
| **Sell** on curve | ✖ ✖ ✖ | ◐ | ✔ | ✔ | same |
| **Hold** | ✖ ERC-20 balances | ✔ | ✔ | ✔ | only `balanceOf(Vault)` per coin is public |
| **Harvest** (burn → roots BNB) | wallet, tokens, BNB public | ◐ epoch aggregate | ✔ | ✔ | `Roots.Harvested` names the Vault |
| **Holder-reward claim** | wallet, amount, run public | ✔ | ✔ | ✔ | no claim tx exists for shielded holders; the reward rides along the next spend |
| **Donation** | wallet, amount public | ✔ via private send to the cause's address; ◐ via a ring pot (pot public) | ✔ | ✔ | the cause is public by design |
| **Shield** (wallet → pool) | wallet, amount public | ✖ amount (denominated) | ✖ wallet | ◐ breaks the link to everything after | inherent to an edge |
| **Unshield** (pool → wallet) | recipient, amount public | ✖ amount (denominated) | ✔ relayed | ◐ | inherent to an edge |
| **Post-graduation trade** | wallet, amount public on the pair | ◐ epoch aggregate | ✔ | ✔ | the Vault's swap is public; the pair tax is paid |
| **Private send** (pool → pool) | ✔ ✔ ✔ | ✔ | ✔ | ✔ | plus: the *asset* of the note is hidden too |

### 1.3 What "linkability" means here

1. **Edge ↔ edge**: shield 1.2345 BNB, unshield 1.2345 BNB. Closed by denominations (already in
   `web/src/lib/zk/denominations.ts`) and, more so, by the fact that in v2 most value never leaves
   the pool: coins, rewards and harvests are notes.
2. **Action ↔ action inside the pool**: buy → hold → sell → harvest. Closed because each is a fresh
   join-split with fresh nullifiers, and because a claim is unlinkable even to its epoch (§2.6).
3. **Payout ↔ identity**: `DepositFor(pubKey, …)` with a reusable pubKey that also appears in a
   published `zkbnb1…` address. Closed by diversified one-time keys (§2.2).

Timing is the residual channel (order at t, execution 60 s later, claim shortly after). The
relayer network's *delayed claim* queue (§2.8) adds a random 0–24 h delay for the user.

---

## 2. Cryptographic design

All hashing is Poseidon over the BN254 scalar field (circomlib parameters, as today). Domain
tags are small constants (`TAG_NOTE = 1`, `TAG_ORDER = 2`, `TAG_RESULT = 3`, `TAG_CREATOR = 4`,
`TAG_ASSET = 5`); each leaf type hashes a different arity *and* a tag, so no leaf of one type can
be reinterpreted as another.

### 2.1 Leaf formats — all in ONE Merkle tree (depth 24)

```
asset        = 0 for BNB, uint160(tokenAddress) for a GroveCoin (any ERC-20 the Vault lists)
note         = Poseidon(TAG_NOTE, asset, amount, pk_d, blinding, rptStart)                  6 inputs
order        = Poseidon(TAG_ORDER, coin, side, epoch, amount, pk_d, blinding)                7 inputs
result       = Poseidon(TAG_RESULT, coin, side, epoch, A, used, packedOutStatus)             7 inputs, inserted by the contract
creator      = Poseidon(TAG_CREATOR, coin, pk_d, blinding)                                   4 inputs, inserted at a shielded plant
asset leaf   = Poseidon(TAG_ASSET, asset, rewardPerToken)                                    3 inputs, separate small tree (depth 16)
```

- `rptStart`: the value of `rewardPerToken(asset)` when the note was created (0 for BNB). The note
  earns `amount × (rptNow − rptStart) / 1e18` wei of BNB, settled whenever it is spent (§2.7).
- `side ∈ {BUY = 1, SELL = 2, HARVEST = 3}`. BUY orders carry BNB (wei); SELL and HARVEST carry
  coin (token wei).
- `packedOutStatus = amountOut + status · 2^128`, `status ∈ {EXECUTED = 1, CANCELLED = 2}`;
  `A` = decrypted total submitted, `used` = what the venue actually consumed (a curve buy refunds
  what exceeds the rest of the curve).
- Tree: incremental Poseidon tree, depth **24** (16.7 M leaves; v1 is 20), 256-root history plus a
  30-day ring of daily checkpoint roots (§2.8). One tree for notes, orders, results and creator
  leaves keeps a single anonymity set and lets the claim circuit prove two memberships under one root.

Encrypted outputs keep today's mechanics (x25519 ephemeral + XChaCha20-Poly1305 in
`NewCommitment`), payload `abi.encode(asset, amount, blinding, rptStart, diversifierIndex)`. Each
output is encrypted twice: to the recipient and, with `ovk`, to the sender (so a sender can
reconstruct their history from chain data alone).

### 2.2 Key hierarchy

```
seed   = keccak256(wallet.signMessage("zkBNB shielded key v2")) mod p   (or 32 random bytes for a wallet-less key)
sk     = Poseidon(seed, 0)        spend key          only ever inside the browser's proving worker
nk     = Poseidon(sk, 1)          nullifier key      derives nullifiers; part of the full viewing key
pk     = Poseidon(sk, 2)          public key         the identity the circuits prove ownership of
ivk    = keccak256(sk, 3) mod 2^255 → x25519 secret  incoming viewing key (decrypts memos)
ovk    = Poseidon(sk, 4)          outgoing viewing key

d_i    = Poseidon(nk, 5, i)       diversifier i (i = 0, 1, 2, …)
pk_d_i = Poseidon(pk, d_i)        diversified one-time public key     (d = 0 means the plain pk)
```

| Key material | Holder | Can |
|---|---|---|
| `sk` | the user's proving worker | spend |
| Full viewing key `(pk, nk, ivk)` | user; optionally an auditor or tax tool | see every incoming note at every diversified address, and detect spends (recompute nullifiers). Cannot spend |
| Incoming viewing key `(pk, ivk)` | a watch-only dashboard | see incoming notes only |
| Address `zkbnb1…` | published | `pk ‖ x25519 pub`, the wire format in `web/src/lib/zk/index.ts` today |

**Diversified payout addresses.** When a *contract* pays a user (`depositFor`), the user's browser
supplies `pk_d_i` for the next unused `i` and a fresh blinding. `DepositFor` shows `pk_d_i` and the
blinding; both are useless without `nk` (to recompute `d_i`) or `pk` (to test the hash). A wallet
rediscovers its payouts by trying `i = 0 … lastUsed + 20` (gap limit, as BIP-44). Causes register
`pk_d_0` plus their x25519 key, as today (a cause's identity is public anyway).

**Nullifier** (same shape as v1, keyed by `nk`):

```
sig       = Poseidon(nk, commitment, leafIndex)
nullifier = Poseidon(commitment, leafIndex, sig)
```

Spending proves `pk = Poseidon(sk, 2)`, `nk = Poseidon(sk, 1)` and `pk_d = Poseidon(pk, d)` (or
`pk_d = pk` when `d = 0`). The v1 relation `pubKey = Poseidon(privKey)` survives only in the v1
circuit used for migration (§7).

### 2.3 Coin balances in the shielded domain

The Vault contract is the single ERC-20 holder of every shielded coin. Invariant per asset:

```
IERC20(coin).balanceOf(Vault) ≥ Σ amount over unspent coin notes
                              + Σ amount over unclaimed SELL/HARVEST orders
                              + tokens bought in executed epochs and not yet claimed
```

The Vault is **not** tax-exempt on any coin (its post-graduation swaps pay the 2 % tax), and it is
excluded from the keeper's holder-reward snapshot; it receives the Vault's pro-rata share through
`fundRewards` (§2.7).

### 2.4 Shielded buy / sell / harvest against the public curve, step by step

An **epoch** is `[openedAt, openedAt + epochLength)`, `epochLength` 60 s by default (BSC blocks are
sub-second since the Maxwell hard fork), extendable to `maxEpochLength` 600 s when the epoch has
fewer than `kMin` orders (§6.2). **EpochBook** owns the order flow; the **Vault** owns notes and funds.

```
 browser                      relayer R                EpochBook / Vault                     committee (t of n)        Launchpad / Pancake / Roots
 ───────                      ─────────                ─────────────────                     ──────────────────        ───────────────────────────
 1 pick coin, side, amount a
 2 prove order.circom:
   spend ≤2 notes → change
   note + order leaf +
   ElGamal(a)          ─────▶ 3 POST /relay/order
                              submitOrder(proof, ext) ▶ 4 verify, mark nullifiers, insert
                                                         change/reward/order leaves,
                                                         acc[coin][side][epoch] += ciphertext
                                                         (Baby Jubjub point adds)
                                                         … epoch closes …
                                                       5 closeEpoch → Closed(C1, C2, count) ─▶ 6 each member computes
                                                                                                D_j = s_j·C1 (+ DLEQ),
                                                                                                hands it to the executor
                                                       7 executor: combine t shares, BSGS → A,
                                                         prove decrypt.circom
                                                       8 execute(coin, side, epoch, A, proof):
                                                         BUY     → Launchpad.buy{value: A}   ───────────────────────▶ 2 % fee → FeeRouter
                                                         SELL    → Launchpad.sell(A)         ───────────────────────▶ 2 % fee → FeeRouter
                                                         HARVEST → Roots.harvest(coin, A)    ───────────────────────▶ BNB ← Roots
                                                         (graduated coin: router swap, 2 % tax)
                                                         insert result leaf (A, used, out, EXECUTED)
 9 later, random delay:
   prove claim.circom
   (order ∈ tree, result ∈ tree,
    out = ⌊amountOut·a/A⌋)  ─▶ 10 POST /relay/claim ──▶ 11 verify, mark order nullifier, insert notes
```

**What the order proof proves** (`order.circom`, §3.2). I own up to two notes of one asset in the
tree (zero pads need not exist); their nullifiers are these; `change = Σ in − a` is committed in
`changeLeaf`; `orderLeaf = Poseidon(TAG_ORDER, coin, side, epoch, a, pk_d, blinding)`; the two
ElGamal ciphertexts encrypt the two 28-bit limbs of `a / unit` under the committee key `P` with
fresh randomness; `a` is a multiple of `unit`; the inputs are BNB for BUY and `coin` for
SELL/HARVEST; the accrued reward of spent coin notes is paid into a BNB output (§2.7);
`extDataHash` binds relayer, fee, encrypted outputs and an encrypted backup of the order.

**What the contract checks** (`EpochBook.submitOrder`). Root known; nullifiers unspent and
distinct; `coin` listed with a venue; `epoch == currentEpoch(coin, side)` (an order for a closed
epoch reverts, so a slow relayer cannot land you in the wrong batch); `P` is the active committee
key; proof verifies; `count < 4096`. Then it inserts the leaves and adds the ciphertext points to
the accumulator (projective twisted-Edwards addition, no inversion, ≈ 1.3 k gas each).

**How price is fixed.** Nobody picks a price. The epoch's whole BUY total is one `Launchpad.buy`,
the whole SELL total one `Launchpad.sell`, HARVEST one `Roots.harvest`, executed in the fixed order
SELL → HARVEST → BUY (sells first so buyers get the post-sell price; the order is a constant, not an
executor choice). Every buyer in the epoch pays the same average price `used / out`; every seller
receives the same. This is a uniform-price batch auction, which is also what removes sandwiching (§2.9).

**How batching hides amounts.** The chain only ever sees `A = Σ a_i` per (coin, side, epoch), and
so does the committee (it decrypts the *sum* ciphertext). Each `a_i` is known to its owner alone.
Relayers submit **dummy orders** (`a = 0`; a valid ciphertext of zero is indistinguishable from any
other) so an observer cannot tell how many real orders an epoch had (§6.2 quantifies this).

**Slippage.** Orders are market orders: an epoch lasts 60–600 s, so the price moves by the epoch's
own volume plus public trades in that window. The UI shows "if this epoch is as large as the 95th
percentile of the last 50 epochs for this coin, your average price would be X". A hidden per-order
limit price cannot be enforced without excluding the order from the aggregate, which would reveal
it, so there is none. Penumbra makes the same trade-off.

**Failure / refund path.**
- The venue call reverts (a `sell` that would exceed `realBnb`, router failure, `Dust`) or the
  committee does not deliver within `decryptTimeout` (30 min): anyone calls `cancelEpoch`; the
  contract inserts a result with `status = CANCELLED`; every order is claimable 1:1 in its original
  asset with the same `claim.circom`. A committee outage can never lock funds.
- `Launchpad.buy` refunds what exceeds the rest of the curve (`used < A`): the claim pays
  `⌊amountOut · a / A⌋` tokens **and** `⌊(A − used) · a / A⌋` BNB (two outputs). Graduation triggered
  by a Vault buy is just this case.
- Rounding dust (`amountOut − Σ ⌊…⌋`) stays in the Vault. `accounted[asset]` tracks what notes and
  open orders can claim; `sweepDust(asset)` moves `balance − accounted` to the treasury.

### 2.5 ElGamal flow encryption — why, and the exact scheme

Baby Jubjub (twisted Edwards, `a = 168700`, `d = 168696`, generator `G` of the prime-order subgroup,
`l ≈ 2^251`) because scalar multiplication is native in circom (`escalarmulfix`, `escalarmulany`)
and point addition is cheap in Solidity.

```
a = unit × (m_0 + 2^28 · m_1),   m_k < 2^28
unit = 1e11 wei (BUY: 0.0000001 BNB granularity, max order 7.2e9 BNB)
unit = 1e18     (SELL/HARVEST: whole tokens, max 7.2e16 tokens)
for each limb k:  r_k ← [0, l),  C1_k = r_k·G,  C2_k = m_k·G + r_k·P        P = committee key
```

Homomorphism: `Σ_i (C1_k, C2_k)` encrypts `Σ_i m_k`. With at most 4,096 orders per epoch the summed
limb is < 2^40, which a relayer recovers from `(Σm)·G` by baby-step giant-step with a 2^20-point
table (16 MB, built once) in milliseconds.

Threshold decryption (`t = 3` of `n = 5` initially). The committee runs a Pedersen/Feldman DKG once
(off-chain, TypeScript on Baby Jubjub); `P` and the members' `P_j = s_j·G` go into
`RelayerRegistry`. For each closed epoch, member `j` publishes `D_j = s_j·C1` with a Chaum–Pedersen
DLEQ proof (`log_G P_j = log_{C1} D_j`). The executor combines `t` shares with Lagrange
coefficients, `M = C2 − Σ λ_j D_j = (Σ m)·G`, solves the 40-bit discrete log, and proves all of it
in `decrypt.circom` (§3.5): the chain verifies one Groth16 proof (≈ 340 k gas) instead of `t`
DLEQ checks in Solidity (≈ 1.5 M gas each because Baby Jubjub scalar multiplication has no precompile).

Rotation: new DKG every 90 days or on membership change. The registry keeps `(P, validFrom,
validUntil)`; orders name the key they used; an old key stays usable until its last epoch closes.

### 2.6 Claims and the results leaf

`execute` / `cancelEpoch` insert the result leaf into the main tree. `claim.circom` proves
membership of *both* the user's order leaf and a result leaf with the same `(coin, side, epoch)`
and reveals only new note commitments plus an **order nullifier**
`Poseidon(orderLeaf, orderIndex, Poseidon(nk, orderLeaf, orderIndex))`. The contract cannot tell
which epoch, coin or side a claim settles. The cost of inserting the result leaf is paid once per
epoch by the executor, not by claimers.

### 2.7 Holder rewards without a claim: the reward accumulator

```
Vault storage: rpt[asset]   wei of BNB per 1e18 token-wei, scaled by 1e18
               assetTree    depth 16, leaf = Poseidon(TAG_ASSET, asset, rpt[asset])

fundRewards(coin) payable      anyone (the keeper flow, or a donor to shielded holders):
    rpt[coin] += msg.value × 1e18 / IERC20(coin).balanceOf(Vault)
    assetTree.update(coin)     16 Poseidon hashes on-chain ≈ 170 k gas
```

The keeper excludes the Vault from the holder list exactly as it excludes the pair and the
launchpad, computes the Vault's share `pot × balanceOf(Vault) / eligibleSupply`, adds a leaf
`(account = Vault, amount = share)` to the run's Merkle tree, and after `postRun` calls the
permissionless `Vault.pullRewardsV1(coin, runId, amount, proof)`, which runs `HolderRewards.claim`
(the Vault is `msg.sender`, so the BNB lands in the Vault) and `fundRewards(coin)` in one tx.
Public holders keep claiming as today.

Every circuit that spends a coin note computes the accrued reward from the asset-tree leaf
(`rptNow`, proven under the public `assetRoot`) and pays it to a BNB output:
`reward_i = ⌊amount_i × (rptNow − rptStart_i) / 1e18⌋`. Since `Σ amount of unspent coin notes ≤
balanceOf(Vault)` whenever `rpt` increases, the total ever claimable is ≤ the BNB funded; dust
accrues to the Vault. No run id, no claim, no amount, no event: the reward is just part of the next
private spend, and a coin note that is sold in an order has its reward settled inside the order
proof. Roots overflow (`Roots.deposit` above cap → `HolderRewards.fund`) rides the same path.

### 2.8 Relayer network and economics

```
RelayerRegistry: register(x25519Pub, babyJubPub, url) with stake ≥ 0.5 BNB; unregister after a 7-day
cooldown; committee set, threshold, P with validity window; epoch parameters; fee accounting.
```

Three paid roles, all paid **from inside the pool**, so no user wallet is ever involved:

| Role | Paid by | How |
|---|---|---|
| **Submitting relayer** (order, claim, transfer, unshield) | the user, via `extData.fee` out of the spent notes | as today (`web/src/lib/relay.ts`), but quotes are rounded **up to one of three tiers** (0.0005 / 0.001 / 0.002 BNB) so the public fee value does not fingerprint the gas price at proving time |
| **Executor** | the epoch | `execFeeBps` (5 bps of `A`) taken before the venue call, plus a flat `execBounty` (0.0005 BNB) from the Vault's dust account; the executor pays the ≈ 1 M gas |
| **Committee member** | the epoch | `committeeFeeBps` (2 bps) split among the shares the decrypt proof names |

**Dummy orders.** Each registered relayer keeps every active (coin, side) at ≥ `kMin` visible
orders per epoch (default 8) by submitting zero-amount orders from its own notes; ≈ 1.15 M gas each,
reimbursed from `dummyBudgetBps` of exec fees. Payment needs proof that an order was a dummy without
revealing it at submission: the relayer later submits `dummy.circom` (proves `a = 0` for an order
leaf it owns) to the registry.

**Delayed claims and unshields.** `POST /relay/claim` accepts `notBefore`; the relayer stores the
proof encrypted at rest and submits it after that time. A proof is bound to a root, and the
256-root ring only covers minutes of activity, so delayed proofs are made against the **daily
checkpoint root** (`checkpointRoots[day]`, written by the first tx of each UTC day, kept 30 days),
which the contracts accept beside the recent ring. The user picks the delay (default random
0–24 h); the relayer only ever learns *when*, never *what* beyond the public proof.

### 2.9 Anti-front-running

- Amounts are encrypted until the epoch closes. A bot knows "there is BUY interest in coin X this
  epoch" but not how much, so it cannot size a sandwich.
- Execution is a **uniform-price batch**: everyone in the epoch gets the same price, so the only
  attack is trading before `execute`. The executor sends `execute` through a private BSC relay
  (48 Club / bloXroute private tx), and the contract rejects an `execute` whose `tx.gasprice` exceeds
  `maxExecGasPrice`, so an executor cannot be pushed into a priority auction that reveals timing.
- Decryption shares travel off-chain and land on-chain only *inside* `execute` (as the decrypt
  proof's public input `A`). There is no reveal tx to sandwich.
- Execution order SELL → HARVEST → BUY and the fee bps are constants per epoch config.
- Residual: a bot that front-runs `execute` on the public curve by guessing from the public *count*
  of orders (dummies blunt this) or from off-chain signals. Bounded by `epochLength`.

---

## 3. Circuits

Common: circom 2.1, Groth16 over BN254, Poseidon from circomlib, main tree depth 24, asset tree
depth 16. Counts are estimated from the measured v1 (Poseidon(2/3) ≈ 240 non-linear constraints,
one Merkle level ≈ 245, `Num2Bits(n)` = n, `EscalarMulFix` 253-bit ≈ 2.3 k, `EscalarMulAny` ≈ 8 k).
Browser proving time scales linearly with v1's measured 27 k constraints → 10–40 s (slow laptop to
desktop) in the current snarkjs worker; rapidsnark-wasm would roughly halve it.

### 3.1 `transfer.circom` — multi-asset join-split, 2 in, 3 out (replaces `transaction.circom`)

| | Signals |
|---|---|
| **Public** (10) | `root`, `assetRoot`, `publicAsset`, `publicAmount` (mod p), `extDataHash`, `inputNullifier[2]`, `outputCommitment[3]` |
| **Private** | per input: `asset, amount, sk, d, blinding, rptStart, pathIndices, pathElements[24]`; `rptNow, assetPathIndices, assetPathElements[16]`; per output: `asset, amount, pk_d, blinding, rptStart` |

Constraints:
1. Per input: `pk = Poseidon(sk,2)`, `nk = Poseidon(sk,1)`, `pk_d = (d == 0) ? pk : Poseidon(pk, d)`.
2. Input commitment recomputed; in the tree at `root` when `amount ≠ 0` (`ForceEqualIfEnabled`, as v1).
3. Nullifier recomputed and equal to the public one; the two differ.
4. Both non-zero inputs share one asset `X`; `(publicAsset − X) × publicAmount == 0`, so a private
   transfer leaves `publicAsset = 0` and hides the asset.
5. Outputs 0 and 1 have `asset == X`; output 2 has `asset == 0`. (When `X == 0` all three are BNB.)
6. Reward: for `X ≠ 0`, `(X, rptNow)` proven under `assetRoot`; `rptNow ≥ rptStart_i`;
   `rewardTotal = Σ ⌊amount_i × (rptNow − rptStart_i) / 1e18⌋` via quotient/remainder witnesses with
   range checks; new coin outputs carry `rptStart = rptNow`. For `X == 0`: `rewardTotal = 0`, all
   `rptStart = 0`.
7. Balance: `X ≠ 0`: `Σ in + publicAmount = out_0 + out_1` and `out_2 = rewardTotal`;
   `X == 0`: `Σ in + publicAmount = out_0 + out_1 + out_2`.
8. Every output `amount < 2^128` (`Num2Bits(128)`).
9. `extDataHash` bound (squared, as v1).

Estimate: inputs 2 × (3 key hashes + Poseidon(6) ≈ 400 + nullifier 480 + 24 levels ≈ 5.9 k) ≈ 14.4 k;
asset tree ≈ 4.2 k; outputs 3 × (400 + 128) ≈ 1.6 k; reward arithmetic ≈ 1.2 k; glue ≈ 0.6 k.
**≈ 22 k non-linear, ≈ 45 k total.** PoT 16. Browser **15–60 s**. zkey ≈ 20 MB.

### 3.2 `order.circom` — spend into an encrypted order, 2 in, 2 out (change + reward)

| | Signals |
|---|---|
| **Public** (22) | `root`, `assetRoot`, `coin`, `side`, `epoch`, `committeeKey[2]`, `C1[2][2]`, `C2[2][2]`, `inputNullifier[2]`, `changeCommitment`, `rewardCommitment`, `orderCommitment`, `extDataHash` |
| **Private** | inputs as in 3.1; `a, m[2], r[2], pk_d_order, orderBlinding`; change and reward note fields |

Constraints: 3.1 items 1–3, 6, 8, 9; `side ∈ {1,2,3}`; input asset `X == 0` for BUY, `X == coin`
otherwise; `a = unit(side) × (m_0 + 2^28 m_1)`, `m_k < 2^28`; `C1_k = r_k·G` (`EscalarMulFix`);
`C2_k = m_k·G + r_k·P` (28-bit `EscalarMulFix` + `EscalarMulAny` on `P`); `r_k < l`
(`Num2Bits(251)`); `orderCommitment = Poseidon(TAG_ORDER, coin, side, epoch, a, pk_d_order,
orderBlinding)`; `change = Σ in − a`, `change < 2^128`; reward output as in 3.1.

Estimate: 14.4 k + 4.2 k + 2 × (2.3 k + 0.3 k + 8 k) ≈ 21.2 k + 1.6 k + 1 k ≈ **42 k non-linear,
≈ 60 k total.** PoT 16. Browser **20–75 s** (the one wait the user notices; the UI proves while the
user reads the epoch preview). zkey ≈ 25 MB.

### 3.3 `claim.circom` — settle an order against its epoch result

| | Signals |
|---|---|
| **Public** (6) | `root`, `assetRoot`, `orderNullifier`, `outputCommitment[2]`, `extDataHash` |
| **Private** | `sk, d`; order fields (`coin, side, epoch, a, orderBlinding, orderIndex, orderPath[24]`); result fields (`A, used, amountOut, status, resultIndex, resultPath[24]`); `rptNow` + asset path (BUY claims stamp `rptStart = rptNow` on the coin output); quotient/remainder witnesses; output blindings |

Constraints: ownership `pk_d = Poseidon(Poseidon(sk,2), d)`; order leaf ∈ tree; result leaf ∈ tree
with the same `(coin, side, epoch)` (recomputed from `packedOutStatus = amountOut + status·2^128`);
`orderNullifier = Poseidon(orderLeaf, orderIndex, Poseidon(nk, orderLeaf, orderIndex))`;
- `status == EXECUTED`: `out_0 = ⌊amountOut × a / A⌋` in the output asset (coin for BUY, BNB for
  SELL/HARVEST); `out_1 = ⌊(A − used) × a / A⌋` BNB (refund share, 0 unless a buy hit the end of the curve).
- `status == CANCELLED`: `out_0 = a` in the original asset, `out_1 = 0`.
- Division witnesses `q × A + rem = amountOut × a`, `rem < A`, `q < 2^128` (products < 2^186 fit the field).

Nothing epoch-specific is public: `A`, `used`, `amountOut` all live inside the result leaf.
Estimate: 2 × 24 levels ≈ 11.8 k + asset tree 4.2 k + hashes ≈ 2 k + arithmetic/ranges ≈ 1.5 k ≈
**19.5 k non-linear, ≈ 32 k total.** PoT 16. Browser **8–30 s**. zkey ≈ 14 MB.

### 3.4 `creator.circom` — claim creator fees / redirect a shielded-planted coin

Public (7): `root`, `coin`, `action` (1 claim pot, 2 redirect), `outputCommitment`,
`redirectTarget`, `actionNullifier = Poseidon(nk, creatorLeaf, action, nonce)`, `extDataHash`.
Private: `sk, d, blinding, path[24], nonce`. Proves ownership of the creator leaf for `coin`. A claim
mints a BNB note of the whole `creatorPot[coin]` (public, §6). **≈ 7 k non-linear.** Browser ~5 s.

### 3.5 `decrypt.circom` — relayer-side proof of threshold decryption (never in a browser)

Public: `committeeRoot` (Poseidon tree of `(j, P_j)`), `t`, and for each of up to 8 limb-ciphertexts
`C1, C2, M` (the plaintext sum). Private: `t` member indices with Merkle paths, shares `D_j`,
DLEQ transcripts `(e_j, z_j)` with `z·G = R1 + e·P_j`, `z·C1 = R2 + e·D_j`,
`e = Poseidon(P_j, C1, D_j, R1, R2)`; Lagrange coefficients computed in-circuit; `M·G = C2 − Σ λ_j D_j`.
Per limb-ciphertext ≈ 3 shares × 4 `EscalarMulAny` ≈ 96 k + combine ≈ 100 k non-linear; 8 per proof
(4 coin-sides) ≈ **800 k constraints, PoT 20**, proven with rapidsnark on the relayer VPS in
15–30 s. Fallback if judged too heavy: verify the DLEQs in Solidity at ≈ 1.5 M gas per share.

### 3.6 `dummy.circom` (≈ 2 k: proves an order leaf has `a = 0`, for relayer accounting) and
`transaction.circom` **v1, unchanged**, kept for the migration bridge (§7).

### 3.7 Ceremony implications

Five new circuits → five Phase-2 ceremonies: Hermez `powersOfTau28_hez_final_16.ptau` (~75 MB) for
the four browser circuits and `_20.ptau` (~1.2 GB) for `decrypt`. Follow `circuits/CEREMONY.md`, but
with **≥ 5 independent outside contributors per circuit** (each `snarkjs zkey contribute` on its own
machine, hashes published), then a drand beacon, then `Groth16Verifier{Transfer,Order,Claim,
Creator,Decrypt}.sol`. Exposure of a compromised key: `transfer`/`claim` → mint notes up to the
Vault's balance (today's exposure class, now including coins); `order` → misreport `a` versus the
ciphertext and steal from the epoch's other participants; `decrypt` → execute a wrong `A`
(bounded by the epoch's funds and detectable, since anyone can recompute `(Σm)·G`). The ceremony is
on the critical path (§8).

---

## 4. Contracts

Launchpad, GroveCoin, FeeRouter, Roots, HolderRewards, DonationRotator, FlapBuyback: **no code
change.** The Vault stack sits beside them and talks to them as a normal account.

### 4.1 `GroveVault.sol` (new; replaces ShieldedPool for new activity) — est. 13–15 KB

Inherits `MerkleTreeWithHistory` (depth 24, 256 roots, `checkpointRoots[day]`).

Storage: `nullifierHashes`, `assetTree` (depth 16), `rpt[asset]`, `accounted[asset]`,
`listed[asset]` (any coin of either launchpad plus BNB), `creatorPot[coin]`, `creatorStub[coin]`,
immutable verifier addresses, immutable `epochBook`, `registry`.

| Function | Caller | Does |
|---|---|---|
| `transact(Proof p, ExtData e)` payable | anyone / relayer | multi-asset join-split. `e.asset`; `e.extAmount > 0` pulls BNB (`msg.value`) or `IERC20.transferFrom`; `< 0` pays `e.recipient`; `fee` to `e.relayer` **in the same asset** (coin-denominated fees let a user with only coin notes pay a relayer). Checks `publicAsset`, `publicAmount`, `extDataHash`, root, nullifiers, proof; inserts 3 leaves |
| `depositFor(asset, pk_d, blinding, memo)` payable | anyone (Roots, HolderRewards, DonationRotator, V1Bridge, CreatorStub) | computes `Poseidon(TAG_NOTE, asset, amount, pk_d, blinding, rpt[asset])` on-chain (PoseidonT7) and inserts; emits the `memo` |
| `fundRewards(coin)` payable | anyone | §2.7 |
| `pullRewardsV1(coin, runId, amount, proof)` | anyone | `HolderRewards.claim` then `fundRewards` |
| `insertLeaf`, `creditAccounted`, `payOut`, `spendNullifier` | `onlyEpochBook` | used by orders, execution, claims |
| `plantShielded(TransferProof, PlantParams, OrderProof)` | relayer | a transfer proof with `publicAsset = 0`, `extAmount = −(plantFee + firstBuy)`, `recipient = Vault`; deploys a `CreatorStub` (CREATE2); `Launchpad.plant` with `payoutMode = Wallet, payoutWallet = stub` (or Holders / Donate chosen now); inserts the creator leaf; turns the first buy into a BUY order of the current epoch |
| `claimCreator(Proof)`, `redirectCreator(Proof, target)` | relayer | §3.4 |
| `sweepDust(asset)` | anyone | `balance − accounted` → treasury |
| `setCheckpoint()` | anyone (also internal, first tx of a UTC day) | writes `checkpointRoots[day]` |

No admin over funds. Owner functions: `setRegistry` (one-shot) and `setMaxDeposit` (BNB deposits
through `transact`, as today).

Why shielded "Me" planting uses a stub: `FeeRouter.collect` pushes the creator share with a bare
50 k-gas call carrying no coin id, so a Vault receiving it could not attribute the BNB. A per-coin
`CreatorStub` as `payoutWallet` gives the call a coin context. The cost is that `Wallet` mode is
handed over at plant time, so a shielded planter chooses Holders / Donate at plant or keeps a hidden
creator pot that can later be redirected to a public wallet (a Phase-B FeeRouter v2 can lift this).

### 4.2 `EpochBook.sol` (new) — est. 14–16 KB

Storage: `EpochConfig { epochLength, maxEpochLength, kMin, decryptTimeout, execFeeBps,
committeeFeeBps, execBounty, maxOrders = 4096, maxExecGasPrice }` (owner-settable within constant
bounds); `Acc { X, Y, T, Z for C1[2], C2[2]; uint32 count; uint64 openedAt; uint8 state }` per
`(coin, side, epoch)`; `currentEpoch[coin][side]`; `venue[coin]` (0 Launchpad v1, 1 Launchpad v2,
2 PancakeSwap pair, derived from `Launchpad.isGraduated`); active committee record.

| Function | Caller | Does |
|---|---|---|
| `submitOrder(OrderProof, OrderExt)` | anyone / relayer | §2.4 checks; `Vault.insertLeaf` ×3; four Baby Jubjub adds into `Acc`; `count++`; nullifiers via Vault |
| `closeEpoch(coin, side)` | anyone, after `openedAt + epochLength` (or `maxEpochLength` when `count < kMin`) | normalizes `Acc` to affine (one inversion), emits `Closed(coin, side, epoch, C1, C2, count)`, opens the next epoch |
| `execute(coin, side, epoch, A, DecryptProof)` | any executor | verifies against stored ciphertext and `committeeRoot`; takes fees; venue call (`Launchpad.buy{value}`, `Launchpad.sell`, `Roots.harvest`, or router `swap…SupportingFeeOnTransferTokens`); measures `used` and `out` by balance deltas; `Vault.insertLeaf(result)`; updates `accounted` |
| `cancelEpoch(coin, side, epoch)` | anyone after `decryptTimeout` | inserts a `CANCELLED` result |
| `claim(ClaimProof, ClaimExt)` | anyone / relayer | verifies; marks `orderNullifier`; `Vault.insertLeaf` ×2; `accounted` adjustments |
| `onVenueChange(coin)` | anyone | flips the venue after graduation |

Baby Jubjub addition in Solidity: extended twisted-Edwards coordinates `(X, Y, T, Z)`, 9 `mulmod`
plus adds, no inversion, ≈ 1.3 k gas; `closeEpoch` does one `modexp` inversion (≈ 3 k gas).

### 4.3 `RelayerRegistry.sol` (new) — est. 6 KB

`register / unregister / stake`; committee management (`setCommittee(members[], t, P, validFrom)`
by the owner, each member confirming `P_j` by signature); `committeeRoot()` for the decrypt circuit;
`reportDummy(orderLeaf, DummyProof)`; fee accounting (`claimFees()`).

### 4.4 `CreatorStub.sol` (new) — ≈ 300 bytes runtime

`receive()` → `vault.creditCreator{value}(coin)` within FeeRouter's 50 k-gas push; `pull()` →
`FeeRouter.withdrawPending()` then forward; `redirect(target)` only by the Vault after a creator proof.

### 4.5 `V1Bridge.sol` (new) — ≈ 2 KB

`migrate(v1Proof, v1ExtData, pk_d, blinding, memo)`: calls `ShieldedPool.transact` (v1) with
`recipient = bridge`, receives the BNB, calls `Vault.depositFor(0, pk_d, blinding, memo)` in the same
tx. Amount public (a v1 withdrawal), sender = relayer, destination a one-time key. Denominations apply.

### 4.6 Verifiers

Five snarkjs-generated `Groth16Verifier*.sol`, 2–4 KB each; gas ≈ 200 k + ≈ 7 k per public input:
transfer (10 → ≈ 270 k), order (22 → ≈ 350 k), claim (6 → ≈ 245 k), creator (7 → ≈ 250 k), decrypt
(≈ 26 → ≈ 380 k).

### 4.7 Poseidon bytecode

Keep `PoseidonT3/T4`; add **`PoseidonT7`** (6 inputs, note) and **`PoseidonT8`** (7 inputs,
order/result) via `circomlibjs.poseidonContract.createCode(n)`; ≈ 25 k / 29 k gas per call.

### 4.8 Size and the 24 KB limit

Launchpad untouched at 21,906 bytes. Every new contract targets ≤ 16 KB with `via_ir`,
`optimizer_runs = 200`. EpochBook is the one to watch (Baby Jubjub + venue adapters); if it grows,
the venue calls move to a 3 KB `VenueAdapter` contract.

### 4.9 Gas per user action (BSC; at 1 gwei, 1 M gas = 0.001 BNB; PoseidonT3 ≈ 10 k as measured in v1)

| Action | Pays | Gas |
|---|---|---|
| Shield BNB or coin (`transact`, 3 inserts at depth 24) | user wallet | 270 k + 3 × 240 k + ≈ 80 k ≈ **1.1 M** |
| Private send / unshield (relayed) | relayer, reimbursed in-pool | **≈ 1.1 M** |
| Submit order (3 inserts + 4 point adds + accumulator storage) | relayer, in-pool | 350 k + 720 k + ≈ 80 k ≈ **1.15 M** |
| Dummy order | relayer | ≈ 1.15 M |
| `closeEpoch` | keeper / anyone | ≈ **60 k** |
| `execute` (decrypt verify 380 k + venue 150–300 k [graduation: +1.5 M once] + result insert 240 k + fees) | executor, in-pool | **≈ 0.8–1.0 M** per coin-side; one decrypt proof covers 4 coin-sides, amortising the verify |
| Claim (verify + 2 inserts + nullifier) | relayer, in-pool | 245 k + 480 k + 25 k ≈ **0.75 M** |
| `depositFor` (payout into the Vault) | the paying contract's caller | 25 k + 240 k ≈ **0.27 M** |
| `fundRewards` (asset-tree update) | keeper | ≈ **0.2 M** |
| `pullRewardsV1` | keeper | ≈ **0.3 M** |
| Shielded plant (transfer proof + GroveCoin deploy ≈ 1.6 M + stub 60 k + creator leaf 240 k + order) | relayer, in-pool | ≈ **3.5 M** (today's `plant` ≈ 2 M) |
| Creator claim | relayer | ≈ 0.5 M |

A full shielded buy = order 1.15 M + claim 0.75 M + a share of `execute` ≈ 2 M gas ≈ 0.002 BNB at
1 gwei, paid from the user's notes through the tiered relayer fee.

---

## 5. Web and keeper / relayer changes

### 5.1 Web (`web/`)

- **Keys v2** (`lib/zk/keys.ts`): derive `sk / nk / pk / ivk / ovk` from the v2 message; keep v1
  derivation for migration; diversifier gap-limit scanning; export of a full viewing key as `zkbnbview1…`.
- **Shared lib** (`circuits/lib/grove-zk.mjs` v2, synced as today): `Note{asset, amount, pk_d,
  blinding, rptStart}`, `Order`, `Result`, Baby Jubjub ElGamal (via circomlibjs `babyjub`),
  `prepareTransfer / prepareOrder / prepareClaim / prepareCreator`, `scanNotes` understanding three
  leaf types and the `memo`, BSGS table builder (relayer only).
- **Proving worker**: four zkeys (transfer 20 MB, order 25 MB, claim 14 MB, creator 4 MB) fetched
  lazily with progress and kept in the Cache API; the claim proof is prepared as soon as the epoch
  result lands.
- **`/move` → `/vault`**: balances per asset (BNB + coins) with "rewards accrued so far" from `rpt`
  deltas; shield / unshield / send for any asset; "migrate from v1" wizard (denominated
  withdrawals through `V1Bridge`).
- **Coin page trade panel**: a *Private* tab beside *Public*: amount, side, epoch countdown,
  "orders in this epoch: 11 (incl. decoys)", worst-case price band, fee tier; afterwards an order
  card *queued → executed (claimable) → claimed*; claims auto-scheduled with a random delay
  (0–24 h, adjustable, "claim now" available) via the relayer's `notBefore`.
- **`/vault/holdings`**: coin notes per coin with harvest value (`Roots.harvestValue`) and
  *Harvest privately* (a HARVEST order).
- **Create form**: *Launch privately* toggle (pays from the Vault via relayer; explains that Holders /
  Donate must be chosen now and that "Me" becomes a hidden creator pot).
- **Rings / trades feed**: one trader "Vault (N orders)" per epoch execution with the public totals.
- **Docs**: rewrite `/docs/shielded` and `/docs/risk` from §6 verbatim, including the committee trust statement.
- **Relay API**: `/api/relay/{transfer,order,claim,creator}` with tiered quotes, a `notBefore` queue
  (encrypted at rest, keyed by nullifier), and `/api/relay/epochs` (counts, closes, results) so the
  UI needs no log scanning for live state. The Vercel route proxies to the VPS relayer daemon.

### 5.2 Keeper (`keeper/`) and relayer daemon (`relayer/`, new package on the VPS)

Keeper: `rewards` excludes the Vault from holders and adds the Vault leaf, then calls
`pullRewardsV1` after `postRun`; new `epochs` command (`closeEpoch` for every due coin-side);
new `venue` command (`onVenueChange` on `Graduated`). Everything else unchanged.

Relayer daemon: HTTP relay for the four proof types; **committee member** (encrypted keystore for
`s_j`, DKG participation, DLEQ shares on request); **executor** (collects `t` shares, BSGS,
rapidsnark `decrypt` proof, `execute` via a private tx relay); **dummy orders** (keeps `kMin` per
active coin-side from its own notes); **delayed queue**; metrics. First committee: the operator's
VPS plus 2–4 invited independent operators (the ceremony contributors are natural candidates);
`t = 3, n = 5`.

---

## 6. What is still public, and anonymity-set analysis

### 6.1 Still public

| Item | Public? | Why / mitigation |
|---|---|---|
| Per (coin, side, epoch) **total** `A`, `used`, `out`, average price | **Yes** | the curve's reserves move by it; batching's whole premise. An epoch with one real order reveals that order's amount (not its owner) |
| Per order: **coin, side, epoch** | **Yes** | needed to route the ciphertext to its accumulator (Penumbra has the same property) |
| Number of orders per epoch **including dummies** | Yes | the real count is hidden by dummies |
| The Vault's **total balance per coin** and total BNB | Yes | ERC-20 `balanceOf`; individual holdings hidden |
| Every **shield** (wallet, asset, amount) and **unshield** (recipient, asset, amount) | Yes | edges; denominations, relayer for the unshield sender |
| **Relayer fee** per relayed tx | Yes, tiered | three tiers only |
| **Timing** of orders, `closeEpoch`, `execute`, claims | Yes | delayed claims; default random 0–24 h |
| **Creator pot** amount at a shielded creator claim; the **plant** itself (coin, metadata, planted via the Vault) | Yes | pot is public storage; the planter hides among all Vault planters |
| **Cause** receiving a ring settlement and the pot amount | Yes | public by design of rings |
| **`DepositFor` amount** for public holders choosing a shielded payout, and for bridge migrations | Yes | the one-time key hides the long-term identity; the amount is inherent |
| **Committee** learns `A` before the chain; **≥ t colluding members** can decrypt individual order amounts (not owners) | Trust assumption | published committee, rotation, independent operators |
| Relayer learns the submitter's **IP / timing** | Yes | Tor-friendly API, several relayers |
| `Trade` events show **trader = Vault** | Yes | that *is* the anonymity set |

### 6.2 Anonymity-set arithmetic

**Senders.** A spend hides among all unspent leaves that could be notes. With `N` unspent notes, the
nullifier says only "one of N". Mainnet v1 today has a tree of a few hundred leaves; v2 opens with
the migrated notes plus every payout, and because coins, rewards, harvests and claims all become
notes, `N` grows roughly ten times faster than in v1 per user. Meaningful: `N ≥ 1,000` unspent notes
(a few hundred users); strong: `N ≥ 10,000`.

**Amounts.** With `k` real orders summing to `A`, an observer learns about one order:

| real orders `k` | what the observer learns about one order |
|---|---|
| 1 | its exact amount (owner still hidden) |
| 2 | `a_1 + a_2 = A`; each roughly uniform over `(0, A)` |
| 3–5 | typical error ≥ 50 % of the true value |
| ≥ 8 | essentially only the order of magnitude of `A / k` |

Hence `kMin = 8` *visible* orders: the observer cannot distinguish "1 real + 7 dummies" from
"8 real". The first case still leaks the amount, but the observer cannot know it is that case.
The adaptive epoch (close waits up to `maxEpochLength` for `count ≥ kMin`) plus relayer dummies
make `k_visible ≥ 8` the norm even for a coin with one trader a minute. **For amounts to be
actually hidden, ≥ 3 real orders per coin-side per epoch are needed** — a coin with ≥ 3 shielded
trades a minute, or a longer epoch. The honest sentence for a quiet coin: "your amount is hidden
only if someone else traded this coin in the same epoch; your identity is hidden regardless".

**Linkability.** Claims are unlinkable to epochs (results leaf). The remaining link is temporal
(order at t, claim at t + Δ). With Δ random in `[0, 24 h]` and ≥ 50 claims/day protocol-wide, a
claim hides among ≈ 50 candidate orders.

**Holdings.** Exact, given the Vault invariant; the only inference is "the Vault's balance in coin
X rose by `out` this epoch".

---

## 7. Migration from the live mainnet contracts (chain 56)

Live (`web/src/config/deployments/56.json`): Launchpad `0x6dF7…95B5`, FeeRouter `0xd480…1748`,
Roots `0x3124…7d93`, HolderRewards `0x16b5…5B13`, DonationRotator `0xB33b…A580`, ShieldedPool
`0x9fd2…d055`, Verifier `0xF926…2282`, PoseidonT3/T4, FlapBuyback `0x6DEc…F795`, treasury Safe.

Constraints found in the code: `FeeRouter.setModules` is one-shot; `Roots`, `HolderRewards`,
`DonationRotator` hold `pool` as `immutable`; `Launchpad.feeRouter` is `immutable`; `ShieldedPool`
has no admin over funds (nothing can be moved on users' behalf).

**Phase A — additive, zero changes to live contracts (the launch plan).**
1. Deploy PoseidonT7/T8, the five verifiers, `GroveVault`, `EpochBook`, `RelayerRegistry`,
   `V1Bridge`. Venues: Launchpad v1 (live) for every existing and future coin; PancakeSwap for
   graduated coins. Nothing in the live stack needs to know the Vault exists.
2. Existing coins trade privately from day one: the Vault is just another buyer/seller.
3. Harvests: `Roots.harvest(coin, tokens, minBnb)` pays `msg.sender` = Vault, so HARVEST orders work
   against the live Roots.
4. Holder rewards: keeper change (exclude Vault, add the Vault leaf) + `pullRewardsV1`. Live
   HolderRewards unchanged.
5. v1 ShieldedPool stays for withdrawals; `/vault` offers "migrate" via `V1Bridge` in denominations.
   `harvestShielded`, `claimShielded` and ring settlements keep paying into v1, but the web derives
   **one-time v1 keys** `otSk = Poseidon(sk, 6, i)` (spendable by the v1 circuit, which requires
   `pubKey = Poseidon(privKey)`), closing the reusable-pubKey leak on v1 with a web-only change.
   Causes are asked to re-register a diversified key.
6. Web, keeper and relayer ship together; `56.json` gains `vault, epochBook, registry, v1Bridge,
   verifiers.*, poseidonT7, poseidonT8`.

**Phase B — optional module v2 (later, breaking).** Redeploy FeeRouter v2 + Roots v2 +
HolderRewards v2 + DonationRotator v2 + Launchpad v2 with `pool = Vault`, so public harvests, claims
and settlements land in the Vault directly and `plantShielded` can use `Creator` mode with a later
`handOver`. Old coins stay on Launchpad v1 (the Vault keeps both venues); the Flap rootstock buyback
is unaffected. Only worth doing once Phase A has users.

Rollback: Phase A is additive. Disabling the Vault means taking the UI down; funds stay claimable
forever (cancel path, unshield) because no contract has admin over them.

---

## 8. Effort estimate by work package

| WP | Scope | Engineer-weeks | Depends on |
|---|---|---|---|
| **WP1** Spec & vectors | key hierarchy, leaf formats, ElGamal/DKG spec, shared test vectors | 2 | — |
| **WP2** Circuits | transfer, order, claim, creator, dummy, decrypt; node tests with real proofs; constraint budget | 6 | WP1 |
| **WP3** Ceremony | PoT 16 / 20, ≥ 5 outside contributors per circuit, drand, verifier export, transcript | 1 (+3 elapsed) | WP2 |
| **WP4** Contracts | GroveVault, EpochBook (Baby Jubjub lib, venues), RelayerRegistry, CreatorStub, V1Bridge, PoseidonT7/T8, forge tests incl. BSC fork against the live Launchpad / Roots / HolderRewards | 7 | WP1 |
| **WP5** Relayer network | daemon (relay, committee, DKG, executor + rapidsnark, dummies, delayed queue), registry ops, runbooks | 6 | WP2, WP4 |
| **WP6** Web | v2 keys + lib, workers, /vault, private trade panel, holdings, launch privately, migration wizard, docs | 6 | WP2, WP4 |
| **WP7** Keeper | rewards exclusion + Vault leaf + `pullRewardsV1`, epochs, venue | 1.5 | WP4 |
| **WP8** Security | internal circuit review (under-constrained signals, division witnesses, field wrap), external audit of circuits + contracts, fix round | 2 (+6–8 elapsed, external) | WP2–WP5 |
| **WP9** Launch | Phase A on 97 then 56, committee onboarding, dummy budget, monitoring, Rings integration | 1.5 | all |
| **Total** | | **≈ 33 engineer-weeks** (≈ 5 months for one strong engineer with ceremony and audit overlapping; ≈ 3 months for two) | |

Risks that move the estimate: `order.circom` proving time on phones (rapidsnark-wasm, or 1-in
orders); EpochBook size (split the venue adapter); committee operations (the automatic cancel path
makes the worst case "no private trades for an hour", never lost funds); BSC private-tx relay
availability for `execute`.
