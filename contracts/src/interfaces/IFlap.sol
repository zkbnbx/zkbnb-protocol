// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice The parts of Flap's Portal (https://docs.flap.sh) the rootstock buyback uses.
interface IFlapPortal {
    /// @dev Flap's TokenStatus: 0 Invalid, 1 Tradable (on the bonding curve), 2 InDuel, 3 Killed,
    ///      4 DEX (migrated to its PancakeSwap V2 pool), 5 Staged.
    struct TokenStateV2 {
        uint8 status;
        uint256 reserve;
        uint256 circulatingSupply;
        uint256 price;
        uint8 tokenVersion;
        uint256 r;
        uint256 dexSupplyThresh;
    }

    /// @dev getTokenV3: the V2 fields plus the quote token (address(0) = native BNB).
    struct TokenStateV3 {
        uint8 status;
        uint256 reserve;
        uint256 circulatingSupply;
        uint256 price;
        uint8 tokenVersion;
        uint256 r;
        uint256 dexSupplyThresh;
        address quoteTokenAddress;
        bool nativeToQuoteSwapEnabled;
    }

    struct ExactInputParams {
        address inputToken; // address(0) = native BNB
        address outputToken;
        uint256 inputAmount;
        uint256 minOutputAmount;
        bytes permitData;
    }

    function getTokenV2(address token) external view returns (TokenStateV2 memory state);
    function getTokenV3(address token) external view returns (TokenStateV3 memory state);
    /// @dev Bonding-curve trades only. With an ERC-20 quote token and BNB in, the Portal swaps BNB
    ///      for the quote token itself (the quote token's nativeToQuoteSwap must be enabled).
    function swapExactInput(ExactInputParams calldata params) external payable returns (uint256 outputAmount);
}

/// @notice PancakeSwap V3 SwapRouter (0x1b81D678ffb9C0263b24A97847620C99d213eB14 on BSC).
interface IPancakeV3SwapRouter {
    /// @dev getTokenV3: the V2 fields plus the quote token (address(0) = native BNB).
    struct TokenStateV3 {
        uint8 status;
        uint256 reserve;
        uint256 circulatingSupply;
        uint256 price;
        uint8 tokenVersion;
        uint256 r;
        uint256 dexSupplyThresh;
        address quoteTokenAddress;
        bool nativeToQuoteSwapEnabled;
    }

    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

/// @notice What the FeeRouter needs from an external rootstock buyback.
interface IRootstockBuyback {
    function token() external view returns (address);
    /// @dev The only caller `buyAndBurn` accepts.
    function feeRouter() external view returns (address);
    /// @dev Spends msg.value on `token`, burns what it bought and returns that amount.
    ///      Any BNB it could not spend is sent back to the caller.
    function buyAndBurn(uint256 minOut) external payable returns (uint256 burned);
}
