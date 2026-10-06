// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {IPancakeRouter02} from "./interfaces/IPancake.sol";
import {IFeeRouter} from "./interfaces/IGrove.sol";

/// @title GroveCoin
/// @notice A coin planted on Grove. 1B supply minted to the Launchpad. After graduation to
///         PancakeSwap the 2.00% creator fee keeps flowing through a pair-tax: trades with the
///         pair leave 2% of the tokens here, and anyone can `sweepTax` them into BNB for FeeRouter.
contract GroveCoin is ERC20, ERC20Burnable {
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;
    uint256 public constant FEE_BPS = 200;
    uint256 public constant BPS = 10_000;
    /// @notice A non-keeper sweep may sell at most this share of the pair's token reserve, once per
    ///         block. That bounds the price impact (and so the MEV) of a public sweep: a sandwich on
    ///         a 1%-of-reserves sale captures well under 1% of it. The keeper (FeeRouter.keeper) sweeps
    ///         the whole pile with an off-chain quoted `minBnbOut`.
    uint256 public constant PUBLIC_SWEEP_BPS = 100;

    address public immutable launchpad;
    IFeeRouter public immutable feeRouter;
    IPancakeRouter02 public immutable router;
    bool public immutable isRootstock;

    address public pair;
    uint256 public lastPublicSweepBlock;
    mapping(address => bool) public isExempt;

    event PairSet(address pair);
    event ExemptSet(address account, bool exempt);
    event TaxSwept(uint256 tokens, uint256 bnb);

    modifier onlyLaunchpad() {
        require(msg.sender == launchpad, "launchpad");
        _;
    }

    constructor(
        string memory name_,
        string memory symbol_,
        address launchpad_,
        address feeRouter_,
        address router_,
        bool isRootstock_
    ) ERC20(name_, symbol_) {
        launchpad = launchpad_;
        feeRouter = IFeeRouter(feeRouter_);
        router = IPancakeRouter02(router_);
        isRootstock = isRootstock_;
        isExempt[launchpad_] = true;
        isExempt[feeRouter_] = true;
        isExempt[address(this)] = true;
        _mint(launchpad_, TOTAL_SUPPLY);
        if (router_ != address(0)) {
            _approve(address(this), router_, type(uint256).max);
        }
    }

    function setPair(address pair_) external onlyLaunchpad {
        require(pair == address(0), "pair set");
        pair = pair_;
        emit PairSet(pair_);
    }

    function setExempt(address account, bool exempt) external onlyLaunchpad {
        isExempt[account] = exempt;
        emit ExemptSet(account, exempt);
    }

    function accruedTax() public view returns (uint256) {
        return balanceOf(address(this));
    }

    /// @notice Swap accrued tax tokens for BNB and hand it to FeeRouter. Anyone can call; callers
    ///         other than the keeper are limited to PUBLIC_SWEEP_BPS of the pair's token reserve per
    ///         block (`minBnbOut` is caller-supplied, so an unbounded public sweep could be sandwiched).
    function sweepTax(uint256 minBnbOut) external returns (uint256 bnb) {
        uint256 tokens = balanceOf(address(this));
        require(tokens > 0, "nothing");
        require(pair != address(0), "not graduated");
        if (msg.sender != feeRouter.keeper()) {
            require(block.number > lastPublicSweepBlock, "one per block");
            lastPublicSweepBlock = block.number;
            uint256 cap = balanceOf(pair) * PUBLIC_SWEEP_BPS / BPS;
            if (tokens > cap) tokens = cap;
            require(tokens > 0, "nothing");
        }
        address[] memory path = new address[](2);
        path[0] = address(this);
        path[1] = router.WETH();
        uint256 before = address(this).balance;
        router.swapExactTokensForETHSupportingFeeOnTransferTokens(tokens, minBnbOut, path, address(this), block.timestamp);
        bnb = address(this).balance - before;
        require(bnb >= minBnbOut, "slippage");
        feeRouter.collect{value: bnb}(address(this));
        emit TaxSwept(tokens, bnb);
    }

    function _update(address from, address to, uint256 amount) internal override {
        address p = pair;
        if (p != address(0) && from != address(0) && to != address(0) && (from == p || to == p)
                && !isExempt[from] && !isExempt[to]) {
            uint256 tax = amount * FEE_BPS / BPS;
            if (tax > 0) {
                super._update(from, address(this), tax);
                amount -= tax;
            }
        }
        super._update(from, to, amount);
    }

    receive() external payable {}
}
