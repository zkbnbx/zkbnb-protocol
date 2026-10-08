# zkBNB keeper

The off-chain worker for zkBNB (SPEC.md §6). One Node process, five jobs:

| command   | what it does | permission |
|-----------|--------------|------------|
| `sweep`   | for every graduated coin, swaps the accrued 2% pair-tax into BNB (`GroveCoin.sweepTax`) once it is worth ≥ `MIN_SWEEP_BNB` | anyone |
| `rewards` | for Holders-mode coins, snapshots holders at a random moment within the hour after the pot crosses `minPot`, publishes the snapshot JSON and posts the Merkle root (`HolderRewards.postRun`) | **keeper key only** |
| `rotate`  | `DonationRotator.settle(ringId)` for every ring whose epoch elapsed and whose pot is > 0 | anyone |
| `buyback` | `FeeRouter.buybackAndBurn` when `rootstockPot ≥ MIN_BUYBACK_BNB` | anyone |
| `feed`    | writes `snapshots/rings.json`, a precomputed 30-day Rings feed the web can fetch instead of scanning logs | – |
| `all`     | all of the above in order (sweep → buyback → rotate → rewards → feed), then the stage-2 `dividends`, `flush`, `pool-feed` (no-ops while their addresses are absent), looping | |

Privacy stage 2 (Dark Curve, `privacy/PRIVACY-SPEC.md` §5.2) adds five more commands. Each is **inert** (returns
before any RPC call) while `grovePool` / `darkCurve` / `planter` are absent from the deployment file, so a keeper
pointed at today's chain-56 file behaves exactly as before. See "Privacy stage 2" below.

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

## Privacy stage 2

| command       | what it does | permission | host |
|---------------|--------------|------------|------|
| `coordinator` | Epoch Coordinator: per `(coin, dir)` openability (`count ≥ K` at `T_MIN`, any count at `T_MAX`), decrypts **only the epoch sum** with the Coordinator key, solves it with the 2^24 BSGS table, quotes `minOut` (`SLIPPAGE_BPS`), proves `epochOpen`, sends `openEpoch` for every openable direction of a coin at once through `PRIVATE_TX_RPC`; drops a band-blocked or reverting direction from the mask and retries the rest; `voidEpoch` after `T_MAX + GRACE`; `pool.checkpoint()` when a period passed without an insert | anyone (the key is what matters) | coordinator host |
| `rotate-key`  | daily key rotation, see "Coordinator key rotation" | DarkCurve owner (Safe) | coordinator host |
| `pool-feed`   | sync bundle `<POOL_FEED_DIR>/<chainId>/{manifest.json, chunk-<n>.json}` (spec Appendix C: 4096 leaves per chunk, sha256 per chunk, checkpoints, epochs per `(coin, dir, seq)`) and `epochs.json` every pass; uploaded to Blob `snapshots/pool/<chainId>/` when `BLOB_READ_WRITE_TOKEN` is set; `--out <dir>` writes the local copy elsewhere | – | keeper |
| `dividends`   | for each Holders-mode run that lists GrovePool: verifies the pool's leaf (= `HolderRewards.leaf`) against the posted root and calls `GrovePool.pullRewards`; idempotent via `isClaimed`; skips while the pool holds < 1 token (`MIN_REWARD_SUPPLY`) | anyone | keeper |
| `flush`       | `CreatorStub.flush()` for every stub (from `Planter.PlantedPrivately`) with `balance + FeeRouter.pending ≥ MIN_FLUSH_BNB` | anyone | keeper |

`rewards` keeps GrovePool an eligible holder (even if `EXCLUDE_ADDRESSES` names it) and excludes DarkCurve,
Planter and every CreatorStub, only when those addresses are in the deployment file.

`coordinator` and `pool-feed` loop every 15 s unless `--interval` is given. `all` **never** runs `coordinator`,
`rotate-key` or the relayer: the Coordinator is its own pm2 app (`ENABLE_COORDINATOR=1 pm2 start
ecosystem.config.cjs --only grove-coordinator`), and **it must run on a different host from the relayer**, under a
different key, with no shared logs (spec §2.10).

What the coordinator logs: coin, direction, seq, intent count, the sum's magnitude (`2^a..2^b`) and tx hashes.
Never a key, never an individual ciphertext, never the exact sum before `EpochOpened` publishes it.
`npm run keeper -- coordinator --once --dry-run` prints the would-be `openEpoch` arguments with `u` redacted the
same way (and simulates them when `KEEPER_PRIVATE_KEY` is set).

ABIs of `GrovePool`, `DarkCurve`, `Planter`, `CreatorStub` are generated from `../contracts/out` into
`src/abis-v2.ts` by `npm run sync:abis` (after `forge build`); `test/abis2.test.ts` fails when the file is stale.

Bundle details: `toIndex` is exclusive; leaves a chunked insert left as `ZERO_LEAF` are listed with kind `"zero"`;
a chunk holds the leaves of its index range plus every record (nullifier, intent, epoch, credit, accRpt) logged while
the tree's `nextIndex` was in that range, so a chunk is immutable once the tree has moved past it. A `credits` row
is either a `Credited` (`amount > 0`, `claimedAmount "0"`) or a `HandleClaimed` (`amount "0"`, `claimedAmount > 0`);
clients sum per handle. `feed-state.json` beside the manifest is local state (not uploaded).

### Relayer (`relayer`, `src/relayer/`)

Standalone HTTP service (Node `http`), its own pm2 app (`ENABLE_RELAYER=1 pm2 start ecosystem.config.cjs --only
grove-relayer`) on a **different host from the Coordinator**, with its own wallet `RELAYER_PRIVATE_KEY` (the keeper
key is never used). Routes (spec §5.3): `GET /relay?chainId=&kind=` (quote), `POST /relay`, `GET /relay/held/<ticket>`,
`GET /relay/epochs?chainId=` (all coins, 15 s cache, same bytes as `epochs.json`), `GET /health`.

- Kinds: `transfer`, `plant`, `intent`, `claim`, `v1migrate` (stage 2; refused while `grovePool` / `darkCurve` are
  absent from the deployment file) and the stage-1 `transact`, `fill`, `vault`, `recover` (same rules as
  `web/src/app/api/relay/route.ts`; `fill` / `vault` / `recover` need `darkPool` in the deployment file).
- Fees: stage-2 fees are tiers (0.0002 / 0.0005 / 0.001 / 0.002 / 0.005 BNB, all under the contracts'
  `MAX_RELAYER_FEE`), the smallest ≥ `gasPrice × gasUnits × 1.2 + RELAY_FLAT_FEE_WEI`, with `gasUnits` from
  `GAS_UNITS_FILE` (`contracts/gas-v2.json`). The quote lists every acceptable tier. Claims are free (reimbursed
  on-chain from the claim budget) and must name this relayer. Stage-1 kinds keep the untiered stage-1 quote.
- Policies are pure (`policy.ts`); `onchain.ts` fills the Coordinator keys, `keySwitchAt`, `plantFee` and `seenC1`
  from one batch of eth_calls. `v1migrate` requires `encryptedOutput2 == abi.encode(handle)` (the contract's handle
  binding) and an unshield to the GrovePool.
- Holds: an intent with `hold: { minOthers, submitByEpochEnd }` and a `v1migrate` with a future `notBefore`
  (≤ 14 days) are stored AES-256-GCM encrypted under `RELAYER_HELD_DIR` (key `RELAYER_HELD_KEY`; without it holds are
  refused). A poller releases each one **individually after its own 0–20 s jitter**, re-checking when it fires; an
  intent whose epoch reaches `startedAt + T_MAX − 30 s` short of `minOthers` is submitted (`submitByEpochEnd`) or
  dropped. Claims are never held. Finished tickets keep their status in memory for a day (not across restarts).
- Safety: nullifiers of an accepted spend are locked while in flight (and while held), sends go through one
  serialised queue, every request is simulated first, per-IP token buckets limit quotes and submissions, CORS
  allows only `RELAYER_ALLOWED_ORIGINS`. `pool.checkpoint()` is called when a period passed without an insert.
- Logging: **no access log**, no request body, no IP. One line per send: `[relayer] sent kind=<kind> hash=<hash>`.
  Errors are logged as a revert name / short message only (viem's full message repeats the calldata).
- `npm run keeper -- relayer --dry-run` serves quotes with an ephemeral key when `RELAYER_PRIVATE_KEY` is unset and
  answers every POST with "dry run: the simulation passed, nothing was sent".

### Coordinator key rotation

The Coordinator key `ecSk` could decrypt every intent made under it, so it is rotated daily and destroyed as soon
as it is no longer needed (spec §2.7, §6.4). Procedure, on the coordinator host:

1. `rotate-key` runs from cron once a day: `0 3 * * * cd /opt/grove/keeper && npx tsx src/index.ts rotate-key --once`.
2. It generates the next key into `COORDINATOR_KEY_DIR/key-<pkX>.json` (mode 0600, directory 0700) and proposes
   `DarkCurve.setCoordinatorKey(pk, now + 1 h)`:
   - chain 97 / local, when `KEEPER_PRIVATE_KEY` owns DarkCurve: sent directly;
   - chain 56 (DarkCurve owned by the Safe): written as a Safe Transaction Builder batch to
     `COORDINATOR_KEY_DIR/proposals/setCoordinatorKey-<switchAt>.json`. A Safe owner imports it (Safe app → Apps →
     Transaction Builder → drop the file) and the signers execute it **before `switchAt − 10 min`**
     (`setCoordinatorKey` needs `switchAt ≥ now + OVERLAP`). An expired proposal is detected on the next pass: its
     unused key is destroyed and a fresh one is proposed.
3. The running `coordinator` picks the new key file up on its next pass (it reads the directory every pass) and
   opens epochs under either key: an epoch records the key generation of its first intent.
4. Once `switchAt` has passed and the **last epoch under the old key** is opened or voided (at most
   `T_MAX + GRACE` = 35 min later), `rotate-key` overwrites the old key file with random bytes, unlinks it and logs
   `KeyDestroyed gen=<g> pk=[x,y]`. Keep that log line: HANDOFF.md cites it as the attestation of destruction.
5. `COORDINATOR_SK` in `.env` is only for a single-key setup (tests, testnet); the process cannot destroy it. When
   it is retired the pass logs "COORDINATOR_SK holds a retired key; remove it from the environment now".
   Production uses `COORDINATOR_KEY_DIR` only.
6. Never copy key files off the host and never back them up: a retired key that survives anywhere extends the
   retroactive exposure beyond one rotation window.

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
- Stage 2: `coordinator.test.ts` (per-direction openability, `dirMask`, `minOut` from mocked reserves, band-blocked
  and reverting directions dropped and retried, void timing, redaction, and a spy proving `elgamal.decrypt` only ever
  sees summed ciphertexts), `rotateKey.test.ts`, `poolFeed.test.ts`, `dividends.test.ts` (pool leaf equals
  `HolderRewards.leaf`, flush), `rewardsPrivacy.test.ts` (inert with the live deployment file), `abis2.test.ts`,
  plus the crypto core `bsgs`, `elgamal`, `checkpoint`, `zkprove`, `v2vectors`.

On-chain cross-check (needs Foundry and `forge build` in `../contracts`):

```sh
anvil --port 8599 &
npm run check:anvil        # deploys HolderRewards, posts a TS-built root, claims every leaf
```
