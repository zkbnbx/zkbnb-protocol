// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPancakeRouter02} from "./interfaces/IPancake.sol";
import {IRoots, IHolderRewards, IDonationRotator, ILaunchpad, IGroveCoin, PayoutMode} from "./interfaces/IGrove.sol";
import {IRootstockBuyback} from "./interfaces/IFlap.sol";

/// @title FeeRouter
/// @notice Every 2.00% creator fee lands here and is split at once:
///         25% roots (0.50%) · 25% rootstock buy+burn (0.50%) · 10% treasury (0.20%) ·
///         40% deployer's choice (0.80%): Creator / Wallet / Holders / Donate.
///         Bounds: roots never below 25% of the fee, treasury never above 20%.
contract FeeRouter is Ownable2Step, ReentrancyGuard {
    uint256 public constant BPS = 10_000;
    uint256 public constant MIN_ROOTS_SHARE = 2500;
    uint256 public constant MAX_TREASURY_SHARE = 2000;

    struct CoinConfig {
        address creator;
        PayoutMode mode;
        address payoutWallet;
        uint256 ringId;
        bool isRootstock;
        bool registered;
        bool handedOver; // once true, nobody can change mode/wallet again
        bool rootsPaused;
    }

    address public launchpad;
    IRoots public roots;
    IHolderRewards public holderRewards;
    IDonationRotator public donationRotator;
    IPancakeRouter02 public immutable router;

    address public treasury;
    address public immutable recoveryAddress;
    address public rootstockCoin;
    /// @notice Set only when the rootstock token lives outside zkBNB (see setExternalRootstock).
    IRootstockBuyback public rootstockBuyback;
    /// @notice Keeper hot wallet: may sweep taxes and run buybacks without the public size caps.
    address public keeper;
    /// @notice Max BNB a non-keeper `buybackAndBurn` spends per call (once per block): bounds the
    ///         sandwichable price impact of a public buyback. The keeper passes an off-chain quote.
    uint256 public publicBuybackCap = 0.05 ether;
    uint256 public lastPublicBuybackBlock;

    uint256 public rootsShareBps = 2500;
    uint256 public rootstockShareBps = 2500;
    uint256 public treasuryShareBps = 1000;
    uint256 public deployerShareBps = 4000;

    uint256 public rootstockPot;
    mapping(address => CoinConfig) public configOf;
    mapping(address => uint256) public pending; // failed pushes, pull them later
    uint256 public totalPending; // sum of `pending`, so the rootstock pot never counts that BNB
    mapping(address => uint256) public collectedOf; // lifetime fees per coin

    event ModulesSet(address launchpad, address roots, address holderRewards, address donationRotator);
    event CoinRegistered(address indexed coin, address creator, PayoutMode mode, address payoutWallet, uint256 ringId, bool isRootstock);
    event FeeCollected(address indexed coin, uint256 amount, address source);
    event FeeSplit(address indexed coin, uint256 toRoots, uint256 toRootstock, uint256 toTreasury, uint256 toDeployer, PayoutMode mode);
    event PayoutModeHandedOver(address indexed coin, PayoutMode mode, address wallet, uint256 ringId);
    event Buyback(uint256 bnbIn, uint256 groveBurned);
    event SharesSet(uint256 roots, uint256 rootstock, uint256 treasury, uint256 deployer);
    event TreasurySet(address treasury);
    event RootstockSet(address coin);
    event RootstockBuybackSet(address buyback);
    event RootsPaused(address indexed coin, bool paused);
    event PendingWithdrawn(address indexed to, uint256 amount);
    event KeeperSet(address keeper);
    event PublicBuybackCapSet(uint256 cap);

    error NotAuthorized();
    error NotRegistered();
    error HandedOver();
    error BadShares();

    constructor(address treasury_, address recoveryAddress_, address router_, address owner_) Ownable(owner_) {
        require(treasury_ != address(0) && recoveryAddress_ != address(0), "zero");
        treasury = treasury_;
        recoveryAddress = recoveryAddress_;
        router = IPancakeRouter02(router_);
    }

    // ---------------------------------------------------------------- admin

    /// @dev One-shot: re-pointing the modules later would let the owner redirect every future fee
    ///      share (SPEC 3.8 promises the admin cannot take roots BNB).
    function setModules(address launchpad_, address roots_, address holderRewards_, address donationRotator_) external onlyOwner {
        require(launchpad == address(0), "set");
        require(launchpad_ != address(0) && roots_ != address(0) && holderRewards_ != address(0) && donationRotator_ != address(0), "zero");
        launchpad = launchpad_;
        roots = IRoots(roots_);
        holderRewards = IHolderRewards(holderRewards_);
        donationRotator = IDonationRotator(donationRotator_);
        emit ModulesSet(launchpad_, roots_, holderRewards_, donationRotator_);
    }

    function setShares(uint256 roots_, uint256 rootstock_, uint256 treasury_, uint256 deployer_) external onlyOwner {
        if (roots_ < MIN_ROOTS_SHARE || treasury_ > MAX_TREASURY_SHARE) revert BadShares();
        if (roots_ + rootstock_ + treasury_ + deployer_ != BPS) revert BadShares();
        rootsShareBps = roots_;
        rootstockShareBps = rootstock_;
        treasuryShareBps = treasury_;
        deployerShareBps = deployer_;
        emit SharesSet(roots_, rootstock_, treasury_, deployer_);
    }

    function setKeeper(address keeper_) external onlyOwner {
        keeper = keeper_;
        emit KeeperSet(keeper_);
    }

    function setPublicBuybackCap(uint256 cap) external onlyOwner {
        publicBuybackCap = cap;
        emit PublicBuybackCapSet(cap);
    }

    function setTreasury(address treasury_) external onlyOwner {
        require(treasury_ != address(0), "zero");
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    function setRootstock(address coin) external onlyOwner {
        require(rootstockCoin == address(0), "set");
        require(configOf[coin].isRootstock, "not rootstock");
        rootstockCoin = coin;
        emit RootstockSet(coin);
    }

    /// @notice One-shot alternative to `setRootstock`: the rootstock token was launched outside
    ///         zkBNB (on Flap), and `buyback_` buys and burns it with the rootstock pot.
    function setExternalRootstock(address coin, address buyback_) external onlyOwner {
        require(rootstockCoin == address(0), "set");
        require(coin != address(0) && IRootstockBuyback(buyback_).token() == coin, "buyback token");
        require(IRootstockBuyback(buyback_).feeRouter() == address(this), "buyback router");
        rootstockCoin = coin;
        rootstockBuyback = IRootstockBuyback(buyback_);
        emit RootstockSet(coin);
        emit RootstockBuybackSet(buyback_);
    }

    /// @notice Pause a coin's roots (its roots share goes to the recovery address while paused).
    function setRootsPaused(address coin, bool paused) external onlyOwner {
        configOf[coin].rootsPaused = paused;
        emit RootsPaused(coin, paused);
    }

    // ------------------------------------------------------------ registry

    function registerCoin(address coin, address creator, PayoutMode mode, address payoutWallet, uint256 ringId, bool isRootstock)
        external
    {
        if (msg.sender != launchpad) revert NotAuthorized();
        CoinConfig storage c = configOf[coin];
        require(!c.registered, "registered");
        c.registered = true;
        c.creator = creator;
        c.isRootstock = isRootstock;
        c.mode = mode;
        if (mode == PayoutMode.Wallet) {
            c.payoutWallet = payoutWallet;
            c.handedOver = true;
        } else if (mode == PayoutMode.Holders) {
            c.handedOver = true;
        } else if (mode == PayoutMode.Donate) {
            require(donationRotator.ringExists(ringId), "ring");
            c.ringId = ringId;
            c.handedOver = true;
            donationRotator.bindCoin(coin, ringId);
        }
        emit CoinRegistered(coin, creator, mode, payoutWallet, ringId, isRootstock);
        if (c.handedOver) emit PayoutModeHandedOver(coin, mode, payoutWallet, ringId);
    }

    /// @notice The creator of a coin still in Creator mode can hand the 0.80% over once:
    ///         to a wallet, to holders, or to a donation ring. Irrevocable.
    function handOver(address coin, PayoutMode mode, address payoutWallet, uint256 ringId) external {
        CoinConfig storage c = configOf[coin];
        if (!c.registered) revert NotRegistered();
        if (msg.sender != c.creator) revert NotAuthorized();
        if (c.handedOver || c.isRootstock) revert HandedOver();
        require(mode != PayoutMode.Creator, "mode");
        c.mode = mode;
        c.handedOver = true;
        if (mode == PayoutMode.Wallet) {
            require(payoutWallet != address(0), "wallet");
            c.payoutWallet = payoutWallet;
        } else if (mode == PayoutMode.Donate) {
            require(donationRotator.ringExists(ringId), "ring");
            c.ringId = ringId;
            donationRotator.bindCoin(coin, ringId);
        }
        emit PayoutModeHandedOver(coin, mode, payoutWallet, ringId);
    }

    // ------------------------------------------------------------- collect

    /// @notice Called by the Launchpad (curve trades) or by the coin itself (pair-tax sweeps).
    function collect(address coin) external payable nonReentrant {
        CoinConfig storage c = configOf[coin];
        if (!c.registered) revert NotRegistered();
        if (msg.sender != launchpad && msg.sender != coin) revert NotAuthorized();
        uint256 amount = msg.value;
        if (amount == 0) return;
        collectedOf[coin] += amount;
        emit FeeCollected(coin, amount, msg.sender);

        if (c.isRootstock) {
            // the rootstock coin's whole fee goes to the treasury (as on Sapling)
            _push(treasury, amount);
            emit FeeSplit(coin, 0, 0, amount, 0, PayoutMode.Creator);
            return;
        }

        uint256 toRoots = amount * rootsShareBps / BPS;
        uint256 toRootstock = amount * rootstockShareBps / BPS;
        uint256 toTreasury = amount * treasuryShareBps / BPS;
        uint256 toDeployer = amount - toRoots - toRootstock - toTreasury;

        if (c.rootsPaused) {
            _push(recoveryAddress, toRoots);
        } else {
            roots.deposit{value: toRoots}(coin);
        }
        rootstockPot += toRootstock;
        _push(treasury, toTreasury);

        if (c.mode == PayoutMode.Creator) {
            _push(c.creator, toDeployer);
        } else if (c.mode == PayoutMode.Wallet) {
            _push(c.payoutWallet, toDeployer);
        } else if (c.mode == PayoutMode.Holders) {
            holderRewards.fund{value: toDeployer}(coin);
        } else {
            donationRotator.fund{value: toDeployer}(coin);
        }
        emit FeeSplit(coin, toRoots, toRootstock, toTreasury, toDeployer, c.mode);
    }

    // ------------------------------------------------------------ rootstock

    /// @notice Buy $GROVE with the rootstock pot and burn it. Anyone can call; non-keeper calls
    ///         spend at most `publicBuybackCap` per block (the keeper quotes `minGroveOut` off-chain).
    /// @dev Not `nonReentrant`: on the curve this calls `Launchpad.buy`, which calls back into
    ///      `collect` (guarded). The pot is debited before any external call instead.
    function buybackAndBurn(uint256 minGroveOut) external returns (uint256 burned) {
        address grove = rootstockCoin;
        require(grove != address(0), "no rootstock");
        uint256 bnb = rootstockPot;
        if (msg.sender != keeper) {
            require(block.number > lastPublicBuybackBlock, "one per block");
            lastPublicBuybackBlock = block.number;
            if (bnb > publicBuybackCap) bnb = publicBuybackCap;
        }
        require(bnb > 0, "empty");
        rootstockPot -= bnb;
        // "free" BNB = balance minus what is owed to pending payees (a push can fail mid-buyback)
        uint256 freeBefore = address(this).balance - totalPending - bnb;

        if (address(rootstockBuyback) != address(0)) {
            // rootstock launched elsewhere (Flap): the buyback contract buys, burns and refunds
            burned = rootstockBuyback.buyAndBurn{value: bnb}(minGroveOut);
            require(burned >= minGroveOut, "slippage");
        } else {
            uint256 before = IERC20(grove).balanceOf(address(this));
            if (ILaunchpad(launchpad).isGraduated(grove)) {
                address[] memory path = new address[](2);
                path[0] = router.WETH();
                path[1] = grove;
                router.swapExactETHForTokensSupportingFeeOnTransferTokens{value: bnb}(minGroveOut, path, address(this), block.timestamp);
            } else {
                ILaunchpad(launchpad).buy{value: bnb}(grove, minGroveOut);
            }
            burned = IERC20(grove).balanceOf(address(this)) - before;
            require(burned >= minGroveOut, "slippage");
            IGroveCoin(grove).burn(burned);
        }
        // a curve can refund whatever exceeds the rest of it: keep that for the next buyback
        uint256 leftover = address(this).balance - totalPending - freeBefore;
        if (leftover > 0) rootstockPot += leftover;
        emit Buyback(leftover < bnb ? bnb - leftover : 0, burned);
    }

    // ------------------------------------------------------------- payouts

    function withdrawPending() external nonReentrant {
        uint256 amount = pending[msg.sender];
        require(amount > 0, "nothing");
        pending[msg.sender] = 0;
        totalPending -= amount;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "send");
        emit PendingWithdrawn(msg.sender, amount);
    }

    function _push(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount, gas: 50_000}("");
        if (!ok) {
            pending[to] += amount;
            totalPending += amount;
        }
    }

    receive() external payable {}
}
