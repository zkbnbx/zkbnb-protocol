// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPancakeRouter02} from "./interfaces/IPancake.sol";
import {IFlapPortal, IPancakeV3SwapRouter, IRootstockBuyback} from "./interfaces/IFlap.sol";

interface IPancakeRouterTokens {
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external;
}

/// @title FlapBuyback
/// @notice Buys the rootstock token that was launched on Flap (paired to an ERC-20 quote token such
///         as Binance-Peg ZEC) with the FeeRouter's rootstock pot, and burns it.
///         - On Flap's bonding curve: one call to the Portal with BNB in (Flap swaps BNB to the
///           quote token internally).
///         - After migration to its PancakeSwap V2 pool: BNB -> quote token on PancakeSwap V3
///           (`bnbToQuotePath`), then quote token -> rootstock token on the V2 pair.
///         Only the FeeRouter can call it, so the FeeRouter's public cap and the keeper's minOut
///         apply to every buyback. Bought tokens go to the dead address.
contract FlapBuyback is IRootstockBuyback, Ownable2Step {
    using SafeERC20 for IERC20;

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint8 internal constant STATUS_TRADABLE = 1;
    uint8 internal constant STATUS_DEX = 4;

    address public immutable override token;
    address public immutable quoteToken;
    address public immutable override feeRouter;
    address public immutable wbnb;
    IFlapPortal public immutable portal;
    IPancakeRouter02 public immutable v2Router;
    IPancakeV3SwapRouter public immutable v3Router;

    /// @notice PancakeSwap V3 path from WBNB to the quote token (abi.encodePacked(token, fee, token...)).
    ///         Settable by the owner because pool depth moves over time; it can only ever start at
    ///         WBNB and end at the quote token, and the caller's minOut still bounds the result.
    bytes public bnbToQuotePath;

    event BnbToQuotePathSet(bytes path);
    event Burned(uint256 bnbIn, uint256 tokensBurned, bool viaDex);

    constructor(
        address token_,
        address quoteToken_,
        address feeRouter_,
        address portal_,
        address v2Router_,
        address v3Router_,
        bytes memory bnbToQuotePath_,
        address owner_
    ) Ownable(owner_) {
        require(token_ != address(0) && quoteToken_ != address(0) && feeRouter_ != address(0) && portal_ != address(0), "zero");
        IFlapPortal.TokenStateV3 memory st = IFlapPortal(portal_).getTokenV3(token_);
        require(st.status == STATUS_TRADABLE || st.status == STATUS_DEX, "not a flap token");
        require(st.quoteTokenAddress == quoteToken_, "quote token");
        token = token_;
        quoteToken = quoteToken_;
        feeRouter = feeRouter_;
        portal = IFlapPortal(portal_);
        v2Router = IPancakeRouter02(v2Router_);
        v3Router = IPancakeV3SwapRouter(v3Router_);
        wbnb = IPancakeRouter02(v2Router_).WETH();
        _setPath(bnbToQuotePath_);
    }

    function setBnbToQuotePath(bytes calldata path) external onlyOwner {
        _setPath(path);
    }

    function _setPath(bytes memory path) internal {
        // one hop is 20 + 3 + 20 bytes, every further hop adds 23
        require(path.length >= 43 && (path.length - 20) % 23 == 0, "path");
        address first;
        address last;
        assembly {
            first := shr(96, mload(add(path, 32)))
            last := shr(96, mload(add(add(path, 32), sub(mload(path), 20))))
        }
        require(first == wbnb && last == quoteToken, "path ends");
        bnbToQuotePath = path;
        emit BnbToQuotePathSet(path);
    }

    /// @notice 1 while the token is on Flap's curve, 4 once it trades on PancakeSwap.
    function status() public view returns (uint8) {
        return portal.getTokenV2(token).status;
    }

    function buyAndBurn(uint256 minOut) external payable override returns (uint256 burned) {
        require(msg.sender == feeRouter, "only feeRouter");
        require(msg.value > 0, "empty");
        uint256 before = IERC20(token).balanceOf(address(this));
        uint8 s = status();
        bool viaDex;
        if (s == STATUS_TRADABLE) {
            portal.swapExactInput{value: msg.value}(
                IFlapPortal.ExactInputParams({inputToken: address(0), outputToken: token, inputAmount: msg.value, minOutputAmount: minOut, permitData: ""})
            );
        } else if (s == STATUS_DEX) {
            viaDex = true;
            v3Router.exactInput{value: msg.value}(
                IPancakeV3SwapRouter.ExactInputParams({path: bnbToQuotePath, recipient: address(this), deadline: block.timestamp, amountIn: msg.value, amountOutMinimum: 0})
            );
            // the whole quote balance: also spends any quote token a curve buy refunded earlier
            uint256 quoteIn = IERC20(quoteToken).balanceOf(address(this));
            IERC20(quoteToken).forceApprove(address(v2Router), quoteIn);
            address[] memory path = new address[](2);
            path[0] = quoteToken;
            path[1] = token;
            IPancakeRouterTokens(address(v2Router)).swapExactTokensForTokensSupportingFeeOnTransferTokens(quoteIn, minOut, path, address(this), block.timestamp);
        } else {
            revert("not tradable");
        }
        uint256 bal = IERC20(token).balanceOf(address(this));
        burned = bal - before;
        require(burned >= minOut, "slippage");
        IERC20(token).safeTransfer(DEAD, bal); // whole balance: tokens sent here are burned too
        // unspent BNB (and any BNB sent here) goes back to the FeeRouter's rootstock pot
        uint256 left = address(this).balance;
        if (left > 0) {
            (bool ok,) = feeRouter.call{value: left}("");
            require(ok, "refund");
        }
        emit Burned(left < msg.value ? msg.value - left : 0, burned, viaDex);
    }

    receive() external payable {}
}
