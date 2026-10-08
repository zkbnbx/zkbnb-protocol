// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoseidonT3} from "./interfaces/IGrove.sol";
import {GroveConstants as C} from "./libraries/GroveConstants.sol";

/// @title Incremental Poseidon Merkle tree, depth 23, 4-leaf chunk inserts, checkpointed roots
/// @notice Spec sections 2.1 / 4.1. Every transaction inserts exactly one chunk of 4 leaves (unused
///         slots = ZERO_LEAF), so `nextIndex` is always a multiple of 4 and a chunk costs 2 + 1 + 21
///         Poseidon calls. Roots are recorded as known only at checkpoints: the root in force at the
///         first insert after each CHECKPOINT_PERIOD boundary, or when anyone calls `checkpoint()`
///         after a boundary with no insert. The map is unbounded: an old checkpoint stays known
///         forever (double spends are stopped by nullifiers, not by root expiry).
abstract contract MerkleTreeWithHistoryV2 {
    uint256 public constant FIELD_SIZE = C.FIELD_SIZE;
    uint256 public constant ZERO_VALUE = C.ZERO_LEAF;
    uint32 public constant CHECKPOINT_PERIOD = C.CHECKPOINT_PERIOD;

    IPoseidonT3 public immutable hasher;
    uint32 public immutable levels;

    mapping(uint256 => uint256) public filledSubtrees;
    mapping(uint256 => uint256) public zeros;
    /// @dev 0 = unknown; else nextIndex at the checkpoint + 1. CHECKPOINTS ONLY.
    mapping(uint256 root => uint32 indexAfter) public rootIndexAfter;
    /// @dev Always a multiple of 4.
    uint32 public nextIndex;
    /// @dev Current root; NOT known until checkpointed.
    uint256 public lastRoot;
    /// @dev block.timestamp / CHECKPOINT_PERIOD of the last checkpoint.
    uint64 public lastCheckpointPeriod;

    event Checkpoint(uint256 root, uint32 indexAfter, uint64 period);

    error TreeFull();
    error NotInField();

    constructor(uint32 _levels, address _hasher) {
        require(_levels > 2 && _levels < 32, "levels");
        levels = _levels;
        hasher = IPoseidonT3(_hasher);

        uint256 currentZero = C.ZERO_LEAF;
        for (uint32 i = 0; i < _levels; i++) {
            zeros[i] = currentZero;
            filledSubtrees[i] = currentZero;
            currentZero = hashLeftRight(currentZero, currentZero);
        }
        lastRoot = currentZero;
        // genesis checkpoint so the first proofs have a root
        lastCheckpointPeriod = uint64(block.timestamp / C.CHECKPOINT_PERIOD);
        rootIndexAfter[currentZero] = 1;
        emit Checkpoint(currentZero, 0, lastCheckpointPeriod);
    }

    function hashLeftRight(uint256 left, uint256 right) public view returns (uint256) {
        if (left >= C.FIELD_SIZE || right >= C.FIELD_SIZE) revert NotInField();
        return hasher.poseidon([left, right]);
    }

    /// @notice Records `lastRoot` as a known root once per CHECKPOINT_PERIOD. Anyone; no-op inside
    ///         the period of the last checkpoint.
    function checkpoint() public {
        uint64 period = uint64(block.timestamp / C.CHECKPOINT_PERIOD);
        if (period <= lastCheckpointPeriod) return;
        lastCheckpointPeriod = period;
        uint32 after_ = nextIndex;
        rootIndexAfter[lastRoot] = after_ + 1;
        emit Checkpoint(lastRoot, after_, period);
    }

    function isKnownRoot(uint256 root) public view returns (bool) {
        return root != 0 && rootIndexAfter[root] != 0;
    }

    function getLastRoot() public view returns (uint256) {
        return lastRoot;
    }

    /// @notice Chunks that are still free.
    function chunksLeft() public view returns (uint256) {
        return (uint256(2) ** levels - nextIndex) / C.CHUNK;
    }

    /// @dev Checkpoints first (so a checkpoint always records the root in force at the boundary,
    ///      with every leaf inserted before it and none after), then inserts the chunk.
    function _insertChunk(uint256[4] memory leaves) internal returns (uint32 firstIndex) {
        checkpoint();
        uint32 idx = nextIndex;
        if (uint256(idx) + C.CHUNK > uint256(2) ** levels) revert TreeFull();

        uint256 h01 = hashLeftRight(leaves[0], leaves[1]);
        uint256 h23 = hashLeftRight(leaves[2], leaves[3]);
        uint256 current = hashLeftRight(h01, h23);
        uint32 ci = idx / C.CHUNK; // position at level 2

        for (uint32 i = 2; i < levels; i++) {
            if (ci % 2 == 0) {
                filledSubtrees[i] = current;
                current = hashLeftRight(current, zeros[i]);
            } else {
                current = hashLeftRight(filledSubtrees[i], current);
            }
            ci /= 2;
        }
        lastRoot = current;
        nextIndex = idx + C.CHUNK;
        return idx;
    }
}
