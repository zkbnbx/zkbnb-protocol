# zkBNB proving-key ceremony transcript

Circuit: `transaction.circom` (2-in-2-out join-split, Merkle depth 20, ~27k constraints),
compiled with circom2 0.2.23, Groth16 over BN254 via snarkjs 0.7.6.

## Phase 1

Hermez / iden3 "Powers of Tau 28" ceremony, `powersOfTau28_hez_final_15.ptau`
(37,831,832 bytes), downloaded from https://circom.info/powersOfTau28_hez_final_15.ptau.
This is the public multi-party ceremony used across the circom ecosystem.

## Phase 2 (circuit-specific)

| # | Who / where | Entropy | Note |
|---|---|---|---|
| 1 | Developer workstation (Windows), 2026-10-02 | 64 random bytes from `/dev/urandom` | `grove dev contribution` |
| 2 | separate VPS (Ubuntu), 2026-10-03 | 96 random bytes from `/dev/urandom`, never written to disk | zkey sha256 after this step: `c8ee6b9ea9f4ea8a846e19cc205b19d9be4d40fe731fc0d11d2539706450a00c` |
| 3 | Public beacon, 2026-10-03 | drand (League of Entropy) mainnet **round 6519014**, randomness `c01200e1fb6cd5144b664df78c44a048c87b1e2cba0fc62c8e6c1098ebc83255`, 2^10 iterations | final |

Final artifacts (sha256):

```
a8bdcea4f74725dde22f08d63247b7e110385f6c329544ec1154baa55bdd1706  circuits/build/transaction.zkey
60af26a42ac1671b39013529e02b37f82a440276e66d6e0525e32a52caa1b4ec  circuits/build/verification_key.json
fa47834653b58ff4a855228b3ca4aeae051cd2c853eeec4e7b8022b4f3cd396c  contracts/src/Groth16Verifier.sol
```

Verify at any time:

```bash
cd circuits
npx snarkjs zkey verify build/transaction.r1cs build/pot15.ptau build/transaction.zkey
curl -s https://api.drand.sh/public/6519014      # confirm the beacon randomness above
```

## Security statement

The proving key is sound as long as **at least one** of the two human contributions destroyed
its toxic waste. Both were made by the same operator on two machines, so this is not yet an
open multi-party ceremony: a third party who controlled both machines could in principle forge
proofs. An open multi-party phase 2 is planned: outside contributors each run `snarkjs zkey contribute`
on the latest zkey and publish their contribution hash, then a fresh drand beacon is applied. A new
proving key needs a new `Groth16Verifier` and `ShieldedPool` deployment.

## What a key compromise could and could not do

A forged proof could mint BNB out of the pool up to its balance (withdraw without a valid note).
It could not touch roots, holder-reward pots, ring pots, the launchpad curve, or any coin; those
contracts never rely on the proof system. The pool's `maxDeposit` and the published balance on
Rings bound the exposure and make an exploit visible immediately.
