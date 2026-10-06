# zkBNB audit scope

Scope document for an external security review of the zkBNB protocol.
Commit to audit: **to be filled with the public repo commit**.

## 1. Protocol summary

zkBNB is a token launchpad on BNB Smart Chain (chain 56). It is live on mainnet.

- Anyone can plant a coin (`GroveCoin`, ERC-20, 1B supply). It trades on a constant-product
  bonding curve in `Launchpad`, paired to native BNB.
- When the curve sells out (~11.33 BNB net), the coin graduates to a PancakeSwap V2 pair. The LP
  goes to `0xdEaD`. After graduation a 2% pair-tax on the coin replaces the curve fee.
- Every 2% creator fee goes to `FeeRouter` and is split at once: 0.50% roots, 0.50% rootstock,
  0.20% operator treasury, 0.80% deployer's choice (creator, another wallet, holders, or a
  donation ring).
- Roots: a per-coin BNB vault. Holders burn coins to harvest `roots x burned / totalSupply`.
- Rootstock: on mainnet the rootstock token is `$ZKBNB`, a Flap tax token paired with Binance-Peg
  ZEC. `FlapBuyback` buys it with the rootstock pot and sends it to `0xdEaD`.
- `ShieldedPool`: a Groth16 shielded BNB pool (tornado-nova shape, 2-in-2-out join-split,
  Poseidon Merkle tree of depth 20). Harvests, holder rewards and donations can be paid as
  shielded notes through `depositFor`.
- `HolderRewards`: Merkle distributor. The keeper posts a snapshot root per run.
- `DonationRotator`: causes and rings. Each epoch a ring's pot is paid to the next cause as a
  shielded note (or to its fallback wallet).
- **Dark pools** (`DarkPool`, `DarkVault`, added 2026-10-06): trade a coin from inside the shielded
  pool without a wallet on the trade. An order (coin, BNB, min tokens, a fresh owner key, deadline,
  nonce) fixes a counterfactual vault address (CREATE2 clone of `DarkVault`, salt = hash of the
  order). A pool withdrawal pays that address; `DarkPool.transactAndFill` does the withdrawal and
  the buy in one transaction, creating the vault. The vault then only acts on its owner key, via an
  EIP-712 `relay` meta-transaction submitted by a relayer, and pays sells, harvests and leftover BNB
  back into the pool through `depositFor`. Neither contract has an admin. The owner key is derived
  from the user's shielded key in the browser (`keccak256(privkey, "zkBNB dark vault v1", index)`).

Design reference: `SPEC.md` (§3.9 for dark pools) and `privacy/DARKPOOL-SPEC.md`. Internal review:
`contracts/SECURITY-REVIEW.md`; the dark-pool contracts had three internal adversarial passes
(fund safety, relayer/web binding, privacy claims) whose confirmed findings are fixed and
regression-tested in `contracts/test/DarkPool.t.sol` (review and integration rounds).
Ceremony: `circuits/CEREMONY.md`, `circuits/build/CEREMONY-HASHES.txt`.

## 2. In scope

nSLOC = non-blank, non-comment lines, measured on the files in this repository.

### Solidity (`contracts/src/`)

| File | nSLOC | Description |
|---|---:|---|
| `Launchpad.sol` | 307 | Coin factory, bonding curve, buy/sell, graduation to PancakeSwap V2 |
| `DonationRotator.sol` | 260 | Causes, immutable rings, epoch settlement into the shielded pool |
| `FeeRouter.sol` | 245 | Fee split, payout modes, handover, rootstock buyback, pull payments |
| `ShieldedPool.sol` | 140 | Groth16 join-split pool, `transact`, `depositFor`, nullifiers |
| `HolderRewards.sol` | 122 | Per-coin holder pots, keeper-posted Merkle runs, claims, expiry |
| `FlapBuyback.sol` | 108 | Buys `$ZKBNB` on the Flap curve or via PancakeSwap V3 + V2, sends it to `0xdEaD` |
| `GroveCoin.sol` | 91 | ERC-20 coin, 2% pair-tax after graduation, `sweepTax` |
| `Roots.sol` | 76 | Per-coin BNB vault, burn-to-harvest (public or shielded), cap overflow |
| `MerkleTreeWithHistory.sol` | 70 | Incremental Poseidon tree, depth 20, 100-root history |
| `interfaces/IGrove.sol` | 68 | Internal interfaces and the `PayoutMode` enum (+ `ILaunchpadFull`, `IShieldedPoolFull`, `IRootsHarvest` for the dark pool) |
| `interfaces/IFlap.sol` | 59 | Flap Portal, PancakeSwap V3 router, `IRootstockBuyback` |
| `interfaces/IPancake.sol` | 42 | PancakeSwap V2 router, factory, pair, WBNB |
| `DarkVault.sol` | 182 | **Dark pools, added 2026-10-06.** Per-order position vault (EIP-1167 clone): `buyFromFactory`, owner path `buy` / `sell` / `harvest` / `shield` / `exec`, EIP-712 `relay(data, fee, deadline, sig)` meta-transaction whose signature names its submitter, proceeds back into `ShieldedPool.depositFor` minus the relay fee |
| `DarkPool.sol` | 88 | **Dark pools, added 2026-10-06.** Counterfactual vault factory: `vaultFor(order)` = CREATE2 clone address with salt `keccak256(abi.encode(order))`, lenient `fill(order)` (vault always created once funded; empty revert data = out-of-gas = fatal), strict `transactAndFill(proof, extData, order)` (pool withdrawal to the vault + buy, everything or nothing) |
| **Hand-written Solidity** | **1,858** | |
| `Groth16Verifier.sol` | 118 | **Generated** by snarkjs 0.7.6 from the ceremony zkey. Review the wiring, not the template |
| `poseidon/PoseidonT3.bin`, `PoseidonT4.bin` | n/a | **Generated** EVM bytecode (circomlibjs `poseidonContract.createCode(2/3)`). No Solidity source |

### Circuits (`circuits/`)

| File | nSLOC | Description |
|---|---:|---|
| `transaction.circom` | 84 | 2-in-2-out join-split: commitments, nullifiers, tree membership, balance, `extDataHash` binding |
| `merkleProof.circom` | 25 | Poseidon Merkle path check, depth 20 |
| `keypair.circom` | 20 | `pubKey = Poseidon(privKey)`, signature used in the nullifier |
| **Circuits** | **129** | Groth16 over BN254. 26,982 constraints, 7 public inputs, 54 private inputs |

Circuit libraries (`circomlib` Poseidon, comparators) are dependencies, not in scope.

### Client library

| File | nSLOC | Description |
|---|---:|---|
| `circuits/lib/grove-zk.mjs` | 406 | Shared zk client: keys, note encryption (x25519 + XChaCha20-Poly1305), commitments, nullifiers, Merkle tree, proof inputs, `extDataHash`, note scanning |

The web app and keeper both use this library. A bug here can lose or leak user notes even when
the contracts are correct, so it is in scope.

### Totals

| Part | nSLOC |
|---|---:|
| Solidity, hand-written | 1,858 |
| Solidity, generated verifier | 118 |
| Circom | 129 |
| JavaScript client library | 406 |
| **Total** | **2,511** |

## 3. Out of scope

- The web app (`web/`, not in this repository).
- Keeper off-chain logic (`keeper/`). Exception: where the keeper's on-chain powers affect safety
  (`HolderRewards.postRun`, uncapped `sweepTax` and `buybackAndBurn`). Those powers are in scope.
- OpenZeppelin Contracts 5.1.0, forge-std 1.17.0, circomlib, snarkjs, circomlibjs, noble.
- PancakeSwap, Flap and Binance-Peg ZEC contracts themselves. Our use of them is in scope.
- Tests, mocks and deploy scripts (`contracts/test`, `contracts/script`, `circuits/scripts`),
  including `DeployDarkPool.s.sol`.
- The dark-pool browser code (owner-key derivation, EIP-712 signing, pending-order recovery) and
  the relayer route live in the web app, outside this repository. Their contract-facing rules are
  stated in `privacy/DARKPOOL-SPEC.md` §2–§3 for reference.
- The trusted setup itself. The transcript is public for review, but re-running it is not part of
  this review.

## 4. Trust model and admin powers

Every module is owned by a Safe, `0x4D55C01c968Af4292dAcED876c4113dcFE20179f`, which today has a single owner (threshold 1 of 1; more owners and a higher threshold are planned), through
`Ownable2Step`. The Safe is also the treasury. No contract is upgradeable. A separate keeper hot
key runs sweeps, buybacks, holder-reward runs and ring settlement.

The Safe can:

- `FeeRouter.setShares`: change the split. Bounds: roots >= 25% of the fee, treasury <= 20%,
  sum == 100%. Rootstock and deployer shares have no individual bound.
- `FeeRouter.setRootsPaused`: pause a coin's roots. While paused, its roots share goes to the
  immutable `recoveryAddress`. Existing roots BNB stays in `Roots`.
- `FeeRouter.setKeeper`, `setTreasury`, `setPublicBuybackCap` (no upper bound).
- `FlapBuyback.setBnbToQuotePath`: set the PancakeSwap V3 path. It must start at WBNB and end at
  ZEC; the pools in between are free.
- `HolderRewards.setKeeper`, `setParams` (min pot, claim window), `setSources`.
- `DonationRotator.setFeeRouter`, `setParams` (register fee, min epoch, treasury),
  `setCauseActive` (moderation).
- `Roots.setCap` (cap overflow goes to the coin's holder pot).
- `Launchpad.setPlantFee`, `setRoots`.
- `ShieldedPool.setMaxDeposit` (caps `transact` deposits only).
- One-shot, already used at deploy: `FeeRouter.setModules`, `FeeRouter.setExternalRootstock`,
  `Roots.setHolderRewards`.

The Safe cannot:

- Take BNB from `Roots`, or move a coin's existing roots balance.
- Re-point FeeRouter modules or the rootstock buyback after deploy.
- Change a coin's payout mode or payee after handover.
- Change a cause's shielded key or fallback wallet (cause owner only).
- Spend pool notes, freeze pool withdrawals (`maxExtAmount` and `maxFee` are constants), or
  block `depositFor`.
- Upgrade any contract.
- Touch a dark vault: `DarkPool` and `DarkVault` have no owner or admin. A vault obeys only the
  owner key named at creation (directly, or through a `relay` signed by it). `Launchpad.setRoots`
  is the one Safe power that reaches vaults: `DarkVault.harvest` resolves Roots from the Launchpad
  at call time.

Relayer trust (dark pools): the site relayer submits `transactAndFill` and `relay` calls. It cannot
change what they do (the order is bound into the vault address, which is bound into `extDataHash`;
a vault call is bound by the owner's signature, which also names the submitter), but it can decline,
delay until the deadline, or trade ahead of the user within their slippage like any mempool
watcher. It learns the order, the client IP and the pubKey proceeds are paid to.

Keeper trust: `HolderRewards.postRun` accepts any Merkle root up to the coin's pot. A malicious
keeper can pay a Holders-mode pot to itself. Roots and the pool are not reachable. Because the
Safe sets the keeper, this is also a Safe power.

Pool trust: soundness of the pool rests on the Groth16 setup. Phase 1 is Hermez Powers of Tau 15.
Phase 2 has two contributions plus a drand beacon (round 6519014). The setup is sound if at least
one contributor destroyed their randomness.

## 5. External integrations

| Integration | Address (chain 56) | Used by |
|---|---|---|
| PancakeSwap V2 router | `0x10ED43C718714eb63d5aA57B78B54704E256024E` | Launchpad graduation (factory + pair only, no `addLiquidityETH`), `GroveCoin.sweepTax`, FlapBuyback ZEC -> `$ZKBNB` |
| PancakeSwap V3 swap router | `0x1b81D678ffb9C0263b24A97847620C99d213eB14` | FlapBuyback BNB -> ZEC |
| Flap Portal | `0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0` | FlapBuyback: token status, curve buys while `$ZKBNB` is on the Flap curve |
| Binance-Peg ZEC | `0x1Ba42e5193dfA8B03D15dd1B86a3113bbBEF8Eeb` | Quote token of `$ZKBNB` |
| WBNB | `0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c` | Graduation, swap paths |

`$ZKBNB` is a Flap tax token. Buys on its V2 pair use the fee-on-transfer router variant.

## 6. Deployed mainnet addresses (chain 56)

From `contracts/deployments/56.json`. Start block 125962928. The 8 source contracts and the two dark-pool contracts are verified
on Sourcify (exact match). PoseidonT3/T4 are raw circomlibjs bytecode.

| Contract | Address |
|---|---|
| Launchpad | `0x6dF75DA4913B0f7c821C55248bA9513703C295B5` |
| FeeRouter | `0xd480Fba1Fe8014529F66a0aAf9A6abb9FbEE1748` |
| Roots | `0x3124a069DD2AA636a4C7263bf6f1898cd7F67d93` |
| HolderRewards | `0x16b5237FE9eb32402a8F5eEBad0f9c68a7055B13` |
| DonationRotator | `0xB33b779c83e910fCdAC34EA4474e0B99CA3aA580` |
| ShieldedPool | `0x9fd27a573551b2069191aB2DebC68Aa5Ba55d055` |
| Groth16Verifier | `0xF926E6119211c4FF885CaE0EA1043e6243862282` |
| FlapBuyback (rootstock buyback) | `0x6DEcA327986350133262aB9523acD82C1dB7F795` |
| PoseidonT3 | `0x5B171B64FC477Ed39E3b889C0e68368fc3324eF6` |
| PoseidonT4 | `0xB1FE38E856aDEEdc4Da1b4DbFf7bc38DfbF2685a` |
| `$ZKBNB` (Flap token, external) | `0xe3E96140f464196440959439CA42F01F986a7777` |
| DarkPool (dark pools, deployed 2026-10-06) | `0xade2c2E6F0edB8bc8d19ECc7BBcA466A9f60e3AF` |
| DarkVault implementation (cloned per order) | `0x6cbf0C7478956FB738E8129e960Ff4eEf4383605` |
| Owner / treasury (Safe) | `0x4D55C01c968Af4292dAcED876c4113dcFE20179f` |

Proving key: `transaction.zkey`, 11.9 MB, sha256
`a8bdcea4f74725dde22f08d63247b7e110385f6c329544ec1154baa55bdd1706`. Not in git. Served at
https://zkbnbx.com/zk/transaction.zkey (to be attached to a GitHub release).
`Groth16Verifier.sol` sha256 `fa47834653b58ff4a855228b3ca4aeae051cd2c853eeec4e7b8022b4f3cd396c`
matches `circuits/build/CEREMONY-HASHES.txt`.

## 7. Known issues

### Resolved in the internal review (`contracts/SECURITY-REVIEW.md`)

All fixed before mainnet, each with a regression test in `contracts/test/Security.t.sol`.

| # | Sev | Summary |
|---|---|---|
| F1 | High | A pre-created, pre-seeded PancakeSwap pair could block graduation, or drain the raise if fixed naively. Graduation now arbitrages the pair to the final ratio and mints directly. |
| F2 | Medium | Public `sweepTax(0)` / `buybackAndBurn(0)` were sandwichable. Public calls are now capped per block. The keeper is uncapped. |
| F3 | Medium | Owner could freeze pool withdrawals via limits. `maxExtAmount` / `maxFee` are now constants. |
| F4 | Medium | Owner could redirect any cause. `updateCause` is now cause-owner only. |
| F5 | Medium | Owner could re-point fee modules. `setModules` and `Roots.setHolderRewards` are one-shot. |
| F6 | Medium | A reverting cause wallet could block a ring. Payouts now fall back and defer to `pending`. |
| F7 | Medium | A full tree locked withdrawals. The pool now goes withdraw-only and drops outputs. |
| F8 | Low | Buyback leftover could double count a failed push. Now tracked with `totalPending`. |
| F9 | Low | Huge `epochLength` could strand a ring. Bounded by `MAX_EPOCH = 365 days`. |
| F10 | Low | `pubKey = 0` and `fee > 0` with no relayer burned funds. Both rejected. |

Accepted residual risks (section 3 of the review): keeper trust over holder pots, trusted setup,
tree depth 20 (~500k transactions), pair-tax bypass through a second pool (V3 or another DEX),
bounded public sweep/buyback MEV, a reverting treasury blocks planting, stray BNB sent to the
Launchpad is lost, and the privacy limits of `depositFor` and relayers.

### Open

- **FlapBuyback admin trust (Low/Medium).** The Safe can set the BNB -> ZEC V3 path to any pools
  that start at WBNB and end at ZEC, and can raise `publicBuybackCap` without bound. The V3 leg
  uses `amountOutMinimum = 0`; only the final `$ZKBNB` amount is checked against the caller's
  `minOut`. A malicious owner could route the rootstock pot through pools it controls. Not fixed.
- **Re-pointable module links (noted while preparing this scope, not yet reviewed).**
  `DonationRotator.setFeeRouter`, `HolderRewards.setSources` and `Launchpad.setRoots` are not
  one-shot. A new `feeRouter` on `DonationRotator` can call `bindCoin` and rebind a Donate-mode
  coin to another ring. Pointing either module away from the live FeeRouter makes
  `FeeRouter.collect` revert for Donate- or Holders-mode coins, which blocks their curve trades
  and sweeps. Please confirm the impact.

## 8. Areas of concern

In priority order:

1. **Shielded pool soundness.** Nullifier and commitment correctness end to end: circuit,
   `ShieldedPool`, `MerkleTreeWithHistory`, Poseidon bytecode wiring, `depositFor`
   commitments computed on-chain, and `grove-zk.mjs`. Double spends, forged notes, field
   overflow of `publicAmount`, `extDataHash` binding of recipient/relayer/fee, root history,
   withdraw-only mode when the tree is full.
2. **Circuit constraints.** Under-constrained signals, zero-amount inputs skipping the root
   check, range checks on amounts, path index handling, nullifier distinctness.
3. **Client library.** Key derivation from a wallet signature, note encryption and decryption,
   nullifier computation, note scanning (spent/unspent), proof input construction.
4. **Graduation math.** Curve exactness (quote == execution), the final buy that clears the curve,
   the pre-seeded pair arbitrage in `Launchpad._graduate`, refund ordering.
5. **Fee split bounds.** `FeeRouter.collect` rounding, share bounds, payout modes, handover
   irrevocability, `_push` / `pending` accounting, rootstock-coin special case.
6. **FlapBuyback refund accounting.** Leftover BNB returned to FeeRouter and re-added to
   `rootstockPot`, the `freeBefore` / `totalPending` arithmetic, ZEC left on the contract, curve
   vs DEX branch on Flap status, sandwich exposure of the V3 leg.
7. **DonationRotator settlement.** Epoch timing, cursor rotation and inactive causes, fallback
   and `pending` paths, public blinding, `withdrawPending`.
8. **Roots and HolderRewards.** Harvest ratio invariant, cap overflow, Merkle leaf encoding, claim
   window and `sweepExpired` accounting.
9. **Dark pools.** Can anyone other than the owner key move a vault's BNB or tokens? CREATE2 /
   clone address binding of the order (every field, including `nonce` and `deadline`), `initialize`
   once and only by the factory, the implementation locked (`owner = address(1)`), `fill`'s
   leniency rule (revert with data tolerated, empty revert data fatal: out-of-gas griefing),
   `transactAndFill` atomicity and its known non-atomic path (a third party submits the bare
   `transact` first; the BNB then sits at the codeless vault address and `fill(order)` is the only
   recovery, see the `@dev` note), EIP-712 `relay`: domain per clone, sequential nonce, signature
   over (data, fee, deadline, nonce, msg.sender), selector denylist (`relay`, `buyFromFactory`,
   `initialize`), `onlyOwner` self-call branch reachable only inside `relay`, re-entrancy through
   `exec` targets, `receive()` and the router's fee-on-transfer swaps, fee accounting
   (`proceeds - _relayFee` into `depositFor`, `FeeExceedsProceeds`, `FeeUnpaid`), the curve vs
   router branches after graduation with the 2% pair-tax, and whether a vault can ever be left
   with funds that no signature of the owner key can move.

## 9. Build and test

Requirements: Foundry (solc 0.8.26, `via_ir`, `evm_version = cancun`), Node 20+.

```sh
cd contracts
git clone --recurse-submodules https://github.com/zkbnbx/zkbnb-protocol.git   # or: git submodule update --init --recursive
# nested OpenZeppelin submodules are needed for the bytecode to match the deployed contracts exactly
forge build
forge test
```

Current result (forge 1.5.1, no fork env): **204 passed, 0 failed, 2 skipped** across 12 suites.

| Suite | Tests |
|---|---:|
| FeeRouter.t.sol | 34 |
| DarkPool.t.sol (dark pools: spec cases 1–14, review round, integration round) | 30 |
| Launchpad.t.sol | 25 |
| FlapBuyback.t.sol | 22 |
| Security.t.sol | 21 |
| DonationRotator.t.sol | 18 |
| HolderRewards.t.sol | 15 |
| GroveCoin.t.sol | 13 |
| Roots.t.sol | 13 |
| ShieldedPool.t.sol (real Groth16 proofs from `test/fixtures/pool.json`) | 13 |
| fork/MainnetFork.t.sol | skipped |
| fork/FlapRootstockFork.t.sol | skipped |

The two fork suites run against a BNB mainnet fork:
`BSC_FORK_URL=<rpc> forge test --match-path "test/fork/*" -vv`.

Circuit and client library:

```sh
cd circuits
npm ci
# download the proving key into build/ (sha256 above)
curl -o build/transaction.zkey https://zkbnbx.com/zk/transaction.zkey
npm test
```

Current result: **7 passed, 0 failed** (includes real proofs for deposit, private transfer,
withdraw and a `depositFor` spend). Without `build/transaction.zkey` the proof test is skipped.
