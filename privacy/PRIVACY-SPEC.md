# zkBNB privacy launchpad — stage 2 architecture ("Dark Curve")

Status: **authoritative build spec**, 2026-10-05, revised the same day after the adversarial review (every
accepted finding is folded into the text; the rejected ones and the reasons are in the *Review log* at the end). Supersedes `privacy/designs/{attacker,maximal,shippable}.md`
(kept as history). Implementation is driven by `privacy/PRIVACY-WORKPLAN.md`. Where this file and a design
disagree, this file wins; where this file and an implementer's guess disagree, this file wins.

Built against the live code at `99ba0eb` (chain 56 deployment `web/src/config/deployments/56.json`), the
dark-pool stage already landing (`privacy/DARKPOOL-SPEC.md`, `contracts/src/DarkPool.sol`,
`contracts/src/DarkVault.sol`, `web/src/lib/darkpool.ts`, `web/src/app/api/relay`), and the three judge
reports. The chosen architecture is the **attacker** design's phase 1, with these grafts: shippable's unbounded
root history (checkpointed, §2.1), `accRpt` dividend-bearing notes and nested-Poseidon commitment; maximal's result leaf in the same
tree, fixed SELL → HARVEST → BUY order, tiered relayer fees, per-coin `CreatorStub`, delayed claims and honest
anonymity arithmetic; and the judges' required amendments (no Launchpad v2, no roots-routing of in-pool rewards,
no individual-ciphertext voiding, Coordinator-held amount visibility stated plainly, a 2^40 discrete-log bound).

Owner's goal, verbatim: "full full full real privacy, the first real privacy launchpad": hide **amount**,
**sender** and **linkability** for launchpad trading itself, not only for moving BNB.

---

## 0. The design on one page

### 0.1 What ships

1. **A multi-asset shielded pool (`GrovePool`).** Notes carry an `assetId` (0 = BNB, `uint160(coin)` for a
   GroveCoin). Coins live inside the pool as notes; `GrovePool` is the one on-chain holder. Nullifiers are keyed
   by a nullifier key `nk` so a full viewing key exists. Roots are **checkpointed** once per `CHECKPOINT_PERIOD`
   (10 min) and every checkpoint stays valid forever: all proofs made in one window share one root (a root never
   says "the tree had exactly N leaves"), and a proof made now can be submitted hours later. Handles replace
   `depositFor`: a contract or wallet credits a one-shot `handle = Poseidon(HANDLE_TAG, ovk, salt)` and the owner
   later folds the credit into an ordinary private spend, so no receiving key is ever published.

2. **Batch auctions ("epochs") against the live Launchpad.** A private buy, sell or harvest is an *intent*: a
   Groth16 proof that escrows a hidden amount of notes into an intent note and publishes an **exponential-ElGamal
   ciphertext** of that amount (Baby Jubjub, verified in-circuit). Epochs are **per `(coin, direction)`**: `DarkCurve`
   sums the ciphertexts of each direction's current epoch, and a direction opens only when *it* has a crowd (or
   has aged out, with the UI saying so). When a direction is openable the **Epoch Coordinator** solves the
   discrete log of its *summed* ciphertext (never an individual one), proves the decryption with a tiny Groth16
   proof and the contract executes the venue calls in the fixed order SELL → HARVEST → BUY on the live `Launchpad`
   (or the PancakeSwap router after graduation, or `Roots`) as an ordinary account. The 2 % curve fee, the 2 % pair
   tax and the $ZKBNB rootstock buyback are untouched; public trading stays instant. Each participant later
   `claim`s a pro-rata share with a proof that reveals neither the coin, the epoch, the direction nor the amount.
   **The contract stamps the epoch onto the intent leaf**, so an intent proof is never bound to an epoch at proving
   time: a relayer can hold it until enough others have joined the same direction.

3. **Holder rewards without a claim.** The pool is one holder in the keeper's snapshot. After each run the keeper
   pulls the pool's share and bumps `accRpt[coin]`; every coin note carries `rpt0` and the owed BNB surfaces in
   the BNB change of the next private spend. No claim transaction, no per-holder leaf, no amount.

4. **Private planting.** The pool unshields the plant fee to a `Planter`, which deploys a per-coin `CreatorStub`
   that calls `Launchpad.plant` and is therefore the coin's `creator` in the immutable `FeeRouter`. Creator fees
   accrue to the stub, are flushed to the creator's per-coin handle, and `handOver` stays possible through an owner
   proof. The creator's first buy is a BUY intent that the relayer **holds by default** until others have joined
   the coin's first BUY epoch (§2.6.6); alone in epoch 0 it would be a public amount, and the create page says so.

5. **Relayers for everything but a shield, with separation of duties.** The relayer (standalone, no access logs,
   Tor hidden service) sees IPs and public inputs; the Coordinator (different host, different key) sees
   ciphertexts and solves only per-direction sums — but it holds a key that *could* decrypt and link every intent
   until stage 3, so the key is rotated daily and old keys destroyed (§2.7, §6.4); nobody sees both. Claims are
   free to the user and reimbursed from a treasury-funded budget so the fee cannot fingerprint a buy with a refund. Relayer fees
   are quoted in five fixed tiers.

6. **Key hygiene fixes for the live bug.** The live key is `keccak(sign("zkBNB shielded key v1"))`, a
   deterministic signature any dapp can request. Stage 2 keys are a generated 32-byte seed by default, or
   wallet-derived from an EIP-712 typed message *plus* a user passphrase. `Transact` no longer carries
   `msg.sender`; no payout event links a wallet to a leaf; the browser syncs from a keeper-published bundle instead
   of per-wallet `eth_getLogs`, reads epoch state for all coins in one call, and prefetches every proving artifact
   at key creation so no fetch is a per-action signal.

### 0.2 What is rejected, and why (one line each)

- **Pedersen commitments + Bulletproofs**: Groth16 already hides amounts inside Poseidon commitments and
  `Num2Bits` is the range proof; a Bulletproof verifier on the EVM has no precompile and costs millions of gas.
  Where additive homomorphism *is* needed (summing hidden intents) exponential ElGamal is used because the opener
  must *decrypt* the sum, which a Pedersen commitment cannot provide without every user's blinding.
- **Ring signatures**: Merkle membership + nullifier is a ring over the whole tree (2^23 leaves), strictly better
  than a ring of 16.
- **Stealth addresses**: a note commitment with a random blinding already makes repeated payments to one `pk`
  unlinkable on-chain; handles cover the one case where a contract must address a payee without a proof.
- **Moving the curve into the shielded domain**: a curve with hidden reserves has no public price; a curve with
  public reserves reveals each trade's size as a reserve delta; the only way to hide an individual size is to never
  execute an individual size — batch.
- **Launchpad v2 / batch-only public curve** (attacker phase 2): the only path to a sandwich-free public curve, but
  it ends instant public trading and therefore the fee volume that funds the flywheel; it is a separate owner
  decision, out of scope here (§8).
- **Day-one threshold committee** (maximal): a solo operator cannot staff 3-of-5 independent operators at launch
  and an 800k-constraint PoT-20 decrypt circuit is not buildable in the window; stage 3 adds threshold decryption
  with no change to user circuits (§8).
- **Dummy orders**: ~1.15 M gas each, funded by nothing, and they hide the count, not the amount.
- **Per-intent limit prices**: honouring one means excluding an intent from the aggregate, which needs an
  individual decryption and leaks that intent's amount; protection is an epoch-level manipulation band and the
  private-tx open instead (§2.6.6).
- **Internal buy/sell matching at a clearing price** (attacker's quadratic): three plain venue calls are auditable
  by balance deltas and pay the full 2 % on every unit of volume; matching would need Launchpad v2.

### 0.3 Relationship to stage 1 (dark pools)

| Stage-1 piece | Stage 2 |
|---|---|
| `DarkPool.sol`, `DarkVault.sol`, their tests, `DeployDarkPool.s.sol` | **Kept deployed, superseded for new buys.** Vaults hide the wallet but publish amount, coin and timing (DARKPOOL-SPEC §0.1). The UI keeps them as *Instant (amount public)* beside the default *Private batch* until the v1 pool is drained. Existing vaults keep working; their proceeds land in the v1 pool and migrate with `migrateFromV1` (§7). Optional: a `DarkVault` re-pointed at `GrovePool.credit(handle)` (WORKPLAN, WP-contracts item C-opt). |
| `web/src/lib/relay.ts` wire format, `relayPolicy`/`parseRelayRequest` pattern, `kind` discriminator | **Extended** with kinds `transfer`, `plant`, `intent`, `claim`, `v1migrate` and a `hold` option (§5.3). Stage-1 kinds `transact`, `fill`, `vault` keep working against the v1 pool. |
| `web/src/app/api/relay/route.ts` (Vercel) | **Kept for stage-1 kinds only.** Stage-2 kinds go to the standalone relayer (`keeper/src/relayer/`) which the browser calls directly; the Vercel route **refuses** stage-2 kinds (`{ok:false, code:"use-relayer"}`, the UI shows a notice) so IP + public inputs never meet on Vercel infrastructure. |
| `web/src/lib/darkpool.ts` owner-key derivation from the shielded key | **Pattern reused**: `CreatorStub` salt and handle salts derive from the stage-2 key the same way; vault owner keys for *existing* vaults still derive from the legacy v1 key (legacy tab). |
| `useTradeQuote.ts`, `lib/revert.ts`, `ProofProgress`, the `TradePanel` segmented control | **Kept**; the `Wallet \| Dark pool` control becomes `Public \| Private \| Instant`. |
| `DarkPoolPanel.tsx`, dark-vault positions in `MoveBnb.tsx` | **Superseded** by `PrivateTradePanel.tsx` and the `/wallet` holdings view; the old panel stays reachable under *Instant*. |
| `/docs/darkpool` | **Kept**, re-titled "Instant dark pools (stage 1)", linking to `/docs/privacy`. |
| Vault-funded trades | **Become batch-funded**: a buy is an intent escrowed inside the pool, executed as part of the epoch aggregate; nothing is withdrawn to a per-order address. |

User migration cost from stage 1: create or derive the stage-2 key once; v1 notes are best **spent from v1**
(unshield to fresh addresses, shield anew later) — *Migrate* (relayed `migrateFromV1` per denomination into a fresh
one-shot handle each, spread over days, §7) exists for users who cannot. No vault needs to be touched.

---

## 1. Threat model and privacy goals

### 1.1 Adversaries

| # | Adversary | Capabilities |
|---|---|---|
| A1 | Chain analyst | Full chain-56 history, calldata, events, storage, timestamps, balances; clustering heuristics (amount matching, timing, subset-sum); BscScan labels. Passive. |
| A2 | MEV bot / builder | Public mempool and block ordering on BSC (~0.75 s blocks); simulation; sandwiching. |
| A3 | Malicious relayer | Receives proofs; sees IP, user agent, exact submission time and public inputs; can delay or censor; cannot alter anything under `extDataHash`. May collude with A1 or A5. |
| A4 | Malicious creator | Plants a coin; sees all of A1 about its coin; may pre-seed the pair; wants buyer identities and sizes. |
| A5 | zkBNB team | Deploys the web app, runs the keeper, the default relayer and the Coordinator, holds the Safe. Curious; also bound as *compromised*. |
| A6 | RPC provider | Sees every `eth_getLogs` / `eth_call` / `eth_sendRawTransaction` with caller IP and query shape. |
| A7 | Browser / client | Malicious site version, phished wallet, another dapp requesting a key-derivation signature, shared-device storage. |

### 1.2 Goals per action

**H** hidden (not derivable from chain data) · **A** aggregate only (derivable only as part of a per-epoch sum) ·
**P** public by design · **p** public on the public path (a private path exists and is the default).

| Action | Amount | Sender | Linkability | Still public |
|---|---|---|---|---|
| plant (private) | plant fee **P** (constant) | **H** (creator = stub; the pool pays) | **H** (a fresh handle per coin: two coins by one creator are not linked) | coin address, metadata, that it was planted via `Planter` |
| buy on curve | **A** per `(coin, BUY, epoch)` | **H** | **H** while `N ≥ 2` in the epoch (an `N = 1` buy is a public amount, and a later `N = 1` sell of the same lot would link to it — the UI steers away from both) | per-direction intent count, aggregate, clearing price |
| sell on curve | **A** | **H** | **H** | same |
| hold | **H** | **H** | **H** | `balanceOf(GrovePool)` per coin |
| harvest from pool | **A** | **H** | **H** | roots balance, aggregate burn |
| harvest from public wallet into pool | **P** (wallet, amount) | **p** | payout note **H** (handle) | credit amount, handle |
| holder reward (in-pool) | **H** (no tx exists) | **H** | **H** | pool's aggregate share in the keeper JSON |
| holder reward (public wallet) | **P** | **p** | **H** after `credit(handle)` | |
| donation from pool | **H** | **H** | **H** | ring/cause payouts **P** (Rings is an audit log) |
| shield | **P** (steered to denominations) | **P** (wallet pays `msg.value`) | **H** afterwards | the one wallet-signed pool tx |
| unshield | **P** (denomination, enforced) | **H** (relayed) | **H** | recipient, denomination, time, relayer |
| post-graduation trade from pool | **A** | **H** | **H** | aggregate router swap |
| private send | **H** (asset hidden too when BNB; coin revealed when a coin moves, §2.1) | **H** | **H** | |

### 1.3 What each adversary learns after stage 2 (summary; full table §6.1)

A1: per-direction-epoch aggregates, pool edges, known-amount credits, timing, the 10-minute checkpoint window a
proof was made in. A2: nothing inside an epoch; the open tx is submitted privately and the band bounds pre-open
manipulation. A3: IP ↔ public inputs; never amounts, keys or wallets. A4: the aggregates of its own coin; buyer
identities never. A5: as Coordinator, **per-direction sums a few seconds before they are public, and the *ability*
to decrypt and link every intent under the current key until stage 3** (its software never does; keys rotate
daily); as relayer operator, IPs; as web host, Vercel request logs of `/api/rpc` and the artifact bundle, which
carry no coin and no action because reads are batched across all coins and artifacts are prefetched — on
different hosts with no shared logs. A6: that a browser fetched the public bundle, nothing per wallet. A7: a
phishing dapp learns nothing from a signature alone (passphrase-mixed, domain-bound) and nothing at all in
generated-seed mode.

---

## 2. Cryptographic design

Field: BN254 scalar field `p`. Hash: Poseidon (circomlib parameters; on-chain via the Yul `poseidon-solidity`
`PoseidonT3`/`PoseidonT4`, byte-identical outputs to the deployed circomlibjs contracts and a fraction of their
~30 k / 46 k gas per call — a forge test asserts equality against the live bytecode). Curve in circuits: Baby Jubjub (circomlib `babyjub.circom`, generator `Base8`). Proof system:
Groth16 via snarkjs. All constants are in Appendix A and must be byte-identical in `circuits/lib/grove-zk-v2.mjs`
and `contracts/src/libraries/GroveConstants.sol`.

### 2.1 Notes, leaves, tree

```
assetId    0 = BNB · uint160(coin) = a GroveCoin · Poseidon(INTENT_TAG, coin, dir) = an intent note
amount     wei / token base units, < 2^128 (range-checked in every circuit)
rpt0       accRpt[coin] when the note was created; 0 for BNB and intent notes
inner      = PoseidonT4(assetId, rpt0, blinding)
commitment = PoseidonT4(amount, pk, inner)                      // v1 shape, inner in the blinding slot
nullifier  = PoseidonT4(commitment, leafIndex, nk)

leaf kinds (all in ONE incremental tree, depth 23, zero leaf ZERO_LEAF):
  note leaf    = commitment
  intent leaf  = PoseidonT3(commitment, epochKey)                // stamped by the contract at submit
  result leaf  = PoseidonT4(RESULT_TAG, epochKey, totalsHash)    // inserted by the contract at open / void
  epochKey     = PoseidonT4(coin, epoch, dir)                    // dir: 0 BUY, 1 SELL, 2 HARVEST
  totalsHash   = PoseidonT4(totalIn, totalOut, PoseidonT3(totalRefund, rptAtSettle))
```

- Nested Poseidon-3/4 hashes (shippable) so two hashers compute every on-chain hash. Arity separates leaf kinds: a note is a `T4` of `(amount, pk, inner)`, an intent leaf a
  `T3`, a result leaf a `T4` beginning with the constant `RESULT_TAG`; none can be reinterpreted as another.
- **Depth 23**, inserted in **4-leaf chunks**: every transaction inserts exactly one chunk (`_insertChunk(uint256[4])`,
  unused slots = `ZERO_LEAF`): a transfer or intent fills 3 slots, a claim 2, an open 1 per direction. `nextIndex`
  is always a multiple of 4, the tree holds 2^21 ≈ 2.1 M transactions, and a chunk costs 2 + 1 + 21 = 24 Poseidon
  calls instead of 3 × 23. Each extra level costs ~245 constraints per Merkle path.
- **Root history is unbounded but checkpointed.** A root is recorded as known (`mapping(uint256 root => uint32
  indexAfter)`, `isKnownRoot` O(1)) only at **checkpoints**: the root in force at the first insert after each
  `CHECKPOINT_PERIOD` (10 min) boundary, or when anyone calls `checkpoint()` after a boundary with no insert (the
  relayer does, so quiet periods still checkpoint). The tree is append-only and double spends are stopped by
  nullifiers, so an old checkpoint is as safe as the current one; a proof can be submitted hours or days after it
  was made (relayer-held intents). **Why not every root**: each root is produced by exactly one insert, so a root
  in calldata would say "this proof was made when the tree had exactly N leaves" — on today's volume that pins an
  intent to the shield that produced leaf N−3 and a held claim to the open it followed. With checkpoints every
  proof in a window shares one root. Cost: a note becomes spendable at the next checkpoint (≤ 10 min after it
  lands; the wallet shows "spendable in m:ss"), and the window a proof was made in is public at 10-minute
  granularity (§6.1 row 6).
- **Why the contract stamps the epoch.** The intent circuit outputs `commitment` for an intent note whose asset
  is `Poseidon(INTENT_TAG, coin, dir)` and knows nothing about epochs. `DarkCurve.submitIntent` computes
  `epochKey` for `cur[coin][dir]` and inserts `PoseidonT3(commitment, epochKey)`. The claim circuit later proves
  both that stamped leaf and the matching result leaf under one checkpoint root. Consequence: a proof is never
  wasted at an epoch boundary, and "wait for ≥ k others on this side" can live in the relayer (§5.3) with no
  per-intent state or voiding on-chain.
- The coin of a private transfer is public only when a coin note is spent or created (`coin` is a public input
  so the contract can supply `accRpt[coin]`); a BNB-only transfer sets `coin = 0` and reveals nothing. Hiding
  the asset of in-pool coin sends would need a second (asset) tree in two circuits for a rare action; rejected.
- Encrypted output: `abi.encode(uint256 assetId, uint256 amount, uint256 blinding, uint256 rpt0)` (128 bytes),
  x25519 ephemeral + XChaCha20-Poly1305 as today, emitted in `NewCommitment(commitment, index, enc)`. The `index`
  is the leaf's position (needed by the wallet to build paths) and links nothing to a wallet; the stage-1 claim
  "no event carries a leafIndex" is replaced by "no payout event links a wallet to a leaf". Intent notes are encrypted to the
  sender's own key; the wallet recognises them by `assetId == Poseidon(INTENT_TAG, coin, dir)` over the coin list.

### 2.2 Key hierarchy

```
seed       32 random bytes (default, "shielded wallet")           — or wallet-derived (below)
ask        spending key    = keccak256(seed ‖ "zkbnb2/ask") mod p
pk         payment key     = Poseidon(ask)                          // Keypair template unchanged
nk         nullifier key   = Poseidon(ask, 1)
ovk        owner key       = Poseidon(OWNER_TAG, ask)                // identifies a creator / claimant through handles (one definition; §3.1 uses the same)
encPriv    x25519 scalar   = keccak256(seed ‖ "zkbnb2/enc")
address    "zkbnb2" + hex32(pk) + hex32(encPub)                     // same wire shape as zkbnb1
FVK        (pk, nk, encPriv)   sees every incoming note and every spend (recomputes nullifiers); cannot spend
IVK        (pk, encPriv)       sees incoming notes only
handle(n)  = Poseidon(HANDLE_TAG, ovk, salt(n)),  salt(n) = Poseidon(ovk, n),  n = 1, 2, 3, …
           // every handle is one-shot and wallet-enumerated: a fresh n per coin planted, per migration, per
           // expected credit. No salt is special (a creator pot is handle(n) for the n the wallet picked at
           // plant), so two coins by one creator share nothing on-chain. The salt is a private witness: a
           // creator claim and a one-shot claim look the same in calldata.
```

**Wallet-derived mode** (for users who refuse to back up a seed):
`seed = keccak256(sig ‖ keccak256(utf8(passphrase)))` where `sig = signTypedData(domain, ShieldedKey)`,
domain `{name: "zkBNB", version: "2", chainId, verifyingContract: GrovePool}`,
type `ShieldedKey(string purpose)` with `purpose = "Derive my zkBNB shielded key. Only sign this on zkbnbx.com."`.
A dapp that phishes the signature still lacks the passphrase; the domain binds chain and contract. The UI
shows the red warning from §5.1 and defaults to generated-seed mode.

**Why `nk`**: today's nullifier needs the spending key to recognise a spend, so there is no viewing key. With `nk`
the circuit proves `nk == Poseidon(ask, 1)` (one Poseidon per input) and the nullifier never touches `ask`.

### 2.3 Nullifiers and padding

`nf = PoseidonT4(commitment, leafIndex, nk)`, public per spend. In-circuit distinctness via `IsEqual`; the contract
rejects a spent `nf`. Zero-amount padding inputs skip the Merkle check (`ForceEqualIfEnabled`, as v1) and use a
fresh random key so their nullifiers are unique.

### 2.4 Handles replace `depositFor`

```
credit{value}(handle)                    anyone; claimable[handle] += msg.value; emit Credited(handle, amount)
claim                                    inside an ordinary transfer proof: public inputs `handle`, `claimAmount`; private `handleAsk`, `handleSalt`;
                                         the circuit proves handle == Poseidon(HANDLE_TAG, Poseidon(OWNER_TAG, handleAsk), handleSalt) when handle != 0,
                                         and claimAmount == 0 when handle == 0; the contract requires claimAmount ≤ claimable[handle],
                                         subtracts it, and claimAmount enters publicAmount
```

A handle claim is therefore a full 2-in-3-out join-split: the known credit amount is mixed with the user's other
notes in the same proof, and the outputs are hidden. What A1 sees: `Credited(handle, amount)` and later
`HandleClaimed(handle, claimAmount)` on a transaction with two nullifiers and three commitments. The receiving key is
never on-chain. **Why `claimAmount` is a public input and not `claimable[handle]` read at execution**: handles are
public, so anyone could front-run a claim with `credit{value: 1}(handle)` and make a proof bound to the old balance
revert forever (the keeper's `flush` racing a creator's claim would do the same by accident). With `≤` the claim
lands whatever arrives in between, and the remainder stays claimable. Handle credits are BNB-only in stage 2 (creator fees, public harvests, reward claims, ring
payouts, v1 migration are all BNB).

### 2.5 Dividend-bearing coin notes (holder rewards)

```
accRpt[coin]            wei of BNB per 1e18 token units, 1e18-scaled; monotone
knownAccRpt[coin][v]    every value accRpt[coin] ever took (one SSTORE per pull) — proofs made against an older
                        value stay valid; the new coin outputs carry rpt0 = that older value and keep accruing
pullRewards(coin, runId, amount, proof)   anyone (the keeper): HolderRewards.claim as the pool, then
                                          accRpt[coin] += amount × 1e18 / IERC20(coin).balanceOf(pool)
owed_i = floor(inAmount_i × (accRpt − rpt0_i) / 1e18)     settled into the BNB side of every spend of a coin note
```

The keeper lists `GrovePool` as an ordinary holder (removes it from `EXCLUDE_ADDRESSES`, keeps `DarkCurve` and
`Planter` excluded). `accRpt` checks are membership checks — `knownAccRpt[coin][s.accRpt]` — never equality with the
current value, so a relayer-held intent survives a `pullRewards` in between. Claims from epochs stamp `rpt0 = rptAtSettle` (recorded in the result leaf), so there is no
rush to claim and nothing accrues to the wrong note. Solvency: `Σ unspent coin amounts + escrow + unclaimed ≤
balanceOf(pool)` and floor division ⇒ total owed ≤ total pulled; dust stays in the pool.

### 2.6 Private trading against the live curve

#### 2.6.1 Epochs

```
EpochParams (Safe-settable within hard bounds)
  T_MIN       = 60 s      [30 s .. 10 min]    a direction's epoch may not be opened before this age
  T_MAX       = 5 min     [2 min .. 30 min]   after this age it may be opened at any count (the UI warns when N < 2)
  K           = 5                              intents in ONE direction that make that direction openable at T_MIN
  GRACE       = 30 min    [10 min .. 24 h]     after T_MAX + GRACE anyone may void an unopened direction epoch
  BAND_BPS    = 1000      [200 .. 2500]        directional manipulation band at open (§2.6.3)
  BAND_FLOOR  = 0.5 BNB   [0.1 .. 5 BNB]       the band never bites below this move of the curve's virtual BNB reserve
  CLAIM_GAS   = measured  [300 k .. 3 M]       gas units reimbursed per claim (§2.6.5); set from forge gas logs, never frozen here
  MAX_INTENTS = 256 per (coin, dir, epoch)     keeps Σu < 2^40
Constants (in circuit / GroveConstants)
  UNIT_BNB    = 1e13 wei (0.00001 BNB)   UNIT_TOKEN = 1e18 (one token)
  U_BITS      = 32                        max intent 42,949 BNB or 4.29 B tokens
  MIN_U_BNB   = 5_000 (0.05 BNB)          MIN_U_TOKEN = 50_000 tokens      dust floor (sybil cost, §6.2)
  INTENT_FEE  = 0.002 BNB                 flat anti-sybil fee per intent, paid from the pool's BNB to the treasury
  CHECKPOINT_PERIOD = 600 s               root checkpoints (§2.1)
```

An epoch is per **coin and direction**: `epoch = (coin, dir, seq)`, `seq = cur[coin][dir]`. It *starts* at its first
intent (`startedAt`, `refPrice = spot(coin)`, `refVb` = the curve's virtual BNB reserve, or the pair's WBNB reserve
after graduation). It is openable when `age ≥ T_MIN && count ≥ K`, or `age ≥ T_MAX`. After an open or a void
`cur[coin][dir]++`. Per epoch the contract keeps `count` and the ElGamal sum `(C1, C2)` as two Baby Jubjub points in
extended coordinates.

**Why per direction.** A crowd counted across directions is a lie for the minority side: seven buyers and one
seller make a "crowd of eight" in which the seller's amount is exact, and an `N = 1` buy followed later by an
`N = 1` sell of `floor(tokensOut / 1e18)` tokens reconstructs a whole position (entry, exit, holding period, P&L)
from events alone. Counting, opening and the relayer's hold knob (§5.3) are therefore all per direction, the UI
shows the per-direction crowd, never offers *sell all* / *harvest all* in Private mode, and warns when a private
sell or harvest size equals the output of any earlier `N = 1` epoch of that coin (the wallet checks against
`EpochOpened`). A direction that is still below `K` at `T_MAX` opens anyway (liveness), with the honest sentence
shown before the user submits.

#### 2.6.2 The intent

A BUY spends BNB notes; a SELL or HARVEST spends coin notes plus BNB for the fees. The proof
(`intent.circom`, §3.2) is a 2-in-3-out join-split with:

```
out[0]  intent note: asset = Poseidon(INTENT_TAG, coin, dir), amount = u · UNIT(dir), rpt0 = 0
out[1]  change in the traded asset (may be zero-amount)
out[2]  BNB change: fee change + dividends owed on spent coin notes (may be zero-amount)
C1 = k·B8,  C2 = u·B8 + k·ecPk           exponential ElGamal of u under the Coordinator key
k  = keccak256("zkbnb2/elgamal" ‖ ask ‖ inputNullifier[0]) mod l      deterministic and unique per intent
```

`k` is derived, not drawn: nullifiers are unique, so two intents can never share `k` even with a broken RNG
(reuse would publish `u_a − u_b` to anyone with the BSGS table). The derivation is a client rule, not a circuit
constraint (`k` stays a private witness); the contract additionally rejects any `C1` it has already seen
(`seenC1`, one SSTORE), so a reuse can never land.

`IntentExt = { relayer, fee, encryptedOutputs[3] }` is hashed into `extDataHash`.
`publicAmount = −(fee + INTENT_FEE) mod p`. What `DarkCurve.submitIntent` checks and does:

1. `coin` is a Launchpad coin (`launchpad.info(coin).creator != 0`; there is no `isCoin` view on the live
   Launchpad); `dir ∈ {0,1,2}`; `ecPk` is the active Coordinator key (or the next one during a rotation overlap)
   and equals the key recorded for the direction's current epoch if it already has intents;
   `count[coin][dir][cur] < MAX_INTENTS`; `knownAccRpt[coin][s.accRpt]`; `!seenC1[c1.x]`.
2. Root is a known checkpoint, nullifiers unspent and distinct, `extDataHash` matches, `fee > 0 ⇒ relayer ≠ 0`,
   Groth16 verify.
3. If this is the direction's first intent: `startedAt = now`, `refPrice = spot(coin)`, `refVb`, `keyId`.
4. Mark nullifiers; `seenC1[c1.x] = true`; insert the chunk `[PoseidonT3(out[0], epochKey(coin, dir, cur)),
   out[1], out[2], ZERO_LEAF]`; `count++`; `sum += (C1, C2)` (two extended-coordinate adds); pay the relayer `fee`
   and the treasury `INTENT_FEE` from the pool's BNB.
5. Emit `IntentSubmitted(coin, dir, seq, count, intentLeaf)` and the three `NewCommitment`s.

The escrow is purely accounting: the pool owes `u·UNIT` to the intent note instead of to the spent notes.

#### 2.6.3 The open

When a direction is openable, the Coordinator (keeper command, §5.2) recovers its plaintext sum by solving a
≤ 2^40 discrete log on the **summed** ciphertext (BSGS, §2.7) — it never decrypts an individual intent, in stage 2
or stage 3 — proves it with `epochOpen.circom` and calls

```
openEpoch(address coin, uint8 dirMask, uint32[3] seq, uint256[3] u, Proof[3] proofs, uint256[3] minOut)
```

for every openable direction of the coin at once when it can (so sells still execute before buys), or a subset:

1. For each `dir` in `dirMask`: `seq[dir] == cur[coin][dir]`, the epoch is collecting with `count > 0` and
   openable; verify `proofs[dir]` against the stored `(C1, C2)` normalised to affine, the epoch's `ecPk`, `u[dir]`.
2. **Directional band**, per included direction, against that direction's own `refPrice` / `refVb`
   (`vB = VIRTUAL_BNB + info(coin).realBnb` on the curve; the pair's WBNB reserve after graduation):
   - BUY is blocked when `spot > refPrice·(1 + BAND_BPS/1e4)` **and** `vB − refVb > BAND_FLOOR` (a pump before the
     batch buys);
   - SELL is blocked when `spot < refPrice·(1 − BAND_BPS/1e4)` **and** `refVb − vB > BAND_FLOOR` (a dump before the
     batch sells);
   - HARVEST is never band-gated (its payout is the roots ratio, not spot).
   A blocked direction reverts `BandExceeded(dir)`; the Coordinator re-submits without it, and it voids after
   `T_MAX + GRACE` if the move persists. `BAND_FLOOR` exists because price ∝ vB² on the curve: 10 % of price is
   0.195 BNB of net buying on a fresh coin, which honest launch-day flow does in a minute — the band is for pumps,
   not a liveness gate, and a 0.2 BNB public buy must not be able to void every private batch of a young coin.
3. `T = u[SELL]·UNIT_TOKEN`, `H = u[HARVEST]·UNIT_TOKEN`, `B = u[BUY]·UNIT_BNB`. Execute the included directions in
   this order:
   - **SELL**: `pool.moveOut(coin, T, this)`; curve: `approve; launchpad.sell(coin, T, minOut[1])`; graduated:
     `router.swapExactTokensForETHSupportingFeeOnTransferTokens(T, minOut[1], [coin, WBNB], this, now)`;
     `bnbOutSell` = balance delta; forward to the pool.
   - **HARVEST**: `pool.moveOut(coin, H, this)`; `approve(roots); roots.harvest(coin, H, minOut[2])` (burns from
     `DarkCurve`, pays `DarkCurve`); forward `bnbOutHarvest` to the pool.
   - **BUY**: `pool.moveOut(0, B, this)`; curve: `launchpad.buy{value: B}(coin, minOut[0])` (the curve may complete
     and graduate inside this call; the Launchpad refunds `B − used` to `DarkCurve`); graduated:
     `router.swapExactETHForTokensSupportingFeeOnTransferTokens{value: B}(minOut[0], [WBNB, coin], this, now)`;
     `tokensOut` = token balance delta, `refund = B − used`; forward tokens and refund to the pool.
4. `rptAtSettle = pool.accRpt(coin)`. Insert one chunk holding the result leaf of each included direction:
   BUY `(B, tokensOut, refund, rptAtSettle)`, SELL `(T, bnbOutSell, 0, rptAtSettle)`,
   HARVEST `(H, bnbOutHarvest, 0, rptAtSettle)`.
5. For each included direction: `cur[coin][dir]++`; emit
   `EpochOpened(coin, dir, seq, u, totalIn, totalOut, refund, spotAfter, rptAtSettle)`.

If a venue call of an included direction reverts (slippage, `Roots.Dust`, `ZeroAmount`, graduated between quote and
now) the whole call reverts and the Coordinator retries next block with fresh `minOut` — and, if it keeps failing,
without that direction, so one failing side never blocks the others. If no open lands for a direction before
`startedAt + T_MAX + GRACE`, **anyone** calls `voidEpoch(coin, dir, seq)`: result leaf `(1, 0, 1, accRpt[coin])`,
`cur[coin][dir]++`, `EpochVoided(coin, dir, seq)`. Every claim then refunds 100 % in the escrowed asset. The
Coordinator is a liveness dependency only.

#### 2.6.4 Price

Each direction gets one uniform average price: buyers `tokensOut / used`, sellers `bnbOutSell / T`, harvesters
`bnbOutHarvest / H`. Sells execute before buys (constant order, and the Coordinator opens every openable direction
of a coin in one call whenever it can), so buyers get the post-sell price and sellers are never sandwiched by
same-epoch buyers. Fees are exactly the live Launchpad's (2 % on gross per side) and the
pair tax after graduation; the FeeRouter sees `Trade.trader = DarkCurve`.

#### 2.6.5 The claim

```
claim(Proof p, ClaimPublic s, ClaimExt e)      s = { root, nullifier, outputCommitments[2], extDataHash }
                                                e = { relayer, encryptedOutputs[2] }
circuit (claim.circom): I own an intent note (coin, dir, a, blinding) stamped into epoch `epoch` and the
  result leaf for (coin, dir, epoch) exists under `root`; outputs:
  out[0] = (dir==BUY ? coin : 0,  floor(a·totalOut/totalIn),     pk', b0, rpt0 = isBuy·rptAtSettle)
  out[1] = (dir==BUY ? 0 : coin,  floor(a·totalRefund/totalIn),  pk', b1, rpt0 = (1−isBuy)·rptAtSettle)
```

A claim is provable once the result leaf is inside a checkpoint (≤ 10 min after the open). The contract checks
root, unspent `nf`, `extDataHash`, verifies, marks `nf`, inserts one chunk with the two leaves, and **reimburses the
relayer** `min(claimGas × tx.gasprice, claimGas × maxReimburseGasPrice)` from `claimBudget` (treasury-funded via
`fundClaimBudget()`; if the budget is empty the claim still succeeds and the relayer is not paid, so claims are never
blocked). `params.claimGas` is set by the Safe from the measured cost (forge gas log at integration, bounds
`[300 k .. 3 M]`) and is deliberately not a constant in this file: a reimbursement at a third of the real cost would
mean no relayer carries free claims. No fee input means the fee cannot reveal which claims are buys with refunds;
every claim consumes a real intent nullifier, so the budget cannot be drained faster than intents are paid for.
Voided epochs use the same circuit and the same path: the result leaf `(1, 0, 1, rpt)` makes `out[1] = a` in the
escrowed asset and `out[0] = 0`. What A1 sees in a claim: one nullifier, two commitments, a relayer, the checkpoint
window the proof was made in. Not the coin, epoch, direction or amount.

Timing is the side channel (§6.3). The mitigation is **lazy proving**: the wallet proves a claim at the moment it
submits it, never earlier — on *Claim now*, or on the user's next visit after a per-claim random delay (default
uniform in 1–24 h after the open, stored locally), or from a Service Worker job at that time when the browser
allows it. The relayer does **not** hold claims: a claim proved right after the open and parked for hours would
carry the open's checkpoint window in its root, and an old root on a fresh transaction would mark its sender as
a "delayed-claim" user. Claims are submitted through the default shared relayer regardless of which relayer carried
the intent (any relayer may carry a claim; it is fee-less).

#### 2.6.6 Slippage and MEV, honestly

- **Inside an epoch** there is no ordering, so nothing to sandwich; every participant gets the same price.
- **Before the open** the public curve is still tradable (the live Launchpad is untouched). Hidden amounts mean a
  bot cannot size a position; the directional band (§2.6.3) blocks a BUY batch after a pump and a SELL batch after a
  dump beyond `BAND_FLOOR` (the manipulator is left holding the move; the other side still executes; the blocked
  side is refunded if the move persists); the Coordinator submits `openEpoch` through a private-transaction RPC
  (`PRIVATE_TX_RPC`, 48 Club / bloXroute) so the open itself is not in the public mempool.
- **The batch's own impact** is not bounded per user: a per-intent limit would require excluding an intent from
  the aggregate, which needs an individual decryption and leaks that intent (judge 0's objection to `minCount`).
  The UI shows the price the epoch would clear at if it were as large as the 95th percentile of the coin's last 50
  epochs, and Private mode lets the user wait for a crowd (§5.3).
- **Launch sniping**: a privately planted coin's first buy is a BUY intent in the coin's BUY epoch 0 — but at plant
  time nobody else knows the coin exists, so alone it would be an `N = 1` public amount attributable to the creator
  (plant and first intent arrive seconds apart). Default: the first buy is a **held** intent (`hold = { minOthers: 2,
  submitByEpochEnd: false }`), released only when two others have joined BUY, proved against the current
  checkpoint like any intent; the create page prints *"Your first buy is private only if others buy in the same
  epoch. Alone it is a public amount. You can also skip it and buy later."* The creator cannot be first inside a
  batch. Public snipers can still hit the public curve — that is the trade-off of keeping the live Launchpad.

#### 2.6.7 Failure and refund paths

| Situation | Who acts | Participant outcome |
|---|---|---|
| Normal open | Coordinator | `claim` → pro-rata tokens / BNB |
| Curve completes mid-batch | Launchpad inside `buy` | `claim` → tokens at the capped amount + BNB refund share; coin graduates |
| Venue reverts (slippage, graduated, Dust, ZeroAmount) | Coordinator retries, then opens the other directions without this one; after `T_MAX + GRACE` anyone voids it | the other directions settle; this one refunds 100 % via `claim` |
| Band exceeded persistently (one direction) | same | that direction refunds 100 %; the other side executes |
| Coordinator offline / key lost | anyone `voidEpoch` per direction | 100 % refund |
| Relayer refuses | user picks another relayer (relayers.json, with the pseudonym warning of §2.10) or self-submits (reveals a wallet) | — |
| Tree near full | contract | `submitIntent` reverts; `transact` keeps paying out with `CommitmentDropped` (withdraw-only), as v1 |
| Note just landed | wallet | spendable at the next checkpoint (≤ 10 min); the wallet shows the countdown |
| Stale root | impossible: every checkpoint stays known | — |

No path lets the Safe, the Coordinator or a relayer take or freeze escrowed funds.

### 2.7 ElGamal flow encryption — exact scheme

Baby Jubjub twisted Edwards `a = 168700`, `d = 168696`, subgroup order `l ≈ 2^251`, generator `B8` (circomlib
`Base8`, Appendix A). Coordinator key `ecPk = ecSk·B8`.

```
u      = amount / UNIT(dir), exact, u < 2^32, u ≥ MIN_U(dir)           (in circuit)
k      = keccak256("zkbnb2/elgamal" ‖ ask ‖ inputNullifier[0]) mod l   (client rule; in circuit: Num2Bits(251))
C1     = k·B8                     EscalarMulFix
C2     = u·B8 + k·ecPk            EscalarMulFix(32-bit) + EscalarMulAny + BabyAdd
sum    Σ_i (C1_i, C2_i) encrypts Σ u_i  <  256 · 2^32  =  2^40
decrypt M = C2 − ecSk·C1 = (Σu)·B8  →  BSGS on the SUM only
```

**BSGS, honestly sized.** With circomlibjs point addition at ~37 µs (measured in this repo), a 2^20 baby-step table
needs up to 2^20 giant steps for a 2^40 range: ~40 s worst case per direction in Node, not milliseconds. The
Coordinator therefore uses a **2^24 table of 8-byte truncated x-coordinates** (128 MB, built once, persisted to
`snapshots/bsgs-24.bin`, collisions resolved by a full recomputation of the candidate): ≤ 2^16 giant steps ≈ 2.4 s
worst case per direction, ~1.2 s average, well inside `T_MAX`. A Rust/WASM point adder (sub-µs) is the upgrade if
opens ever queue; the circuits do not change.

**Sum-only decryption.** The Coordinator software decrypts the *summed* ciphertext and never an individual one, in
stage 2 as in stage 3 — so the per-intent knowledge the first draft conceded ("per-intent amounts, never
identities") does not exist in the running system. What remains is *ability*: the operator holds `ecSk` and could
decrypt and **link** every intent under that key (a payout `floor(u·UNIT·totalOut/totalIn)` matched to a later
whole-token sell, chaining intents into positions), and the per-intent ciphertexts live in calldata forever, so a
future key compromise, compelled disclosure or careless handover would decrypt them retroactively. The trust
statement (§6.4) says so, and the exposure is bounded by rotation.

Decision versus the designs: maximal's two 28-bit limbs and attacker's single 48-bit limb both give a 2^40 sum
bound only with extra constraints or a 2^24 BSGS; a single 32-bit limb with a 256-intent cap gives the same 2^40
bound, half the ElGamal constraints, and a granularity (0.00001 BNB, one token) finer than any denomination.

On-chain addition: extended twisted-Edwards coordinates `(X, Y, T, Z)`, no inversion, ≈ 1.5 k gas per add;
`openEpoch` normalises to affine with one `modexp` inverse. `BabyJubjub.sol` is an `internal` library (inlined; it
has no address of its own and is not recorded in the deployment JSON). Fixtures store sums as affine `(x, y)`; the
contract test normalises its extended sum with `toAffine` before comparing.

**Key rotation and destruction**: `setCoordinatorKey(newPk, switchAt)` (Safe) is called **daily** by the
Coordinator's operator procedure (`keeper/README.md`, "Coordinator key rotation", attested in `HANDOFF.md`).
Intents are accepted under the old key until `switchAt` and under the new key from `switchAt − OVERLAP (10 min)`;
an epoch sums only ciphertexts under one key (the contract records `keyId` at its first intent and rejects the
other). The Coordinator **destroys an old `ecSk`** (overwrites the file, logs the event with the key's public
point) as soon as the last epoch under it is opened or voided, which is at most `T_MAX + GRACE` after `switchAt`.
Retroactive exposure is therefore bounded to one rotation window (~1 day of intents) at any moment. Stage 3
replaces `ecPk` with a committee key; user circuits are unchanged (they encrypt to a point either way).

### 2.8 Private planting and creator income

```
transact(proof, s, e) with e.recipient == planter, e.extAmountBnb == −launchpad.plantFee(), e.payload = abi.encode(ACTION_PLANT, PlantParams p, uint256 creatorHandle)
  the plant amount is EXEMPT from the unshield denominations (it is a public constant: 0.005 BNB live, below the smallest denomination;
  `plantFee` is Safe-settable, so the pool reads it at execution and requires equality — anything else reverts BadPlantValue)
  creatorHandle = handle(n) for a fresh wallet-enumerated n; the wallet records n ↔ coin when PlantedPrivately lands
  pool → planter.plantFor{value: plantFee}(payload)
  planter: stub = new CreatorStub{salt: keccak(creatorHandle, stubNonce++)}(planter, pool, launchpad, feeRouter, creatorHandle)
           coin = stub.plant{value}(p)          // stub calls launchpad.plant: creator = stub, msg.value == plantFee, no first buy
           stubOf[coin] = stub; stub.bind(coin)
  p.payoutMode may be Creator (default; stub receives the deployer share and can hand over later), Holders or Donate.
  Wallet mode is refused (it would name a public wallet at plant; use handOver later).
stub.flush()           anyone: feeRouter.withdrawPending() if pending > 0, then pool.credit{value: balance}(handle)
                       (FeeRouter._push gives 50 k gas and no coin id; the stub's receive() just accepts)
handOver               a zero-value transfer proof with s.handle == stub.handle, s.claimAmount == 0 and e.payload = abi.encode(ACTION_HANDOVER, coin, mode, wallet, ringId);
                       pool → planter.handOver(coin, handle, mode, wallet, ringId) → stub.handOver → feeRouter.handOver(coin, …)
```

Payloads are dispatched on their first word (`ACTION_PLANT = 2`, `ACTION_HANDOVER = 1`); a plant payload can never
fall into the hand-over branch, and a hand-over requires `e.recipient != planter`. `Planted(coin, creator = stub, …)`
is public; the creator's key never appears, and `PlantedPrivately(coin, stub, handle)` publishes a handle that is
used for this coin only, so a creator's coins are not linkable through it. The first buy is a **held** BUY intent
(§2.6.6) that the UI pre-fills for the coin's BUY epoch 0 and that the user may skip. Creator income:
`FeeSplit.toDeployer` is public per coin (it is today); the handle's claims are known-amount credits (§6.1 row 5).

### 2.9 Harvest, rewards, donations

- **Harvest from the pool**: a HARVEST intent; the batch burns `H` through `Roots.harvest` and participants claim
  BNB pro-rata. **From a public wallet**: `Planter.harvestToHandle(coin, tokens, minBnb, handle)` (transferFrom,
  harvest, `credit(handle)`): wallet and amount public, destination key hidden. `Roots.harvestShielded` (v1 pool)
  is no longer offered by the UI.
- **Holder rewards**: §2.5. Public holders keep claiming as today; `claimShielded` into v1 is no longer offered;
  a public holder who wants rewards in the pool claims to the wallet and `credit`s a handle (two txs).
- **Donations**: private donations are pool transfers to a cause's `zkbnb2` address (asset hidden). Ring
  settlements still pay the live `DonationRotator`'s causes into the **v1** pool (immutable `pool`), as do
  `Roots.harvestShielded` and `HolderRewards.claimShielded` for anyone who still calls them: these v1 endpoints
  publish `pubKey + amount` in `DepositFor` **by contract design** and cannot be changed without redeploying
  `Roots`/`HolderRewards`/`DonationRotator`. The UI no longer offers them, `/docs/privacy` says they are public,
  and successors that `credit(handle)` instead of `depositFor` are planned for the next deployable cycle (§8).
  Causes keep spending from v1 or migrate (§7). Rings is an audit log by design.

### 2.10 Relayer economics and roles

- **Fee**: quoted before proving as the smallest tier ≥ `gasPrice × gasUnits(kind) × 1.2 + flat`, tiers
  `FEE_TIERS = {0.0002, 0.0005, 0.001, 0.002, 0.005} BNB`, bound in `extDataHash`, paid from the pool's BNB.
  `gasUnits(kind)` for `transfer`, `plant`, `intent`, `v1migrate` are **not frozen in this file**: the relayer loads
  them from `contracts/gas-v2.json`, written from `forge test` gas logs at integration (WP §6 step 2), and
  `feeCovers` is evaluated against those units. `plant` is its own kind (detected by `recipient == planter`): the
  call deploys a GroveCoin inside `transact → Planter → CreatorStub → Launchpad.plant` and costs several million
  gas more than a transfer. Claims: 0 (reimbursed on-chain, §2.6.5). The first draft's figures (transfer 1.0 M,
  intent 1.4 M) assumed ~10 k gas per on-chain Poseidon; the circomlibjs contracts cost ~30 k / 46 k, which is why
  §2.1 moves to Yul hashers and chunk inserts and why every gas figure in §4 is marked as an estimate to measure.
  Intents additionally pay `INTENT_FEE` to the treasury (§2.6.1).
- **Any relayer**: contracts are relayer-agnostic; `web/public/relayers.json` lists the default and a second
  operator; "use my own relayer" is a field. A registry with stake is a later convenience, not a trust anchor.
  **A non-default relayer is a pseudonym**: `relayer` is public in every intent, claim, transfer and unshield, so a
  rare relayer (or your own) clusters all of your actions into one actor, and a self-run relayer wallet funded
  from an exchange account names you. The UI defaults to the shared relayer for everything, prints this warning
  when another is chosen, and always sends claims through the default relayer (§2.6.5).
- **What a relayer learns**: IP, UA, time, public inputs (coin, dir, ciphertext, nullifiers, commitments), and
  the `hold` preference. Not the amount, the key or the wallet. It can decline or delay, never redirect.
- **Separation of duties**: relayer and Coordinator run on different hosts under different keys with no shared
  logs; the relayer keeps no access logs and offers a Tor hidden service. Shields are never relayed. The Vercel
  app never proxies stage-2 kinds (§0.3), so the web host sees neither IPs-with-public-inputs nor held intents.

---

## 3. Circuits

circom 2.1, Groth16/BN254, snarkjs 0.7, Poseidon from circomlib. Measured baseline: `transaction.circom`
26,982 constraints (12,888 non-linear), zkey 11.9 MB, browser proving 10–40 s (`web/src/lib/relay.ts`). Estimates
below use ~245 constraints per Poseidon(2), ~290 per Poseidon(3), ~2.7 k per 253-bit `EscalarMulFix`, ~7 k per
`EscalarMulAny`, ~440 B of zkey per constraint, and 1.2 s per 1 k constraints in the current worker. Every count
below is an estimate that WP-circuits must measure and record in `circuits/build/setup-v2.log`; the hard limit is
PoT 16 (65,536 constraints) for every circuit. Faithful sketches compiled during the review measured intent
41,566, claim 33,563 (after the quadratic fix in §3.3) and epochOpen 7,054 total constraints at the default `−O1`,
so PoT 16 holds; compile with `−O2` before the ceremony (the last moment the constraint system can change) to
shrink zkeys and proving time. Shared templates: `keypair.circom` (+ `NullifierKey`),
`merkleProof.circom` (unchanged), new `note.circom` (nested commitment), `elgamal.circom`.

| # | Circuit | Public inputs | Est. constraints | Browser | zkey | PoT |
|---|---|---|---|---|---|---|
| C1 | `transfer.circom` `Transfer(23, 2, 3)` | 13 (`handleSalt` private, `claimAmount` public) | ≈ 18 k non-linear / 36 k total | 15–45 s | ≈ 16 MB | 16 |
| C2 | `intent.circom` `Intent(23)` | 17 | ≈ 27 k / 50 k | 20–65 s | ≈ 22 MB | 16 |
| C3 | `claim.circom` `Claim(23)` | 5 | ≈ 16 k / 30 k | 12–38 s | ≈ 13 MB | 16 |
| C5 | `epochOpen.circom` | 7 | ≈ 11 k | Node 1–3 s (snarkjs) | ≈ 5 MB | 16 (one ptau for all) |
| C5t | `epochOpenShare.circom` (stage 3, spec only) | 6 | ≈ 9 k | n/a | — | 16 |

Three browser zkeys (~51 MB) and one node-side zkey. The browser **prefetches all three sets at key creation and
re-validates them on every visit** (Service Worker + CacheStorage keyed by the pinned sha256): a 22 MB zkey pulled
from the site origin seconds before an intent lands would tell the web host which action a browser was about to
take, so no artifact is ever fetched on demand. There is no separate handle circuit: the handle claim is folded
into C1 (§2.4).

### 3.1 `transfer.circom`

```
public  (13, in this order):
  root, publicAmount, coin, publicAmountCoin, accRpt, handle, claimAmount, extDataHash,
  inputNullifier[0], inputNullifier[1], outputCommitment[0], outputCommitment[1], outputCommitment[2]
private:
  per input i∈{0,1}: inAsset, inAmount, inRpt0, inBlinding, inAsk, inPathIndices, inPathElements[23], inQ, inR
  per output j∈{0,1,2}: outAsset, outAmount, outPubkey, outBlinding            (outRpt0 is derived, not an input)
  handleAsk, handleSalt
constraints:
  per input:  pk = Poseidon(inAsk); nk = Poseidon(inAsk, 1); inner = Poseidon(inAsset, inRpt0, inBlinding);
              c = Poseidon(inAmount, pk, inner); inputNullifier == Poseidon(c, inPathIndices, nk);
              Merkle(c) == root iff inAmount != 0;  inAsset·(inAsset − coin) == 0;  isCoin = 1 − IsZero(inAsset)
              delta = accRpt − inRpt0, Num2Bits(128)(delta);  inAmount·delta == inQ·1e18 + inR;  inR < 1e18;  Num2Bits(128)(inQ)
              owed = isCoin · inQ
  per output: outAsset·(outAsset − coin) == 0;  isCoinOut = 1 − IsZero(outAsset);  outRpt0 = isCoinOut·accRpt
              outputCommitment == Poseidon(outAmount, outPubkey, Poseidon(outAsset, outRpt0, outBlinding));  Num2Bits(128)(outAmount)
  handle:     ovk = Poseidon(OWNER_TAG, handleAsk);  ForceEqualIfEnabled(handle, Poseidon(HANDLE_TAG, ovk, handleSalt), enabled = handle)
              IsZero(handle) · claimAmount == 0;  Num2Bits(128)(claimAmount)
  balance:    Σ_i (1−isCoin_i)·inAmount_i + Σ_i owed_i + publicAmount  ==  Σ_j (1−isCoinOut_j)·outAmount_j        (mod p)
              Σ_i isCoin_i·inAmount_i + publicAmountCoin               ==  Σ_j isCoinOut_j·outAmount_j             (mod p)
  nullifiers distinct;  extDataHash·extDataHash (binding)
```

`claimAmount` is part of `publicAmount` (contract-side below); it is a separate public signal only so the contract
can check `claimAmount ≤ claimable[handle]` and subtract exactly it (§2.4). `handleSalt` is private: a creator
claim and a one-shot claim are indistinguishable in calldata, and the salt scheme (§2.2) is a wallet convention
the circuit never sees.

Contract-side meanings: `publicAmount = field(extAmountBnb − fee + claimAmount)`,
`publicAmountCoin = field(extAmountCoin)`, `coin = uint160(e.coin)` (0 when no coin is involved; then
`publicAmountCoin` must be 0 and `accRpt` must be 0), `accRpt ∈ knownAccRpt[coin]`, `claimAmount ≤ claimable[handle]`.

### 3.2 `intent.circom`

```
public  (17, in this order):
  root, publicAmount, coin, accRpt, dir, ecPk[0], ecPk[1], C1[0], C1[1], C2[0], C2[1], extDataHash,
  inputNullifier[0], inputNullifier[1], outputCommitment[0], outputCommitment[1], outputCommitment[2]
private: as C1 (inputs with dividends; outputs 1 and 2 as in C1), plus u, k, out0Pubkey, out0Blinding
constraints (beyond C1's input, output-1/2, nullifier and binding rules; no handle; coin != 0 enforced by the contract):
  dir·(dir−1)·(dir−2) == 0;  isBuy = IsZero(dir)
  unit = UNIT_BNB + (1 − isBuy)·(UNIT_TOKEN − UNIT_BNB);  minU = MIN_U_BNB + (1 − isBuy)·(MIN_U_TOKEN − MIN_U_BNB)
  Num2Bits(32)(u);  GreaterEqThan(33)(u, minU) == 1
  out0Amount = u·unit;  out0Asset = Poseidon(INTENT_TAG, coin, dir);  outputCommitment[0] == Poseidon(out0Amount, out0Pubkey, Poseidon(out0Asset, 0, out0Blinding))
  Num2Bits(251)(k);  BabyCheck(ecPk);  C1 == k·B8 (EscalarMulFix);  kP = k·ecPk (EscalarMulAny);  C2 == BabyAdd(u·B8, kP)
  balance BNB:  Σ bnb inputs + Σ owed + publicAmount == Σ_{j∈{1,2}} bnb outputs + isBuy·out0Amount
  balance coin: Σ coin inputs                       == Σ_{j∈{1,2}} coin outputs + (1 − isBuy)·out0Amount
```

Contract-side: `publicAmount = field(−fee − INTENT_FEE)`; `coin` is a Launchpad coin; `ecPk` is the active key;
`k` follows the derivation rule of §2.7 (client side; the contract rejects a repeated `C1`).

### 3.3 `claim.circom`

```
public  (5, in this order): root, nullifier, outputCommitment[0], outputCommitment[1], extDataHash
private: ask, coin, dir, epoch, a, blinding, intentPathIndices, intentPathElements[23],
         totalIn, totalOut, totalRefund, rptAtSettle, resultPathIndices, resultPathElements[23],
         q, r, qr, rr, outPubkey[2], outBlinding[2]
constraints:
  pk = Poseidon(ask); nk = Poseidon(ask, 1); dir·(dir−1)·(dir−2) == 0; isBuy = IsZero(dir)
  intentAsset = Poseidon(INTENT_TAG, coin, dir); c0 = Poseidon(a, pk, Poseidon(intentAsset, 0, blinding))
  epochKey = Poseidon(coin, epoch, dir); leaf = Poseidon(c0, epochKey); Merkle(leaf, intentPath) == root
  nullifier == Poseidon(c0, intentPathIndices, nk)
  resultLeaf = Poseidon(RESULT_TAG, epochKey, Poseidon(totalIn, totalOut, Poseidon(totalRefund, rptAtSettle))); Merkle(resultLeaf, resultPath) == root
  Num2Bits(128) on totalIn, totalOut, totalRefund, q, qr;  Num2Bits(96)(a);  totalIn != 0
  qt  <== q·totalIn;    a·totalOut    === qt  + r;   r  < totalIn      // intermediate signals: circom rejects two
  qrt <== qr·totalIn;   a·totalRefund === qrt + rr;  rr < totalIn      // products of private signals in one constraint (T3001)
  out0Asset = isBuy·coin;        out0Rpt0 = isBuy·rptAtSettle;        outputCommitment[0] == Poseidon(q,  outPubkey[0], Poseidon(out0Asset, out0Rpt0, outBlinding[0]))
  out1Asset = (1−isBuy)·coin;    out1Rpt0 = (1−isBuy)·rptAtSettle;    outputCommitment[1] == Poseidon(qr, outPubkey[1], Poseidon(out1Asset, out1Rpt0, outBlinding[1]))
  extDataHash·extDataHash
```

Field-wrap guard: two 128-bit factors could multiply past `p`, so `a` is range-checked to **96 bits** (once, in the
constraint list above; the largest intent `2^32 · 1e18 < 2^92`) and `totalIn`, `totalOut`, `totalRefund`, `q`,
`qr` to 128 bits, keeping every product `< 2^224 < p`. The quotient/remainder witnesses are therefore sound
integers. The two intermediate signals add two constraints; the sketch with them compiles at 16,171 non-linear /
33,563 total.

### 3.4 `epochOpen.circom`

```
public (7): ecPk[0], ecPk[1], C1[0], C1[1], C2[0], C2[1], u
private:    ecSk
constraints: Num2Bits(251)(ecSk); ecPk == ecSk·B8; D = ecSk·C1 (EscalarMulAny); M = BabyAdd(C2, −D); Num2Bits(40)(u); M == u·B8
```

Stage 3 (`epochOpenShare.circom`, spec only): public `sharePk[2], C1[2], D[2]`, private `shareSk`:
`sharePk == shareSk·B8`, `D == shareSk·C1`. `openEpoch` would take `t` share proofs and combine with Lagrange
coefficients on-chain (`t` scalar multiplications ≈ 2–3 M gas) or one combining proof.

### 3.5 Ceremony

Phase 1: Hermez `powersOfTau28_hez_final_16.ptau` (~75 MB) for all four circuits. Phase 2: **one open round**:
each contributor runs `snarkjs zkey contribute` on `transfer`, `intent`, `claim` and `epochOpen` in sequence and
publishes the four hashes; target ≥ 5 outside contributors (recruit from week 1), finish with a fresh drand beacon,
export the four verifiers, publish `circuits/CEREMONY-v2.md` with transcripts and sha256 of every artifact, pin the
zkey hashes in `web/src/lib/zk/artifacts.ts` and verify them in the browser before proving.

**The ceremony is a hard gate for chain 56.** Every verifier is `immutable` in `GrovePool` and `DarkCurve` and
nothing is upgradeable (§4), so "redeploy the verifiers" means a new pool, a new tree and a v2→v3 migration.
Testnet 97 may run with dev keys and is thrown away; `deploy.sh 56 --privacy` refuses to run unless
`circuits/build/CEREMONY-HASHES-v2.txt` matches the verifiers' embedded keys (the script recomputes the vkey hash
from the Solidity source). A mainnet pool behind dev-key verifiers — whose toxic waste the operator holds, as the
v1 `CEREMONY.md` already records for both v1 contributions made by the same operator on two machines — is not
acceptable.

**Contributions bind one exact constraint system.** `CEREMONY-v2.md` publishes, before the first outside
contribution, the sha256 of each `.r1cs`, the exact circom version (`circom2` 0.2.x wasm build, pinned in
`circuits/package.json`) and the compile flags (`−O2`, see §3), and requires every contributor to run
`snarkjs zkey verify <r1cs> <ptau> <zkey>` and publish its output beside the contribution hash. The optimisation
level changes the r1cs (v1 has 14,094 linear constraints because `setup.sh` compiles at the default `−O1`), so a
contribution against a differently compiled r1cs is void.

Blast radius of a compromised key: C1/C3 forge withdrawals of any asset in the pool; C2 forges an intent (steals
from its epoch); C5 lets the Coordinator misstate a sum (bounded by the epoch's escrow, detectable since anyone can
recompute `(Σu)·B8`). `maxShieldPerTx` stays as the brake.

---

## 4. Contracts

Solidity 0.8.26, `via_ir`, `optimizer_runs = 200`, OpenZeppelin 5.1. Nothing upgradeable. Size budget 24,576 B;
the live Launchpad (21.9 KB) is **not modified**. New: `PoseidonT3`/`PoseidonT4` (Yul, `poseidon-solidity`, same
parameters as the live circomlibjs contracts — a test hashes 1,000 random inputs through both and requires
equality), `MerkleTreeWithHistoryV2`, `GrovePool`, `DarkCurve`, `BabyJubjub` (internal library), `Planter`,
`CreatorStub`, four generated verifiers, `GroveConstants` (library of constants).

**Gas figures in this section are estimates to be measured**, not interface. The first draft assumed ~10 k gas per
on-chain Poseidon; measured against the deployed circomlibjs bytecode a `PoseidonT3` call is 29,918 gas, a `T4`
46,185, and one steady-state depth-23 insert 717,729 (v1's depth-20 `depositFor` shows 847 k for this reason).
Every derived constant — `claimGas`, the relayer `gasUnits` table — is therefore an *output* of `forge test` gas
logs (`contracts/gas-v2.json`, WP §6 step 2), and nothing here or in Appendix A freezes one.

### 4.1 `MerkleTreeWithHistoryV2`

```solidity
abstract contract MerkleTreeWithHistoryV2 {
    uint256 public constant FIELD_SIZE = …;            // as v1
    uint256 public constant ZERO_VALUE = ZERO_LEAF;    // Appendix A
    uint32  public constant CHECKPOINT_PERIOD = 600;   // seconds
    IPoseidonT3 public immutable hasher; uint32 public immutable levels;      // 23
    mapping(uint256 => uint256) public filledSubtrees; mapping(uint256 => uint256) public zeros;
    mapping(uint256 root => uint32 indexAfter) public rootIndexAfter;         // 0 = unknown; else nextIndex at the checkpoint (+1 encoded); CHECKPOINTS ONLY
    uint32 public nextIndex;                                                  // always a multiple of 4
    uint256 public lastRoot;                                                  // current root; NOT known until checkpointed
    uint64  public lastCheckpointPeriod;                                      // block.timestamp / CHECKPOINT_PERIOD of the last checkpoint
    event Checkpoint(uint256 root, uint32 indexAfter, uint64 period);
    function isKnownRoot(uint256 root) public view returns (bool);           // root != 0 && rootIndexAfter[root] != 0
    function getLastRoot() public view returns (uint256);
    function checkpoint() public;                                             // anyone; no-op unless block.timestamp / PERIOD > lastCheckpointPeriod; records lastRoot
    function _insertChunk(uint256[4] memory leaves) internal returns (uint32 firstIndex);  // checkpoint(); then 2 + 1 + 21 Poseidon calls, one root
}
```

`_insertChunk` calls `checkpoint()` **before** hashing, so a checkpoint always records the root that was in force at
the period boundary (every leaf inserted before the boundary, none after). The relayer and the keeper call
`checkpoint()` once per period when no insert has happened (one SSTORE + one event). The genesis root (empty tree)
is checkpointed in the constructor so the first proofs have a root. Capacity: `2^levels / 4` chunks; `_insertChunk`
reverts `TreeFull` when `nextIndex + 4 > 2^levels` (callers handle it as §2.6.7).

### 4.2 `GrovePool`

```solidity
contract GrovePool is MerkleTreeWithHistoryV2, Ownable2Step, ReentrancyGuard {
    struct Proof { uint256[2] a; uint256[2][2] b; uint256[2] c; }
    struct TransferPublic { uint256 root; uint256 publicAmount; address coin; uint256 publicAmountCoin; uint256 accRpt;
                            uint256 handle; uint256 claimAmount; bytes32 extDataHash; uint256[2] inputNullifiers; uint256[3] outputCommitments; }
    struct ExtData { address recipient; int256 extAmountBnb; int256 extAmountCoin; address relayer; uint256 fee; bytes payload; bytes[3] encryptedOutputs; }

    IVerifier13 public immutable transferVerifier; IPoseidonT3 immutable t3; IPoseidonT4 public immutable t4;   // the new Yul hashers
    ILaunchpadFull public immutable launchpad; IHolderRewardsClaim public immutable holderRewards; ShieldedPool public immutable v1;
    address public darkCurve; address public planter;                       // setModules, one-shot
    uint256 public maxShieldPerTx = 100 ether;                              // BNB shields only; withdrawals never gated
    mapping(uint256 => bool) public nullifierHashes;
    mapping(uint256 handle => uint256) public claimable;
    mapping(address coin => uint256) public accRpt;
    mapping(address coin => mapping(uint256 => bool)) public knownAccRpt;   // knownAccRpt[coin][0] = true for every coin
    mapping(uint256 amount => bool) public unshieldDenom;                   // BNB; owner may only add
    mapping(uint256 amount => bool) public tokenLot;                        // tokens; owner may only add

    event NewCommitment(uint256 indexed commitment, uint32 index, bytes encryptedOutput);
    event NewNullifier(uint256 nullifier);
    event Transact(int256 extAmountBnb, address coin, int256 extAmountCoin, address recipient, address relayer, uint256 fee);   // no sender
    event Credited(uint256 indexed handle, uint256 amount);
    event HandleClaimed(uint256 indexed handle, uint256 claimAmount);
    event RewardsPulled(address indexed coin, uint256 runId, uint256 amount, uint256 accRpt);
    event MigratedFromV1(uint256 indexed handle, uint256 amount);
    event CommitmentDropped(uint256 indexed commitment);
    event ModulesSet(address darkCurve, address planter); event MaxShieldSet(uint256); event DenominationAdded(bool token, uint256 amount);

    error InvalidProof(); error UnknownRoot(); error AlreadySpent(); error BadExtDataHash(); error BadPublicAmount(); error BadClaimAmount();
    error BadValue(); error OverLimit(); error NotDenomination(); error BadPlantValue(); error UnknownAccRpt(); error NotModule(); error NotCoin(); error TransferFailed();

    function transact(Proof calldata p, TransferPublic calldata s, ExtData calldata e) external payable nonReentrant;
    function credit(uint256 handle) external payable;                                             // handle != 0, < FIELD_SIZE, msg.value > 0
    function pullRewards(address coin, uint256 runId, uint256 amount, bytes32[] calldata proof) external nonReentrant;
    function migrateFromV1(ShieldedPool.Proof calldata vp, ShieldedPool.ExtData calldata ve, uint256 handle) external nonReentrant;
    // module hooks
    function insertChunk(uint256[4] calldata leaves, bytes[] calldata encryptedOutputs) external returns (uint32);  // onlyModule; emits NewCommitment per non-zero slot (encryptedOutput may be "")
    function markSpent(uint256 nullifier) external;                                                // onlyModule; reverts AlreadySpent; emits NewNullifier
    function moveOut(address asset, uint256 amount, address to) external;                          // onlyModule; BNB when asset == 0
    // admin
    function setModules(address darkCurve_, address planter_) external onlyOwner;                  // once
    function setMaxShield(uint256) external onlyOwner;
    function addUnshieldDenomination(uint256 wei_) external onlyOwner; function addTokenLot(uint256 units) external onlyOwner;
    // views
    function hashExtData(ExtData calldata e) public pure returns (bytes32);                        // keccak(abi.encode(e)) % FIELD_SIZE
    function isCoin(address coin) public view returns (bool);                                      // launchpad.info(coin).creator != 0
    function isSpent(uint256) external view returns (bool);
    function verifyTransfer(Proof calldata p, TransferPublic calldata s) public view returns (bool);
    receive() external payable;                                                                     // only from darkCurve, launchpad (refunds), router, roots, v1, holderRewards
}
```

`transact` rules, in order:

1. `e.extAmountBnb > 0` ⇒ `msg.value == extAmountBnb ≤ maxShieldPerTx`; else `msg.value == 0`.
   `e.extAmountBnb < 0` ⇒ **if** `e.recipient == planter`: `uint256(-extAmountBnb) == launchpad.plantFee()` (else
   `BadPlantValue`); **else** `unshieldDenom[-extAmountBnb]` (**enforced**: every BNB unshield that is not a plant
   is a denomination; the plant fee is a public constant below the smallest denomination, §2.8).
   `e.extAmountCoin > 0` ⇒ `IERC20(coin).transferFrom(msg.sender, this, amount)` and `tokenLot[amount]`;
   `< 0` ⇒ `tokenLot[-amount]` and `transfer(recipient)`. `e.coin != 0 ⇒ isCoin(e.coin)`.
   `s.coin == uint160(e.coin)`; `e.coin == 0 ⇒ s.publicAmountCoin == 0 && s.accRpt == 0`; else `knownAccRpt[coin][s.accRpt]`.
2. `isKnownRoot(s.root)`; nullifiers unspent and distinct; `s.extDataHash == hashExtData(e)`; `fee > 0 ⇒ relayer != 0`.
3. `uint256 h = s.handle; h == 0 ⇒ s.claimAmount == 0; h != 0 ⇒ s.claimAmount ≤ claimable[h]` (else `BadClaimAmount`);
   `s.publicAmount == field(e.extAmountBnb − int(e.fee) + int(s.claimAmount))`; `s.publicAmountCoin == field(e.extAmountCoin)`.
4. `verifyTransfer`; mark nullifiers; `claimable[h] −= s.claimAmount` and `HandleClaimed(h, claimAmount)` if `claimAmount > 0`.
5. Insert one chunk `[out0, out1, out2, ZERO_LEAF]` (or `CommitmentDropped` ×3 when the tree is full, still paying out).
6. Payouts, dispatched on `e.payload`'s first word when it is non-empty:
   `extAmountBnb < 0 && e.recipient == planter` ⇒ payload must decode as `(ACTION_PLANT, PlantParams, handle)` →
   `planter.plantFor{value}(payload)`; `extAmountBnb < 0` otherwise ⇒ `_pay(recipient)`.
   `fee > 0` → `_pay(relayer)`.
   `h != 0 && s.claimAmount == 0 && e.recipient != planter && payload[0] == ACTION_HANDOVER` ⇒ `planter.handOver(…)`
   decoded from `payload` (the owner-auth path, §2.8). Any other non-empty payload reverts. Emit `Transact`.

`pullRewards`: `holderRewards.claim(coin, runId, amount, proof)` (pays this contract; `receive` accepts from
`holderRewards`), then `supply = IERC20(coin).balanceOf(this)`; `require(supply > 0)`;
`accRpt[coin] += amount·1e18 / supply`; `knownAccRpt[coin][accRpt[coin]] = true`; emit.

`migrateFromV1`: `ve.recipient == address(this) && ve.extAmount < 0 && handle != 0`; `v1.transact(vp, ve)`
(`receive` accepts from `v1`); `claimable[handle] += uint256(-ve.extAmount)`; emit `Credited` and `MigratedFromV1`.
The v1 relayer fee in `ve.fee` is paid by the v1 pool to `ve.relayer` as usual.

Gas (estimates to measure; 24 Yul Poseidon calls per chunk, verify ≈ 230 k + 7 k per public input, roots stored
only at checkpoints): shield/transfer/unshield ≈ **0.6–0.9 M**; a private plant ≈ transfer + `Launchpad.plant`
(GroveCoin deployment, ≈ 2.5–3 M more); `credit` ≈ 45 k; `pullRewards` ≈ 120 k; `migrateFromV1` ≈ 0.75 M (v1
verify) + 45 k. Size ≈ 12 KB.

### 4.3 `DarkCurve`

```solidity
contract DarkCurve is Ownable2Step, ReentrancyGuard {
    enum Dir { BUY, SELL, HARVEST }
    struct Params { uint32 tMin; uint32 tMax; uint32 k; uint32 grace; uint16 bandBps; uint16 maxIntents; uint128 bandFloorWei; uint32 claimGas; }
    struct Point { uint256 x; uint256 y; uint256 t; uint256 z; }           // extended twisted-Edwards; the ONLY on-chain representation of a sum
    struct Epoch { uint64 startedAt; uint8 status; /*0 none, 1 collecting, 2 opened, 3 voided*/ uint8 keyId; uint32 count;
                   uint256 refPrice; uint256 refVb; Point c1; Point c2; }
    struct IntentPublic { uint256 root; uint256 publicAmount; address coin; uint256 accRpt; uint8 dir; uint256[2] ecPk; uint256[2] c1; uint256[2] c2;
                          bytes32 extDataHash; uint256[2] inputNullifiers; uint256[3] outputCommitments; }
    struct IntentExt { address relayer; uint256 fee; bytes[3] encryptedOutputs; }
    struct ClaimPublic { uint256 root; uint256 nullifier; uint256[2] outputCommitments; bytes32 extDataHash; }
    struct ClaimExt { address relayer; bytes[2] encryptedOutputs; }

    GrovePool public immutable pool; ILaunchpadFull public immutable launchpad; IRootsHarvest public immutable roots;
    IPancakeRouter02 public immutable router; address public immutable weth; address public immutable treasury;   // INTENT_FEE sink (FeeRouter.treasury() at deploy)
    IVerifier17 public immutable intentVerifier; IVerifier5 public immutable claimVerifier; IVerifier7 public immutable openVerifier;
    Params public params;
    mapping(address coin => uint32[3]) public cur;                           // per direction
    mapping(bytes32 => Epoch) internal epochs;                              // key = keccak(coin, dir, seq)
    mapping(uint256 c1x => bool) public seenC1;                              // ElGamal randomness may never repeat
    uint256[2][2] public coordinatorKey; uint64 public keySwitchAt;        // [0] current, [1] next
    uint256 public claimBudget; uint256 public maxReimburseGasPrice = 5 gwei;

    event IntentSubmitted(address indexed coin, uint8 indexed dir, uint32 seq, uint32 count, uint256 intentLeaf);
    event EpochOpened(address indexed coin, uint8 indexed dir, uint32 seq, uint256 u, uint256 totalIn, uint256 totalOut, uint256 refund, uint256 spotAfter, uint256 rptAtSettle);
    event EpochVoided(address indexed coin, uint8 indexed dir, uint32 seq);
    event Claimed(address relayer, uint256 reimbursed);
    event ParamsSet(Params p); event CoordinatorKeySet(uint256[2] pk, uint64 switchAt); event ClaimBudgetFunded(uint256 amount);

    error NotCoin(); error BadDir(); error EpochFull(); error WrongKey(); error UnknownAccRpt(); error InvalidProof(); error UnknownRoot(); error AlreadySpent();
    error BadExtDataHash(); error BadPublicAmount(); error ReusedRandomness(); error NotOpenable(uint8 dir); error WrongSeq(uint8 dir); error BandExceeded(uint8 dir);
    error NotVoidable(); error OutOfBounds(); error EmptyMask();

    function submitIntent(GrovePool.Proof calldata p, IntentPublic calldata s, IntentExt calldata e) external nonReentrant;
    function openEpoch(address coin, uint8 dirMask, uint32[3] calldata seq, uint256[3] calldata u, GrovePool.Proof[3] calldata proofs, uint256[3] calldata minOut) external nonReentrant;
    function voidEpoch(address coin, uint8 dir, uint32 seq) external nonReentrant;
    function claim(GrovePool.Proof calldata p, ClaimPublic calldata s, ClaimExt calldata e) external nonReentrant;
    function fundClaimBudget() external payable;
    function setParams(Params calldata p) external onlyOwner;                        // within the bounds of §2.6.1 (hard-coded constants)
    function setCoordinatorKey(uint256[2] calldata pk, uint64 switchAt) external onlyOwner;  // switchAt ≥ now + OVERLAP
    function setMaxReimburseGasPrice(uint256) external onlyOwner;
    // views
    function epochKey(address coin, uint32 seq, uint8 dir) public view returns (uint256);        // t4(coin, seq, dir)
    function epochOf(address coin, uint8 dir, uint32 seq) external view returns (Epoch memory);
    function epochsOf(address[] calldata coins) external view returns (Epoch[3][] memory);        // one call for every active coin (§5.1: no per-coin reads)
    function isOpenable(address coin, uint8 dir, uint32 seq) public view returns (bool);
    function spot(address coin) public view returns (uint256 price, uint256 vB);                  // launchpad.price + VIRTUAL_BNB + info.realBnb, or pair reserves
    function hashIntentExt(IntentExt calldata) public pure returns (bytes32); function hashClaimExt(ClaimExt calldata) public pure returns (bytes32);
    receive() external payable;                                                                  // from pool.moveOut, launchpad refunds/sells, roots, router
}
library BabyJubjub { function add(DarkCurve.Point memory P, DarkCurve.Point memory Q) internal pure returns (DarkCurve.Point memory);
                     function toAffine(DarkCurve.Point memory P) internal view returns (uint256 x, uint256 y);
                     function fromAffine(uint256 x, uint256 y) internal pure returns (DarkCurve.Point memory);
                     function isOnCurve(uint256 x, uint256 y) internal pure returns (bool); }
```

`claim` reimbursement: `uint256 r = params.claimGas × min(tx.gasprice, maxReimburseGasPrice); r = min(r, claimBudget);
claimBudget −= r; _pay(e.relayer, r)` (skip when `e.relayer == 0`). Claims never revert for lack of budget.

Gas (estimates to measure): `submitIntent` ≈ 350 k verify + one chunk (24 Yul Poseidon) + epochKey T4 + leaf T3 +
2 ecAdd + storage (`seenC1`) ≈ **1.0–1.4 M**; `openEpoch` ≈ 250 k per direction proof + venue 150–300 k
(graduation +1.5–2.5 M once) + one chunk ≈ **0.8–1.5 M** for three directions (Coordinator-paid, reimbursed by
treasury off-chain); `claim` ≈ 265 k + one chunk ≈ **0.5–0.7 M**; `voidEpoch` ≈ one chunk + storage. `forge test`
writes the measured figures to `contracts/gas-v2.json`; `params.claimGas` and the relayer's units come from there.
Size ≈ 15 KB.

### 4.4 `Planter` and `CreatorStub`

```solidity
contract Planter {
    GrovePool public immutable pool; ILaunchpadFull public immutable launchpad; IFeeRouterFull public immutable feeRouter; IRootsHarvest public immutable roots;
    mapping(address coin => address) public stubOf; uint256 public stubNonce;
    event PlantedPrivately(address indexed coin, address stub, uint256 handle);
    event HandedOverPrivately(address indexed coin, PayoutMode mode, address wallet, uint256 ringId);
    event HarvestedToHandle(address indexed coin, uint256 tokens, uint256 bnb, uint256 handle);
    function plantFor(bytes calldata payload) external payable returns (address coin);                        // onlyPool; payload = abi.encode(ACTION_PLANT, Launchpad.PlantParams, uint256 handle); mode != Wallet; msg.value == launchpad.plantFee()
    function handOver(address coin, uint256 handle, PayoutMode mode, address wallet, uint256 ringId) external; // onlyPool; CreatorStub(stubOf[coin]).handle() == handle
    function harvestToHandle(address coin, uint256 tokens, uint256 minBnb, uint256 handle) external;          // anyone; transferFrom → approve → roots.harvest → pool.credit{value}(handle)
    function predictStub(uint256 handle, uint256 nonce) external view returns (address);
}
contract CreatorStub {
    address public immutable planter; GrovePool public immutable pool; ILaunchpadFull public immutable launchpad; IFeeRouterFull public immutable feeRouter;
    uint256 public immutable handle; address public coin;
    function plant(Launchpad.PlantParams calldata p) external payable returns (address);    // onlyPlanter, once; coin = launchpad.plant{value: msg.value}(p)
    function handOver(PayoutMode mode, address wallet, uint256 ringId) external;             // onlyPlanter → feeRouter.handOver(coin, mode, wallet, ringId)
    function flush() external;                                                               // anyone: try feeRouter.withdrawPending(); pool.credit{value: address(this).balance}(handle)
    receive() external payable {}                                                            // FeeRouter._push, 50 k gas
}
```

`PlantParams.payoutMode == Creator` keeps the deployer share flowing to the stub (`FeeRouter.collect` pushes to
`c.creator`, verified at `FeeRouter.sol:155–215, 303`), with `handOver` possible later; `Holders`/`Donate` are
allowed at plant; `Wallet` is refused. The stub's `receive` only accepts so the 50 k-gas push never fails into
`pending`; `flush` also drains `pending` defensively.

### 4.5 Verifiers

snarkjs-generated `Groth16VerifierTransfer` (13 inputs), `Groth16VerifierIntent` (17), `Groth16VerifierClaim` (5),
`Groth16VerifierOpen` (7); `IVerifier13/17/5/7` interfaces in `IGrove.sol`. All four are `immutable` in the
contracts that use them: on chain 56 they are deployed **only** from ceremony artifacts (§3.5). Poseidon T3/T4 are
new Yul deployments (`poseidon-solidity`); the live circomlibjs contracts (`0x5B17…4eF6`, `0xB1FE…685a`) stay in
use by v1 and serve as the equality oracle in tests.

### 4.6 Admin powers (Safe) and what admin cannot do

Can: `setMaxShield`; add (never remove) denominations and lots; set `Params` (including `claimGas` and
`bandFloorWei`) within hard bounds; set the Coordinator key for *future* intents (done daily, §2.7); fund the
claim budget; set `maxReimburseGasPrice`; set modules once.
Cannot: spend or freeze any note or escrow (`claim`, `voidEpoch`, unshields are permissionless and never gated),
change a coin's payee after handover, re-point modules, upgrade anything, or lower the open deadline below the
bounds.

---

## 5. Web, keeper and relayer

### 5.1 Web (`web/`)

- **Keys** (`src/lib/zk/keys.ts`): *Create a shielded wallet* (32 random bytes, encrypted at rest with a
  passphrase via WebCrypto AES-GCM in IndexedDB, 12-word BIP-39 backup shown once) is the default; *Derive from
  wallet* (EIP-712 + passphrase, §2.2) is the alternative with the warning "any site that gets this signature and
  your passphrase gets your shielded key; zkBNB will never ask you to sign it anywhere but on this page". Export
  / import of FVK (`zkbnb2view…`) and IVK. The legacy v1 key is derived on demand for *Migrate* and the legacy
  dark-pool tab only.
- **Note store** (`src/lib/zk/store.ts`): multi-asset notes, intent notes with `(coin, seq, dir)` and claim
  status, handles created (salts), epoch results; IndexedDB encrypted with the session key.
- **Sync** (`src/lib/zk/sync.ts`): downloads the keeper's bundle (§5.2; same bytes for everyone) and trial-decrypts
  locally. Live reads never name a coin: `DarkCurve.epochsOf(allActiveCoins)` and a single multicall for
  `accRpt`/`cur`/`count` of **every** coin (or the keeper's `epochs.json`, same for everyone) replace per-coin
  reads, because Vercel keeps request logs (path, IP, time) for `/api/rpc` regardless of what the app logs, and a
  per-coin read minutes before an `IntentSubmitted(coin, …)` would hand the web host IP ↔ coin. No per-wallet
  `eth_getLogs` anywhere.
- **Proving** (`src/lib/zk/prove.worker.ts`): the three artifact sets are **prefetched at key creation** and
  re-validated by a Service Worker on every visit, kept in CacheStorage keyed by the pinned sha256
  (`src/lib/zk/artifacts.ts`) and verified before use; a job never fetches on demand (if the cache was evicted the
  UI shows "preparing — this takes a minute" and waits for all three sets before any action is offered).
- **Coin page** (`components/coin/TradePanel.tsx` → segmented `Public | Private | Instant`): *Private* is default
  when a stage-2 key exists: amount, side (Buy / Sell / Harvest), mode **Private (wait for ≥ 3 others on this
  side — may include bots)** / **Fast**, per-direction crowd counter ("4 buy intents in this epoch, opens in
  2:10"), expected price band (95th-percentile epoch size), fee tier (+ the flat `INTENT_FEE`), `Trade privately` →
  `ProofProgress` → "Held by the relayer until 3 others join" or "Submitted, epoch opens in …". The honest sentence
  is always visible on quiet coins: *"Your identity is hidden regardless. Your amount is hidden only if others
  trade this coin in the same direction in the same epoch."* Private never offers *sell all* / *harvest all*; a
  private sell or harvest size equal to the output of any earlier `N = 1` epoch of the coin gets a warning and a
  suggested round lot (§2.6.1). Minimum private size is 0.05 BNB / 50,000 tokens. The trades feed and chart show
  per-direction aggregates (`EpochOpened`) beside public `Trade`s, one row "Private batch (n buys)". *Instant* is
  the stage-1 dark-pool panel labelled "amount public".
- **Wallet** (`/wallet`, replaces `/move`'s notes list; `/move` keeps shield/unshield): balances per asset with
  accrued dividends (local `amount × (accRpt − rpt0)`), "spendable in m:ss" on notes not yet in a checkpoint,
  pending intents, claimable epochs with *Claim now* / *Auto-claim later* (default: **lazy** — the wallet draws a
  random 1–24 h delay per claim, stores it locally, and proves + submits on the next visit after it, or from a
  Service Worker job; the proof is never made before it is sent, §2.6.5), handles to claim (shown as "incoming
  0.37 BNB"), legacy v1 notes with *Spend from v1* (recommended) and *Migrate slowly* (§7), legacy dark vaults.
  Relayer picker with the pseudonym warning (§2.10). Unshield: denominations mandatory (on-chain), a
  per-denomination "shields since yours: n" counter, and a warning when a selected input set equals a known credit
  or a recent shield (subset-sum check).
- **Create** (`/create`): *Launch privately* (default with a key): pays `plantFee` from notes via the relayer
  (kind `plant`), creator = a fresh per-coin handle, mode Creator/Holders/Donate, first buy pre-filled as a **held**
  epoch-0 BUY intent with the sentence of §2.6.6 and a *Skip the first buy* option; image re-encoded locally
  (EXIF stripped) into the on-chain data URL as today — no upload leaves the browser; *Launch publicly* as today.
  Creator page: *Claim creator fees* (flush + handle claim), *Hand over* (owner proof).
- **Docs**: new `/docs/privacy` = §1.2, §6 and §0.3 of this file in plain words; `/docs/shielded`, `/docs/risk`,
  `/docs/trust`, `/docs/darkpool` updated per the WORKPLAN.
- **Build hygiene**: SRI on scripts, CSP without third-party origins, reproducible build with published dist
  hashes, zkey hashes pinned and checked.

### 5.2 Keeper (`keeper/`)

New commands in the existing process model (`src/index.ts`, pm2):

- `coordinator`: watches `IntentSubmitted` and `isOpenable` per `(coin, dir)`; when a direction is openable it reads
  the on-chain sum, decrypts **the sum only** with `COORDINATOR_SK` and solves it with the 2^24 BSGS table (§2.7;
  the per-intent ciphertexts are never decrypted — the code path does not exist in the command), quotes `minOut`
  from current reserves / pair (`SLIPPAGE_BPS`, default 300), builds C5 proofs with snarkjs
  (`circuits/build/epochOpen.{wasm,zkey}`), submits `openEpoch` for all openable directions of the coin through
  `PRIVATE_TX_RPC` (falls back to the public RPC when unset, logged as a warning), retries with fresh hints and
  drops a direction that keeps reverting or is band-blocked from the mask, calls `voidEpoch` when `T_MAX + GRACE`
  lapses, and calls `pool.checkpoint()` once per period when nothing else has. **Key rotation** (`rotate-key`
  subcommand, run daily by cron): generates the next `ecSk`, proposes `setCoordinatorKey(pk, now + 1 h)` to the
  Safe, and after the last epoch under the old key is opened or voided overwrites the old key file and logs
  `KeyDestroyed(pk)`. Runs on a **different host** from the relayer (ecosystem file documents it).
- `pool-feed`: writes the sync bundle to Blob (`snapshots/pool/<chainId>/manifest.json` + `chunk-<n>.json`,
  schema Appendix C) from `NewCommitment`, `NewNullifier`, `IntentSubmitted`, `EpochOpened/Voided`, `Credited`,
  `HandleClaimed`, `RewardsPulled` logs.
- `dividends`: after each `postRun` on a Holders-mode coin, `pullRewards(coin, runId, poolShare, proof)`.
- `flush`: calls `CreatorStub.flush()` for stubs with balance or pending above `MIN_FLUSH_WEI`.
- `rewards`: `GrovePool` is an eligible holder (its leaf is published in the snapshot JSON like any other);
  `DarkCurve`, `Planter` and every `CreatorStub` are excluded.
- Existing `sweep`, `buyback`, `rotate`, `feed` unchanged except ABI additions; `feed` adds per-epoch rows.

### 5.3 Relayer (`keeper/src/relayer/`, standalone HTTP service on the VPS)

Protocol (`web/src/lib/relay.ts` stays the single source of types; wire format unchanged: uints as decimal
strings, bytes/addresses as 0x hex):

```
GET  /relay?chainId=56&kind=transfer|plant|intent|claim|v1migrate|transact|fill|vault
     → { ok:true, chainId, kind, relayer, fee, feeTier, gasPrice, gasUnits, validUntil, tiers:[…] } | { ok:false, reason }
POST /relay   body (discriminated by kind):
  { kind:"transfer",  chainId, proof, pub: TransferPublicJson, extData: ExtData2Json }
  { kind:"plant",     chainId, proof, pub: TransferPublicJson, extData: ExtData2Json }          // recipient == planter; its own gasUnits
  { kind:"intent",    chainId, proof, pub: IntentPublicJson,   extData: IntentExtJson, hold?: { minOthers: 1..16, submitByEpochEnd: boolean } }
  { kind:"claim",     chainId, proof, pub: ClaimPublicJson,    extData: ClaimExtJson }           // no hold, no notBefore: the browser proves lazily (§2.6.5)
  { kind:"v1migrate", chainId, proof: ProofJson(v1), extData: ExtDataJson(v1), handle: string, notBefore?: unixSeconds (≤ now + 14 d) }
  { kind:"transact"|"fill"|"vault", … }                                   // stage 1, unchanged
     → { ok:true, hash } | { ok:true, held:true, ticket } | { ok:false, error, code }
GET  /relay/held/<ticket> → { status:"held"|"submitted"|"dropped", hash?, reason?, count?, opensAt? }
GET  /relay/epochs?chainId=56 → { coins: { [coin]: [{ seq, startedAt, count, openableAt, refPrice }, ×3 dirs] }, updatedAt }   (ALL active coins, no coin parameter; cached; same bytes for everyone)
```

Policy is split in two: **pure** functions in `relay.ts` (unit-tested) — chain match; `extData.relayer` is this
relayer; `fee` equals a tier and `feeCovers(fee, gasPrice, gasUnits[kind], flat)` with `gasUnits` loaded from
`contracts/gas-v2.json`; `transfer`: `extAmountBnb ≤ 0` (shields never relayed), `extAmountCoin ≤ 0`,
`recipient != planter`; `plant`: `recipient == planter`, `−extAmountBnb == onChain.plantFee`, payload decodes as
`ACTION_PLANT`; `intent`: `publicAmount == field(−fee − INTENT_FEE)`, `dir ∈ 0..2`, `ecPk == onChain.coordinatorKey`
(current or next), `!onChain.seenC1`; `claim`: `fee` absent (free) — and an explicit `onChain: { coordinatorKey,
plantFee, seenC1 }` input the server fills from one `eth_call` batch, so the pure part stays pure. The route then
simulates, locks nullifiers in flight, sends from the relayer wallet through a serialised queue, rate-limits per
client, and **writes no access log**; one structured line per send with kind and hash only.

**Held intents** (the wait-for-crowd knob, per direction): the relayer stores the signed request encrypted at rest
(keyed by its first nullifier), polls `count` for `(coin, dir, cur[coin][dir])`, and submits when
`count ≥ hold.minOthers`, or at `startedAt + T_MAX − 30 s` when `submitByEpochEnd`, or drops it (status `dropped`;
the browser re-uses the same proof later: the checkpoint root stays valid and the nullifiers are still unspent)
otherwise. Releases are **individual, with a random 0–20 s jitter each**, never as one burst: when several held
intents become releasable at once, a burst of old-root intents in one block would mark exactly the
privacy-conscious subset. The relayer learns the user's privacy preference and nothing else new; the contract has
no per-intent state. **Claims are not held** (§2.6.5). `v1migrate` may carry `notBefore` (a migration's amount is
public anyway, so its proving time hides nothing new; the hold spreads a user's migrations over days, §7). A held
proof is deleted on submission or after 14 days. The relayer also calls `pool.checkpoint()` once per period when
the chain shows no insert in that period.

Deployment: `relayer` is a second pm2 app in `keeper/ecosystem.config.cjs`, env `RELAYER_PRIVATE_KEY`, `RELAYER_PORT`,
`RELAYER_ALLOWED_ORIGINS`, `RELAY_FLAT_FEE_WEI`, `GAS_UNITS_FILE` (default `contracts/gas-v2.json`), optional
`TOR_HIDDEN_SERVICE_DIR`. The browser reads `web/public/relayers.json` (`[{ name, url, onion?, address }]`) and lets
the user pick or type one, with the pseudonym warning (§2.10). The Vercel `/api/relay` route keeps serving
stage-1 kinds and **refuses** stage-2 kinds with `{ ok:false, code:"use-relayer" }`; the browser never falls back
to it for stage 2 (fail closed with a notice).

---

## 6. What is still public, and how big the crowd must be

### 6.1 Still public (this table is the acceptance test for /docs/privacy)

| # | Public datum | Who | Why it stays public |
|---|---|---|---|
| 1 | Per `(coin, direction, epoch)`: intent count, aggregate `B`/`T`/`H`, `tokensOut`, `bnbOut`, refund, average price, reserves after. With `N = 1` the aggregate *is* the amount, and a later `N = 1` exit of the same lot links to it | everyone | the curve must move by the aggregate; the price must be auditable. Mitigation: per-direction crowds, hold knob, UI lot steering (§2.6.1) |
| 2 | Public `Launchpad.buy/sell`, public harvests, public reward claims, direct PancakeSwap trades | everyone | the user chose the public path |
| 3 | `balanceOf(GrovePool)` per coin (all in-pool holdings combined) and the pool's BNB | everyone | ERC-20 and chain state |
| 4 | Every shield: wallet, amount, time. Every unshield: recipient, denomination, time, relayer. Token shields/unshields: the same with lots. The plant fee unshield (constant, to `Planter`) | everyone | `msg.value` comes from a wallet; a recipient must be named. Mitigation: denominations (unshields enforced on-chain), "shields since yours", never unshield what you shielded |
| 5 | Known-amount credits: `Credited(handle, amount)` for creator-fee flushes (per coin), public-wallet harvests (wallet, amount), v1 migrations, ring payouts; and each later `HandleClaimed(handle, claimAmount)`. Each handle is one-shot, so credits to different handles are not linked by the handle | everyone | the amount is a function of public state; the key is hidden; a claim is linked to its credit by the handle, not to a key or to other notes |
| 6 | Timing of every transaction; **the 10-minute checkpoint window each proof was made in** (`root` in calldata) — so a relayer-held intent is recognisable as held when it lands with an old root; relayer addresses (a rare relayer clusters all of one user's actions, §2.10); fee tiers | everyone | the chain is public; a proof must name a root; relayers are paid on-chain |
| 7 | Coin creation (address, metadata, plant fee, that `Planter` planted it), graduation, the per-coin creator-fee stream | everyone | the product; `FeeSplit` is public today |
| 8 | Nullifiers, commitments, roots, intent leaves, result leaves, ciphertexts | everyone | random-looking; carry nothing without keys |
| 9 | The coin of an in-pool coin transfer (not the amount, sender or recipient) | everyone | `accRpt[coin]` must be supplied by the contract |
| 10 | **The ability to decrypt every intent's amount and to link intents into positions** (the running software decrypts sums only; the operator holds `ecSk`); per-direction sums seconds before they are public; and, if a key ever leaks, every intent encrypted under it (ciphertexts are in calldata forever, ElGamal has no forward secrecy) | the Epoch Coordinator (zkBNB keeper) | it holds `ecSk` in stage 2. Bounded by daily rotation and destruction of old keys (§2.7); removed by the threshold committee in stage 3; until then marketing must not say "nobody can see your amount" |
| 11 | Submitter IP, time, public inputs, hold preference of each relayed action | the relayer used | network layer. Tor, no logs, independent relayers, separate from the Coordinator |
| 11b | IP + time of bundle, artifact and `/api/rpc` requests — never a coin or an action kind, because reads are batched over all coins and artifacts are prefetched | the web host (Vercel) and zkBNB | hosting logs exist regardless of app code; the mitigation is that no request is specific to an action |
| 11c | v1 pool endpoints still called by the live `Roots.harvestShielded`, `HolderRewards.claimShielded` and `DonationRotator` payouts: `pubKey + amount` in `DepositFor` | everyone | immutable `pool` in deployed contracts; the UI no longer offers them; successors credit handles (§8) |
| 12 | Public-wallet holders and balances; keeper snapshot JSON (the pool as one holder) | everyone | ERC-20; allocation is published by design |
| 13 | Stage-1 dark vaults: coin, amount, vault, time of every vault buy; `DepositFor` pubKey of vault proceeds | everyone | stage-1 property; superseded for new buys |
| 14 | Coordinator and relayer liveness, Safe parameter changes, ceremony transcripts | everyone | governance |

### 6.2 Anonymity-set arithmetic

**Sender and linkability do not depend on the crowd.** A relayed intent, claim, transfer or handle claim exposes
no wallet and spends notes whose only trace is a nullifier that nobody can map to a commitment without `nk`. The
sender's anonymity set is every unspent note in the tree (hundreds today, millions eventually). Caveats: pool
edges (row 4) and timing (§6.3).

**Amounts on the curve depend on the crowd — on the same side.** An observer learns the sum `S` over the `N`
private intents in `(coin, dir, epoch)`; an adversary controlling `m` of them learns the sum over the `N − m`
honest ones. Intents in the other directions of the same coin add nothing to `N` (§2.6.1).

| Honest private intents in the epoch | What is learned about one honest amount | Verdict |
|---|---|---|
| 1 | exactly (`S` minus the adversary's own) | **public amount**, sender still hidden |
| 2 | each learns the other's; outsiders learn `a + b = S` | hidden from outsiders as a split of `S` |
| 3–4 | `S` and the count; a wide posterior | weak |
| ≥ 5 | `S/N` estimates the average; individual amounts are essentially unrecoverable | **hidden** |
| ≥ 20 | approaches the coin's trade-size distribution | strong |

Expected crowd from trading rates with `T_MAX = 5 min`: a coin doing 50 trades/day averages 0.17 private intents
per epoch across all directions (almost always `N = 1` on any one side); 300/day gives ~1; a launch-day coin at
2,000/day gives ~7, of which perhaps 5 are buys, and the per-direction `K = 5` trigger closes the BUY epoch as soon
as `T_MIN` passes while the SELL side keeps collecting until it has its own crowd or `T_MAX`. **Quiet coins give no
amount privacy on their own.** That is a property of every batching scheme; it is why the UI defaults to *Private
(wait for ≥ 3 others on this side)* on coins whose 24 h intent rate is below one per `T_MAX`, shows the live
per-direction crowd counter, and prints the sentence from §5.1.

**Active sybil, honestly priced.** The crowd counter and the relayer's hold knob count every `IntentSubmitted`,
including an attacker's. An attacker watching a quiet coin can submit `minOthers` dust intents in the same
direction, release the honest user's held intent, and read the honest amount as `S − m × MIN_U`. Per dust intent
the cost is `INTENT_FEE (0.002 BNB) + MIN_U × 2 % (0.001 BNB) + gas (~0.001–0.003 BNB)` ≈ **0.005 BNB**, so
isolating one honest intent behind "wait for ≥ 3 others" costs ≈ **0.015 BNB** (principal comes back as tokens or
refunds). The first draft's 0.005 BNB floor made it 0.03 BNB for `K − 1 = 7`; raising `MIN_U` to 0.05 BNB and adding
`INTENT_FEE` raises the per-intent cost ~5×, and that is the ceiling without pricing out honest small buyers. The UI
therefore says *"others (may include bots)"*, never *"protected"*. Honest statement: on the curve the amount
guarantee is *k-anonymity among honest participants*, and the hold knob is a convenience against *accidental*
isolation, not a defence against a targeted one; stage 3 does not change this. Sender and linkability are
unaffected by the attack.

**Pool edges.** A 1 BNB shield followed by a 1 BNB unshield hides only among the other 1 BNB shields made before
the unshield and not yet consumed. Rule of thumb: wait for 20–50 same-denomination shields after yours, and never
unshield a sum equal to a known credit (row 5). In this design most value never leaves the pool (coins, rewards,
harvests and claims are notes), so unshields are rare, which is the real gain.

**Known-amount notes.** A `HandleClaimed(handle, 0.37 BNB)` credit is always folded into a join-split with the
user's other notes (§2.4), so there is no standalone 0.37 note; the wallet still warns when a later unshield's
inputs sum to a recent credit.

### 6.3 Timing

| Correlation | Exposure | Mitigation |
|---|---|---|
| intent → open | none beyond epoch membership, already public as a count | — |
| open → claim | a claim 30 s after an open is probably from that epoch: the set collapses from "all epochs" to that epoch's `N` (not to one person) | lazy proving with a random 1–24 h delay, proof made at submit time so the root does not date it (§2.6.5) |
| shield → intent | a fresh 1 BNB shield followed within minutes by an intent on coin X suggests the depositor bought X (amount still hidden if `N ≥ 5`) | checkpoint roots (the intent's root is shared by every proof of the window, not the shield's own root); the note is spendable only at the next checkpoint; wallet suggests waiting and shows "your deposit is 1 of n recent 1 BNB shields" |
| root age → held | an intent landing with a root two windows old was held (or the user proved and waited) | 10-minute windows, individual jittered releases (§5.3); accepted as public, row 6 |
| plant → first buy | an intent seconds after `PlantedPrivately` is the creator's | the first buy is held until two others join BUY (§2.6.6) |
| unshield → prior epoch | an unshield equal to a plausible pro-rata share | denominations; mixed inputs |
| IP ↔ action | the relayer sees both | Tor, independent relayers, no logs |
| artifact fetch / RPC read ↔ action | the web host would see "a browser fetched the intent zkey / read coin X" minutes before an intent | prefetch at key creation, Service Worker; all-coin reads (§5.1) |

### 6.4 Trust statement (verbatim for /docs/privacy and /docs/trust)

"In this release a single Epoch Coordinator run by zkBNB holds the key that decrypts private-trade amounts. Its
software decrypts only the total of each batch, but the key itself could decrypt how much each private intent is
for and could tell which private trades belong to the same person; it never learns who that person is, and it
cannot take, redirect or freeze anything: if it stops, every epoch voids and every intent is refunded. The key is
replaced every day and the old one destroyed, so a leak would expose at most one day of intents. The relayer that
submits your transactions sees your IP address and never your amounts; it runs on a different machine with no
shared logs. The threshold committee that removes the Coordinator's view is stage 3, and until it ships we do not
call amounts private from zkBNB itself."

---

## 7. Migration from the live chain-56 deployment

Live: Launchpad `0x6dF7…95B5`, FeeRouter `0xd480…1748`, Roots `0x3124…7d93`, HolderRewards `0x16b5…5B13`,
DonationRotator `0xB33b…A580`, ShieldedPool v1 `0x9fd2…d055`, Verifier `0xF926…2282`, PoseidonT3 `0x5B17…4eF6`,
PoseidonT4 `0xB1FE…685a`, FlapBuyback `0x6DEc…F795`, treasury Safe `0x4D55…179f`, $ZKBNB `0xe3E9…7777` on Flap,
plus `darkPool` / `darkVaultImpl` once stage 1 is deployed. `FeeRouter.setModules` and `Roots.setHolderRewards`
are one-shot; `Roots`, `HolderRewards`, `DonationRotator` hold `pool` as `immutable`; nothing is upgradeable.

**Additive deployment, no live contract touched** (`contracts/script/DeployPrivacy.s.sol`, chains 97 then 56):

0. **Ceremony first** (§3.5): chain 56 is deployed only with ceremony verifiers; `deploy.sh 56 --privacy` checks
   the vkey hashes against `CEREMONY-HASHES-v2.txt`. Testnet 97 may use dev keys and is redeployed afterwards.
1. `PoseidonT3`, `PoseidonT4` (Yul, `poseidon-solidity`); verifiers `Transfer`, `Intent`, `Claim`, `Open`.
2. `GrovePool(transferVerifier, poseidonT3, poseidonT4, launchpad, holderRewards, v1Pool, owner = Safe)` (the
   `BabyJubjub` library is `internal` and inlined; it has no address).
3. `DarkCurve(pool, launchpad, roots, router, treasury, intentVerifier, claimVerifier, openVerifier, owner = Safe)` with
   default `Params` (`claimGas` from `contracts/gas-v2.json`), `coordinatorKey` from `COORDINATOR_PK_X/Y`.
4. `Planter(pool, launchpad, feeRouter, roots)`.
5. `pool.setModules(darkCurve, planter)`; `pool.addUnshieldDenomination` × 10 (Appendix B); `pool.addTokenLot` × 10;
   `darkCurve.fundClaimBudget{value: 0.5 BNB}`.
6. `forge verify-contract` per module (extend `deploy.sh` `VERIFY_MODULES` and `check_deployed`).
7. `deployments/<chainId>.json` += `grovePool, darkCurve, planter, poseidonT3v2, poseidonT4v2, verifierTransfer,
   verifierIntent, verifierClaim, verifierOpen, privacyStartBlock`. The v1 keys stay.
8. Keeper: `coordinator` on host B, `relayer` on host A, `pool-feed`, `dividends`, `flush`; `EXCLUDE_ADDRESSES`
   gains `darkCurve`, `planter`; `rewards` includes `grovePool`.
9. Web: `npm run sync` (ABIs, three artifact sets, lib v2), deploy, **promote** (HANDOFF gotcha).
10. `ShieldedPool v1.setMaxDeposit(0)` is **deferred**: a withdraw-only v1 is a shrinking, publicly enumerable set
    in which every late withdrawal or migration is drawn from fewer and fewer unspent notes (the last-k problem).
    The Safe closes v1 deposits only once v1's unspent set is a small fraction of its all-time deposits and the
    live `depositFor` payers (`Roots`, `HolderRewards`, `DonationRotator`) have successors (§8).

**Existing coins** trade privately from day one (`submitIntent` requires only `info(coin).creator != 0`); graduated
coins via the router path. **Existing v1 notes — the honest advice is not to migrate.** v1 shields are
wallet-attributed, the v1 key is `keccak(sign("zkBNB shielded key v1"))` (any dapp could have requested it, and its
holder recomputes v1 nullifiers and sees which migration is yours), and migrations are known-amount credits: a user
who migrates 2 + 1 + 0.5 BNB in three relayed txs emits credits that sum to one wallet's v1 deposits, and the next
`HandleClaimed` is that wallet's first v2 spend. The wallet therefore recommends *Spend from v1* (unshield to fresh
addresses; shield anew later, in denominations, after waiting) and offers *Migrate slowly* only as the fallback:
`migrateFromV1` per denomination, **a fresh one-shot handle per migration**, relayer-held with random delays spread
over **days** (`notBefore`, §5.3), and a warning when the sum of a user's migrations would equal one of their v1
deposits. **Existing dark vaults**: unchanged; their proceeds land in v1 and are spent or migrated the same way;
owner keys derive from the v1 key as today. **Donate-mode coins**: unchanged; causes keep spending from v1 or
migrate slowly. **Rollback**: additive; disabling means taking the UI down; funds stay claimable forever (void
path, unshields) because no contract has admin over them.

---

## 8. Effort and the stages after this one

| WP | Scope | Eng. weeks |
|---|---|---|
| circuits | note/keypair/elgamal templates, C1–C3, C5, `grove-zk-v2.mjs` (notes, keys, ElGamal, BSGS, prepare*, scan), fixtures, node tests with real proofs, measurements | 4 |
| contracts | tree v2, GrovePool, DarkCurve + BabyJubjub, Planter + CreatorStub, verifiers, forge unit/fuzz/fork tests, deploy script | 4.5 |
| web | keys v2, store, bundle sync, 3-zkey worker, Private panel, wallet, create-privately, docs, relay client | 4 |
| keeper-relayer | coordinator, pool-feed, dividends, flush, rewards change, standalone relayer with holds and tiers | 2.5 |
| ceremony | PoT 16, ≥ 5 outside contributors × 4 zkeys, drand, transcript, hash pinning | 0.5 eng + 2–3 elapsed |
| review + audit prep | internal adversarial review (division witnesses, selector soundness, escrow accounting, DL bounds, reentrancy on `moveOut`), fork tests on 56 | 1.5 |
| **Total before external audit** | | **≈ 15–17 engineering weeks** (≈ 4 months for one engineer with agents, ≈ 8–10 weeks for three parallel agents plus integration) |

**Stage 3 — threshold Coordinator** (gate for marketing "private amounts"): `ecPk` becomes a 3-of-5 committee key
(DKG off-chain among the operator, two independent relayer operators, two ceremony contributors); `openEpoch`
accepts `t` share proofs (`epochOpenShare.circom`) and combines them; user circuits unchanged. ≈ 3 engineering weeks.

**Next deployable cycle — handle-crediting successors for the v1 `depositFor` payers**: `Roots.harvestShielded`,
`HolderRewards.claimShielded` and `DonationRotator` ring payouts hold the v1 `pool` as `immutable` and publish
`pubKey + amount`. Successors (`RootsV2.harvestToHandle`, `HolderRewardsV2.claimToHandle`, a rotator paying
`GrovePool.credit(handle)` to causes) need a `FeeRouter` redeploy or a new `setModules` cycle and are scoped with
the stage-3 work; until then those endpoints are documented as public (§6.1 row 11c) and not offered by the UI.

**Owner decision, separate** — Launchpad v2 with a batch-only curve (attacker phase 2): sandwich-free and
snipe-free for everyone, but public buyers also wait for an epoch; it changes the product and costs a second audit.
Not part of this spec.

---

## Appendix A. Constants (byte-identical in `circuits/lib/grove-zk-v2.mjs` and `contracts/src/libraries/GroveConstants.sol`)

```
FIELD_SIZE   = 21888242871839275222246405745257275088548364400416034343698204186575808495617
ZERO_LEAF    = keccak256("grove-v2") mod p        = 1014863620666096670253896730964143634766893057150169129055179254946258934505
INTENT_TAG   = keccak256("grove-v2/intent") mod p = 5485727973690184042573032548250662701561163999721995087532894922013676652701
HANDLE_TAG   = keccak256("grove-v2/handle") mod p = 4197082601223926234440412842350092754680596943151188710592157759256107473565
OWNER_TAG    = keccak256("grove-v2/owner") mod p  = 4084283354661981865798945521922129247864409744154712678450526337611273152227
RESULT_TAG   = keccak256("grove-v2/result") mod p = 19481998103912434576622020492478150961191355642108690953568066567392742677477
LEVELS       = 23                            CHUNK = 4 leaves per transaction (nextIndex ≡ 0 mod 4)
CHECKPOINT_PERIOD = 600 s
UNIT_BNB     = 10_000_000_000_000 (1e13)     UNIT_TOKEN = 1_000_000_000_000_000_000 (1e18)
U_BITS       = 32                            MIN_U_BNB = 5_000 (0.05 BNB)    MIN_U_TOKEN = 50_000
INTENT_FEE   = 2_000_000_000_000_000 wei (0.002 BNB) → treasury
MAX_INTENTS  = 256                           ⇒ Σu < 2^40 = 1_099_511_627_776
RPT_SCALE    = 1e18
Baby Jubjub  a = 168700, d = 168696, subgroup order l = 2736030358979909402780800718157159386076813972158567259200215660948447373041
B8.x         = 5299619240641551281634865583518297030282874472190772894086521144482721001553
B8.y         = 16950150798460657717958625567821834550301663161624707787222815936182638968203
Dir          BUY = 0, SELL = 1, HARVEST = 2
ACTION_HANDOVER = 1, ACTION_PLANT = 2          (first word of a transact payload)
Keys         ask = keccak256(seed ‖ "zkbnb2/ask") mod p; pk = Poseidon(ask); nk = Poseidon(ask, 1); ovk = Poseidon(OWNER_TAG, ask)
Handles      salt(n) = Poseidon(ovk, n), n ≥ 1; handle(n) = Poseidon(HANDLE_TAG, ovk, salt(n)); salt is a private witness
ElGamal k    = keccak256("zkbnb2/elgamal" ‖ ask ‖ inputNullifier[0]) mod l
EIP-712      name "zkBNB", version "2", verifyingContract = GrovePool; type ShieldedKey(string purpose)
Key strings  "zkbnb2/ask", "zkbnb2/enc", "zkbnb2/elgamal"; address prefix "zkbnb2"; FVK prefix "zkbnb2view"
Epoch params T_MIN 60, T_MAX 300, K 5 (per direction), GRACE 1800, BAND_BPS 1000, BAND_FLOOR 0.5 BNB, OVERLAP 600; bounds as §2.6.1
Claim        claimGas: NOT a constant — Params field set from contracts/gas-v2.json (bounds 300k..3M); maxReimburseGasPrice 5 gwei
Fee tiers    [2e14, 5e14, 1e15, 2e15, 5e15] wei;  gasUnits per kind: NOT constants — contracts/gas-v2.json
Shared test vector  circuits/test/fixtures/keys.json: seed → ask, pk, nk, ovk, encPub, address, handle(1), salt(1)  (copied into web/test/fixtures and keeper/test/fixtures; a mismatch fails every suite)
```

## Appendix B. Denominations and lots (on-chain; owner may only add)

BNB unshields: 0.01 · 0.02 · 0.05 · 0.1 · 0.2 · 0.5 · 1 · 2 · 5 · 10 BNB (= `web/src/lib/zk/denominations.ts`).
Token lots (× 1e18): 1e5 · 2e5 · 5e5 · 1e6 · 2e6 · 5e6 · 1e7 · 2e7 · 5e7 · 1e8. Shields are steered by the UI,
not enforced.

## Appendix C. JSON schemas

```ts
// relay.ts additions (uints as decimal strings, bytes/addresses 0x hex)
interface TransferPublicJson { root; publicAmount; coin: Hex; publicAmountCoin; accRpt; handle; claimAmount; extDataHash: Hex; inputNullifiers: [s,s]; outputCommitments: [s,s,s] }
interface ExtData2Json      { recipient: Hex; extAmountBnb; extAmountCoin; relayer: Hex; fee; payload: Hex; encryptedOutputs: [Hex,Hex,Hex] }
interface IntentPublicJson  { root; publicAmount; coin: Hex; accRpt; dir: 0|1|2; ecPk: [s,s]; c1: [s,s]; c2: [s,s]; extDataHash: Hex; inputNullifiers: [s,s]; outputCommitments: [s,s,s] }
interface IntentExtJson     { relayer: Hex; fee; encryptedOutputs: [Hex,Hex,Hex] }
interface ClaimPublicJson   { root; nullifier; outputCommitments: [s,s]; extDataHash: Hex }
interface ClaimExtJson      { relayer: Hex; encryptedOutputs: [Hex,Hex] }
interface OnChainPolicyInput { coordinatorKey: [[s,s],[s,s]]; keySwitchAt: number; plantFee: s; seenC1: boolean }   // filled by the server, consumed by the pure policies
type RelayKind2 = "transfer" | "plant" | "intent" | "claim" | "v1migrate" | "transact" | "fill" | "vault";

// contracts/gas-v2.json (written by forge test gas logs; read by the relayer and by DeployPrivacy for params.claimGas)
{ "measuredAt": string, "commit": string, "transfer": number, "plant": number, "intent": number, "claim": number, "v1migrate": number, "openEpoch3": number, "voidEpoch": number }

// sync bundle (keeper pool-feed → Blob; browser sync.ts)
manifest.json { chainId, grovePool, darkCurve, fromBlock, toBlock, nextIndex, chunkSize: 4096, chunks: [{ file, fromIndex, toIndex, sha256 }], checkpoints: [{ root: s, indexAfter: number, period: number }], updatedAt }
chunk-<n>.json {
  leaves:     [{ i: number, leaf: string, enc: Hex, kind: "note"|"intent"|"result"|"zero" }],      // enc "" for result and zero leaves
  nullifiers: string[],
  intents:    [{ leaf: string, coin: Hex, dir: 0|1|2, seq: number }],
  epochs:     [{ coin: Hex, dir: 0|1|2, seq: number, status: "opened"|"voided", totalIn: s, totalOut: s, refund: s, rptAtSettle: s, resultLeaf: s|null }],
  credits:    [{ handle: string, amount: s, block: number, claimedAmount: s }],
  accRpt:     [{ coin: Hex, values: s[] }]
}
// epochs.json (keeper, every 15 s; identical to GET /relay/epochs)
{ chainId, coins: { [coin: Hex]: [{ seq, startedAt, count, openableAt, refPrice }, { … }, { … }] }, updatedAt }
// relayers.json
[{ name: string, url: string, onion?: string, address: Hex, chainId: number }]
```

## Appendix D. Decisions where the judges disagreed

- **Launchpad v2**: cut (all three judges). Private trades hit the live curve as an account.
- **In-pool rewards**: `accRpt` accumulator, not roots routing (judges 0, 1, 2).
- **`minCount` voiding**: replaced by relayer-held intents against a contract-stamped epoch (judge 0 offered either;
  this one has no on-chain state and no ciphertext subtraction).
- **ElGamal limbs**: one 32-bit limb with a 256-intent cap (same 2^40 bound as maximal's two limbs, fewer constraints).
- **Denominations on-chain**: enforced for unshields and token edges (judges 1, 2), steered for BNB shields (a
  shield is already attributed to its wallet; four proofs per deposit would be the only effect).
- **Slippage**: an epoch-level manipulation band plus private-tx submission; no per-intent limit (judge 0's leak
  argument beats judge 1's request, and judge 1 asked only that the gap be designed, not hidden).
- **Handle circuit**: folded into the transfer circuit (one zkey fewer; known-amount credits are mixed at claim).
- **Internal matching**: none; three venue calls (auditable, full 2 % to the flywheel).
- **Private plant creator mode**: `Creator` through the stub so `handOver` survives (fixes the regression both
  maximal and shippable accepted).
- **Threshold Coordinator**: stage 3, and the gate for the word "private" about amounts in marketing (judge 1).
- **Root history** (review): shippable's "every root" became "every checkpoint" — the unbounded part survives,
  the per-insert pin does not.
- **Epoch granularity** (review): per `(coin, direction)`, not per coin; `K` counts one side.
- **Coordinator decryption** (review): sum-only in stage 2 as well; daily key rotation with destruction.
- **Poseidon** (review): new Yul hashers and 4-leaf chunk inserts instead of reusing the circomlibjs bytecode —
  the reuse was a convenience, and it cost 2–2.5× on every transaction.

---

## Review log (2026-10-05 adversarial review of this file and the work plan)

Twenty findings were raised. Nineteen are accepted and folded into the text above; the table records where, and
the one partial rejection with its reason. Severity is the reviewer's.

| # | Finding (short) | Sev. | Verdict | Where it landed |
|---|---|---|---|---|
| 1 | Every root is an exact timestamp (`rootIndexAfter` per insert) linking intents to shields and held claims to their epoch | critical | accepted | §2.1 checkpoint roots (10-min windows, `checkpoint()`), §4.1, §2.6.5 lazy claim proving (no relayer-held claims), §5.3 jittered individual releases, §6.1 row 6, §6.3; §0.1(6) reworded to "no payout event links a wallet to a leaf" |
| 2 | Crowd counted across directions; `N = 1` buy → `N = 1` sell reconstructs a position | high | accepted | §2.6.1 epochs per `(coin, dir)`, `K` per direction, hold per direction, UI lot steering; §1.2, §4.3 (`cur[coin][dir]`, per-direction events), §5.1, §6.1 row 1, Appendix C |
| 3 | Coordinator links intents across epochs; no forward secrecy if `ecSk` leaks | high | accepted | §2.7 sum-only decryption in stage 2, daily rotation + destruction procedure; §5.2 `rotate-key`; §6.1 row 10; §6.4 trust statement names linkability and the one-day bound |
| 4 | Creator handle salt 0 links all of a creator's coins | high | accepted | §2.2 one-shot `handle(n)` for everything, no special salt; `handleSalt` is a private witness (§3.1); §2.8, §1.2 |
| 5 | Web/hosting telemetry: lazy zkey fetch, per-coin RPC reads, Vercel proxy fallback, image upload | high | accepted (1–3), **rejected (4)** | §3 and §5.1 prefetch at key creation + Service Worker; `epochsOf(all coins)` / multicall / `epochs.json`; Vercel `/api/relay` fails closed for stage-2 kinds (§0.3, §5.3); §6.1 row 11b. **(4) is not real**: `PlantForm.tsx` re-encodes the image locally (`stripAndEncode`, EXIF stripped) into a data URL stored on-chain in `PlantParams.metadata.image`; there is no Blob upload and no upload API route in `web/src/app/api` (only `relay` and `rpc`), so no upload log can link a coin to an IP. §5.1 states the on-chain path explicitly |
| 6 | Migration re-attributes v1 users; v1 becomes a shrinking set; the phishable v1 key watches it | medium | accepted | §7: "do not migrate" as default advice, fresh handle per migration, relayer-held `notBefore` over days, sum warning, `setMaxDeposit(0)` deferred; §2.9 and §6.1 row 11c document the v1 `depositFor` payers; §8 successors |
| 7 | Dust sybils satisfy the hold knob for ~0.03 BNB | medium | accepted (with an honest ceiling) | `MIN_U_BNB` 0.05 BNB, `MIN_U_TOKEN` 50,000, flat `INTENT_FEE` 0.002 BNB to the treasury (§2.6.1, §4.3); §6.2 reprices the attack (~0.015 BNB for three) and says the knob is not a targeted defence; UI wording "others (may include bots)". The reviewer's "> 0.2 BNB" would price out honest small buyers; the Coordinator-refuses-to-open idea is unavailable once decryption is sum-only (finding 3) |
| 8 | The privately planted coin's first buy is alone in epoch 0 | medium | accepted | §2.6.6 held first buy (`minOthers: 2`), skip option, honest sentence on the create page; §0.1(4), §2.8, §5.1, §6.3 |
| 9 | Relayer selection is a persistent pseudonym | low | accepted | §2.10 warning and default-relayer rule; claims always via the default relayer (§2.6.5); §6.1 row 6; §2.6.7 |
| 10 | ElGamal `k` reuse unenforced | low | accepted | §2.6.2/§2.7 deterministic `k = H("zkbnb2/elgamal" ‖ ask ‖ nf0) mod l`; `seenC1` on-chain (`ReusedRandomness`) and in the relayer policy; Appendix A |
| 11 | Gas figures 2–2.5× too low; frozen constants wrong; no `plant` kind | high | accepted | §4 intro states the measurements; Yul `poseidon-solidity` hashers and 4-leaf chunk inserts (§2.1, §4.1); `claimGas` is a Params field and `gasUnits` come from `contracts/gas-v2.json` (§2.6.5, §2.10, Appendix A/C); `plant` relayer kind (§5.3) |
| 12 | 10 % band anchored at the first intent voids every batch on busy coins; one venue revert voids all directions | high | accepted | §2.6.3 directional band (BUY on pumps, SELL on dumps, HARVEST never) with `BAND_FLOOR` 0.5 BNB of reserve; `openEpoch(dirMask, …)` opens a subset so a failing side never blocks the others; §2.6.6, §2.6.7; fork test in WP §2.3 |
| 13 | Private plant cannot execute (plant fee is not a denomination) | high | accepted | §4.2 rule 1 exemption `recipient == planter ⇒ amount == launchpad.plantFee()`; §2.8; rule 6 dispatch on `ACTION_PLANT` / `ACTION_HANDOVER`; WP: end-to-end plant through `transact`, `plantPolicy` |
| 14 | Handle claims griefable with a 1-wei `credit` | medium | accepted | `claimAmount` public input, `≤ claimable`, subtract (§2.4, §3.1, §4.2); 13-signal order updated in WP §1.2 |
| 15 | Two definitions of `ovk` | medium | accepted | `ovk = Poseidon(OWNER_TAG, ask)` everywhere (§2.2, §3.1, Appendix A); shared `keys.json` vector in all three test suites |
| 16 | BSGS over 2^40 is ~40 s, not milliseconds | medium | accepted | §2.7 2^24 table with 8-byte truncated x (128 MB, ≤ 2^16 giant steps ≈ 2.4 s); WP acceptance rewritten (`u < 2^32` in < 300 ms with 2^20; `Σu < 2^40` in < 5 s with 2^24) |
| 17 | Ceremony plan assumes swappable verifiers; r1cs not pinned | medium | accepted | §3.5 hard gate for chain 56 (`deploy.sh` checks vkey hashes), r1cs sha256 + circom version + flags published, `snarkjs zkey verify` required, `−O2` before the ceremony; §4.5, §7 step 0 |
| 18 | Claim circuit has non-quadratic constraints; `a` bit-width stated twice | low | accepted | §3.3 intermediate signals `qt`, `qrt`; `Num2Bits(96)(a)` once |
| 19 | Seven interface ambiguities (sum representation, `babyJubjub` address, `ILaunchpadFull`, `accRpt` equality, leafIndex wording, impure policy, frozen order) | low | accepted | `Point` extended struct and affine fixtures (§4.3, §2.7); library inlined, dropped from the JSON (§2.7, §7); `ILaunchpadFull` extended in place (WP §2.1); `knownAccRpt[coin][s.accRpt]` (§2.5, §2.6.2); §2.1 wording; `onChain` policy input (§5.3, Appendix C); WP §1.2 |
| 20 | Five packages launched onto a tree with uncommitted stage-1 edits | low | accepted | WP §0: stage 1 is committed first and every package runs in its own `git worktree` |

Also corrected while applying the findings: the live `Launchpad` has no `isCoin` view (the spec called one); coin
existence is `launchpad.info(coin).creator != address(0)`, wrapped as `GrovePool.isCoin` (§2.6.2, §4.2).
