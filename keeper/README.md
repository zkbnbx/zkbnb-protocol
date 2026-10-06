# zkBNB keeper

The off-chain worker for zkBNB (SPEC.md §6). One Node process, five jobs:

| command   | what it does | permission |
|-----------|--------------|------------|
| `sweep`   | for every graduated coin, swaps the accrued 2% pair-tax into BNB (`GroveCoin.sweepTax`) once it is worth ≥ `MIN_SWEEP_BNB` | anyone |
| `rewards` | for Holders-mode coins, snapshots holders at a random moment within the hour after the pot crosses `minPot`, publishes the snapshot JSON and posts the Merkle root (`HolderRewards.postRun`) | **keeper key only** |
| `rotate`  | `DonationRotator.settle(ringId)` for every ring whose epoch elapsed and whose pot is > 0 | anyone |
| `buyback` | `FeeRouter.buybackAndBurn` when `rootstockPot ≥ MIN_BUYBACK_BNB` | anyone |
| `feed`    | writes `snapshots/rings.json`, a precomputed 30-day Rings feed the web can fetch instead of scanning logs | – |
| `all`     | all of the above in order (sweep → buyback → rotate → rewards → feed), looping | |

Stack: TypeScript, viem, tsx, vitest, dotenv. No ethers.

## Setup

```sh
cd keeper
npm install
cp .env.example .env        # fill in RPC_URL, CHAIN_ID, KEEPER_PRIVATE_KEY, SNAPSHOT_BASE_URL
npm run build               # tsc → dist/
npm test                    # vitest
```

The contract addresses are read from `../contracts/deployments/<CHAIN_ID>.json` (written by
`contracts/script/Deploy.s.sol`; see `deployments.example.json` for the schema). Point
`DEPLOYMENTS_PATH` elsewhere if needed. The keeper refuses to start if the RPC's chain id does not
match `CHAIN_ID` or the file's `chainId`. Optional keys: `rootstockBuyback` (the FlapBuyback adapter)
and `rootstockExternal: true` when the rootstock token (`grove`) was launched on Flap (BSC mainnet).

Run a job once:

```sh
npx tsx src/index.ts sweep --once
npx tsx src/index.ts rewards --once --dry-run
npm run all                              # loop every KEEPER_INTERVAL_SEC (default 300)
node dist/index.js all                   # same, from the build
```

Every command loops at `KEEPER_INTERVAL_SEC` unless `--once` is given. `--dry-run` (or
`DRY_RUN=1`) only runs `simulateContract`; nothing is signed or sent. Without a
`KEEPER_PRIVATE_KEY` the keeper only starts in dry-run mode.

## Environment

| var | default | meaning |
|-----|---------|---------|
| `RPC_URL` | – | HTTP JSON-RPC (BSC mainnet 56 / testnet 97 / anvil) |
| `CHAIN_ID` | 97 | must match the RPC and the deployments file |
| `KEEPER_PRIVATE_KEY` | – | signer; must be `HolderRewards.keeper()` for `rewards` |
| `DEPLOYMENTS_PATH` | `../contracts/deployments/<CHAIN_ID>.json` | address file |
| `MIN_SWEEP_BNB` | 0.02 | sweep when the tax quotes to at least this |
| `MIN_POT_BNB` | `HolderRewards.minPot()` | override the on-chain threshold (must not be lower, or `postRun` reverts) |
| `MIN_HOLDING_USD` | 20 | a wallet needs at least this much of the coin to be in a snapshot |
| `BNB_USD` | – | fallback price when `api.binance.com` is unreachable |
| `MIN_BUYBACK_BNB` | 0.05 | buy back when the rootstock pot reaches this |
| `SNAPSHOT_DIR` | `./snapshots` | snapshots, caches, `state.json`, `rings.json` |
| `SNAPSHOT_BASE_URL` | – | public prefix serving `SNAPSHOT_DIR`; the on-chain `uri` is `<prefix>/<coin>/<runId>.json` |
| `BLOB_READ_WRITE_TOKEN` | – | if set, snapshot JSON (and `rings.json`) are uploaded to Vercel Blob and the blob URL becomes the `uri` |
| `EXCLUDE_ADDRESSES` | – | extra comma-separated addresses excluded from snapshots (e.g. team wallets) |
| `LOG_CHUNK` | 2000 | `eth_getLogs` window; halved automatically when a node rejects a range |
| `CONFIRMATIONS` | 20 | blocks behind head that are treated as final for the on-disk caches |
| `FEED_DAYS` | 30 | window of `rings.json` |
| `KEEPER_INTERVAL_SEC` | 300 | loop period |
| `DRY_RUN` | – | `1` = simulate only |
| `LOG_LEVEL` | info | debug / info / warn / error |

## How the random snapshot timing works, and why

The holder snapshot is taken at an unannounced moment so nobody can buy right before
it and sell right after. zkBNB does the same:

1. Every loop, for each coin whose `FeeRouter.configOf(coin).mode == Holders`, the keeper reads
   `HolderRewards.pot(coin)` and `lastRunAt(coin)`. A coin is *due* when
   `pot ≥ minPot` **and** `now ≥ lastRunAt + 1 h` (both are also enforced by `postRun`).
2. The first time a coin is due, the keeper draws `at = now + randomInt(0, 3600)` with
   `crypto.randomInt` and writes it to `SNAPSHOT_DIR/state.json`. The moment is **never logged,
   never published and never put on-chain**; only the fact that a snapshot is pending is logged.
   Because it is persisted, a restart does not re-roll it (an attacker who could restart the
   keeper would otherwise learn nothing but could keep postponing).
3. The loop sleeps until `min(KEEPER_INTERVAL_SEC, at)`. When `now ≥ at` it takes
   `snapshotBlock = latest`, rebuilds balances from `Transfer` logs (cached per coin in
   `SNAPSHOT_DIR/cache/<coin>.json`, everything older than `CONFIRMATIONS` blocks is folded into
   the cache, the tail is applied in memory only), prices the coin (`Launchpad.price` on the curve,
   pair reserves after graduation), fetches BNB/USD from Binance, and keeps every wallet holding
   ≥ `MIN_HOLDING_USD` worth, excluding the pair, Launchpad, Roots, FeeRouter, HolderRewards,
   the coin itself, `0x0`, `0xdead` and `EXCLUDE_ADDRESSES`.
4. The pot is split pro-rata with integer math: shares under 1e12 wei are dropped and, together
   with the rounding remainder, go to the largest holder, so the leaves sum to the pot exactly.
5. Leaves are `keccak256(abi.encode(coin, runId, account, amount))` (the layout `HolderRewards.leaf`
   uses; plain `abi.encode`, not OpenZeppelin's double-hashed StandardMerkleTree), internal nodes
   are `keccak256` of the sorted pair, an odd node is promoted. `runId = HolderRewards.runCount(coin)`
   at post time. Every proof is verified locally against the root before anything is sent.
6. The snapshot is written to `SNAPSHOT_DIR/<coin>/<runId>.json`, published (Blob or base URL),
   and `postRun(coin, root, amount, holders, uri)` is sent. If the pot dropped below `minPot` or a
   run was posted meanwhile, the pending schedule is dropped and re-evaluated next hour.

If you run `rewards --once` from cron instead of the loop, the snapshot fires on the first cron
tick after the drawn moment, so use a cron period of a few minutes.

### Snapshot JSON schema

```json
{
  "coin": "0x…",                 // checksummed
  "runId": 3,
  "root": "0x…",                 // bytes32
  "amount": "123456789000000000", // wei, decimal string, == sum of leaves
  "holders": 42,                 // == leaves.length
  "snapshotBlock": 45123456,
  "takenAt": 1760000000,         // unix seconds
  "rule": {
    "minHoldingWei": "40000000000000000000", // token wei threshold used (MIN_HOLDING_USD at that BNB/USD and coin price)
    "excluded": ["0x…"]          // sorted, deduped
  },
  "leaves": [
    { "account": "0x…", "amount": "…", "proof": ["0x…", "0x…"] }
  ]
}
```

A holder claims with `HolderRewards.claim(coin, runId, amount, proof)` or
`claimShielded(coin, runId, amount, proof, pubKey, blinding)`.

## State and caches

```
snapshots/
  state.json              pending snapshot moments + last tx per job (keep private)
  <coin>/<runId>.json     published snapshots
  rings.json              the Rings feed
  cache/<coin>.json       balances folded up to a final block
  cache/blocks.json       block → timestamp
  cache/feed-events.json  decoded events for rings.json (incremental)
  cache/payout-events.json  all-time DonationRotator payout events (incremental, from startBlock)
```

`rings.json` also carries (additive, still `version: 1`) `payouts` — every donation payout, all time, newest
first, capped at 500, one record per Settled / DirectDonation with `delivery` = `shielded` | `wallet` |
`deferred` (see `src/payouts.ts`, shared verbatim with `web/src/lib/payouts.ts`) — `pendingByAddress`
(deferred / withdrawn / outstanding per payee) and the daily columns `payoutsBnb`, `payouts`, `directBnb`,
`directs`, `deferredBnb`.

Serve `snapshots/` publicly (minus `state.json` and `cache/`) at `SNAPSHOT_BASE_URL`, or set
`BLOB_READ_WRITE_TOKEN` and let Vercel Blob host them.

## Transactions

Every send goes through `simulateContract` first; a revert there is logged and skipped (the loop
never dies on one coin). Sends are serialised, use the pending nonce, and retry up to 4 times on
nonce collisions. `minOut` slippage: sweep 98% of the router quote, buyback 97% of the quote
(curve `quoteBuy`, or router `getAmountsOut` reduced by the 2% pair-tax after graduation; for a
rootstock on Flap, the return value of `buybackAndBurn(0)` simulated from the keeper, which already
nets Flap's buy tax). FlapBuyback's "not tradable" revert (token mid-migration) is logged and skipped.

## Running as a service

### systemd

```ini
# /etc/systemd/system/zkbnb-keeper.service
[Unit]
Description=zkBNB keeper
After=network-online.target

[Service]
User=grove
WorkingDirectory=/opt/grove/keeper
EnvironmentFile=/opt/grove/keeper/.env
ExecStart=/usr/bin/node /opt/grove/keeper/dist/index.js all
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload && sudo systemctl enable --now zkbnb-keeper
journalctl -u zkbnb-keeper -f
```

### pm2

```sh
npm run build
pm2 start dist/index.js --name zkbnb-keeper -- all
pm2 save && pm2 startup
pm2 logs zkbnb-keeper
```

## Tests

```sh
npm test
```

- `merkle.test.ts` — tree + proofs checked against an independent TS port of
  `MerkleProof.processProof` (sorted-pair keccak), odd-node promotion, tampering.
- `allocation.test.ts` — pro-rata, remainder to largest, dust rollover, determinism, USD threshold.
- `balances.test.ts` — balance reconstruction from a synthetic Transfer log, incrementality,
  cache round trip, exclusions.
- `snapshot.test.ts` — exact JSON schema, proof verification with the Solidity leaf layout, file layout.
- `abi.test.ts` — the hand-written ABIs are checked against `contracts/out` (skipped if not built).

On-chain cross-check (needs Foundry and `forge build` in `../contracts`):

```sh
anvil --port 8599 &
npm run check:anvil        # deploys HolderRewards, posts a TS-built root, claims every leaf
```
