# zkBNB dark pools — design spec

Status: design fixed 2026-10-05, implementation driven by `privacy/WORKPLAN.md`.
Authority: this file wins over anything an implementer would otherwise guess. `SPEC.md` §3.9 summarises it.

## 0. What a dark pool is here

A **dark pool** lets someone trade a coin on the zkBNB launchpad (and, after graduation, on its PancakeSwap pair)
**from inside the shielded pool**, so the wallet that owns the money never appears on the trade. The chain still
sees *that* a buy happened, *which* coin, *how much* BNB and the address that now holds the tokens (a one-off
"dark vault"). It does not see *who*. Selling, harvesting and leftover BNB go straight back into the shielded
pool as notes, again without any user wallet on the transaction.

No new circuit, no new trusted setup, no change to any deployed contract. It reuses:

- the mainnet `ShieldedPool` and its anonymity set (every dark-pool buy is an ordinary `transact` withdrawal),
- the relayer in `web/src/app/api/relay/route.ts` (the only EOA that ever sends a dark-pool transaction),
- the Launchpad curve and the Pancake router exactly as a wallet would use them.

The trick is **counterfactual vaults**: the proof withdraws BNB to an address that does not exist yet but is
fully determined by the order (`CREATE2` of a minimal clone, salt = hash of the order). Only the `DarkPool`
factory can put code at that address, and it will only do so by executing that exact order. So the relayer,
or anyone, can "fill" the order, but nobody can change it: coin, amount, slippage, owner key and deadline are
all bound into the recipient address, which is bound into `extDataHash`, which is bound by the proof.

### 0.1 Privacy claims (must be stated this way on /docs)

Hidden:
- The wallet (and the shielded key) behind a buy, a sell, a harvest or a shield-back. The only EOA on those
  transactions is the relayer's (the way back still names the pubKey, see Public).
- Which note paid for a buy; what is done with the proceeds note after it is created (the note's amount,
  pubKey and blinding are public in `DepositFor`; spending it is not).
- A link between two dark vaults of the same person while they still hold their position (fresh owner key
  per vault; only timing / amount heuristics). After a sell / harvest / shield-back the vaults are linked by
  the `DepositFor` pubKey, see Public.

Public:
- Every buy: the coin, the BNB amount (an unshield), the vault address, the tokens it received, the time.
- Every sell / harvest / shield-back: the vault, the amount, and the `DepositFor` pubKey it paid into
  (a fresh or the user's own shielded pubKey; the UI uses the user's own key, so all of a user's vault
  proceeds land on **one** pubKey and every paid-out vault is publicly one owner. The pubKey is a Poseidon
  image, not a wallet; linking it to a wallet needs a wallet-signed `harvestShielded` / `claimShielded` /
  `registerCause` carrying that pubKey, before or after; the coin-page harvest notice and `/docs/roots` warn,
  Move BNB does not). The proceeds amount is odd and public: unshielding exactly it to a wallet matches the
  vault; the docs steer to private sends or standard-size unshields.
- The relayer learns the client IP, the order and the pubKey on vault calls (not the wallet). It can decline,
  delay up to the deadline or front-run within the user's slippage like any mempool watcher, never redirect.
- Standard sizes matter: an unusual BNB amount, or a buy of the amount just shielded, links a shield to the
  buy. The UI steers to the denominations in `web/src/lib/zk/denominations.ts`.

## 1. Contracts (`contracts/src/DarkPool.sol`, `contracts/src/DarkVault.sol`)

Solidity 0.8.26, OpenZeppelin 5.1 (`Clones`, `EIP712`, `ECDSA`, `ReentrancyGuard`, `SafeERC20`). Nothing is
ownable or upgradeable. No admin at all.

### 1.1 DarkVault (implementation, cloned per order)

```solidity
contract DarkVault is EIP712, ReentrancyGuard {           // EIP712("zkBNB DarkVault", "1")
    // immutables live in the implementation bytecode, so every clone shares them
    address   public immutable factory;      // DarkPool
    ILaunchpadFull public immutable launchpad;
    IShieldedPoolFull public immutable pool;
    IPancakeRouter02 public immutable router;
    function roots() public view returns (IRootsHarvest); // launchpad.roots() resolved at CALL time (setRoots is not one-shot)
    address   public immutable weth;         // router.WETH()

    address public owner;                    // set once by initialize; 0 on the impl (impl is locked in its constructor)
    address public coin;
    uint256 public nonce;                    // relay() nonce, strictly sequential from 0

    bytes32 public constant RELAY_TYPEHASH =
        keccak256("Relay(bytes data,uint256 fee,uint256 deadline,uint256 nonce,address relayer)");

    event Bought(uint256 bnbIn, uint256 tokensOut, bool viaRouter);
    event Sold(uint256 tokensIn, uint256 bnbOut, uint256 fee, uint256 pubKey, uint256 leafIndex, bool viaRouter);
    event Harvested(uint256 tokensBurned, uint256 bnbOut, uint256 fee, uint256 pubKey, uint256 leafIndex);
    event Shielded(uint256 amount, uint256 fee, uint256 pubKey, uint256 leafIndex);
    event Executed(address target, uint256 value, bytes data);
    event Relayed(address indexed relayer, uint256 nonce, uint256 fee, bytes4 selector);

    function initialize(address owner_, address coin_) external;              // onlyFactory, once
    receive() external payable;                                                // the pool pays here

    // --- factory path (the fill) ---
    function buyFromFactory(uint256 bnbIn, uint256 minTokensOut, uint256 deadline) external;  // onlyFactory

    // --- owner path: callable by `owner` directly, or by anyone through relay() with the owner's signature ---
    function buy(uint256 bnbIn, uint256 minTokensOut) external;                // retry with BNB sitting in the vault
    function sell(uint256 tokens, uint256 minBnbOut, uint256 pubKey, uint256 blinding) external;
    function harvest(uint256 tokens, uint256 minBnb, uint256 pubKey, uint256 blinding) external;
    function shield(uint256 amount, uint256 pubKey, uint256 blinding) external; // amount 0 = whole balance (minus relay fee)
    function exec(address target, uint256 value, bytes calldata data) external; // escape hatch (claim rewards, move tokens out…)

    // --- meta-transaction entry (anyone submits, owner signed) ---
    function relay(bytes calldata data, uint256 fee, uint256 deadline, bytes calldata sig) external;   // digest uses msg.sender as `relayer`
    function relayDigest(bytes calldata data, uint256 fee, uint256 deadline, uint256 nonce_, address relayer) external view returns (bytes32);
}
```

Rules:

- `onlyOwner` passes when `msg.sender == owner`, **or** when `msg.sender == address(this)` during a `relay()`
  (flag `_inRelay`). `relay()` is `nonReentrant`; the owner functions are not (they are entered by the
  self-call), but `sell/harvest/shield/buy/exec` must each be marked so they cannot be re-entered from outside
  a relay by a non-owner (the `onlyOwner` check already guarantees this).
- `relay(data, fee, deadline, sig)`: `block.timestamp <= deadline`; digest =
  `_hashTypedDataV4(keccak256(abi.encode(RELAY_TYPEHASH, keccak256(data), fee, deadline, nonce, msg.sender)))`
  (the owner signs for one submitter, so a mempool front-runner who copies the calldata gets `BadSignature`
  and cannot take the fee or make the real submitter's transaction revert);
  `ECDSA.recover(digest, sig) == owner`; `nonce++`; set `_inRelay = true; _relayFee = fee`; `address(this).call(data)`
  and bubble the revert data on failure; clear the flags; if `fee > 0` pay `msg.sender` `fee` from the vault's
  balance (revert if it cannot). `data` must be ≥ 4 bytes and its selector must not be `relay` or
  `buyFromFactory` or `initialize` (revert `BadCall`).
- Fee semantics: the functions that pay into the pool deposit `proceeds - _relayFee` (revert if
  `proceeds <= _relayFee`), leaving `_relayFee` in the vault for `relay()` to pay out. `buy` and `exec` leave
  the fee to be taken from whatever BNB the vault holds after the call. When called directly by the owner
  `_relayFee` is 0.
- `buyFromFactory` / `buy`: if `launchpad.isGraduated(coin)` is false → `launchpad.buy{value: bnbIn}(coin, minTokensOut)`;
  else `router.swapExactETHForTokensSupportingFeeOnTransferTokens{value: bnbIn}(minTokensOut, [weth, coin], address(this), deadline)`
  and enforce `minTokensOut` on the balance delta yourself (the fee-on-transfer variant does not check it).
  `bnbIn` must be ≤ `address(this).balance`. Tokens stay in the vault. Emit `Bought`.
- `sell`: on the curve → `approve(launchpad, tokens)` then `launchpad.sell(coin, tokens, minBnbOut)`; graduated →
  approve router, `swapExactTokensForETHSupportingFeeOnTransferTokens(tokens, minBnbOut, [coin, weth], address(this), block.timestamp)`,
  check the BNB delta ≥ `minBnbOut`. Then `pool.depositFor{value: proceeds - _relayFee}(pubKey, blinding)`.
  Emit `Sold` with the leaf index.
- `harvest`: `r = launchpad.roots()` (resolved at call time), `approve(r, tokens)`, `r.harvest(coin, tokens, minBnb)`
  (the **public** harvest, paid to the vault), then `depositFor{value: bnb - _relayFee}(pubKey, blinding)`. Emit
  `Harvested`. (Roots' own `harvestShielded` is not used: the fee has to come out of the proceeds.)
- `shield(amount, pubKey, blinding)`: `amount == 0` means `address(this).balance - _relayFee`; else require
  `amount + _relayFee <= balance`. `depositFor{value: amount}`. Emit `Shielded`.
- `exec(target, value, data)`: `target.call{value}(data)`, bubble reverts. `target` must not be the vault itself.
- `initialize` reverts if `owner != 0`. The implementation's constructor sets `owner = address(1)` so the
  implementation can never be initialised or used.
- `pubKey` and `blinding` are validated by the pool (`depositFor` requires field elements, pubKey ≠ 0).

### 1.2 DarkPool (factory)

```solidity
contract DarkPool is ReentrancyGuard {
    struct Order {
        address coin;
        uint256 bnbIn;          // exactly what the proof withdraws to the vault
        uint256 minTokensOut;
        address owner;          // fresh per order, derived from the shielded key in the browser (§3.1)
        uint64  deadline;       // unix seconds; 0 = none
        bytes32 nonce;          // random, makes the salt unique
    }

    ShieldedPool public immutable pool;
    ILaunchpadFull public immutable launchpad;
    address public immutable vaultImpl;      // DarkVault implementation deployed in the same constructor/script
    mapping(address => bool) public isVault;
    uint256 public vaultCount;

    event VaultCreated(address indexed vault, address indexed owner, address indexed coin, uint256 bnbIn, uint256 tokensOut, bool bought, bytes32 nonce);

    function orderSalt(Order calldata o) public pure returns (bytes32);            // keccak256(abi.encode(o))
    function vaultFor(Order calldata o) public view returns (address);             // Clones.predictDeterministicAddress(vaultImpl, orderSalt(o), address(this))
    function fill(Order calldata o) external nonReentrant returns (address vault); // lenient: the vault is always created, the buy may fail
    function transactAndFill(ShieldedPool.Proof calldata p, ShieldedPool.ExtData calldata e, Order calldata o)
        external nonReentrant returns (address vault);                             // strict: everything or nothing
}
```

Rules:

- `fill(o)`: `vault = vaultFor(o)`; revert `BadAmount` if `o.bnbIn == 0` (an unfunded order must never pass
  the next gate); revert `AlreadyFilled` if it has code; revert `NotFunded` if `vault.balance < o.bnbIn` (so a
  griefer cannot deploy an empty vault ahead of the payment). Deploy with
  `Clones.cloneDeterministic(vaultImpl, salt)`, `initialize(o.owner, o.coin)`, mark `isVault`, then
  `try vault.buyFromFactory(o.bnbIn, o.minTokensOut, deadline)` where `deadline = o.deadline == 0 ? type(uint256).max : o.deadline`;
  if the deadline has passed or the buy reverts, the vault keeps the BNB (`bought = false`) and the owner can
  `buy` or `shield` it back through `relay`. Leniency covers only a buy that reverts *with data* (every
  genuine failure on that path does: Launchpad / DarkVault custom errors, router string reasons, Panic); an
  empty revert payload is the inner call running out of gas, which the caller controls, and reverts the whole
  fill with `FillFailed`, so nobody can register an unbought vault by starving the buy of gas. Emit `VaultCreated`.
- `transactAndFill(p, e, o)`: require `e.recipient == vaultFor(o)`, `e.extAmount < 0 && uint256(-e.extAmount) == o.bnbIn`,
  `o.deadline == 0 || block.timestamp <= o.deadline`; `pool.transact(p, e)` (msg.value 0; the pool pays the
  vault address and pays `e.fee` to `e.relayer` itself); then the same creation as `fill` but with the buy
  **required** to succeed (no try/catch), so a failed slippage check reverts the whole transaction, the
  nullifiers stay unspent and the user simply re-proves. Returns the vault.
  Caveat: the pool binds the proof to `ExtData`, not to `msg.sender`, so a third party who sees `(p, e)` (the
  mempool, or the relayer itself) can submit the bare `pool.transact(p, e)` first. The BNB then sits at
  `vaultFor(o)` with no code, `transactAndFill` reverts `AlreadySpent`, and `fill(o)` is the only way to
  recover it (a different nonce is a different address). Atomicity therefore holds unless someone front-runs
  the withdrawal; the client must keep the order (chainId, order, vault) until a `VaultCreated` for that
  vault is observed, and offer `fill(o)` for a funded, codeless vault (§3.3).
- `vaultCount` increments on creation. No other state.

### 1.3 Interfaces to add to `contracts/src/interfaces/IGrove.sol`

```solidity
interface ILaunchpadFull is ILaunchpad { function sell(address coin, uint256 tokensIn, uint256 minBnbOut) external returns (uint256); function roots() external view returns (address); }
interface IShieldedPoolFull is IShieldedPool { /* depositFor already there */ }
interface IRootsHarvest { function harvest(address coin, uint256 tokens, uint256 minBnb) external returns (uint256 bnb); }
```
(`DarkPool` imports `ShieldedPool` itself for the `Proof`/`ExtData` structs.)

### 1.4 Deployment

- `script/Deploy.s.sol`: `_deployStack` deploys `DarkVault(impl)` then `DarkPool` after `launchpad.setRoots`
  (the vault impl reads `launchpad.roots()`), adds `darkPool` and `darkVaultImpl` to `Deployment`, the JSON
  and the log. `DeployLocal.s.sol` inherits it.
- New `script/DeployDarkPool.s.sol`: for chains already deployed (56, 97). Reads `deployments/<chainid>.json`
  (`launchpad`, `shieldedPool`, `router`), deploys impl + factory, and writes `darkPool`, `darkVaultImpl`
  back into that file (read the JSON, add the two keys, write it; keep every other key). Env: none beyond the
  broadcaster. Usage in its header comment:
  `forge script script/DeployDarkPool.s.sol:DeployDarkPool --rpc-url bsc --broadcast --private-key $PK`.
- `deploy.sh`: add `darkPool:src/DarkPool.sol:DarkPool darkVaultImpl:src/DarkVault.sol:DarkVault` to
  `VERIFY_MODULES` and `darkPool darkVaultImpl` to the `check_deployed` module list.

### 1.5 Tests (`contracts/test/DarkPool.t.sol`, on `BaseTest`)

MockVerifier accepts any proof, so a `transact` withdrawal is forged by building `ExtData` with the right
`recipient`/`extAmount`/`relayer`/`fee`, `Proof.extDataHash = pool.hashExtData(e)`,
`publicAmount = pool.calculatePublicAmount(extAmount, fee)`, `root = pool.getLastRoot()`, distinct nullifiers,
after `vm.deal(address(pool), …)`. Must cover at least:

1. `vaultFor` is stable and differs when any order field changes.
2. `transactAndFill` on the curve: vault holds tokens, `Trade` event has the vault as trader, relayer got
   `e.fee`, `VaultCreated(bought=true)`, `isVault`.
3. `transactAndFill` after graduation goes through the router (mock) and respects `minTokensOut`.
4. `transactAndFill` with a too-high `minTokensOut` reverts entirely: nullifiers unspent, pool balance intact.
5. `transactAndFill` with `recipient != vaultFor` or `bnbIn` mismatch reverts.
6. `fill` before funding reverts `NotFunded`; after a direct `vm.deal` to the predicted address it works;
   second `fill` reverts `AlreadyFilled`.
7. `fill` past the deadline creates the vault, does not buy, BNB stays; owner `relay(shield)` returns it to the
   pool as a `DepositFor` of `amount - fee` and pays the fee to the submitter.
8. `relay(sell)`: proceeds minus fee land in the pool (`DepositFor` with the given pubKey), fee paid to
   `msg.sender`, `Sold` emitted; `nonce` incremented.
9. `relay` replay (same sig) reverts; wrong signer reverts; expired reverts; forbidden selector reverts;
   inner revert bubbles (e.g. slippage on sell).
10. `relay(harvest)` burns via Roots and deposits proceeds minus fee.
11. `relay(exec)` moves tokens to an external address.
12. Direct owner call works without a signature (`vm.prank(owner)`), a stranger's direct call reverts.
13. `initialize` twice reverts; the implementation cannot be initialised; `buyFromFactory` from a non-factory reverts.
14. Gas: log `transactAndFill` gas on the curve so the relayer's `RELAY_GAS_UNITS_FILL_DEFAULT` can be checked
    (measured 1.87 M with the mock verifier: the pool's two Merkle inserts alone are ≈ 1.5 M; expect ≈ 2.1–2.2 M
    with the real verifier).

15. Review round: a direct `pool.transact` to `vaultFor(o)` strands the BNB (`transactAndFill` then reverts
    `AlreadySpent`) and `fill(o)` recovers it; a gas-starved `fill` reverts `FillFailed` instead of creating
    an unbought vault, while a slippage revert stays lenient; `fill` with `bnbIn == 0` reverts `BadAmount`;
    a relay signature is bound to its vault (two clones, same owner, nonce 0) and to the chain id; the
    lenient fill on a graduated coin; a curve-clearing fill (graduation inside the buy, refund in the vault);
    harvest after graduation; the `shield` amount / fee boundary; `exec` with value and `FeeUnpaid`; an
    `exec` target that re-enters `relay` or calls an owner function reverts.

Signatures in tests: `vm.sign(ownerPk, vault.relayDigest(data, fee, deadline, nonce, submitter))` and the relay
is sent with `vm.prank(submitter)`.

## 2. Relayer (`web/src/lib/relay.ts`, `web/src/app/api/relay/route.ts`)

Keep the existing `transact` request working unchanged. Add two request kinds and quote kinds.

### 2.1 Quote

`GET /api/relay?chainId=56&kind=transact|fill|vault|recover` (default `transact`). Gas units per kind, env-overridable:

| kind | default units | env |
|---|---|---|
| transact | `RELAY_GAS_UNITS_DEFAULT = 1_000_000` | `RELAY_GAS_UNITS` |
| fill | `RELAY_GAS_UNITS_FILL_DEFAULT = 2_300_000` | `RELAY_GAS_UNITS_FILL` |
| vault | `RELAY_GAS_UNITS_VAULT_DEFAULT = 450_000` | `RELAY_GAS_UNITS_VAULT` |
| recover | `RELAY_GAS_UNITS_RECOVER_DEFAULT = 500_000` | `RELAY_GAS_UNITS_RECOVER` (quoted for completeness; a recovery is not charged) |

Same margin and flat fee. `RelayQuote` gains `kind`. `fill` and `vault` quotes answer `{ok:false, reason:"dark pool not deployed on this chain"}` when `getDeployment(chainId).darkPool` is missing.

### 2.2 Submit

`POST /api/relay` body is one of (discriminated by `kind`, default `"transact"`):

```ts
{ kind?: "transact", chainId, proof, extData }                                   // existing
{ kind: "fill", chainId, proof, extData, order: OrderJson }                      // DarkPool.transactAndFill
{ kind: "vault", chainId, vault: Hex, data: Hex, fee: string, deadline: string, relayer: Hex, sig: Hex }   // DarkVault.relay
{ kind: "recover", chainId, order: OrderJson }                                   // DarkPool.fill(order), no proof, no fee
```
`OrderJson = { coin: Hex, bnbIn: string, minTokensOut: string, owner: Hex, deadline: string, nonce: Hex /*bytes32*/ }`.

Policy (pure, in `relay.ts`, unit-tested in `web/test/relay.test.mjs`):
- `fill`: everything `relayPolicy` already checks for a withdrawal, plus `extData.extAmount == -order.bnbIn`,
  `order.owner != 0`, `order.coin != 0`, `order.bnbIn > 0`. The route then checks on-chain that
  `extData.recipient == darkPool.vaultFor(order)` (readContract), estimates `transactAndFill`, requires
  `feeCovers(extData.fee, gasPrice, gas, flat)`, locks the nullifiers like today, sends from the relayer wallet.
- `vault`: `relayer` must be this relayer's address (the signature covers it), `fee > 0`, `deadline` in the
  future, `data` ≥ 4 bytes and ≤ 4 KB, `sig` 65 bytes. The route checks
  `darkPool.isVault(vault)` on-chain, estimates `vault.relay(data, fee, deadline, sig)` from the relayer account,
  requires `feeCovers(fee, gasPrice, gas, flat)`, sends. Serialise sends through the same queue; rate-limit like
  submissions. Log one line per send with the kind.

- `recover`: `bnbIn > 0`, `owner` and `coin` non-zero. The route reads `vaultFor(order)`, requires the address
  to have **no code** and a balance ≥ `bnbIn`, then sends `DarkPool.fill(order)` from the relayer wallet with no
  fee check: the pool already paid `extData.fee` to the relayer when that withdrawal was mined, whoever sent it.
  The `fill` path does the same check before `transactAndFill` and switches to the plain fill when the
  withdrawal has already landed (a retry after a lost race, or a front-runner who submitted the bare `transact`).

The response type is unchanged (`{ok, hash}` / `{ok:false, error, code}`).

## 3. Web

### 3.1 Vault owner keys (`web/src/lib/darkpool.ts`, pure, no React)

```ts
export const DARK_VAULT_KEY_TAG = "zkBNB dark vault v1";
/** secp256k1 private key for vault index i: keccak256(abi.encodePacked(bytes32(privkey), tag, uint32(i))) ; retry i+1 if ≥ n or 0 (never happens in practice). */
export function vaultOwnerKey(shieldedPrivkey: bigint, index: number): Hex;
export function vaultOwnerAddress(shieldedPrivkey: bigint, index: number): Address;   // privateKeyToAccount(...).address
export const VAULT_KEY_BATCH = 32;  // derive this many, extend while the highest match is within 10 of the end
export const DARK_VAULT_DOMAIN = (chainId: number, vault: Address) => ({ name: "zkBNB DarkVault", version: "1", chainId, verifyingContract: vault });
export const RELAY_TYPES = { Relay: [{ name: "data", type: "bytes" }, { name: "fee", type: "uint256" }, { name: "deadline", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "relayer", type: "address" }] } as const;
// pending orders: an order whose proof went to the relayer is kept in localStorage (key zkbnb:darkpool:pending:v1:<chainId>:<pubHex>)
// until its VaultCreated event is seen; listPendingOrders / savePendingOrder / removePendingOrders
export interface Order { coin: Address; bnbIn: bigint; minTokensOut: bigint; owner: Address; deadline: bigint; nonce: Hex }
export function randomOrderNonce(): Hex;      // 32 random bytes
export function serializeOrder(o: Order): OrderJson;
export function encodeVaultCall(fn: "buy" | "sell" | "harvest" | "shield" | "exec", args: readonly unknown[]): Hex;   // encodeFunctionData on DarkVaultAbi
```
Signing: `privateKeyToAccount(vaultOwnerKey(privkey, i)).signTypedData({ domain, types: RELAY_TYPES, primaryType: "Relay", message: { data, fee, deadline, nonce, relayer } })`
with `relayer` = the address from the `kind=vault` quote.
The owner keys are derived on demand from the in-memory shielded key and never stored.

### 3.2 ABIs and addresses

- Hand-write `web/src/abi/DarkPool.ts` and `web/src/abi/DarkVault.ts` (`as const`) from §1 so the web can be
  built before the contracts compile; `scripts/sync-abis.mjs` gets `"DarkPool", "DarkVault"` in `NAMES` and
  overwrites them from `contracts/out` afterwards.
- `Deployment` (`web/src/config/addresses.ts`) gains optional `darkPool` and `darkVaultImpl` (env overrides
  `NEXT_PUBLIC_DARK_POOL`, `NEXT_PUBLIC_DARK_VAULT_IMPL`; not in the `required` list; zero address when absent).
  `useZkbnb()` exposes `darkPoolDeployed: boolean`. `.env.example` documents them and the three relay env vars.

### 3.3 Hooks (`web/src/hooks/useDarkPool.ts`)

```ts
export interface DarkVault { vault: Address; owner: Address; ownerIndex: number; coin: Address; createdBlock: bigint; tx: Hex; tokens: bigint; bnb: bigint; nonce: bigint }
export function useDarkVaults(coin?: Address): { vaults: DarkVault[]; nextOwnerIndex: number; isLoading: boolean; refetch(): void }
  // derives owner addresses in batches of VAULT_KEY_BATCH from the shielded key, scans DarkPool VaultCreated
  // logs from dep.startBlock (scanLogs, react-query key ["dark-vaults", chainId, pubHex]), keeps those whose
  // owner is one of ours, reads balanceOf / getBalance / nonce for each via multicall or readContracts.
export function useDarkPoolActions(): {
  buy(coin: Address, bnbIn: bigint, minTokensOut: bigint): Promise<Hash | null>;   // quote(kind=fill) → order with owner = next free index → vaultFor → prove withdraw of bnbIn (+fee) to the vault → POST kind=fill
  relayVault(v: DarkVault, call: { fn; args }): Promise<Hash | null>;               // quote(kind=vault) → encode → sign with owner key → POST kind=vault
  sell(v: DarkVault, tokens: bigint, minBnbOut: bigint): Promise<Hash | null>;      // relayVault with sell(tokens, minBnbOut, key.pubkey, randomField())  + rememberBlinding("dark-sell")
  harvest(v: DarkVault, tokens: bigint, minBnb: bigint): Promise<Hash | null>;
  shield(v: DarkVault): Promise<Hash | null>;                                       // amount 0
  recover(p: PendingBuy): Promise<Hash | null>;                                    // POST kind=recover for a funded, codeless vault
  // useDarkVaults also returns `pending: PendingBuy[]` ({order, vault, at, funded}) from the stored pending orders:
  // dropped once the vault exists, or once an unfunded order is 15 min past its deadline. The panel shows them
  // above the positions with a "Finish this buy" button when `funded`.
  state: ActionState; progress: ProveProgress; busy: boolean; reset(): void;
}
```
`buy` reuses `useShieldedActions`' proving path (extract its `run` into a shared helper or export a lower-level
`proveSpend` from `useShieldedActions.ts`; do not duplicate the worker plumbing). The relayer is **mandatory**
for dark-pool buys (no wallet fallback: a wallet-sent `transactAndFill` would defeat the purpose); if the quote
fails the action errors with the reason. After success invalidate `["dark-vaults"]`, `["pool-events"]`,
`["notes"]`, `["coins"]`, `["launchpad-logs"]`.

### 3.4 UI

- `web/src/components/coin/TradePanel.tsx`: a second segmented control in the header, `Wallet | Dark pool`,
  shown only when `darkPoolDeployed`. In `Dark pool` mode the card body is `<DarkPoolPanel coin={coin} />`.
- `web/src/components/coin/DarkPoolPanel.tsx`:
  - No shielded key → the same "Derive it now" notice RootsBox uses.
  - Buy: amount input with the denomination chips (`DENOMINATIONS`, disabled above the shielded balance minus
    the quoted relayer fee), the curve/router quote (reuse the quote logic from TradePanel: factor it into
    `web/src/hooks/useTradeQuote.ts` used by both panels), slippage, a line "Relayer fee ≈ x BNB, paid from your
    notes", `Buy privately`. Non-standard amounts get the same warning as Move BNB.
  - Positions: the user's vaults for this coin (tokens, BNB left, created time, vault address linking to
    BscScan). Per vault: `Sell → pool` (amount input, all by default, quote + min), `Harvest → pool` (only when
    roots > 0), `Shield BNB` (only when `bnb > 0`). Each shows the quoted fee and the status / tx link.
  - `ProofProgress` while proving; a `Notice` with the honest summary from §0.1 (one paragraph).
  - If the relayer is unavailable: explain and disable the buttons (no wallet fallback).
- `web/src/components/MoveBnb.tsx`: a `Dark pool positions` section under the notes list: every vault across
  coins (symbol from `useCoins`, tokens, link to `/coin/<address>`), only when `darkPoolDeployed` and a key is
  derived. Keep the existing relayer / denominations work untouched otherwise.
- Home / coin cards: nothing.

### 3.5 Docs

- New `web/src/app/docs/darkpool/page.tsx` ("Dark pools"), added to `DOCS_GROUPS` under *Using zkBNB* after
  "The shielded pool". Content: what it is (§0), how a buy works (counterfactual vault, one proof, the
  relayer fills), how sells/harvests return to the pool, the hidden/public lists from §0.1 verbatim in spirit,
  the standard-sizes advice, what the relayer can and cannot do, the `relay()` signature model (your vault
  only acts on your owner key's signature; the key is derived from your shielded key, so your shielded key is
  all you need to recover every vault), and the addresses (`darkPool`, `darkVaultImpl`) read from the
  deployment like `/docs/trust` does.
- `/docs/shielded`: one bullet under "What is private" and one under "What is not private" pointing to the
  dark-pool page. `/docs/trust`: the "Admin cannot" list gains "touch a dark vault: DarkPool and DarkVault
  have no owner". `/docs` overview: the "Private people" idea mentions trading privately through dark pools.
- `SPEC.md`: new §3.9 "DarkPool / DarkVault" (10–20 lines, the contract surface and the privacy table), the
  relayer paragraph in §3.5 gains the two new kinds, §5 gains the panel and the docs page, §7 adds the two
  contracts to the deployment order.

## 4. Out of scope (say so in docs as "later")

- Hiding the amount or the coin of a buy (needs a multi-asset circuit and a new ceremony).
- Holder-reward claims from a vault in the UI (possible today through `exec`).
- A relayer network; there is one site relayer.
