// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IHolderRewardsPost {
    function postRun(address coin, bytes32 root, uint256 amount, uint256 holders, string calldata uri)
        external
        returns (uint256 runId);
}

interface IGrovePoolRewards {
    function pullRewards(address coin, uint256 runId, uint256 amount, bytes32[] calldata proof) external;
}

/// @title HolderRewards keeper for privacy stage 2 (review N1)
/// @notice GrovePool spreads a pulled run over the coin notes in the pool *at pull time*. With the run
///         posted in one transaction and pulled in a later one, anyone could shield coins after seeing
///         the posted run and take a share earned by earlier shielded holders (or be paid twice: once
///         as a snapshot holder, once through the pool). This contract is HolderRewards' keeper and
///         does both in one transaction, so the run is never public before the pool's share is in.
///         It holds no funds and has no owner: to rotate the operator, deploy a new poster and point
///         `HolderRewards.setKeeper` at it.
contract RewardPoster {
    IHolderRewardsPost public immutable holderRewards;
    IGrovePoolRewards public immutable pool;
    /// @notice The keeper wallet allowed to post.
    address public immutable operator;

    error NotOperator();
    error ZeroAddress();

    constructor(address holderRewards_, address pool_, address operator_) {
        if (holderRewards_ == address(0) || pool_ == address(0) || operator_ == address(0)) revert ZeroAddress();
        holderRewards = IHolderRewardsPost(holderRewards_);
        pool = IGrovePoolRewards(pool_);
        operator = operator_;
    }

    /// @notice Posts the run and, when the pool is in it (`poolAmount > 0`), pulls the pool's share in
    ///         the same transaction. Reverts as a whole if the pull fails, so a run that includes the
    ///         pool is never left with its pool leaf unclaimed.
    function post(
        address coin,
        bytes32 root,
        uint256 amount,
        uint256 holders,
        string calldata uri,
        uint256 poolAmount,
        bytes32[] calldata poolProof
    ) external returns (uint256 runId) {
        if (msg.sender != operator) revert NotOperator();
        runId = holderRewards.postRun(coin, root, amount, holders, uri);
        if (poolAmount > 0) pool.pullRewards(coin, runId, poolAmount, poolProof);
    }
}
