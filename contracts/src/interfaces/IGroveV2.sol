// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IFeeRouter, PayoutMode} from "./IGrove.sol";
import {Launchpad} from "../Launchpad.sol";

/// Privacy stage 2 (privacy/PRIVACY-SPEC.md section 4) interfaces. IGrove.sol is left untouched;
/// everything the new contracts need beyond it lives here.

/// Groth16 verifiers by public-input count (snarkjs export; MockVerifierN in tests).
interface IVerifier13 {
    function verifyProof(uint256[2] calldata a, uint256[2][2] calldata b, uint256[2] calldata c, uint256[13] calldata pubSignals)
        external
        view
        returns (bool);
}

interface IVerifier17 {
    function verifyProof(uint256[2] calldata a, uint256[2][2] calldata b, uint256[2] calldata c, uint256[17] calldata pubSignals)
        external
        view
        returns (bool);
}

interface IVerifier5 {
    function verifyProof(uint256[2] calldata a, uint256[2][2] calldata b, uint256[2] calldata c, uint256[5] calldata pubSignals)
        external
        view
        returns (bool);
}

interface IVerifier8 {
    function verifyProof(uint256[2] calldata a, uint256[2][2] calldata b, uint256[2] calldata c, uint256[8] calldata pubSignals)
        external
        view
        returns (bool);
}

interface IHolderRewardsClaim {
    function claim(address coin, uint256 runId, uint256 amount, bytes32[] calldata proof) external;
}

interface IFeeRouterFull is IFeeRouter {
    function handOver(address coin, PayoutMode mode, address payoutWallet, uint256 ringId) external;
    function withdrawPending() external;
    function pending(address) external view returns (uint256);
}

/// The live Launchpad as the privacy contracts see it. There is no `isCoin` view in the stage-1
/// interface; coin existence is `info(coin).creator != 0`.
interface ILaunchpadPrivacy {
    function buy(address coin, uint256 minTokensOut) external payable returns (uint256 tokensOut);
    function sell(address coin, uint256 tokensIn, uint256 minBnbOut) external returns (uint256);
    function isGraduated(address coin) external view returns (bool);
    function pairOf(address coin) external view returns (address);
    function roots() external view returns (address);
    function plant(Launchpad.PlantParams calldata p) external payable returns (address);
    function plantFee() external view returns (uint256);
    function price(address coin) external view returns (uint256);
    function info(address coin)
        external
        view
        returns (
            address creator,
            uint64 createdAt,
            uint64 graduatedAt,
            uint256 realBnb,
            uint256 soldTokens,
            uint256 buys,
            uint256 sells,
            uint256 volumeBnb,
            address pair,
            PayoutMode payoutMode,
            uint256 ringId
        );
    function VIRTUAL_BNB() external view returns (uint256);
    function router() external view returns (address);
}

/// What GrovePool calls on the Planter (spec section 2.8).
interface IPlanter {
    function plantFor(bytes calldata payload) external payable returns (address coin);
    function handOver(address coin, uint256 handle, PayoutMode mode, address wallet, uint256 ringId) external;
}

/// The pool's module hooks as DarkCurve / Planter consume them (spec section 4.2).
interface IGrovePoolModule {
    function insertChunk(uint256[4] calldata leaves, bytes[] calldata encryptedOutputs) external returns (uint32);
    function markSpent(uint256 nullifier) external;
    function moveOut(address asset, uint256 amount, address to) external;
    function credit(uint256 handle) external payable;
    function isKnownRoot(uint256 root) external view returns (bool);
    function isSpent(uint256 nullifier) external view returns (bool);
    function accRpt(address coin) external view returns (uint256);
    function knownAccRpt(address coin, uint256 value) external view returns (bool);
    function isCoin(address coin) external view returns (bool);
}

/// Roots as the privacy contracts use it (burn from the caller, pay the caller).
interface IRootsHarvestV2 {
    function harvest(address coin, uint256 tokens, uint256 minBnb) external returns (uint256 bnb);
}
