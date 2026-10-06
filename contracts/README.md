# zkBNB contracts

Foundry project (solc 0.8.26, `via_ir`, OpenZeppelin 5.1). See `../SPEC.md` for the design.

```
src/
  GroveCoin.sol            ERC-20, 2% pair-tax after graduation, sweepTax -> FeeRouter
  Launchpad.sol            factory + bonding curve + PancakeSwap graduation
  FeeRouter.sol            25/25/10/40 split, deployer's choice, rootstock buyback-burn
  Roots.sol                per-coin BNB vault, burn-to-harvest (public or shielded)
  HolderRewards.sol        Merkle distributor for keeper snapshots
  DonationRotator.sol      causes, rings, epoch rotation into the shielded pool
  ShieldedPool.sol         Groth16 join-split pool + depositFor
  Groth16Verifier.sol      generated: cd ../circuits && npm run build
poseidon/                  Poseidon T3 / T4 EVM bytecode (circomlibjs)
test/                      forge tests (mocks for WBNB / Pancake V2 / verifier in test/mocks)
script/                    Deploy, DeployLocal, SeedTestnet
deployments/<chainId>.json addresses written by the deploy scripts
```

## Build & test

```sh
forge build
forge test                      # unit tests, mocks only
forge test --match-path test/ShieldedPool.t.sol -vv   # real Groth16 proofs (needs circuits/build)
```

`forge test` prints the exact curve numbers in `LaunchpadTest::test_curveNumbers` (`-vv`).

## Curve

```
VIRTUAL_BNB = 4 BNB, VIRTUAL_TOKENS = 1 073 000 000, CURVE_TOKENS = 793 100 000, LP_TOKENS = 206 900 000
BNB to clear the curve: 11.334047874240800286 BNB net of fee
                        11.565354973715102333 BNB gross (2% fee included)
start price:            3 727 865 796 wei / token   (3.73e-9 BNB)
end price (curve):     54 784 022 416 wei / token   (5.48e-8 BNB, 14.7x)
pool at graduation:     206.9M tokens + 11.334 BNB, LP sent to 0xdead
```

## Deploy

Environment:

| var        | required | meaning                                                              |
|------------|----------|----------------------------------------------------------------------|
| `TREASURY` | yes      | receives the 0.20% operator share, plant fees, cause-registration fees |
| `RECOVERY` | yes      | fixed address that receives a coin's roots share while it is paused   |
| `KEEPER`   | yes      | HolderRewards keeper (posts snapshot roots)                            |
| `OWNER`    | no       | Safe that will own every module (default: the broadcaster). Ownable2Step: it must call `acceptOwnership()` on ShieldedPool, FeeRouter, Roots, HolderRewards, DonationRotator and Launchpad. |
| `ROUTER`   | no       | PancakeSwap V2 router for chains other than 56 / 97                   |
| `PK`       | yes      | deployer private key                                                  |

The script picks the router by chain id: 56 -> `0x10ED43C718714eb63d5aA57B78B54704E256024E`,
97 -> `0xD99D1c33F9fC3444f8101754aBC46c52416550D1`, otherwise `ROUTER`.

```sh
export TREASURY=0x... RECOVERY=0x... KEEPER=0x... PK=0x...

# BNB testnet (chain 97)
forge script script/Deploy.s.sol:Deploy --rpc-url bsc_testnet --broadcast --private-key $PK -vv
# -> deployments/97.json

# seed demo data: 3 causes, "zkBNB global ring" (1 day epoch), two demo coins (Holders, Donate)
forge script script/SeedTestnet.s.sol:SeedTestnet --rpc-url bsc_testnet --broadcast --private-key $PK -vv
# -> deployments/97.seed.json

# BNB mainnet (chain 56)
forge script script/Deploy.s.sol:Deploy --rpc-url bsc --broadcast --private-key $PK --verify --etherscan-api-key $BSCSCAN_KEY -vv
```

The deployer needs a little BNB beyond gas for `SeedTestnet` (3 x 0.002 cause fees,
2 x 0.005 plant fees, 2 x `FIRST_BUY`, default 0.01 BNB each).

`deployments/<chainId>.json`:

```json
{
  "chainId": 97,
  "poseidonT3": "0x..", "poseidonT4": "0x..", "verifier": "0x..", "shieldedPool": "0x..",
  "feeRouter": "0x..", "roots": "0x..", "holderRewards": "0x..", "donationRotator": "0x..",
  "launchpad": "0x..", "grove": "0x..", "router": "0x..", "treasury": "0x..",
  "startBlock": 12345678
}
```

## Local flow (anvil)

```sh
anvil                                             # terminal 1, chain id 31337

# terminal 2: anvil's first account
export PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
forge script script/DeployLocal.s.sol:DeployLocal --rpc-url http://127.0.0.1:8545 --broadcast --private-key $PK -vv
# deploys MockWBNB + MockPancakeFactory + MockPancakeRouter, then the stack -> deployments/31337.json
forge script script/SeedTestnet.s.sol:SeedTestnet --rpc-url http://127.0.0.1:8545 --broadcast --private-key $PK -vv
```

`TREASURY`, `RECOVERY`, `KEEPER`, `OWNER` default to the broadcaster for `DeployLocal`.

## Trust notes

- No contract is upgradeable. Admin (owner) can, among others: change fee shares within bounds, change
  treasury, pause a coin's roots to the fixed recovery address, set the keeper, set pool limits. See AUDIT-SCOPE.md section 4 for the complete list of owner powers, including the module links that can still be re-pointed (`Launchpad.setRoots`, `HolderRewards.setSources`, `DonationRotator.setFeeRouter`) and the $ZKBNB buyback path and public cap.
- `buybackAndBurn` is callable by anyone; on the curve it buys `$ZKBNB` through the Launchpad,
  after graduation through the router. Any curve refund stays in `rootstockPot`.
- Shielded payouts (`depositFor`) are limited by `ShieldedPool.maxDeposit` (100 BNB).
  A donation-ring pot or a single harvest above that reverts until the owner raises the limit.
