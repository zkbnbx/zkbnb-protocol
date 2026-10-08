# zkBNB "Dark Curve" — an attacker-first privacy architecture

Status: design proposal, 2026-10-05. Written against the live code (`contracts/src/*.sol` at
`5f3a8c9`, `circuits/transaction.circom`, `web/src/lib/zk/**`, `keeper/src/**`, SPEC.md §3–§6) and
the chain-56 deployment in `web/src/config/deployments/56.json`.

Owner's goal, verbatim: "full full full real privacy, the first real privacy launchpad". Hide
**amount**, **sender** and **linkability** for launchpad trading itself, not only for moving BNB.

The method of this document is attacker-first: §1 lists seven adversaries and what each one can
learn from zkBNB today, action by action. Every later design decision is justified by the row of
that table it removes, or by the number it reduces a leak to. §6 is the honest residue: what stays
public, and how many users an epoch needs before "hidden" means hidden.

---

## 0. The design in one page

**What zkBNB has today.** A Tornado-Nova style BNB-only pool (`ShieldedPool.sol`, Poseidon tree
depth 20, 2-in-2-out Groth16 join-split, 26,982 constraints, zkey 11.9 MB, Powers of Tau 15) with
a working relayer path for unshields and private sends. The pool hides the spending graph inside
the pool. Everything else — every curve trade, every holding, every harvest, every reward claim,
every `depositFor` payout (which publishes `pubKey`, `amount`, `blinding` and the paying wallet) —
is public. The launchpad itself (`Launchpad.sol`) has no privacy at all.

**What this design adds.**

1. **A multi-asset pool (`GrovePool v2`).** Notes carry an `assetId` (0 = BNB, or the coin's
   address). Coins live inside the pool as notes; the pool contract is the on-chain holder. A
   single 2-in-2-out join-split moves BNB and one coin in the same proof (so a relayer fee in BNB
   can ride on a coin transfer). Hidden amounts and range checks come from Groth16, as today.

2. **Batch auctions ("epochs") as the only way the curve moves.** Nobody trades against the curve
   directly. Buyers, sellers and harvesters submit *intents*: a proof that escrows a hidden amount
   of their notes into an intent note tagged `(coin, epoch, direction)`, plus an **additively
   homomorphic ElGamal ciphertext** of the amount (Baby Jubjub, verified inside the circuit). The
   contract sums ciphertexts per `(coin, epoch, direction)` on-chain. At epoch close an
   **Epoch Coordinator** decrypts only the *sum*, proves the decryption with a tiny Groth16
   proof, and the contract executes one aggregate trade at one **uniform clearing price**.
   Participants later `claim` their pro-rata output with a proof that hides which epoch they were
   in. Individual amounts never appear on-chain; the aggregate per epoch does.

3. **Handles replace `depositFor`.** Contract payouts (harvests, holder rewards, donations,
   creator fees) credit a one-time `handle = Poseidon(TAG, ownerKey, salt)`; the beneficiary later
   mints a note with a proof of knowledge of `ownerKey`. The receiving public key is never
   published, so payouts to the same person can no longer be clustered.

4. **Relayers everywhere, and a separation of duties.** Every pool transaction except a public
   shield is relayed. The relayer learns IP and timing, never amounts or identities. The Epoch
   Coordinator learns per-intent amounts (single-party mode) or only sums (threshold mode, phase 3)
   but never identities. The two roles are run by different operators.

5. **Private planting and private creator income.** A coin can be planted from the pool; its
   creator is a handle, its fee income accrues to that handle.

**What this design rejects, explicitly.**

- *Pedersen commitments + Bulletproofs for amounts*: not needed. Groth16 already hides amounts
  inside Poseidon commitments and enforces ranges with `Num2Bits`; a Bulletproof would cost
  ~700 bytes and 2–5 M gas to verify on the EVM (no precompile) for nothing we do not already
  have. The one place additive homomorphism *is* needed — summing hidden intent amounts — uses
  exponential ElGamal on Baby Jubjub, because the Coordinator must be able to *decrypt* the sum,
  which a Pedersen commitment cannot provide without a party who knows every blinding.
- *Ring signatures (Monero)*: a ring hides the sender among 11–16 decoys. Our nullifier-based
  spend hides it among every note ever created (2^23 leaves). Strictly better; nothing to add.
- *Stealth addresses for on-chain unlinkability*: a note commitment `Poseidon(asset, amount,
  pk, blinding)` with a random blinding already makes repeated payments to one `pk` unlinkable
  on-chain. One-time keys are still used where a *contract* must address a payee without a proof
  (handles), and viewing keys are separated from spending keys so an auditor never gets spend
  power.

**What is still public** (full table in §6): per-`(coin, epoch, direction)` counts and aggregate
executed amounts, the curve reserves and clearing prices, the pool's total holdings per coin,
every shield/unshield edge (asset + amount, and the depositor wallet on a shield), every
public-path action, known-amount contract payouts (harvest, reward, donation, creator fee: the
*amount* and the *fact*, not the key), transaction timing, relayer addresses, and — until the
Coordinator is thresholded — the per-intent amount distribution to the zkBNB keeper.

---

## 1. Threat model

### 1.1 Adversaries

| # | Adversary | Capabilities assumed |
|---|---|---|
| A1 | **Chain analyst** | Full history of chain 56; reads every event, calldata, `msg.sender`, balance, block timestamp; runs clustering heuristics (amount matching, timing, address reuse, subset-sum); has BscScan labels. Passive. |
| A2 | **MEV bot / builder** | Sees the public mempool and, as a BSC builder (bloXroute, 48 Club, BlockRazor, Nodereal), orders transactions within a block; can insert its own trades before/after a victim; can simulate. ~0.75 s blocks, gas ≈ 0.1–1 gwei. |
| A3 | **Malicious relayer** | Receives proof + extData from the browser; sees the submitter's IP and the exact submission time; can delay, censor, or submit; cannot alter anything bound by `extDataHash`. May collude with A1 or A5. |
| A4 | **Malicious creator** | Plants a coin; sees everything A1 sees about *its* coin; wants to identify buyers and their sizes (snipe, dump on them, target them); can pre-seed the PancakeSwap pair; chooses the payout mode. |
| A5 | **zkBNB team** | Deploys the web app (Vercel), runs the keeper (holder snapshots, buybacks, settlements), runs the default relayer and the Epoch Coordinator, holds the Safe `0x4D55…179f`, ran the proving-key ceremony alone (CEREMONY.md: both human contributions by one operator). Assumed *curious*, and we must also bound what a *compromised* team can do. |
| A6 | **RPC provider** | Sees every `eth_getLogs` / `eth_call` / `eth_sendRawTransaction` with the caller's IP, time, and query shape (which blocks, which topics); the wallet's own RPC (MetaMask default) sees every wallet-signed transaction before broadcast. |
| A7 | **Browser / client** | A malicious site version (supply chain, compromised deploy), a malicious or phished wallet extension, another dapp that asks the user to sign the key-derivation message, local storage on a shared device. |

### 1.2 What each adversary learns today, per action

Legend: **W** = wallet address, **$** = amount, **C** = coin, **PK** = shielded public key,
**t** = timing, **link** = linkable to the user's other actions.

| Action (today) | A1 chain analyst | A2 MEV | A3 relayer | A4 creator | A5 team | A6 RPC | A7 browser |
|---|---|---|---|---|---|---|---|
| **plant** (`Launchpad.plant`) | W, C, metadata, payout wallet, first-buy $ | front-run the first buy (sniped the $ZKBNB launch 1) | — (not relayed) | — | same as A1 | W↔IP | key-less action, W |
| **buy** (`buy`, `Trade` event: trader, bnb, tokens) | W, $, C, price, t, full link to W's history | sandwich; sniping | — | sees every buyer and size | A1 | W↔IP, $ | W |
| **sell** | W, $, C, t, link | sandwich | — | every seller | A1 | W↔IP | W |
| **hold** (ERC20 `balanceOf`) | every holder and balance (that is how the keeper snapshots) | — | — | the whole cap table | A1 + snapshot files publish holders | — | — |
| **harvest** (`Roots.harvest`, `harvestShielded`) | W, $, C; shielded variant also PK, blinding, leafIndex → the *note itself* is public | — | — | who exits and how much | A1 | W↔IP | W |
| **holder-reward claim** (`claim`, `claimShielded`) | W, $, runId; shielded variant publishes PK, blinding, leafIndex | — | — | — | computes who is eligible (snapshot) | W↔IP | W |
| **donation** (`donate`, `donateToCause`) | W, $, ring/cause; `depositFor` publishes the cause's note | — | — | — | A1 | W↔IP | W |
| **shield** (`transact`, extAmount>0) | W, $, t; `Transact(sender, …)` event; the two output commitments are *linked to W* as an edge | nothing to gain | not relayed | — | A1 | W↔IP, sees the tx first | W, derived key |
| **private send** (relayed) | relayer W, fee, t; two nullifiers + two commitments | — | IP↔(nullifiers, t) | — | A1 + relay logs (Vercel logs IPs) | relayer IP only | key |
| **unshield** (relayed) | recipient W, $, relayer, fee, t → amount-matching to an earlier shield of the same $ unless a standard denomination was used | front-run impossible (bound) | IP↔recipient↔$ | — | A1 + IP | relayer IP | key |
| **post-graduation trade** (PancakeSwap) | W, $, C, t | sandwich | — | every trader | A1 | W↔IP | W |
| **DepositFor** payouts in general | PK, $, blinding, index, `from` wallet. All payouts to one PK cluster into one shielded identity; the harvester/claimer wallet is linked to that identity | — | — | — | A1 | — | — |

Structural leaks that cut across actions:

- `ShieldedPool.Transact` emits `sender`; `Harvested`, `Claimed`, `Settled` emit `leafIndex`, so
  A1 knows exactly which leaf belongs to which public event.
- The shielded key is `keccak(sign("zkBNB shielded key v1")) mod p` (`web/src/lib/zk/index.ts`,
  `useShielded.ts`). ECDSA in MetaMask is deterministic (RFC 6979), so **any site** that asks the
  user to sign the same 22-byte message obtains the user's shielded spending key (A7). The key
  is also a deterministic function of the wallet, so wallet and shielded identity are bound
  forever.
- The pool is BNB-only: a coin can never be private, so all of launchpad trading leaks fully.
- The browser scans `NewCommitment`/`DepositFor`/`NewNullifier` logs from `startBlock` through
  the configured RPC (`notes.ts`, `scanLogs`): A6 sees who syncs a shielded wallet and when.
- The relayer runs as a Vercel function: A5's host logs IPs; cold starts leak timing.
- The ceremony has one human operator across two machines (CEREMONY.md): a compromise of that
  operator's machines is a compromise of pool soundness (forge withdrawals), though not of
  privacy.

### 1.3 Privacy goals per action

Goal levels: **H** hidden (not derivable from chain data), **A** aggregate only (derivable only
as part of a per-epoch sum), **P** public by design, **p** public *on the public path* (the user
may choose a public path; the private path exists and is the default).

| Action | Amount | Sender | Linkability to the user's other actions | Notes |
|---|---|---|---|---|
| plant | plant fee **P** (constant); first buy **A** | **H** (handle) | **H** | coin address, name, metadata **P** |
| buy (curve) | **A** per `(coin, epoch)` | **H** | **H** | count of intents per epoch **P** |
| sell (curve) | **A** | **H** | **H** | |
| hold | **H** (notes) / **p** (ERC20) | **H** / **p** | **H** | pool's total per coin **P** |
| harvest | **A** (from pool) / **P** (public wallet, via handle) | **H** / **p** | **H** | roots balance + supply **P** so aggregate burn **P** |
| holder-reward claim | **P** (snapshot is public by design) | **p** (the wallet is a public holder by definition) | payout note **H** after `handleClaim` | in-pool holders are rewarded through roots (§2.7) |
| donation (from pool) | **H** | **H** | **H** | ring/cause payouts **P** by design (Rings audit log) |
| shield | **P** (edge; use denominations) | **P** (the wallet pays) | **H** after the edge | the only wallet-signed pool transaction |
| unshield | **P** (edge) | **H** (relayed) | **H** | recipient **P** |
| post-graduation trade (from pool) | **A** | **H** | **H** | the aggregate swap on PancakeSwap **P** |

---

## 2. Cryptographic design

Field: BN254 scalar field `p` (as today). Hash: Poseidon (circomlib). Curve inside circuits:
Baby Jubjub (circomlib `babyjub.circom`, `escalarmulfix`, `escalarmulany`). Proof system: Groth16
via snarkjs, as today. New constants are domain tags, fixed in `circuits/lib/grove-zk.mjs` and
mirrored in Solidity.

### 2.1 Notes and assets

```
assetId      0 for BNB; uint160(coin address) for a GroveCoin (any ERC20 the pool whitelists)
note         commitment = Poseidon(assetId, amount, pk, blinding)          // Poseidon(4)
amount       wei (BNB) or token base units; range-checked < 2^128 in every circuit
intent note  commitment = Poseidon(intentAsset, amount, pk, blinding)
             intentAsset = Poseidon(INTENT_TAG, coin, epoch, dir)         // dir: 0 BUY, 1 SELL, 2 HARVEST
epoch leaf   leaf = Poseidon( Poseidon(coin, epoch, dir), Poseidon(totalIn, totalOut, totalRefund) )
             (Poseidon(3) inner, Poseidon(2) outer: both already deployed on-chain as T4/T3)
tree         one incremental Poseidon Merkle tree, depth 23 (8.4 M leaves), 100-root history,
             zero leaf keccak("grove-v2") mod p. Notes, intent notes and epoch leaves share it.
```

Why one tree: the claim proof (§2.5.6) must show that an intent note *and* its epoch's result
leaf both exist. Putting epoch leaves in the same tree means one root, one history ring, no
second contract, and a claim that reveals nothing about which epoch it refers to.

Why depth 23: an intent inserts 3 leaves, a claim 2, a transfer 2, an epoch open 1. At 20 levels
the live pool caps at 1 M leaves; 23 gives 8 M at +3 Poseidon hashes per Merkle path (≈ +730
constraints per input).

Coins are held by the pool contract. Shielding a coin publicly (`transferFrom`) is allowed but
discouraged; the private way to acquire a coin is an intent.

### 2.2 Key hierarchy

```
seed        32 random bytes (generated) — or derived from a wallet signature (legacy mode, §5.1)
ask         spending key          = keccak(seed || "ask") mod p
nk          nullifier key         = Poseidon(ask, 1)
pk          payment key           = Poseidon(ask)                       // unchanged from v1
ovk         owner key             = Poseidon(OWNER_TAG, ask)            // identifies a creator / cause / claimant
encPriv     x25519 scalar         = keccak(ask || "enc")                // note encryption, unchanged
address     "zkbnb2" + hex(pk 32B || encPub 32B)

Full viewing key  FVK = (pk, nk, encPriv)   → decrypts all incoming notes AND can compute their
                                              nullifiers, so it sees balance and spent status.
                                              It cannot spend: every spend proof needs ask.
Incoming viewing key IVK = (pk, encPriv)    → sees incoming notes only (an auditor who may not
                                              learn when you spend).
```

The change versus v1 is `nk`. Today the nullifier's inner "signature" is `Poseidon(privKey,
commitment, index)`, so anyone who can tell spent from unspent must hold the spending key; there
is no viewing key. With `nk` the circuit proves `nk == Poseidon(ask, 1)` (one Poseidon(2), ~240
constraints per input) and the nullifier never touches `ask` directly.

One-time keys: not needed for on-chain unlinkability (§0). The `ovk` is a *pseudonymous* owner
identity used by handles; it never appears on-chain in the clear except where the owner is public
by design (a registered cause).

### 2.3 Nullifiers

```
nf = Poseidon(commitment, leafIndex, nk)
```

Public per spend, as today. Distinctness inside one proof is enforced in-circuit (`IsEqual`), and
the contract rejects a spent `nf`. Zero-amount padding inputs skip the Merkle check exactly as the
current `ForceEqualIfEnabled` does.

### 2.4 Handles — replacing `depositFor`

Today `depositFor(pubKey, blinding)` computes the commitment on-chain, so the paying contract must
publish `pubKey` and `blinding`. `Roots.harvestShielded`, `HolderRewards.claimShielded` and
`DonationRotator._payCause` all do this. A1 reads every payout to a PK as income of one person.

Replacement:

```
handle   = Poseidon(HANDLE_TAG, ovk, salt)        // Poseidon(3) → PoseidonT4, deployed on-chain
credit   GrovePool.credit{value}(handle)          // any contract/EOA; claimable[handle] += msg.value
claim    GrovePool.handleClaim(proof, handle, salt, outCommitment, encryptedOutput, extData)
         proof: I know ask with ovk = Poseidon(OWNER_TAG, ask) and handle = Poseidon(HANDLE_TAG, ovk, salt),
                and outCommitment = Poseidon(0, claimable[handle], pk', blinding) for a pk' I choose.
         contract: amount = claimable[handle]; claimable[handle] = 0; insert outCommitment.
```

Three uses:

| Use | `ovk` | `salt` | Who computes the handle on-chain |
|---|---|---|---|
| one-shot payout (public-wallet harvest or reward claim into the pool) | fresh random per payout | 0 | nobody; the user passes `handle` to `harvestShielded`/`claimShielded` |
| creator fee pot | the creator's `ovk` | 0 | `Launchpad.plantFromPool` once at plant; FeeRouter credits it on every batch |
| cause payout | the cause's registered `ovk` | `Poseidon(ringId, epoch)` | `DonationRotator._payCause` (T3 + T4 calls) |

What A1 sees: `Credited(handle, amount, from)` and later `HandleClaimed(handle, amount)` plus a
commitment. The two are linked by `handle`, which is fine: the user's *key* is not in either, the
output note's owner and blinding are private, and the relayer submits the claim. Compared to
`depositFor`, the PK clustering leak is gone; the known-amount leak remains (§6, row 5).

### 2.5 Shielded trading against the public curve

#### 2.5.1 Why batching is the only option

The curve's reserves `(realBnb, soldTokens)` are public storage and must be, because PancakeSwap
graduation, `price()`, `quoteBuy()` and the Rings feed depend on them. Every individual execution
moves them by exactly the trade size. A single buy therefore reveals its amount through the
reserve delta no matter how it is paid. The only two ways to hide a size are (a) to execute many
trades as one aggregate move, or (b) to make the curve itself live in the shielded domain — which
is (a) in disguise, because at some point the public reserves have to change. So: **frequent
batch auctions with a uniform clearing price**, and the curve moves only at epoch boundaries.

The batch total still has to become known to the contract, and it is the sum of hidden amounts.
Three ways to get it, and why we pick the second:

| Option | Who learns individual amounts | Cost |
|---|---|---|
| Each intent reveals its amount on-chain | everyone | none; no privacy |
| **Homomorphic ciphertexts summed on-chain, Coordinator decrypts the sum and proves it** | the key holder(s) only: one party (phase 1), or nobody with t-of-n threshold (phase 3) | ~10 k constraints in the intent circuit, ~16 k gas per intent on-chain, one 250 k-gas proof per epoch |
| Coordinator receives plaintexts and proves `Σ = total` with a fixed-size batch circuit | the Coordinator | fixed N, padding, a 2 M-constraint circuit, no threshold path |

#### 2.5.2 Epochs

An epoch is per `(coin)`; buys, sells and harvests of the same coin and epoch are opened together.

```
EpochParams (global, Safe-settable within hard bounds):
  T_MIN   = 60 s      an epoch may not be opened before this age (bounds: 30 s .. 10 min)
  T_MAX   = 10 min    after this age it must be openable (bounds: 2 min .. 60 min)
  K       = 8         private-intent count that makes the epoch openable at T_MIN
  GRACE   = 30 min    after T_MAX + GRACE anyone may void an unopened epoch
  MIN_INTENT = 0.005 BNB / 5,000 tokens   dust floor (raises sybil cost, §6.2)

Epoch identity: epoch = (coin, seq). seq increments at each open/void. The current open epoch of a
coin is `cur[coin]`; intents may target cur or cur+1 (so a proof finished at the boundary is not wasted).
Openable when: age ≥ T_MAX, or (age ≥ T_MIN and privateCount ≥ K).
```

Per `(coin, epoch, dir)` the contract keeps: `count`, `publicIn` (sum of public intents, see
2.5.8), and the ElGamal sum `(C1, C2)` as two Baby Jubjub points in extended coordinates.

#### 2.5.3 The intent (user side)

A BUY intent spends BNB notes; a SELL or HARVEST intent spends coin notes plus a BNB note for the
relayer fee. The proof (`intent.circom`, §3.2) is a 2-in-3-out join-split with these extra duties:

```
public:   root, extDataHash, nf[2], outCommitment[3], coin, epoch, dir,
          ecPk (2 field elements: the Coordinator key registered for `epoch`),
          C1 (2), C2 (2)                                    // ElGamal ciphertext of the intent amount
private:  input notes (asset, amount, blinding, path, ask), output notes, k (ElGamal randomness)

constraints (beyond the join-split):
  out[0].asset == Poseidon(INTENT_TAG, coin, epoch, dir)
  out[0].amount counts toward the BNB slot if dir == BUY, else toward the coin slot
  u = out[0].amount / UNIT exactly (UNIT = 1e12 for BNB, 1e15 for tokens), u < 2^40
  C1 = k·G,  C2 = u·G + k·ecPk                              // exponential ElGamal on Baby Jubjub
  out[1] is change in the traded asset, out[2] is BNB change (either may be zero-amount)
```

Submission is by a relayer (§2.9). `IntentData` (hashed into `extDataHash`): `{coin, epoch, dir,
minCount, relayer, fee, encryptedOutput[3]}`. `minCount` is the smallest number of *other*
private intents the user accepts in the epoch (0 = fast mode).

What the contract checks (`DarkCurve.submitIntent`):

1. `epoch ∈ {cur[coin], cur[coin]+1}` and that epoch is not opened/voided; coin is a known coin.
2. `ecPk == coordinatorKey(epoch)` (keys rotate per epoch, §2.5.5).
3. Root known, nullifiers unspent and distinct, `extDataHash` matches, fee > 0 ⇒ relayer ≠ 0.
4. Groth16 verify (`IntentVerifier`).
5. Mark nullifiers, insert the three commitments, `count++`, add `(C1, C2)` to the epoch sum
   (two Baby Jubjub point additions in extended coordinates, ~7 k gas each), record
   `intentMin[epoch].push(minCount)` only if `minCount > 0` (most are 0).
6. Pay the relayer fee from the pool's BNB.

The intent amount is now escrowed inside the pool's own balance: nothing moved, the pool simply
owes `u·UNIT` of the asset to the intent note instead of to the spent notes.

#### 2.5.4 The open (Coordinator side)

When an epoch is openable, the Coordinator (keeper module, §5.2) computes the plaintext sums. In
single-party mode it decrypts each intent as it arrives (it holds `ecSk`); in threshold mode
only the summed ciphertext is decryptable, so it solves a small discrete log (`u_total < 2^48` by
construction: `u < 2^40` per intent and at most 256 intents per `(coin, epoch, dir)`; BSGS in
≤ 2^24 steps, under a second). It then produces `epochOpen.circom` proofs (one per direction with
intents) and calls:

```
DarkCurve.openEpoch(coin, epoch,
                    uBuy, uSell, uHarvest,          // plaintext unit sums (0 if no intents)
                    proofBuy, proofSell, proofHarvest,
                    minOutHint)                     // slippage bound for v1-launchpad / AMM legs
```

Contract:

1. Epoch openable, not yet opened; each `proof_d` verifies `C2_d − ecSk·C1_d == u_d·G` against the
   stored `(C1_d, C2_d)` and `ecPk` (the proof's private input is `ecSk`; its public inputs are the
   points and `u_d`). A direction with `count == 0` needs no proof and `u_d == 0`.
2. `minCount` enforcement: for every intent `i` with `minCount_i > privateCount_d − 1`, subtract
   its ciphertext from the sum (the Coordinator supplies its plaintext `u_i` and a decryption
   proof for that single ciphertext), mark `voided[intentCommitment_i] = true` and emit
   `IntentVoided`. The remaining `u_d` is then re-checked. In practice intents with `minCount > 0`
   are rare and the Coordinator knows in advance whether they will be voided.
3. `B = uBuy·1e12 + publicBuyIn`, `T = uSell·1e15 + publicSellIn`, `H = uHarvest·1e15 + publicHarvestIn`.
4. Execute (§2.5.5): `(tokensOut, bnbOutSell, bnbUsed, bnbOutHarvest) = engine.execute(coin, B, T, H, minOutHint)`.
5. Insert epoch leaves for each direction that had intents:
   `BUY: (B, tokensOut, B − bnbUsed)`, `SELL: (T, bnbOutSell, 0)`, `HARVEST: (H, bnbOutHarvest, 0)`.
   Public-intent participants are settled by `claimPublic` against the same totals (2.5.8).
6. `cur[coin]++`; emit `EpochOpened(coin, epoch, B, T, H, tokensOut, bnbOutSell, bnbOutHarvest, priceAfter)`.

If step 4 reverts (coin graduated between the last quote and now, slippage bound hit on an AMM or
v1 leg) the call reverts and the Coordinator retries next block with a fresh hint. If no open
succeeds before `T_MAX + GRACE`, **anyone** calls `voidEpoch(coin, epoch)`: the contract inserts
`(1, 0, 1)` leaves for all three directions and increments `cur`. Claims then refund 100 %. No
funds are ever stuck on an absent Coordinator; the Coordinator is a *liveness* dependency only.

#### 2.5.5 Price: one uniform clearing price per epoch

Let `vB = VIRTUAL_BNB + realBnb`, `vT = VIRTUAL_TOKENS − soldTokens`, `k = vB·vT` before the
epoch, and `f = 2 %`. Fees are taken on the gross of each side exactly as today (buyers pay
`f·B`, sellers pay `f` of their gross BNB), so the FeeRouter flywheel receives the same 2 % of
every unit of volume whether a trade was matched internally or against the curve.

```
Bn = B·(1 − f)                                 net BNB buyers bring
P  = clearing price in BNB per token (18-dec)
buyers receive  tokensOut = Bn / P
sellers receive gross     = T·P,   net bnbOutSell = T·P·(1 − f)
the curve absorbs the net:  ΔB = Bn − T·P,   ΔT = Bn/P − T,   (vB + ΔB)(vT − ΔT) = k

→  T·(vT+T)·P² − ((vB+Bn)(vT+T) + T·Bn − k)·P + (vB+Bn)·Bn = 0        (quadratic in P)
   T = 0:  P = (vB + Bn) / vT                  (identical to today's quoteBuy)
   Bn = 0: P = vB / (vT + T)                   (identical to today's quoteSell)
```

Solved on-chain with `Math.sqrt` (OpenZeppelin), rounding in the pool's favour by one wei. The
curve-completion cap is applied as today: if `ΔT` would exceed `CURVE_TOKENS − soldTokens`, `Bn`
is capped at `remainingCost` and the excess BNB is `totalRefund` (pro-rata back to buyers as BNB
notes); the coin graduates inside the same transaction (`_graduate` unchanged, including the
pre-seeded-pair normalisation). Harvests are independent of the trade clearing:
`bnbOutHarvest = roots.balance(coin)·H / totalSupply` through `Roots.harvestFromPool` (burns the
pool's tokens, pays the pool).

Every participant in the epoch, private or public, buy or sell, gets `P`. Ordering inside the
epoch is irrelevant, so there is nothing to sandwich (§2.10).

Rounding dust (`a_i·totalOut mod totalIn` per claim) accumulates in the pool and is sweepable to
the treasury; it is at most `count` wei-units per epoch.

#### 2.5.6 The claim (user side, later, any time)

```
claim.circom
public:   root, nf (of the intent note), outCommitment[2], extDataHash
private:  intent note (coin, epoch, dir, amount a, blinding, path, ask, nk),
          epoch leaf (totalIn, totalOut, totalRefund, path),
          q, r, qr, rr, output notes (pk', blinding')

constraints:
  intentAsset == Poseidon(INTENT_TAG, coin, epoch, dir); note in tree at root; nf correct
  leaf == Poseidon(Poseidon(coin, epoch, dir), Poseidon(totalIn, totalOut, totalRefund)); leaf in tree at root
  a·totalOut == q·totalIn + r,  r < totalIn,  q < 2^128          // pro-rata output, floor
  a·totalRefund == qr·totalIn + rr,  rr < totalIn                 // pro-rata refund (buys only; 0 otherwise)
  out[0] = (dir==BUY ? coin : 0,  q,  pk', b0)                    // tokens for a buy, BNB for sell/harvest
  out[1] = (0, qr, pk', b1)                                       // BNB refund (zero-amount when none)
```

Contract (`DarkCurve.claim`): root known, `nf` unspent, verify, mark `nf`, insert the two
commitments. The claim circuit has no BNB input, so a relayer fee cannot be paid from the spent
note; rather than add one (and reveal, through the fee, which claims are buys with a BNB refund),
**claims are free to relay**: relayers are reimbursed per claim from `DarkCurve.claimBudget`,
funded by the treasury share and capped per epoch at `count × gasUnits × gasPrice`. A claim is
bookkeeping the protocol wants done, and the cap means a griefer cannot drain the budget (every
claim consumes a real intent nullifier).

Voided intents use `claimVoided(proof, intentCommitment, …)`: same circuit with a public
selector that fixes `(totalIn, totalOut, totalRefund) = (1, 0, 1)` and exposes
`intentCommitment` so the contract can check `voided[]`. This reveals which intent is being
refunded — an intent that never traded, whose sender and amount stay hidden.

What A1 sees in a claim: one nullifier, two commitments, a relayer. It cannot tell which coin,
which epoch, which direction, or how much. Timing is the only side channel (§6.3).

#### 2.5.7 Failure and refund paths, complete list

| Situation | Who acts | Outcome for a participant |
|---|---|---|
| Normal open | Coordinator | `claim` → pro-rata tokens/BNB |
| Curve completes mid-batch | contract (inside open) | `claim` → tokens at the capped `Bn` plus BNB refund of the unused share; coin graduates |
| Open reverts (AMM/v1 slippage, graduated meanwhile) | Coordinator retries; after `T_MAX + GRACE` anyone `voidEpoch` | `claim` → 100 % refund in the escrowed asset |
| Coordinator offline / key lost | anyone `voidEpoch` | 100 % refund |
| `minCount` not met | contract at open | `claimVoided` → 100 % refund |
| Relayer refuses an intent | user picks another relayer, or self-submits (reveals wallet) | — |
| Tree nearly full (`nextIndex + 3 > 2^23`) | contract | `submitIntent` reverts; `transact` enters withdraw-only mode exactly like v1 (`CommitmentDropped`) |
| Proof rejected (stale root) | client re-proves against the current root (100-root history ≈ several minutes of activity) | — |

No path lets the Safe, the Coordinator or a relayer take or freeze escrowed funds.

#### 2.5.8 Public intents (users who choose no privacy)

To keep the curve batch-only for everyone — the property that makes it MEV-free — a public
user does not get an immediate `buy`. `CurveEngine.publicBuy(coin) payable`,
`publicSell(coin, tokens)`, `publicHarvest(coin, tokens)` record `(wallet, amount)` in the
current epoch and are settled by `claimPublic(coin, epoch)` after the open at the same `P`.
Their amounts and wallets are public; they are added to `B`, `T`, `H` *after* the ElGamal sums,
so they never improve or degrade the private participants' anonymity (an analyst simply
subtracts them).

### 2.6 Private planting and creator income

```
GrovePool.transactAndCall(proof, extData)   // transfer proof with extAmount < 0 and recipient = Launchpad
Launchpad.onPoolPayment{value}(bytes payload) // onlyPool; payload = abi.encode(PlantParams, creatorHandle)
```

The pool unshields `plantFee` to the Launchpad, which decodes `PlantParams` and
`creatorHandle = Poseidon(HANDLE_TAG, ovk, 0)` (computed client-side; the Launchpad stores it
in `CoinInfo.creatorHandle` and registers it with FeeRouter as the payee of `PayoutMode.Creator`).
The creator's wallet never appears; `Planted(coin, creatorHandle, …)` replaces
`Planted(coin, creator, …)`. The first buy is **not** part of the plant: the UI submits it as a
normal private intent into the coin's first epoch, where it sits in the same crowd as everyone
else (this also removes the launch-sniping vector that hit $ZKBNB launch 1: nobody can be first
inside a batch).

Creator fee income: FeeRouter v2 calls `pool.credit{value: toDeployer}(creatorHandle)` once per
batch (not per trade). The creator claims with `handleClaim` whenever they like, via a relayer.
`handOver` for a handle-owned coin takes an `ownerAuth` proof (the `handleClaim` circuit with a
public `actionHash` instead of an amount) so the creator can switch to Holders/Donate/Wallet
without revealing a wallet. Metadata (name, symbol, description, image) stays public: it is the
product.

### 2.7 Harvest, holder rewards, donations

**Harvest.** Two paths. (a) *From the pool*: a `HARVEST` intent spends coin notes; the batch
burns `H` tokens through `Roots.harvestFromPool(coin, H)` (Roots v2, `onlyPool`, `burnFrom(pool)`),
BNB comes back to the pool, participants `claim` BNB notes pro-rata. Amount hidden in the
aggregate, sender hidden, destination hidden. (b) *From a public wallet*:
`Roots.harvestShielded(coin, tokens, minBnb, handle)` → `pool.credit(handle)`; the wallet and
amount are public, the destination key is not.

**Holder rewards.** The keeper snapshots ERC20 balances from `Transfer` logs. Inside the pool
there are no per-holder balances to snapshot — that is the point — so the pool contract is
excluded from snapshots and its pro-rata share of each run is deposited into the coin's
**roots** (`HolderRewards.postRun(..., poolShare)` → `Roots.depositFrom(coin)`; if roots are at
`cap`, the share stays in the public holders' pot to avoid the deposit→overflow→fund loop).
In-pool holders thus receive their reward through a higher harvest value per token, claimable
privately with a `HARVEST` intent, instead of as a dividend they would have to prove eligibility
for. This is a deliberate simplification: a per-note "unspent at snapshot block" proof needs a
nullifier non-membership structure (indexed Merkle tree) that costs more than the rewards are
worth. Public holders keep the Merkle claim; `claimShielded(..., handle)` lands it in the pool
without publishing a key.

**Donations.** Private donations are pool transfers to a cause's `pk` (already the case;
now relayed). Ring settlements and direct public donations credit
`Poseidon(HANDLE_TAG, cause.ovk, Poseidon(ringId, epoch))`; the cause claims with its `ovk`.
Causes register `(pk, encPub, ovk)`; `shieldedPubKey/encryptionKey` stay for private donations.
Payout amounts and recipients stay public — Rings is an audit log by design.

### 2.8 Post-graduation trading

Once `pair != 0`, `CurveEngine.execute` routes the net leg through the PancakeSwap router
(`swapExactETHForTokensSupportingFeeOnTransferTokens` / `swapExactTokensForETH…`) with
`minOutHint` as slippage bound. The pool is **not** tax-exempt on any coin, so the 2 % pair tax
keeps feeding FeeRouter. Internal matching (buyers vs sellers in the same epoch) happens first at
the clearing price derived from the pair's reserves and the net leg. Users still get: aggregate
amounts, hidden sender, no linkability. What they do not get: protection from sandwiching of the
net AMM leg by A2, except through private transaction submission by the Coordinator and the
slippage bound (§2.10). Direct PancakeSwap trades from a wallet are public and outside the
system.

### 2.9 Relayer economics and roles

- **Fee**: `gasPrice × gasUnits(action) × (1 + margin) + flat`, quoted before proving, bound in
  `extDataHash`, paid from the pool's BNB to `extData.relayer` (as today). `gasUnits`: transfer
  ≈ 0.85 M, intent ≈ 1.25 M, handleClaim ≈ 0.55 M, claim free (treasury-reimbursed per claim,
  bounded by a per-epoch budget so a griefer cannot drain it: at most `count` claims per epoch).
- **Any relayer**: the contracts are relayer-agnostic. The web ships a default relayer URL and a
  "use my own relayer" field; a `RelayerRegistry` (name, URL, address, optional stake) is a
  later convenience, not a trust anchor.
- **What a relayer learns**: IP, user agent, submission time, the public inputs (coin, epoch,
  direction, ciphertext). Not the amount, not the key, not the wallet.
- **What a relayer can do**: decline or delay. It cannot redirect, re-price or front-run: every
  mutable field is under `extDataHash`, and the proof is useless to anyone else (a relayer that
  submits it anyway just does the user's job for free).
- **Separation of duties**: the default relayer and the Coordinator run as different services
  under different operators (or at minimum different hosts and keys with no shared logs), so no
  single party holds `IP ↔ amount`. The relayer keeps no access logs; a Tor hidden service is
  offered.
- **Deposits** (shields) are never relayed: `msg.value` has to come from the user. This is the
  one wallet-signed pool transaction, and the UI keeps steering it to standard denominations.

### 2.10 Anti-front-running and MEV

| Vector | Today | Design |
|---|---|---|
| Sandwich a curve buy/sell | trivial (`Trade` in the public mempool) | impossible on v2 coins: the curve moves only at `openEpoch`, every participant gets the same `P`, and the only way to trade is to be *in* a batch |
| Snipe a launch | possible (and happened) | the first buy is a private intent in epoch 0 with everyone else |
| Front-run `openEpoch` on a **v1** coin (public `buy/sell` still exist on Launchpad v1) | n/a | Coordinator submits through a private-transaction RPC (48 Club / bloXroute BSC private tx); `minOutHint` bounds the damage; a griefer paying 2 % per push to move the curve can delay an open, not steal from it |
| Sandwich the net AMM leg after graduation | n/a | same two mitigations; the leg is the net of the whole epoch, so the per-user exposure is pro-rata of one bounded slippage |
| Observe intent counts and direction to trade ahead | n/a | counts and directions are public (§6). A bot can join the *next* epoch at that epoch's price; it cannot get ahead inside an epoch. Amounts are hidden, so it cannot size a position against a known flow |
| Reorder relayed txs | relayer could delay | bound by `extDataHash`; a delayed intent still lands in `cur` or `cur+1` or reverts harmlessly |

### 2.11 Primitives considered and rejected

- **Pedersen + Bulletproofs**: rejected (§0). Groth16 already gives hidden amounts with ranges at
  ~250 k gas per proof; Bulletproof verification on the EVM is 10–20× that and needs no trusted
  setup only in exchange for logarithmic proof size we do not need.
- **Ring signatures**: rejected; the nullifier model's anonymity set is the whole tree.
- **Stealth addresses (DH one-time keys) computed by paying contracts**: rejected; a Baby Jubjub
  scalar multiplication in Solidity is ~0.7–1 M gas and the contract has no secret randomness.
  Handles achieve the same unlinkability for 2 Poseidon calls.
- **Fixed-N batch-sum circuit instead of homomorphic ciphertexts**: rejected (§2.5.1 table).
- **Pedersen (not ElGamal) for the sums**: rejected; the opener would need `Σ blinding`, which
  forces every user to send its blinding to the opener anyway — ElGamal with the opener's key is
  the same trust with a decryption proof for free and a threshold path.
- **Immediate execution for public users**: rejected; it would reintroduce a public path to
  sandwich against and would let bots trade ahead of an epoch open.

---

## 3. Circuits

All Groth16/BN254, circom 2.1, Poseidon from circomlib. Numbers for the existing circuit are
measured (`circuits/build/setup.log`: 26,982 constraints, 12,888 non-linear; zkey 11.9 MB;
browser proving 10–40 s per `web/src/lib/relay.ts`). Estimates below use ~243 constraints per
Poseidon(2), ~290 per Poseidon(3/4), ~2.7 k per `EscalarMulFix` (253-bit), ~6.5 k per
`EscalarMulAny`, ~440 bytes of zkey per constraint, and browser proving ≈ 1.2 s per 1 k
constraints on a mid-range laptop (snarkjs, multi-threaded worker), i.e. the same throughput the
current circuit shows.

| # | Circuit | Public inputs | Private inputs | Key constraints | Est. constraints | Browser proving | zkey | PoT |
|---|---|---|---|---|---|---|---|---|
| C1 | `transfer.circom` (2-in-2-out, multi-asset) | `root, publicAmount, publicAsset, extDataHash, nf[2], outC[2]` (8) | per input: `asset, amount, blinding, pathIndices, pathElements[23]`; `ask`; `txAsset`; per output: `asset, amount, pk, blinding` | each note's `asset ∈ {0, txAsset}`; per-asset conservation `Σin + publicAmount·[asset==publicAsset] = Σout + fee·[asset==0]`; `(publicAsset − asset_slot)·publicAmount == 0`; `nk = Poseidon(ask,1)`; nullifiers; Merkle ×2 (23 levels); `Num2Bits(128)` on outputs | **≈ 30 k** | 12–45 s | ≈ 13 MB | 15 (fits 32,768) or 16 |
| C2 | `intent.circom` (2-in-3-out + ElGamal) | C1's + `coin, epoch, dir, ecPk[2], C1[2], C2[2]` (17) | C1's + `k` (ElGamal randomness), `u` | C1 constraints (3 outputs); `out[0].asset == Poseidon(INTENT_TAG, coin, epoch, dir)`; `out[0].amount == u·UNIT(dir)`, `u < 2^40`; `C1 = k·G` (fix), `kP = k·ecPk` (any), `C2 = u·G (fix, 40-bit) + kP`; `k` range | **≈ 42 k** | 18–65 s | ≈ 19 MB | 16 |
| C3 | `claim.circom` | `root, nf, outC[2], extDataHash, voidedSelector, intentCommitmentOrZero` (7) | intent note fields + path (23), `ask`, epoch leaf fields + path (23), `q, r, qr, rr`, output notes | two Merkle proofs (46 Poseidon(2)); intentAsset recompute; leaf recompute (3 Poseidons); two Euclidean divisions with range checks; 2 output commitments; voided mode fixes totals to (1,0,1) and exposes the commitment | **≈ 15 k** | 6–22 s | ≈ 7 MB | 14/15 |
| C4 | `handleClaim.circom` (also `ownerAuth`) | `handle, salt, amount, outC, extDataHash, actionHash` (6) | `ask, pk', blinding'` | `ovk = Poseidon(OWNER_TAG, ask)`; `handle == Poseidon(HANDLE_TAG, ovk, salt)`; `outC == Poseidon(0, amount, pk', blinding')`; `actionHash² ` (bind) | **≈ 1.2 k** | < 1 s | ≈ 0.6 MB | 11 |
| C5 | `epochOpen.circom` (decrypt sum) | `ecPk[2], C1[2], C2[2], u` (7) | `ecSk` | `ecPk == ecSk·G`; `M = C2 − ecSk·C1` (any + add); `M == u·G` (fix, 48-bit); `u < 2^48` | **≈ 11 k** | n/a (Node: 1–3 s snarkjs, < 0.5 s rapidsnark) | ≈ 5 MB | 14 |
| C5t | `epochOpenShare.circom` (threshold, phase 3) | `sharePk[2], C1[2], D[2]` | `shareSk` | `D == shareSk·C1`, `sharePk == shareSk·G` | ≈ 9 k | n/a | — | 14 |

Notes:

- C1 and C2 could be one circuit (an intent is a transfer with an extra output and a ciphertext),
  but keeping C1 at ~30 k keeps the common action (send/unshield) fast and lets C1 stay on the
  existing PoT 15 file if it fits; measure before deciding.
- `publicAsset` is a public input so the contract knows which ERC20 to move on an unshield; for a
  pure private transfer the client sets `publicAsset = 0` and `publicAmount = 0`, revealing
  nothing about the asset moved.
- Baby Jubjub points as public inputs cost one `ecMul` each in the verifier (~6 k gas per
  public input); C2's 17 public inputs push its verify to ≈ 300 k gas. Hashing the public inputs
  into one field element (Poseidon) inside the circuit and exposing only the hash would bring it
  back to ≈ 230 k at the price of the contract recomputing the Poseidon (~5 hashes ≈ 60 k gas);
  not worth it on BSC.
- **Ceremony**: C1–C5 are new circuits, so each needs its own phase-2. Phase 1 moves to the
  Hermez `powersOfTau28_hez_final_16.ptau` (65,536 constraints, ~75 MB) for C2, and 15/14/11 for
  the rest (or 16 for all, one download). The current phase-2 (one operator, two machines, drand
  round 6519014) is not acceptable for a system that custodies coins as well as BNB: run an
  **open multi-party ceremony** with ≥ 10 outside contributors per circuit (`snarkjs zkey
  contribute`, hashes published), finish with a fresh drand beacon, publish `CEREMONY.md` v2 with
  all transcripts. A compromised key for C1/C3/C4 forges withdrawals of any asset in the pool; for
  C2 it forges an intent (steals from the epoch); for C5 it lets a malicious Coordinator lie about
  the sum (steals the difference from the escrow). The exposure is the pool's balance, visible on
  Rings; `maxDeposit` stays as the brake.

---

## 4. Contracts

Solidity 0.8.26, `via_ir`, optimizer runs 200 (as `foundry.toml`). Nothing is upgradeable.
Size budget 24,576 bytes per contract. Current Launchpad: 21.9 KB.

### 4.1 `GrovePool` (new; replaces `ShieldedPool`)

Holds all funds (BNB + ERC20s), the tree, the nullifier set, handles. Modules (`DarkCurve`,
`CurveEngine`) are authorised callers for leaf insertion and fund movement.

```
storage
  MerkleTreeWithHistory(23)            filledSubtrees, zeros, roots[100], nextIndex
  mapping(uint256 => bool)   spent     nullifiers
  mapping(uint256 => uint256) claimable  handle → wei
  mapping(address => bool)   isModule
  mapping(address => bool)   isAsset   0x0 (BNB) always; GroveCoins added by Launchpad.plant / registerAsset(owner)
  uint256 maxDeposit                   per public shield (owner-settable, as today)
  IVerifier transferVerifier, handleVerifier

functions
  transact(Proof, ExtData)                 shield (extAmount>0, msg.value or transferFrom of publicAsset),
                                           unshield (extAmount<0 → pay recipient in publicAsset),
                                           private transfer (extAmount==0). Relayer fee always BNB.
  transactAndCall(Proof, ExtData)          unshield to a contract and call onPoolPayment(payload)  (plant, future hooks)
  credit(uint256 handle) payable           claimable[handle] += msg.value; emit Credited(handle, amount, msg.sender)
  handleClaim(Proof, handle, salt, outC, encOut, ExtData)   zero claimable, insert note, pay relayer
  insertLeaves(uint256[])  onlyModule      used by DarkCurve (intent/claim commitments, epoch leaves)
  markSpent(uint256[])     onlyModule
  moveOut(asset, amount, to) onlyModule    escrow → CurveEngine for the net leg; back via receive()/transferFrom
  setMaxDeposit, setModule (one-shot per module address), registerAsset
events
  NewCommitment(commitment, index, encryptedOutput), NewNullifier(nf), Credited, HandleClaimed(handle, amount),
  Transact(extAmount, publicAsset, recipient, relayer, fee)     // NO sender field (v1 leaks msg.sender)
```

Gas (BSC, 23-level tree, ~12 k gas per on-chain Poseidon T3, Groth16 verify ≈ 230 k + 6 k per
public input): shield/transfer/unshield ≈ **0.8 M**; handleClaim ≈ **0.55 M**; credit ≈ 45 k.
Estimated size ≈ 11 KB.

### 4.2 `DarkCurve` (new; epochs, intents, claims)

```
storage
  struct Epoch { uint64 openedAt; uint64 startedAt; uint32 count[3]; bool opened; bool voided;
                 uint256[4] cipherSum[3];  /* C1.x,C1.y,C2.x,C2.y in affine after normalisation; extended coords in memory */
                 uint256 publicIn[3]; }
  mapping(address coin => uint256) cur
  mapping(bytes32 (coin,seq) => Epoch) epochs
  mapping(uint256 intentCommitment => bool) voided
  mapping(uint256 intentCommitment => uint8 minCount)   only when minCount > 0
  mapping(uint256 epochSeqGlobal => uint256[2]) coordinatorKey   // key valid from a given global epoch counter
  EpochParams params;  GrovePool pool;  CurveEngine engine;  IVerifier intentVerifier, claimVerifier, openVerifier

functions
  submitIntent(Proof, IntentData)                     §2.5.3 checks; babyjub add ×2; relayer fee
  openEpoch(coin, epoch, u[3], proofs[3], voidList, voidProofs, minOutHint)   §2.5.4
  voidEpoch(coin, epoch)                              after T_MAX + GRACE
  claim(Proof, ExtData)                               insert 2 leaves, mark nf; relayer reimbursed from claimBudget
  claimVoided(Proof, intentCommitment, ExtData)
  fundClaimBudget() payable                           treasury tops up; per-epoch cap = count × gasUnits × gasPrice
  setParams (within bounds), setCoordinatorKey(fromGlobalEpoch, pk)   // never affects an epoch already accepting intents
library BabyJubjub                                    extended twisted-Edwards add (~7 k gas), normalise via modexp inverse (~3 k)
```

Gas: `submitIntent` ≈ 300 k verify + 3 inserts ≈ 830 k + 2 ecAdd 14 k + storage ≈ **1.2 M**.
`openEpoch` ≈ 250 k per direction proof + engine execution 150–250 k (graduation: +2.5 M once per
coin) + 1–3 leaf inserts ≈ 280 k each ≈ **0.9–1.5 M**, paid by the Coordinator and reimbursed
from the treasury share. `claim` ≈ 240 k + 560 k ≈ **0.8 M**. `voidEpoch` ≈ 0.9 M (3 leaves).
Estimated size ≈ 14 KB (+ 3 KB library, deployed separately).

### 4.3 `CurveEngine` (new; batch execution math) and `Launchpad v2` (changed)

The live Launchpad is 21.9 KB and has no batch entry point; the math of §2.5.5, public intents
and `claimPublic` do not fit next to planting and graduation. Split:

```
Launchpad v2 (≈ 20 KB target)
  plant(PlantParams) payable                 public plant, as today (payout wallet / creator wallet)
  onPoolPayment(bytes payload) onlyPool      private plant: decode PlantParams + creatorHandle; registers coin with FeeRouter v2
  plantRootstock                             dropped on 56 (rootstock is external: FlapBuyback) — saves ~1 KB
  applyBatch(coin, dBnb, dTokens, feeBnb) onlyEngine   updates realBnb/soldTokens/volume, collects fee, graduates if complete
  _graduate / _normalizePair → GraduationLib (external library, delegatecall)   saves ~3 KB
  metadataOf → emitted in Planted only, not stored                            saves ~0.8 KB
  views unchanged: price, quoteBuy, quoteSell, remainingCost, stage, curveProgress

CurveEngine (≈ 9 KB)
  execute(coin, B, T, H, minOutHint) onlyDarkCurve → (tokensOut, bnbOutSell, bnbUsed, bnbOutHarvest)
      curve branch: quadratic of §2.5.5, Math.sqrt, cap at remainingCost, launchpad.applyBatch, tokens/BNB ↔ pool
      AMM branch: internal match at pair spot, net leg via router with minOutHint
      v1 branch (coins on Launchpad v1): internal match at v1 quote, net leg via v1.buy/sell with minOut
      harvest: roots.harvestFromPool(coin, H)
  publicBuy(coin) payable / publicSell(coin, tokens) / publicHarvest(coin, tokens) / claimPublic(coin, epoch)
```

Gas for a public participant: `publicBuy` ≈ 60 k, `claimPublic` ≈ 70 k (plus ERC20 transfer).

### 4.4 `FeeRouter v2` (changed)

Same split (25/25/10/40, bounds unchanged), same treasury `0x4D55…179f`, same rootstock adapter
pattern. Changes: `registerCoin(coin, creator, creatorHandle, mode, wallet, ringId, isRootstock)`;
`collect` additionally authorised for `CurveEngine`; `PayoutMode.Creator` with
`creatorHandle != 0` → `pool.credit{value}(creatorHandle)`; `handOver` accepts either
`msg.sender == creator` or an `ownerAuth` proof (`handleVerifier`, `actionHash = keccak(coin,
mode, wallet, ringId, nonce)`). `setModules` stays one-shot. Size ≈ 10 KB.

### 4.5 `Roots v2`, `HolderRewards v2`, `DonationRotator v2` (changed)

- Roots: `harvestShielded(coin, tokens, minBnb, handle)` → `pool.credit`; `harvestFromPool(coin,
  tokens) onlyPool`; `depositFrom(coin) payable onlyHolderRewards` (no overflow loop).
- HolderRewards: `claimShielded(..., handle)`; `postRun(..., poolShare)` forwards `poolShare` to
  `roots.depositFrom` (or keeps it if roots are capped).
- DonationRotator: `Cause` gains `ovk`; `_payCause` credits
  `Poseidon(HANDLE_TAG, ovk, Poseidon(ringId, epoch))` via the deployed T3/T4; fallback wallet
  path unchanged; `PayoutDeferred` unchanged.
- GroveCoin: unchanged (the pool must **not** be exempt, so graduated trading keeps paying the
  2 % pair tax). `FlapBuyback v2`: same code, `feeRouter` = FeeRouter v2.

### 4.6 Verifiers

Five snarkjs-generated verifiers (`TransferVerifier`, `IntentVerifier`, `ClaimVerifier`,
`HandleVerifier`, `OpenVerifier`), ≈ 9 KB each, separate deployments. Poseidon T3/T4 bytecode is
reused from the live deployment (`0x5B17…4eF6`, `0xB1FE…685a`): stateless, same parameters.

### 4.7 Admin powers in v2 (Safe), and what admin cannot do

Can: set `maxDeposit`; set `EpochParams` within hard bounds; set the Coordinator key for *future*
epochs; register assets; set FeeRouter shares within bounds; pause a coin's roots to the fixed
recovery address (as today); set the keeper; fund the claim budget. Cannot: spend or freeze any
note or escrow (`voidEpoch` and `claim` are permissionless and never gated), change a coin's payee
after handover, re-point modules (one-shot), upgrade anything, or lower the open deadline below
`T_MIN + GRACE` bounds.

---

## 5. Web, keeper and relayer changes

### 5.1 Web (`web/`)

- **Key management**: generated-seed mode by default ("Create a shielded wallet": 32 random bytes,
  encrypted at rest with a passphrase via WebCrypto, 12-word backup); wallet-signature mode kept
  as "Derive from wallet" with an EIP-712 typed message (domain `{name:"zkBNB", version:"2",
  chainId, verifyingContract: GrovePool}`) *plus* a user passphrase mixed into the hash, and a
  red warning that any site asking for that signature gets the key. Export/import of FVK and IVK.
- **Note store**: multi-asset notes, intent notes (with `(coin, epoch, dir)` and their claim
  status), handles we created, epoch leaves we are entitled to; IndexedDB, encrypted with the
  session key.
- **Sync**: no more per-wallet `eth_getLogs` through the user's RPC. The keeper publishes a
  compact bundle of all `NewCommitment` (commitment, index, encryptedOutput), nullifiers,
  `Credited` and epoch leaves (`snapshots/pool/<chunk>.bin`, Blob-hosted, cache-friendly); the
  browser downloads *everything* (same bytes for every user) and trial-decrypts locally. Reads
  that must be live (current root, `cur[coin]`, epoch counts) go through the existing
  `/api/rpc` proxy, which keeps no logs. A1/A6 learn only that a browser fetched the public
  bundle.
- **Proving**: three browser zkeys (C1 ≈ 13 MB, C2 ≈ 19 MB, C3 ≈ 7 MB, C4 ≈ 0.6 MB) fetched with
  progress and kept in CacheStorage keyed by `CEREMONY-HASHES.txt`; the worker loads the one it
  needs. Proving UI shows the epoch countdown and the crowd counter while it runs.
- **Coin page**: the buy/sell panel becomes "Private buy / Private sell / Private harvest" with
  mode *Private (wait for ≥ k others)* / *Fast*; quote shows the *expected* clearing price range
  (from current reserves and the epoch's public intents) and the worst case; trades feed becomes
  an **epochs feed** (per epoch: count, aggregate in/out, `P`); the chart is built from
  `EpochOpened` instead of `Trade`. A "Public buy" link remains, labelled as public.
- **Portfolio** (`/wallet`): shielded holdings per coin, pending intents, claimable epochs,
  handles to claim, "auto-claim later" toggle (default: claim via relayer at a random time 1–24 h
  after the open, or lazily when the user next acts) — the timing defence of §6.3.
- **Plant**: "Plant privately" (pays from the pool, creator = handle) as default when a shielded
  wallet exists; first buy becomes a pre-filled intent for epoch 0.
- **Move**: v2 pool, denominations unchanged, plus "Migrate from v1" (§7).
- **Rings**: epochs, voids, claim budget, Coordinator key history, ceremony transcript link.
- **Docs**: §6 of this document becomes `/docs/privacy`, verbatim in spirit.
- Build hygiene against A5/A7: reproducible build, published `dist` hashes, SRI on all scripts,
  IPFS mirror, CSP with no third-party origins; zkey hashes pinned in the client and checked
  before use (today `sync-zk.mjs` copies them, but the browser does not verify).

### 5.2 Keeper (`keeper/`)

New commands in the same process model (`index.ts` loop, pm2 on the VPS):

- `coordinator`: watches `IntentSubmitted` (count, epoch age); decrypts (single-party) or solves
  the DL (threshold); when an epoch is openable, builds C5 proofs (Node snarkjs, ≈ 1–3 s each),
  quotes `minOutHint` from current reserves/pair, submits `openEpoch` through a **private tx RPC**
  (configurable `PRIVATE_TX_RPC`), retries with fresh hints, and calls `voidEpoch` when the grace
  period lapses. Logs *nothing* about plaintext amounts beyond aggregates. Holds `ecSk` in an env
  var on a host separate from the relayer (threshold: holds one share).
- `pool-feed`: writes the sync bundle (§5.1).
- `rewards`: excludes `GrovePool` from eligibility, computes `poolShare`, calls `postRun(…,
  poolShare)`.
- `claims`: pays relayers for claims from `claimBudget` (or simply runs its own relayer for
  claims).
- Existing `sweep`, `buyback`, `rotate`, `feed` unchanged except ABI updates.

### 5.3 Relayer

Move `web/src/app/api/relay/route.ts` to a standalone service (`relayer/`) on a VPS: Vercel
functions log client IPs, cold-start (timing), and cap at 30 s. Keep the quote/submit protocol of
`web/src/lib/relay.ts`; add `action ∈ {transfer, intent, claim, handleClaim}` with per-action
`gasUnits`; nullifier in-flight locks and per-client rate limits as today; **no access logs**;
Tor hidden service; a second operator's relayer listed by default so the team is not the only
choice. Relay policy stays "only `extAmount ≤ 0`" for transfers.

---

## 6. What is still public, and how big the crowd must be

### 6.1 Still public

| # | Public datum | Who | Why it stays public |
|---|---|---|---|
| 1 | Per `(coin, epoch, direction)`: number of private intents, aggregate `B`/`T`/`H`, `tokensOut`, `bnbOut`, clearing price, reserves after | everyone | the curve must move by the aggregate; the price must be auditable |
| 2 | Per epoch: public intents (wallet, amount) | everyone | the user chose the public path |
| 3 | Pool's total ERC20 balance per coin (= all in-pool holdings combined) | everyone | ERC20 `balanceOf(pool)` |
| 4 | Every shield: depositor wallet, asset, amount, time. Every unshield: recipient, asset, amount, time, relayer | everyone | `msg.value` must come from a wallet; a recipient must be named. Mitigated by denominations and by never unshielding what you shielded |
| 5 | Known-amount credits: creator-fee accruals per coin (amount, handle), public-wallet harvests into the pool (wallet, amount, handle), reward claims (wallet, amount), ring/cause payouts (cause, amount). And each later `HandleClaimed(handle, amount)` | everyone | the amount is a public function of public state (volume, roots, snapshot, pot); the *key* is now hidden |
| 6 | Timing of every transaction, relayer addresses, fee amounts | everyone | the chain is public; the relayer is paid on-chain |
| 7 | Coin creation (address, name, symbol, metadata, plant fee), graduation (time, pair, raise) | everyone | the product |
| 8 | Nullifiers, commitments, roots, epoch leaves, ciphertexts | everyone | random-looking; carry no information without keys |
| 9 | Post-graduation: the pool's net swap per epoch on PancakeSwap; any direct wallet trade on PancakeSwap | everyone | AMM is public |
| 10 | **Per-intent amounts (not identities)** | the Epoch Coordinator (zkBNB keeper) in single-party mode | it holds `ecSk`. Removed by threshold mode (phase 3) |
| 11 | Submitter IP, timing, public inputs of each relayed action | the relayer used | network layer. Mitigated by Tor, no logs, independent relayers |
| 12 | Which handle is claimed when (links a credit to a claim, not to a key) | everyone | by construction of handles |
| 13 | Public-wallet holders and their balances | everyone | ERC20 |
| 14 | Coordinator and relayer liveness/behaviour, Safe parameter changes, ceremony transcripts | everyone | governance |

### 6.2 Anonymity-set analysis

**Sender and linkability** do not depend on the crowd. A relayed intent, claim, transfer or
handleClaim exposes no wallet and spends notes whose only on-chain trace is a nullifier that no
one can map back to a commitment without `nk`. The anonymity set of a sender is every note in
the tree (today ~hundreds; eventually millions), minus notes already provably spent. The two
caveats are the pool *edges* (row 4) and timing (§6.3).

**Amounts on the curve** depend on the crowd. An observer learns the sum `S` over the `N` private
intents in `(coin, epoch, dir)`; an adversary who controls `m` of them learns the sum over the
`N − m` honest ones.

| Honest private intents in the epoch (`N − m`) | What is learned about one honest participant's amount | Verdict |
|---|---|---|
| 0 (only public intents) | nothing to hide; everyone is public | — |
| 1 | the amount, exactly (`S` minus known public and adversary amounts) | **public** — sender still hidden |
| 2 | each honest participant learns the other's exactly; outsiders learn `S = a + b` | hidden from outsiders as a split of `S`; not from the co-participant |
| 3–4 | `S` and the count; with a plausible prior over sizes, posterior on any one amount is wide | weak |
| ≥ 5 | `S/N` is a reasonable estimate of the *average*; individual amounts are essentially unrecoverable | **hidden** |
| ≥ 20 | approaches the distribution of the coin's trade sizes | strong |

Expected crowd per epoch, from trading rates: with `T_MAX = 10 min` a coin doing 50 trades/day
averages 0.35 intents per epoch (almost always `N = 1`); 300 trades/day gives ~2; a launch-day
coin at 2,000 trades/day gives ~14, and with the `K = 8` early trigger, epochs close at 8 as soon
as `T_MIN` passes. **Quiet coins give no amount privacy on their own.** This is a property of
any batching scheme and must be said in the UI, which is why intents carry `minCount` and the
wallet defaults to *Private (≥ 3 others)* on coins whose 24 h intent rate is below ~1 per
`T_MAX`; the user chooses to wait, to accept *Fast*, or to be voided and refunded.

**Active sybil.** `minCount` is a defence against passive observers and solitude, not against an
attacker who fills an epoch with `K − 1` dust intents to isolate one victim: cost ≈
`(K − 1) × MIN_INTENT × 2 % fee` + gas ≈ 0.03 BNB per targeted epoch at `MIN_INTENT = 0.005
BNB` (the attacker gets its principal back as tokens or refunds). That is cheap. Raising
`MIN_INTENT` raises it linearly; nothing in the design makes it expensive. Honest statement: on
the curve, the amount guarantee is *k-anonymity among honest participants*; an attacker willing
to pay ~0.03 BNB per epoch can learn the sum of the remaining honest intents. Sender and
linkability guarantees are unaffected by this attack.

**Pool edges.** A shield of 1 BNB followed by an unshield of 1 BNB is unlinkable only among the
other 1-BNB shields that occurred before the unshield and have not been "consumed" by matching
unshields. Rule of thumb (Tornado-style): wait until at least 20–50 same-denomination shields
have happened after yours before unshielding, and never unshield a sum that equals a known
credit (row 5) or a known shield. The UI already steers to 10 denominations
(`denominations.ts`); v2 adds a per-denomination "shields since yours" counter next to the
unshield button.

**Known-amount notes.** A `HandleClaimed(handle, 0.37 BNB)` note that is later spent together
with another note into two hidden outputs is safe; spent alone into an unshield of 0.37 BNB it
is linked. The wallet never selects a single known-amount note as the sole input of an unshield
and warns on subset-sum matches against recent credits.

### 6.3 Timing

| Correlation | Exposure | Mitigation |
|---|---|---|
| intent submitted → epoch open | none beyond epoch membership, which is already public as a count | — |
| epoch open → claim | a claim 30 s after an open is probably from that epoch: the anonymity set collapses from "all epochs" to "that epoch's `N`" (not to one person) | auto-claim at a random delay (1–24 h) or lazily; claims are needed only before the next action on those notes |
| shield → intent | a fresh shield of 1 BNB followed within minutes by an intent on coin X suggests the depositor bought X (amount still hidden if `N ≥ 5`) | wallet suggests waiting; shows "your deposit is 1 of `n` recent 1-BNB shields" |
| unshield → prior epoch | unshield of an amount equal to a plausible pro-rata share | denominations; unshield mixed notes |
| IP ↔ action (relayer) | relayer sees both | Tor, independent relayers, no logs |

---

## 7. Migration from the live chain-56 deployment

Live (deployments/56.json, relaunch 2026-10-06): Launchpad `0x6dF7…95B5`, FeeRouter
`0xd480…1748`, ShieldedPool `0x9fd2…d055`, Verifier `0xF926…2282`, Roots `0x3124…7d93`,
HolderRewards `0x16b5…5B13`, DonationRotator `0xB33b…A580`, FlapBuyback `0x6DEc…7795`, Poseidon
T3 `0x5B17…4eF6`, T4 `0xB1FE…685a`, treasury/Safe `0x4D55…179f`, rootstock $ZKBNB
`0xe3E9…7777` (Flap, external). Nothing is upgradeable; `FeeRouter.setModules` and
`Roots.setHolderRewards` are one-shot, so a v2 launchpad **cannot** register coins with the live
FeeRouter and the live Roots cannot accept a new depositor. Migration is therefore a v2 module
set deployed beside v1, with v1 kept alive for its coins and notes.

**Phase 1 — private trading on top of the live launchpad (no v1 contract touched).**
Deploy Poseidon-reusing `GrovePool v2`, `DarkCurve`, `CurveEngine` (v1 branch only:
`Launchpad v1.buy/sell`, `Roots v1.harvest` — both public functions pay `msg.sender`, which is
the pool), the five verifiers, `BabyJubjub` lib, `MigrationAdapter`. Fees from pool trades flow
through v1's `buy/sell` into the live FeeRouter: the flywheel (roots, FlapBuyback of $ZKBNB,
treasury, deployer share) is untouched. Weaknesses in this phase: the v1 curve is still publicly
tradable, so opens are front-runnable (mitigated by private tx submission); `depositFor`
payouts of v1 modules still leak keys unless users route through the adapter. Users migrate BNB
notes with `MigrationAdapter.migrate(v1Proof, v1ExtData, handle)`: one tx does `v1.transact`
(recipient = adapter) and `pool2.credit{value}(handle)`; relayer-submitted, so no wallet; amount
public once (use denominations). Safe calls `ShieldedPool v1.setMaxDeposit(0)` so no new v1
deposits happen; v1 stays withdraw-only forever.

**Phase 2 — the v2 launchpad.** Deploy FeeRouter v2 (same shares, same treasury,
`setExternalRootstock($ZKBNB, FlapBuyback v2)`), Roots v2, HolderRewards v2, DonationRotator v2
(no rings or causes exist on mainnet yet, so nothing to migrate), Launchpad v2 + GraduationLib;
`CurveEngine` gains the curve branch; `DarkCurve` routes per coin by which launchpad it belongs
to. New coins plant on v2 (batch-only, private plant available). v1 coins stay on v1 (tradable
publicly there and privately through the pool); an optional one-way "adopt" is *not* offered:
moving a coin's curve between launchpads would require moving `realBnb` and tokens out of a
non-upgradeable contract, which v1 cannot do. The web lists both and labels v1 coins "public
curve".

**Phase 3 — threshold Coordinator.** `ecPk` becomes a t-of-n key (3-of-5: keeper + two
independent relayer operators + two community members); `openEpoch` takes `t` share proofs
(C5t) and combines them on-chain (t Baby Jubjub scalar multiplications ≈ 2–3 M gas, or one
combining Groth16 proof). No circuit change for users: C2 encrypts to a point either way.

**Ops**: `deploy.sh` grows a `--v2` module set; `web/src/config/deployments/56.json` gains
`grovePool`, `darkCurve`, `curveEngine`, `launchpadV2`, `feeRouterV2`, … while keeping the v1
keys; keeper gets a second pm2 process for `coordinator` on a different host than the relayer;
`CEREMONY.md` v2 published before any mainnet deposit; `npm run sync` in web/keeper pulls four
zkeys.

---

## 8. Effort estimate by work package

Assumes one senior Solidity/circom engineer plus a reviewer; weeks are engineering weeks, not
elapsed.

| WP | Scope | Est. | Depends on |
|---|---|---|---|
| WP0 | Freeze this design into SPEC v2: constants, tags, ABIs, epoch parameters, UI copy for §6 | 1 w | — |
| WP1 | Circuits C1–C5 (+ C5t spec), `grove-zk.mjs` v2 (multi-asset Utxo, ElGamal, handles, claim witness), fixtures, node tests with real proofs, constraint/size measurements | 5–6 w | WP0 |
| WP2 | `GrovePool`, `DarkCurve`, `CurveEngine` (v1 branch), `BabyJubjub`, `MigrationAdapter`, verifiers; forge unit + fuzz (clearing-price quadratic, rounding, cap/graduation, void paths, minCount) + fork tests against live 56 contracts | 5 w | WP1 (verifiers) |
| WP3 | Launchpad v2 + GraduationLib (size work), FeeRouter v2, Roots/HolderRewards/DonationRotator v2, FlapBuyback v2, deploy scripts | 4 w | WP2 |
| WP4 | Keeper: `coordinator` (decrypt/DL, C5 proving, private tx, voids), `pool-feed` bundle, rewards pool-share; standalone relayer service with Tor, per-action gas table, claim reimbursement | 3 w | WP2 |
| WP5 | Web: key management (generated seed, EIP-712 + passphrase), multi-asset note store, bundle sync, four-zkey worker, intents/claims UI with crowd counter and modes, epochs feed/chart, portfolio + auto-claim, private plant, migration flow, docs/privacy | 5–6 w | WP1, WP2 |
| WP6 | Open MPC ceremony for five circuits (≥ 10 outside contributors each, drand finish, transcripts) | 1 w eng + 2–3 w elapsed | WP1 frozen |
| WP7 | External audit (contracts + circuits) and fixes; internal adversarial review of §2.5 soundness (escrow accounting, ciphertext subtraction on voids, DL bounds) | 2 w eng + 4–6 w elapsed | WP2–WP5 |
| WP8 | Mainnet rollout: phase-1 deploy, v1 `setMaxDeposit(0)`, web promote, keeper/relayer hosts, runbooks, monitoring of epoch opens/voids/claim budget | 1–2 w | WP6, WP7 |
| WP9 | Phase 3 threshold Coordinator (C5t, share combination, key ceremony among operators) | 3 w | WP8 |
| **Total** | | **≈ 30–33 engineering weeks** (≈ 7 months for one engineer, ≈ 4 months for two in parallel on WP1/WP2 vs WP5), plus audit and ceremony elapsed time | |

Order of value: WP1+WP2+WP4+WP5 on top of the live launchpad (phase 1) already delivers hidden
sender and linkability for every launchpad action and aggregate-only amounts; WP3 adds the
MEV-free batch-only curve and private planting; WP9 removes the last single party that sees
per-intent amounts.

---

## Appendix A — open questions for the owner

1. Epoch defaults: `T_MAX = 10 min` is a latency cost every private trader pays on quiet coins.
   Accept, or prefer `T_MAX = 3 min` with weaker crowds?
2. Claims free (treasury-reimbursed) vs. paid from the claimed note: free is better UX and avoids
   a BNB input in C3; it costs the treasury ≈ 0.001 BNB per claim at 1 gwei.
3. In-pool holder rewards through roots (§2.7) vs. not rewarding in-pool holdings at all vs. a
   later eligibility-proof design. Roots is proposed.
4. Should public `buy/sell` on Launchpad v2 exist at all (as public intents) or should v2 be
   pool-only? Public intents are proposed, to keep a no-wallet-setup path.
5. Threshold Coordinator operators: who are the other `n − 1`?

## Appendix B — constants to fix in WP0

`INTENT_TAG`, `HANDLE_TAG`, `OWNER_TAG`, `EPOCH_TAG` (field elements, `keccak("grove-v2/…") mod
p`), `UNIT_BNB = 1e12`, `UNIT_TOKEN = 1e15`, `U_BITS = 40`, `MAX_INTENTS_PER_DIR = 256`,
tree depth 23, zero leaf `keccak("grove-v2") mod p`, root history 100, EIP-712 domain, address
prefix `zkbnb2`, Baby Jubjub generator = circomlib `Base8`.
