import { parseAbi } from "viem";

/**
 * Human-readable ABIs for the slice of each contract the keeper touches.
 * Signatures mirror contracts/src/*.sol exactly; test/abi.test.ts cross-checks them against
 * the compiled artifacts in contracts/out when those exist.
 */

export const groveCoinAbi = parseAbi([
  "function accruedTax() view returns (uint256)",
  "function pair() view returns (address)",
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function sweepTax(uint256 minBnbOut) returns (uint256 bnb)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event TaxSwept(uint256 tokens, uint256 bnb)",
]);

export const launchpadAbi = parseAbi([
  "function allCoins() view returns (address[])",
  "function coinCount() view returns (uint256)",
  "function pairOf(address coin) view returns (address)",
  "function isGraduated(address coin) view returns (bool)",
  "function stage(address coin) view returns (uint8)",
  "function price(address coin) view returns (uint256)",
  "function quoteBuy(address coin, uint256 bnbIn) view returns (uint256 tokensOut, uint256 bnbUsed, uint256 fee)",
  "function info(address coin) view returns (address creator, uint64 createdAt, uint64 graduatedAt, uint256 realBnb, uint256 soldTokens, uint256 buys, uint256 sells, uint256 volumeBnb, address pair, uint8 payoutMode, uint256 ringId)",
  "function roots() view returns (address)",
  "event Planted(address indexed coin, address indexed creator, string name, string symbol, uint8 payoutMode, address payoutWallet, uint256 ringId)",
  "event Trade(address indexed coin, address indexed trader, bool isBuy, uint256 bnb, uint256 tokens, uint256 fee, uint256 priceAfter, uint256 realBnbAfter)",
  "event Graduated(address indexed coin, address pair, uint256 bnb, uint256 tokens)",
  "error NotCoin()",
  "error Graduated_()",
  "error NotGraduated()",
  "error Slippage()",
  "error ZeroAmount()",
  "error BadParams()",
]);

export const feeRouterAbi = parseAbi([
  "function configOf(address coin) view returns (address creator, uint8 mode, address payoutWallet, uint256 ringId, bool isRootstock, bool registered, bool handedOver, bool rootsPaused)",
  "function rootstockPot() view returns (uint256)",
  "function rootstockCoin() view returns (address)",
  "function rootstockBuyback() view returns (address)",
  "function keeper() view returns (address)",
  "function collectedOf(address coin) view returns (uint256)",
  "function launchpad() view returns (address)",
  "function treasury() view returns (address)",
  "function buybackAndBurn(uint256 minGroveOut) returns (uint256 burned)",
  "event FeeCollected(address indexed coin, uint256 amount, address source)",
  "event FeeSplit(address indexed coin, uint256 toRoots, uint256 toRootstock, uint256 toTreasury, uint256 toDeployer, uint8 mode)",
  "event Buyback(uint256 bnbIn, uint256 groveBurned)",
  "event PayoutModeHandedOver(address indexed coin, uint8 mode, address wallet, uint256 ringId)",
  "event CoinRegistered(address indexed coin, address creator, uint8 mode, address payoutWallet, uint256 ringId, bool isRootstock)",
  "event RootstockBuybackSet(address buyback)",
  "error NotAuthorized()",
  "error NotRegistered()",
  "error HandedOver()",
  "error BadShares()",
]);

export const rootsAbi = parseAbi([
  "function balance(address coin) view returns (uint256)",
  "function cap() view returns (uint256)",
  "event Deposited(address indexed coin, uint256 amount, uint256 overflow)",
  "event Harvested(address indexed coin, address indexed harvester, uint256 tokensBurned, uint256 bnb, bool shielded, uint256 leafIndex)",
]);

export const holderRewardsAbi = parseAbi([
  "function pot(address coin) view returns (uint256)",
  "function lastRunAt(address coin) view returns (uint256)",
  "function minPot() view returns (uint256)",
  "function claimWindow() view returns (uint256)",
  "function keeper() view returns (address)",
  "function runCount(address coin) view returns (uint256)",
  "function getRun(address coin, uint256 runId) view returns ((bytes32 root, uint256 amount, uint256 claimed, uint256 holders, uint64 postedAt, string uri))",
  "function leaf(address coin, uint256 runId, address account, uint256 amount) pure returns (bytes32)",
  "function postRun(address coin, bytes32 root, uint256 amount, uint256 holders, string uri) returns (uint256 runId)",
  "function tip(address coin) payable",
  "function claim(address coin, uint256 runId, uint256 amount, bytes32[] proof)",
  "function isClaimed(address coin, uint256 runId, address account) view returns (bool)",
  "event Funded(address indexed coin, uint256 amount, address from)",
  "event RunPosted(address indexed coin, uint256 indexed runId, bytes32 root, uint256 amount, uint256 holders, string uri)",
  "event Claimed(address indexed coin, uint256 indexed runId, address indexed account, uint256 amount, bool shielded, uint256 leafIndex)",
  "event Swept(address indexed coin, uint256 indexed runId, uint256 amount)",
  "error NotAuthorized()",
  "error BadProof()",
  "error AlreadyClaimed()",
  "error TooSoon()",
  "error PotTooSmall()",
  "error WindowOpen()",
]);

export const donationRotatorAbi = parseAbi([
  "function ringCount() view returns (uint256)",
  "function ringExists(uint256 ringId) view returns (bool)",
  "function pot(uint256 ringId) view returns (uint256)",
  "function nextSettleAt(uint256 ringId) view returns (uint256)",
  "function nextCause(uint256 ringId) view returns (uint256)",
  "function getRing(uint256 ringId) view returns (string name, uint256[] causeIds, uint256 epochLength, uint256 cursor, uint256 lastSettled, uint256 epochsSettled, address creator)",
  "function settle(uint256 ringId) returns (uint256 causeId, uint256 amount)",
  "function causeCount() view returns (uint256)",
  "function getCause(uint256 causeId) view returns ((string name, string uri, uint256 shieldedPubKey, bytes32 encryptionKey, address fallbackWallet, address owner, bool active, uint256 received))",
  "function pending(address) view returns (uint256)",
  "event Funded(uint256 indexed ringId, address indexed coin, uint256 amount, address from)",
  "event Donated(uint256 indexed ringId, uint256 amount, address from)",
  "event DirectDonation(uint256 indexed causeId, uint256 amount, address from, bool shielded, uint256 leafIndex)",
  "event Settled(uint256 indexed ringId, uint256 indexed epoch, uint256 indexed causeId, uint256 amount, bool shielded, uint256 leafIndex)",
  "event PayoutDeferred(uint256 indexed causeId, address indexed to, uint256 amount, bool poolFailed)",
  "event PendingWithdrawn(address indexed to, uint256 amount)",
  "error NotAuthorized()",
  "error BadCause()",
  "error BadRing()",
  "error TooSoon()",
  "error Empty()",
]);

/** Adapter that buys and burns a rootstock token launched on Flap (contracts/src/FlapBuyback.sol). */
export const flapBuybackAbi = parseAbi([
  "function token() view returns (address)",
  "function quoteToken() view returns (address)",
  "function feeRouter() view returns (address)",
  "function status() view returns (uint8)",
  "event Burned(uint256 bnbIn, uint256 tokensBurned, bool viaDex)",
]);

export const routerAbi = parseAbi([
  "function WETH() view returns (address)",
  "function factory() view returns (address)",
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
]);

export const pairAbi = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
]);

/** Every event the Rings feed decodes, in one ABI so a single getLogs per chunk suffices. */
export const feedEventsAbi = [
  ...feeRouterAbi.filter((x) => x.type === "event"),
  ...rootsAbi.filter((x) => x.type === "event"),
  ...holderRewardsAbi.filter((x) => x.type === "event"),
  ...donationRotatorAbi.filter((x) => x.type === "event"),
] as const;
