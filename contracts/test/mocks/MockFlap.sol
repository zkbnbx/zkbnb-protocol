// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IFlapPortal, IPancakeV3SwapRouter} from "../../src/interfaces/IFlap.sol";

/// @notice Mintable ERC-20 standing in for the Flap token and its quote token (ZEC).
contract MockToken is ERC20 {
    constructor(string memory symbol_) ERC20(symbol_, symbol_) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Flap Portal stand-in: per-token status / quote token, and a bonding-curve buy with BNB in
///         at `rate` tokens per wei that can refund part of the BNB (`refundBps`, as when a buy
///         finishes the curve).
contract MockFlapPortal {
    mapping(address => uint8) public statusOf;
    mapping(address => address) public quoteOf;
    uint256 public rate = 1000;
    uint256 public refundBps;

    function setToken(address token, uint8 status, address quote) external {
        statusOf[token] = status;
        quoteOf[token] = quote;
    }

    function setRate(uint256 r) external {
        rate = r;
    }

    function setRefundBps(uint256 bps) external {
        refundBps = bps;
    }

    function getTokenV2(address token) external view returns (IFlapPortal.TokenStateV2 memory s) {
        s.status = statusOf[token];
    }

    function getTokenV3(address token) external view returns (IFlapPortal.TokenStateV3 memory s) {
        s.status = statusOf[token];
        s.quoteTokenAddress = quoteOf[token];
        s.nativeToQuoteSwapEnabled = true;
    }

    function swapExactInput(IFlapPortal.ExactInputParams calldata p) external payable returns (uint256 out) {
        require(statusOf[p.outputToken] == 1, "not on curve");
        require(p.inputToken == address(0) && p.inputAmount == msg.value, "input");
        uint256 refund = msg.value * refundBps / 10_000;
        out = (msg.value - refund) * rate;
        require(out >= p.minOutputAmount, "SlippageTooHigh");
        MockToken(p.outputToken).mint(msg.sender, out);
        if (refund > 0) {
            (bool ok,) = msg.sender.call{value: refund}("");
            require(ok, "refund");
        }
    }
}

/// @notice PancakeSwap stand-in: V3 `exactInput` (BNB -> quote at `quoteRate` per wei) and the V2
///         `swapExactTokensForTokensSupportingFeeOnTransferTokens` (quote -> token at `tokenRate`).
contract MockFlapDex is IPancakeV3SwapRouter {
    address public immutable WETH;
    uint256 public quoteRate = 2;
    uint256 public tokenRate = 500;
    bytes public lastPath;

    constructor(address weth) {
        WETH = weth;
    }

    function setRates(uint256 q, uint256 t) external {
        quoteRate = q;
        tokenRate = t;
    }

    function exactInput(ExactInputParams calldata p) external payable override returns (uint256 amountOut) {
        require(msg.value == p.amountIn, "value");
        lastPath = p.path;
        address quote;
        bytes memory path = p.path;
        assembly {
            quote := shr(96, mload(add(add(path, 32), sub(mload(path), 20))))
        }
        amountOut = p.amountIn * quoteRate;
        require(amountOut >= p.amountOutMinimum, "Too little received");
        MockToken(quote).mint(p.recipient, amountOut);
    }

    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256
    ) external {
        IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn);
        uint256 out = amountIn * tokenRate;
        require(out >= amountOutMin, "INSUFFICIENT_OUTPUT_AMOUNT");
        MockToken(path[1]).mint(to, out);
    }
}

/// @notice Accepts every module call the FeeRouter makes (roots / holder rewards / donations).
contract MockSink {
    function deposit(address) external payable {}
    function fund(address) external payable {}
    function bindCoin(address, uint256) external {}

    function ringExists(uint256) external pure returns (bool) {
        return true;
    }
}
