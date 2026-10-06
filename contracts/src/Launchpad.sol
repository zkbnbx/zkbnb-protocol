// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {GroveCoin} from "./GroveCoin.sol";
import {IPancakeRouter02, IPancakeFactory, IPancakePair, IWETH} from "./interfaces/IPancake.sol";
import {IFeeRouter, PayoutMode, IGroveCoin} from "./interfaces/IGrove.sol";

/// @title Grove Launchpad
/// @notice Plants GroveCoins and runs their bonding curve (constant product with virtual reserves,
///         pump.fun shape scaled to BNB). When the curve sells out the coin graduates: the
///         remaining 206.9M tokens and all raised BNB become a PancakeSwap V2 pool whose LP
///         tokens are burned.
contract Launchpad is Ownable2Step, ReentrancyGuard {
    uint256 public constant BPS = 10_000;
    uint256 public constant FEE_BPS = 200; // 2.00% creator fee
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;
    uint256 public constant VIRTUAL_BNB = 4 ether;
    uint256 public constant VIRTUAL_TOKENS = 1_073_000_000e18;
    uint256 public constant CURVE_TOKENS = 793_100_000e18;
    uint256 public constant LP_TOKENS = TOTAL_SUPPLY - CURVE_TOKENS;
    uint256 public constant SEED_BUYS = 10;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    struct Metadata {
        string description;
        string image;
        string website;
        string twitter;
        string telegram;
    }

    struct CoinInfo {
        address creator;
        uint64 createdAt;
        uint64 graduatedAt;
        uint256 realBnb;
        uint256 soldTokens;
        uint256 buys;
        uint256 sells;
        uint256 volumeBnb;
        address pair;
        PayoutMode payoutMode;
        uint256 ringId;
    }

    struct PlantParams {
        string name;
        string symbol;
        Metadata metadata;
        PayoutMode payoutMode;
        address payoutWallet;
        uint256 ringId;
        uint256 minFirstBuyTokens;
    }

    IFeeRouter public immutable feeRouter;
    IPancakeRouter02 public immutable router;
    address public roots;
    uint256 public plantFee = 0.005 ether;

    address[] public coins;
    mapping(address => CoinInfo) public info;
    mapping(address => Metadata) public metadataOf;
    mapping(address => bool) public isCoin;

    event Planted(
        address indexed coin,
        address indexed creator,
        string name,
        string symbol,
        PayoutMode payoutMode,
        address payoutWallet,
        uint256 ringId
    );
    event Trade(
        address indexed coin,
        address indexed trader,
        bool isBuy,
        uint256 bnb,
        uint256 tokens,
        uint256 fee,
        uint256 priceAfter,
        uint256 realBnbAfter
    );
    event Graduated(address indexed coin, address pair, uint256 bnb, uint256 tokens);
    event PlantFeeSet(uint256 fee);
    event RootsSet(address roots);

    error NotCoin();
    error Graduated_();
    error NotGraduated();
    error Slippage();
    error ZeroAmount();
    error BadParams();

    constructor(address feeRouter_, address router_, address owner_) Ownable(owner_) {
        feeRouter = IFeeRouter(feeRouter_);
        router = IPancakeRouter02(router_);
    }

    // ---------------------------------------------------------------- admin

    function setPlantFee(uint256 fee) external onlyOwner {
        plantFee = fee;
        emit PlantFeeSet(fee);
    }

    /// @dev Roots burns from holders via burnFrom; it must be tax-exempt on every coin.
    function setRoots(address roots_) external onlyOwner {
        roots = roots_;
        emit RootsSet(roots_);
    }

    // ---------------------------------------------------------------- views

    function coinCount() external view returns (uint256) {
        return coins.length;
    }

    function allCoins() external view returns (address[] memory) {
        return coins;
    }

    function isGraduated(address coin) public view returns (bool) {
        return info[coin].pair != address(0);
    }

    function pairOf(address coin) external view returns (address) {
        return info[coin].pair;
    }

    /// @return 0 Seed (< 10 buys), 1 Sapling (on the curve), 2 Orchard (graduated)
    function stage(address coin) external view returns (uint8) {
        CoinInfo storage c = info[coin];
        if (c.pair != address(0)) return 2;
        if (c.buys < SEED_BUYS) return 0;
        return 1;
    }

    /// @notice Curve progress in BPS (0..10000).
    function curveProgress(address coin) external view returns (uint256) {
        return info[coin].soldTokens * BPS / CURVE_TOKENS;
    }

    /// @notice Spot price in wei per whole token (1e18 units), on the curve.
    function price(address coin) public view returns (uint256) {
        CoinInfo storage c = info[coin];
        uint256 vB = VIRTUAL_BNB + c.realBnb;
        uint256 vT = VIRTUAL_TOKENS - c.soldTokens;
        return vB * 1e18 / vT;
    }

    /// @notice BNB needed (net of fee) to buy the rest of the curve.
    function remainingCost(address coin) public view returns (uint256) {
        CoinInfo storage c = info[coin];
        uint256 remaining = CURVE_TOKENS - c.soldTokens;
        uint256 vB = VIRTUAL_BNB + c.realBnb;
        uint256 vT = VIRTUAL_TOKENS - c.soldTokens;
        // ceil division so the last buy always clears the curve
        return (vB * remaining + (vT - remaining) - 1) / (vT - remaining);
    }

    /// @notice Quote a buy with `bnbIn` sent (fee included). Returns tokens out, BNB actually used
    ///         (including fee) and the fee.
    function quoteBuy(address coin, uint256 bnbIn)
        public
        view
        returns (uint256 tokensOut, uint256 bnbUsed, uint256 fee)
    {
        CoinInfo storage c = info[coin];
        uint256 netMax = remainingCost(coin);
        uint256 grossMax = netMax * BPS / (BPS - FEE_BPS) + 1;
        bnbUsed = bnbIn < grossMax ? bnbIn : grossMax;
        fee = bnbUsed * FEE_BPS / BPS;
        uint256 net = bnbUsed - fee;
        uint256 vB = VIRTUAL_BNB + c.realBnb;
        uint256 vT = VIRTUAL_TOKENS - c.soldTokens;
        tokensOut = vT * net / (vB + net);
        uint256 remaining = CURVE_TOKENS - c.soldTokens;
        if (tokensOut > remaining) tokensOut = remaining;
    }

    /// @notice Quote a sell of `tokensIn`. Returns BNB to the seller (net), gross BNB and the fee.
    function quoteSell(address coin, uint256 tokensIn)
        public
        view
        returns (uint256 bnbOut, uint256 gross, uint256 fee)
    {
        CoinInfo storage c = info[coin];
        uint256 vB = VIRTUAL_BNB + c.realBnb;
        uint256 vT = VIRTUAL_TOKENS - c.soldTokens;
        gross = vB * tokensIn / (vT + tokensIn);
        if (gross > c.realBnb) gross = c.realBnb;
        fee = gross * FEE_BPS / BPS;
        bnbOut = gross - fee;
    }

    // ------------------------------------------------------------- planting

    function plant(PlantParams calldata p) external payable nonReentrant returns (address coin) {
        if (bytes(p.name).length == 0 || bytes(p.symbol).length == 0) revert BadParams();
        if (msg.value < plantFee) revert BadParams();
        if (p.payoutMode == PayoutMode.Wallet && p.payoutWallet == address(0)) revert BadParams();

        GroveCoin c = new GroveCoin(p.name, p.symbol, address(this), address(feeRouter), address(router), false);
        coin = address(c);
        if (roots != address(0)) c.setExempt(roots, true);

        coins.push(coin);
        isCoin[coin] = true;
        CoinInfo storage ci = info[coin];
        ci.creator = msg.sender;
        ci.createdAt = uint64(block.timestamp);
        ci.payoutMode = p.payoutMode;
        ci.ringId = p.ringId;
        metadataOf[coin] = p.metadata;

        feeRouter.registerCoin(coin, msg.sender, p.payoutMode, p.payoutWallet, p.ringId, false);

        _send(feeRouter.treasury(), plantFee);
        emit Planted(coin, msg.sender, p.name, p.symbol, p.payoutMode, p.payoutWallet, p.ringId);

        uint256 firstBuy = msg.value - plantFee;
        if (firstBuy > 0) {
            _buy(coin, msg.sender, firstBuy, p.minFirstBuyTokens);
        }
    }

    /// @notice Operator-only: plant the rootstock coin ($GROVE). Its whole fee goes to treasury.
    function plantRootstock(string calldata name, string calldata symbol, Metadata calldata md)
        external
        payable
        onlyOwner
        nonReentrant
        returns (address coin)
    {
        GroveCoin c = new GroveCoin(name, symbol, address(this), address(feeRouter), address(router), true);
        coin = address(c);
        if (roots != address(0)) c.setExempt(roots, true);
        coins.push(coin);
        isCoin[coin] = true;
        CoinInfo storage ci = info[coin];
        ci.creator = msg.sender;
        ci.createdAt = uint64(block.timestamp);
        ci.payoutMode = PayoutMode.Creator;
        metadataOf[coin] = md;
        feeRouter.registerCoin(coin, msg.sender, PayoutMode.Creator, address(0), 0, true);
        emit Planted(coin, msg.sender, name, symbol, PayoutMode.Creator, address(0), 0);
        if (msg.value > 0) _buy(coin, msg.sender, msg.value, 0);
    }

    // -------------------------------------------------------------- trading

    function buy(address coin, uint256 minTokensOut) external payable nonReentrant returns (uint256 tokensOut) {
        return _buy(coin, msg.sender, msg.value, minTokensOut);
    }

    function _buy(address coin, address buyer, uint256 bnbIn, uint256 minTokensOut) internal returns (uint256 tokensOut) {
        if (!isCoin[coin]) revert NotCoin();
        CoinInfo storage c = info[coin];
        if (c.pair != address(0)) revert Graduated_();
        if (bnbIn == 0) revert ZeroAmount();

        (uint256 out, uint256 used, uint256 fee) = quoteBuy(coin, bnbIn);
        if (out == 0) revert ZeroAmount();
        if (out < minTokensOut) revert Slippage();
        tokensOut = out;

        c.realBnb += used - fee;
        c.soldTokens += out;
        c.buys += 1;
        c.volumeBnb += used;

        IERC20(coin).transfer(buyer, out);
        feeRouter.collect{value: fee}(coin);

        emit Trade(coin, buyer, true, used, out, fee, price(coin), c.realBnb);

        if (c.soldTokens >= CURVE_TOKENS) {
            _graduate(coin);
        }
        // refund last: the buyer gets no callback while the pair is being built
        if (bnbIn > used) _send(buyer, bnbIn - used);
    }

    function sell(address coin, uint256 tokensIn, uint256 minBnbOut) external nonReentrant returns (uint256 bnbOut) {
        if (!isCoin[coin]) revert NotCoin();
        CoinInfo storage c = info[coin];
        if (c.pair != address(0)) revert Graduated_();
        if (tokensIn == 0) revert ZeroAmount();

        (uint256 net, uint256 gross, uint256 fee) = quoteSell(coin, tokensIn);
        if (net == 0) revert ZeroAmount();
        if (net < minBnbOut) revert Slippage();
        bnbOut = net;

        c.realBnb -= gross;
        c.soldTokens -= tokensIn;
        c.sells += 1;
        c.volumeBnb += gross;

        IERC20(coin).transferFrom(msg.sender, address(this), tokensIn);
        feeRouter.collect{value: fee}(coin);
        _send(msg.sender, net);

        emit Trade(coin, msg.sender, false, gross, tokensIn, fee, price(coin), c.realBnb);
    }

    // ------------------------------------------------------------ graduation

    /// @dev Pairs with the raised BNB on PancakeSwap V2 and burns the LP.
    ///      Anyone can create the pair early (factory.createPair) and seed it with skewed reserves
    ///      (token / WBNB donation + sync, optionally minting LP). With strict addLiquidity mins that
    ///      would make graduation revert forever; with loose mins it would add our BNB at the
    ///      attacker's price and let token holders drain it. So we never rely on the router's
    ///      liquidity math: if LP already exists we first trade the pair back to our price (the
    ///      mispricing is captured by us, not by the LP holder), then put everything we hold into
    ///      the pair and mint LP to DEAD. The final pool is (their tokens + ours, their BNB + ours):
    ///      a donation can only lower the opening price, never let anyone take the raised BNB.
    function _graduate(address coin) internal {
        CoinInfo storage c = info[coin];
        uint256 bnb = c.realBnb;
        require(IERC20(coin).balanceOf(address(this)) >= LP_TOKENS, "lp tokens");

        address factory = router.factory();
        address weth = router.WETH();
        address pair = IPancakeFactory(factory).getPair(coin, weth);
        if (pair == address(0)) pair = IPancakeFactory(factory).createPair(coin, weth);

        (uint112 r0, uint112 r1,) = IPancakePair(pair).getReserves();
        if ((r0 != 0 || r1 != 0) && IPancakePair(pair).totalSupply() != 0) {
            bnb = _normalizePair(coin, pair, weth, bnb);
        }

        uint256 tokens = IERC20(coin).balanceOf(address(this));
        IERC20(coin).transfer(pair, tokens);
        IWETH(weth).deposit{value: bnb}();
        IWETH(weth).transfer(pair, bnb);
        IPancakePair(pair).mint(DEAD);

        IGroveCoin(coin).setPair(pair);
        c.pair = pair;
        c.realBnb = 0;
        c.graduatedAt = uint64(block.timestamp);
        emit Graduated(coin, pair, bnb, tokens);
    }

    /// @dev Best-effort arbitrage of a pre-seeded pair towards the ratio the final pool will have
    ///      anyway, (their tokens + ours) : (their BNB + ours), using the coin's own tokens / BNB.
    ///      After the swap the pair and what we still hold sit at that same ratio, so the mint wastes
    ///      neither side and the seeder's LP is worth exactly its fair share (at most what was put
    ///      in). Returns the BNB we still hold for the pool. Capped so we always keep most of both
    ///      sides for the mint; the swap fee and wei rounding leave a negligible residual.
    function _normalizePair(address coin, address pair, address weth, uint256 bnb) internal returns (uint256) {
        (uint112 r0, uint112 r1,) = IPancakePair(pair).getReserves();
        (uint256 rT, uint256 rB) = IPancakePair(pair).token0() == coin ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        if (rT == 0 || rB == 0) return bnb;
        uint256 tokens = IERC20(coin).balanceOf(address(this));
        address[] memory path = new address[](2);

        if (rT * bnb > rB * tokens) {
            // tokens are cheaper there than in the final pool: buy them with BNB until the ratio matches
            uint256 targetB = Math.sqrt(Math.mulDiv(rT * rB, rB + bnb, rT + tokens));
            if (targetB <= rB) return bnb;
            uint256 inB = targetB - rB;
            if (inB > bnb * 9 / 10) inB = bnb * 9 / 10;
            path[0] = weth;
            path[1] = coin;
            if (inB == 0 || router.getAmountsOut(inB, path)[1] == 0) return bnb;
            router.swapExactETHForTokensSupportingFeeOnTransferTokens{value: inB}(0, path, address(this), block.timestamp);
            return bnb - inB;
        }
        if (rT * bnb < rB * tokens) {
            // tokens are dearer there: sell some into the pair until the ratio matches
            uint256 targetT = Math.sqrt(Math.mulDiv(rT * rB, rT + tokens, rB + bnb));
            if (targetT <= rT) return bnb;
            uint256 inT = targetT - rT;
            if (inT > tokens * 9 / 10) inT = tokens * 9 / 10;
            path[0] = coin;
            path[1] = weth;
            if (inT == 0 || router.getAmountsOut(inT, path)[1] == 0) return bnb;
            IERC20(coin).approve(address(router), inT);
            uint256 before = address(this).balance;
            router.swapExactTokensForETHSupportingFeeOnTransferTokens(inT, 0, path, address(this), block.timestamp);
            return bnb + (address(this).balance - before);
        }
        return bnb;
    }

    function _send(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount}("");
        require(ok, "send");
    }

    receive() external payable {}
}
