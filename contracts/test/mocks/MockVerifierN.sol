// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Groth16 verifier stand-ins for the stage-2 circuits, one per public-input count.
///         They accept every proof unless `setResult(false)`. Tests pin the exact signal order the
///         contracts build (WORKPLAN section 1.2) with `vm.expectCall` on `verifyProof`.
///         INTEGRATION HOOK: swap these for the dev verifiers exported by circuits/scripts/setup-v2.sh
///         (contracts/src/verifiers/Groth16Verifier{Transfer,Intent,Claim,Open}.sol) and feed the
///         real proofs from contracts/test/fixtures/v2/ — see `PrivacyBase.t.sol: _verifiers()`.
abstract contract MockVerifierBase {
    bool public result = true;

    function setResult(bool r) external {
        result = r;
    }
}

contract MockVerifier13 is MockVerifierBase {
    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[13] calldata)
        external
        view
        returns (bool)
    {
        return result;
    }
}

contract MockVerifier17 is MockVerifierBase {
    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[17] calldata)
        external
        view
        returns (bool)
    {
        return result;
    }
}

contract MockVerifier5 is MockVerifierBase {
    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[5] calldata)
        external
        view
        returns (bool)
    {
        return result;
    }
}

contract MockVerifier8 is MockVerifierBase {
    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[8] calldata)
        external
        view
        returns (bool)
    {
        return result;
    }
}
