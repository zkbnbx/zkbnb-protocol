// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoseidonT3} from "./interfaces/IGrove.sol";

/// @notice Incremental Poseidon Merkle tree with a ring buffer of recent roots (tornado style).
contract MerkleTreeWithHistory {
    uint256 public constant FIELD_SIZE =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;
    /// keccak256("grove") mod FIELD_SIZE. Any leaf index that was never filled hashes from this.
    uint256 public constant ZERO_VALUE =
        19524425634078878347273533764823178855725786503789258942133279824547046949394;
    uint32 public constant ROOT_HISTORY_SIZE = 100;

    IPoseidonT3 public immutable hasher;
    uint32 public immutable levels;

    mapping(uint256 => uint256) public filledSubtrees;
    mapping(uint256 => uint256) public zeros;
    mapping(uint256 => uint256) public roots;
    uint32 public currentRootIndex;
    uint32 public nextIndex;

    constructor(uint32 _levels, address _hasher) {
        require(_levels > 0 && _levels < 32, "levels");
        levels = _levels;
        hasher = IPoseidonT3(_hasher);

        uint256 currentZero = ZERO_VALUE;
        for (uint32 i = 0; i < _levels; i++) {
            zeros[i] = currentZero;
            filledSubtrees[i] = currentZero;
            currentZero = hashLeftRight(currentZero, currentZero);
        }
        roots[0] = currentZero;
    }

    function hashLeftRight(uint256 left, uint256 right) public view returns (uint256) {
        require(left < FIELD_SIZE && right < FIELD_SIZE, "field");
        return hasher.poseidon([left, right]);
    }

    function _insert(uint256 leaf) internal returns (uint32 index) {
        uint32 _nextIndex = nextIndex;
        require(_nextIndex != uint32(2) ** levels, "tree full");
        uint32 currentIndex = _nextIndex;
        uint256 currentLevelHash = leaf;
        uint256 left;
        uint256 right;

        for (uint32 i = 0; i < levels; i++) {
            if (currentIndex % 2 == 0) {
                left = currentLevelHash;
                right = zeros[i];
                filledSubtrees[i] = currentLevelHash;
            } else {
                left = filledSubtrees[i];
                right = currentLevelHash;
            }
            currentLevelHash = hashLeftRight(left, right);
            currentIndex /= 2;
        }

        uint32 newRootIndex = (currentRootIndex + 1) % ROOT_HISTORY_SIZE;
        currentRootIndex = newRootIndex;
        roots[newRootIndex] = currentLevelHash;
        nextIndex = _nextIndex + 1;
        return _nextIndex;
    }

    function isKnownRoot(uint256 root) public view returns (bool) {
        if (root == 0) return false;
        uint32 i = currentRootIndex;
        do {
            if (root == roots[i]) return true;
            if (i == 0) i = ROOT_HISTORY_SIZE;
            i--;
        } while (i != currentRootIndex);
        return false;
    }

    function getLastRoot() public view returns (uint256) {
        return roots[currentRootIndex];
    }
}
