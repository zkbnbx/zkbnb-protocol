// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ILaunchpad, IShieldedPool} from "./IGrove.sol";

/// Dark pools (SPEC §3.9 / privacy/DARKPOOL-SPEC.md §1.3): what a DarkVault needs beyond ILaunchpad.
/// Kept out of IGrove.sol so the deployed contracts' sources stay byte-identical to what is verified.
interface ILaunchpadFull is ILaunchpad {
    function sell(address coin, uint256 tokensIn, uint256 minBnbOut) external returns (uint256);
    function roots() external view returns (address);
}

interface IShieldedPoolFull is IShieldedPool {}

interface IRootsHarvest {
    function harvest(address coin, uint256 tokens, uint256 minBnb) external returns (uint256 bnb);
}
