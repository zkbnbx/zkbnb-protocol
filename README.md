# zkBNB protocol

**Dark pools are coming to zkBNB:** trade any zkBNB coin without your wallet appearing on the
trade. They are in development and not deployed yet. See [Coming next: dark pools](#coming-next-dark-pools).

zkBNB is a coin launchpad on BNB Smart Chain. Anyone can plant a coin. It trades on a bonding
curve paired to BNB and graduates to PancakeSwap V2 with the LP burned. Every trade pays a 2% fee
that is split on-chain: 0.50% to the coin's roots vault (holders burn coins to harvest it), 0.50%
to buy and burn $ZKBNB, 0.20% to the operator and 0.80% to the deployer's choice (the deployer, another
wallet, holders, or a donation ring). Payouts can settle privately through a zero-knowledge
settlement layer, the same layer the dark pools will trade through.

This repository holds the contracts, the circuit with its ceremony transcript, and the keeper.
The full design is in [SPEC.md](SPEC.md). The web app is not part of this repository.

## Coming next: dark pools

A dark pool lets you buy, sell and harvest a zkBNB coin, on the bonding curve or on its PancakeSwap
pair after graduation, without your wallet ever appearing on the trade. A relayer submits the
transaction; the trade executes from a one-off vault address that is fixed by the order itself, so
nobody can change the coin, amount, slippage or recipient after you sign it. Proceeds settle back
into the private settlement layer.

- **Status:** in development. Not deployed, not audited. It will be audited before it holds any funds
  on mainnet, and its code will be published here.
- **What stays public:** that a trade happened, which coin, the BNB amount and the vault address. What
  is hidden is who traded.
- **What it reuses:** the live settlement layer below and its anonymity set. No new circuit and no new
  trusted setup.

## Repository layout

```
SPEC.md                     design: contracts, circuit, keeper, trust model
contracts/                  Foundry project (solc 0.8.26, via_ir, cancun, OpenZeppelin 5.1.0)
  src/                      Launchpad, GroveCoin, FeeRouter, Roots, HolderRewards,
                            DonationRotator, ShieldedPool, MerkleTreeWithHistory,
                            FlapBuyback, Groth16Verifier (generated), interfaces/
  poseidon/                 Poseidon T3 / T4 EVM bytecode (circomlibjs)
  test/                     forge tests; test/fork/ needs BSC_FORK_URL and skips without it
  script/                   deploy scripts, check-deployed.sh
  deployments/<chainId>.json deployed addresses (56 = BSC mainnet, 97 = BSC testnet)
  lib/                      git submodules: openzeppelin-contracts v5.1.0, forge-std v1.17.0
  SECURITY-REVIEW.md        internal pre-launch review
circuits/                   circom circuit, ceremony artifacts, zk client library
  transaction.circom        2-in-2-out join-split, Merkle depth 20
  lib/grove-zk.mjs          notes, tree, proving, note scanning (used by web and tests)
  build/                    transaction.wasm, verification_key.json, CEREMONY-HASHES.txt
  CEREMONY.md               phase 1 and phase 2 transcript
keeper/                     off-chain worker: fee sweeps, buybacks, ring rotation,
                            holder-reward snapshots, Rings feed (TypeScript, viem)
```

## Settlement layer (ShieldedPool)

The settlement layer is live on mainnet; dark pools will run on top of it. There is one `ShieldedPool` for the whole protocol. Every coin and every kind of payout uses it:
roots harvests, holder-reward claims, donation-ring payouts, and direct shield / unshield /
private transfers. The pool holds only BNB, so all notes look alike. One pool means one anonymity
set; a pool per coin or per payout type would split users into small sets that are easy to link.

- Note: `commitment = Poseidon(amount, pubKey, blinding)`. Keys: `pubKey = Poseidon(privKey)`.
- Tree: incremental Poseidon Merkle tree, depth 20, 100-root history.
- Join-split: 2 inputs, 2 outputs, Groth16 over BN254. Public inputs are the root, the public
  amount, the external-data hash, two nullifiers and two output commitments.
- Contracts pay into the pool with `depositFor(pubKey, blinding)`, which computes the commitment
  on-chain without a proof. The amount and key are public on that transaction. Only the holder of
  `privKey` can spend the note later.
- No admin over funds. The owner can only change the cap on `transact` deposits.

Details: SPEC.md sections 3.5, 4 and 8.

## Build and test

Clone with submodules (the nested OpenZeppelin submodules are needed for a bytecode-exact build):

```sh
git clone --recurse-submodules https://github.com/zkbnbx/zkbnb-protocol.git zkbnb-protocol
# or, in an existing clone:
git submodule update --init --recursive
```

On Windows, run `git config --global core.longpaths true` first: some of OpenZeppelin's nested
submodule paths are too long for the default setting.

Requirements: [Foundry](https://book.getfoundry.sh/getting-started/installation), Node.js 20+,
bash, curl.

### Contracts

```sh
cd contracts
forge build
forge test
```

`forge test` runs the unit tests with mocks, plus the shielded-pool tests that verify real Groth16
proofs from `test/fixtures/pool.json`. The fork suites in `test/fork/` skip unless
`BSC_FORK_URL` is set:

```sh
BSC_FORK_URL=https://bsc-dataseed.bnbchain.org forge test --match-path 'test/fork/*' -vv
```

Deploy instructions are in [contracts/README.md](contracts/README.md).

### Circuits

```sh
cd circuits
npm ci
npm run verify   # downloads build/transaction.zkey if missing and checks every hash
npm test         # generates and verifies real Groth16 proofs
```

`npm test` needs `build/transaction.zkey` (11.9 MB, not in git). `npm run verify` fetches it from
https://zkbnbx.com/zk/transaction.zkey. It will also be attached to a GitHub release.

`npm run build` recompiles the circuit and runs a new phase 2 setup. It overwrites the
ceremony artifacts and the verifier, so only use it for a new ceremony.

### Keeper

```sh
cd keeper
npm ci
npx tsc --noEmit -p .
npm test
```

`test/abi.test.ts` checks the keeper's ABIs against `contracts/out`; it skips those cases if
`forge build` has not run. Setup and environment: [keeper/README.md](keeper/README.md).

## Verify the circuit artifacts and the deployed verifier

The proving key comes from the Hermez Powers of Tau (phase 1, `powersOfTau28_hez_final_15.ptau`)
and a circuit-specific phase 2 with two contributions and a drand beacon (round 6519014).
The transcript is [circuits/CEREMONY.md](circuits/CEREMONY.md). The final hashes are in
[circuits/build/CEREMONY-HASHES.txt](circuits/build/CEREMONY-HASHES.txt):

```
a8bdcea4f74725dde22f08d63247b7e110385f6c329544ec1154baa55bdd1706  build/transaction.zkey
60af26a42ac1671b39013529e02b37f82a440276e66d6e0525e32a52caa1b4ec  build/verification_key.json
fa47834653b58ff4a855228b3ca4aeae051cd2c853eeec4e7b8022b4f3cd396c  ../contracts/src/Groth16Verifier.sol
```

1. Key and verifier match the transcript. This checks the three hashes, then re-exports the
   verification key and the Solidity verifier from the zkey with snarkjs and checks those too:

   ```sh
   cd circuits && npm ci && npm run verify
   ```

2. The zkey belongs to this circuit and to the phase 1 ceremony. This needs the r1cs (compile
   with circom2 0.2.23) and the 38 MB ptau:

   ```sh
   cd circuits
   npx circom2 transaction.circom --r1cs -o build < /dev/null   # may not exit by itself; stop it once build/transaction.r1cs is written
   curl -fLo build/pot15.ptau https://circom.info/powersOfTau28_hez_final_15.ptau
   npx snarkjs zkey verify build/transaction.r1cs build/pot15.ptau build/transaction.zkey
   curl -s https://api.drand.sh/public/6519014    # beacon randomness in CEREMONY.md
   ```

3. The deployed contracts match this source. This compares the runtime bytecode of all eight
   contracts on chain 56 with a local build. Immutable slots are masked; the rest, including the
   metadata hash, must be identical:

   ```sh
   cd contracts && forge build && bash script/check-deployed.sh https://bsc-dataseed.bnbchain.org 56
   ```

The same eight contracts are verified on [Sourcify](https://sourcify.dev). PoseidonT3 and
PoseidonT4 are raw circomlibjs bytecode (`contracts/poseidon/*.bin`) and have no Solidity source.

## Mainnet deployment (BSC, chain 56)

From [contracts/deployments/56.json](contracts/deployments/56.json). Start block 125962928.

| Contract | Address |
|---|---|
| Launchpad | [0x6dF75DA4913B0f7c821C55248bA9513703C295B5](https://bscscan.com/address/0x6dF75DA4913B0f7c821C55248bA9513703C295B5) |
| FeeRouter | [0xd480Fba1Fe8014529F66a0aAf9A6abb9FbEE1748](https://bscscan.com/address/0xd480Fba1Fe8014529F66a0aAf9A6abb9FbEE1748) |
| Roots | [0x3124a069DD2AA636a4C7263bf6f1898cd7F67d93](https://bscscan.com/address/0x3124a069DD2AA636a4C7263bf6f1898cd7F67d93) |
| HolderRewards | [0x16b5237FE9eb32402a8F5eEBad0f9c68a7055B13](https://bscscan.com/address/0x16b5237FE9eb32402a8F5eEBad0f9c68a7055B13) |
| DonationRotator | [0xB33b779c83e910fCdAC34EA4474e0B99CA3aA580](https://bscscan.com/address/0xB33b779c83e910fCdAC34EA4474e0B99CA3aA580) |
| ShieldedPool | [0x9fd27a573551b2069191aB2DebC68Aa5Ba55d055](https://bscscan.com/address/0x9fd27a573551b2069191aB2DebC68Aa5Ba55d055) |
| Groth16Verifier | [0xF926E6119211c4FF885CaE0EA1043e6243862282](https://bscscan.com/address/0xF926E6119211c4FF885CaE0EA1043e6243862282) |
| PoseidonT3 | [0x5B171B64FC477Ed39E3b889C0e68368fc3324eF6](https://bscscan.com/address/0x5B171B64FC477Ed39E3b889C0e68368fc3324eF6) |
| PoseidonT4 | [0xB1FE38E856aDEEdc4Da1b4DbFf7bc38DfbF2685a](https://bscscan.com/address/0xB1FE38E856aDEEdc4Da1b4DbFf7bc38DfbF2685a) |
| FlapBuyback (rootstock buyback) | [0x6DEcA327986350133262aB9523acD82C1dB7F795](https://bscscan.com/address/0x6DEcA327986350133262aB9523acD82C1dB7F795) |
| $ZKBNB (rootstock token, Flap) | [0xe3E96140f464196440959439CA42F01F986a7777](https://bscscan.com/address/0xe3E96140f464196440959439CA42F01F986a7777) |
| Owner / treasury (Safe) | [0x4D55C01c968Af4292dAcED876c4113dcFE20179f](https://bscscan.com/address/0x4D55C01c968Af4292dAcED876c4113dcFE20179f) |
| PancakeSwap V2 router | [0x10ED43C718714eb63d5aA57B78B54704E256024E](https://bscscan.com/address/0x10ED43C718714eb63d5aA57B78B54704E256024E) |

$ZKBNB is a Flap tax token paired with Binance-Peg ZEC. It was launched on Flap, not on the zkBNB
Launchpad. The FeeRouter's 0.50% rootstock pot buys it through FlapBuyback and sends it to
`0x000000000000000000000000000000000000dEaD`. Every module is owned by the Safe above. No
contract is upgradeable.

## Security

- One internal pre-launch review: [contracts/SECURITY-REVIEW.md](contracts/SECURITY-REVIEW.md).
  Every confirmed finding was fixed and has a regression test in `contracts/test/Security.t.sol`.
- No external audit yet. An audit by [Shieldify](https://shieldify.org) is planned.
- The phase 2 ceremony had two contributions from one operator plus a public beacon. See the
  security statement in [circuits/CEREMONY.md](circuits/CEREMONY.md).
- Scope and notes for auditors: [AUDIT-SCOPE.md](AUDIT-SCOPE.md).
- Known issues and how to report a vulnerability: [SECURITY.md](SECURITY.md).

## License

MIT, see [LICENSE](LICENSE). `contracts/src/Groth16Verifier.sol` is generated by snarkjs and keeps
its GPL-3.0 header. The circuit imports circomlib (GPL-3.0) as an npm dependency.
