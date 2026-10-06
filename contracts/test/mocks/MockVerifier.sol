// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Groth16 verifier stand-in for unit tests: accepts every proof unless told not to.
contract MockVerifier {
    bool public result = true;

    function setResult(bool r) external {
        result = r;
    }

    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[7] calldata)
        external
        view
        returns (bool)
    {
        return result;
    }
}
