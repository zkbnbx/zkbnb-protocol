# Security policy

zkBNB is live on BNB Smart Chain mainnet with real funds. Please report vulnerabilities privately.

## Reporting a vulnerability

Open a private GitHub security advisory on this repository
(Security tab, "Report a vulnerability"). Do not open a public issue or pull request for a
vulnerability, and do not test against mainnet contracts with funds that are not yours.

Please include:

- the affected contract, circuit or keeper file and function;
- a description of the issue and its impact;
- steps or a test to reproduce it (a forge test against a BSC fork is ideal);
- whether you have shared it with anyone else.

We will acknowledge the report, keep you informed while we work on it, and credit you when it is
disclosed unless you ask us not to.

## Scope

In scope:

- `contracts/src/*`: Launchpad, GroveCoin, FeeRouter, Roots, HolderRewards, DonationRotator,
  ShieldedPool, MerkleTreeWithHistory, FlapBuyback, Groth16Verifier, interfaces.
- The mainnet deployment listed in `contracts/deployments/56.json`.
- `circuits/transaction.circom`, `keypair.circom`, `merkleProof.circom` and the proving key
  described in `circuits/CEREMONY.md`.
- `circuits/lib/grove-zk.mjs` (note encryption, nullifiers, proof inputs).
- `keeper/` where a bug lets someone other than the keeper move funds or post a wrong snapshot.

Out of scope:

- The $ZKBNB token contract and the Flap portal (third-party code).
- PancakeSwap, the Binance-Peg ZEC token, and other external protocols.
- The web app, hosting and RPC providers.
- Issues that need the owner Safe or the keeper key to act maliciously, unless they let that
  role do more than SPEC.md section 3.8 and the notes below allow.
- Test files, mocks and deploy scripts.

## Audit status

- Internal pre-launch review: [contracts/SECURITY-REVIEW.md](contracts/SECURITY-REVIEW.md).
- No external audit yet. An audit by [Shieldify](https://shieldify.org) is planned.

## Known issues

These are known and accepted for now. Reports about them are not needed unless you find a worse
consequence than the one described.

1. **FlapBuyback path and buyback cap are owner-set without bounds (low / medium, admin trust).**
   The owner can change the PancakeSwap V3 path from WBNB to ZEC with
   `FlapBuyback.setBnbToQuotePath`. Only the first and last tokens are checked, so the path can
   go through any intermediate token and pool. The owner can also raise
   `FeeRouter.publicBuybackCap` without limit. Once $ZKBNB trades on PancakeSwap, the BNB to ZEC
   leg is swapped with `amountOutMinimum = 0`; only the caller's final `minOut` bounds the result,
   and a public caller can pass 0. A malicious or compromised owner could route the rootstock pot
   through pools it controls and take most of the BNB meant for the $ZKBNB buyback. Only the rootstock pot (0.50% of fees) is
   exposed; roots vaults, holder-reward pots, ring pots and the shielded pool are not. The owner
   is a Safe (currently 1-of-1, see issue 9), and path changes emit `BnbToQuotePathSet`.
2. **Keeper trust.** `HolderRewards.postRun` accepts any Merkle root from the keeper. A
   compromised keeper key can pay a Holders-mode coin's reward pot to itself. Roots, ring pots
   and the shielded pool are not reachable. The keeper is also the uncapped caller of
   `sweepTax` and `buybackAndBurn`.
3. **Trusted setup.** The phase 2 ceremony had two contributions from the same operator on two
   machines, plus a drand beacon. If both contributions leaked their toxic waste, proofs could be
   forged and BNB taken from the shielded pool, up to its balance. No other contract depends on the
   proof system. An open multi-party ceremony is planned.
4. **Tree depth 20.** The pool has room for about 500k transactions. When it is full it becomes
   withdraw-only (`CommitmentDropped`); funds are never locked.
5. **Public sweep and buyback MEV.** Non-keeper `sweepTax` and `buybackAndBurn` calls are capped
   per block, which bounds sandwich losses but does not remove them.
6. **Pair-tax bypass.** Only the canonical PancakeSwap V2 pair of a graduated coin is taxed.
   Trading through another pool avoids the 2% creator fee.
7. **Privacy limits.** `depositFor` reveals the amount and the recipient key. A relayer sees the
   IP address of the withdrawer. Shielding and unshielding the same amount is linkable.

More detail on items 2 to 7: section 3 of [contracts/SECURITY-REVIEW.md](contracts/SECURITY-REVIEW.md).

8. **Module links the owner can re-point (medium, admin trust).** `Launchpad.setRoots`,
   `HolderRewards.setSources` and `DonationRotator.setFeeRouter` are not one-shot. A malicious owner
   could point `DonationRotator.feeRouter` at itself and call `bindCoin` to move a Donate-mode coin to
   another ring, or point a module away from the live FeeRouter so `FeeRouter.collect` reverts and
   trades and sweeps of Holders- or Donate-mode coins stop. Fixing it needs a redeploy (make the setters
   one-shot, like `FeeRouter.setModules`).
9. **Single-key admin (medium, operational).** The owner Safe currently has one owner and threshold 1, so
   one compromised key controls every owner power above and the treasury. Adding owners (including a
   hardware wallet) and raising the threshold is planned.
