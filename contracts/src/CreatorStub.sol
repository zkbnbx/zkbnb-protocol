// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Launchpad} from "./Launchpad.sol";
import {PayoutMode} from "./interfaces/IGrove.sol";
import {ILaunchpadPrivacy, IFeeRouterFull, IGrovePoolModule} from "./interfaces/IGroveV2.sol";

/// @title The public "creator" of a privately planted coin (spec section 2.8 / 4.4)
/// @notice Deployed by the Planter per private plant. It is the `msg.sender` of `Launchpad.plant`
///         (so `Planted.creator == stub` and FeeRouter pushes the deployer share here), it can hand
///         the payout mode over once (only through the Planter, which is only reachable through a
///         pool proof that owns `handle`), and anyone may `flush` its balance into the pool as a
///         credit to `handle`. Nothing here names a key or a wallet.
contract CreatorStub {
    address public immutable planter;
    IGrovePoolModule public immutable pool;
    ILaunchpadPrivacy public immutable launchpad;
    IFeeRouterFull public immutable feeRouter;
    uint256 public immutable handle;
    address public coin;

    event Flushed(uint256 amount);

    error NotPlanter();
    error AlreadyPlanted();
    error NotPlanted();

    modifier onlyPlanter() {
        if (msg.sender != planter) revert NotPlanter();
        _;
    }

    constructor(address planter_, address pool_, address launchpad_, address feeRouter_, uint256 handle_) {
        planter = planter_;
        pool = IGrovePoolModule(pool_);
        launchpad = ILaunchpadPrivacy(launchpad_);
        feeRouter = IFeeRouterFull(feeRouter_);
        handle = handle_;
    }

    /// @notice Plant once; `msg.value` is exactly the plant fee (no first buy: the creator's first
    ///         buy is a held BUY intent, spec section 2.6.6).
    function plant(Launchpad.PlantParams calldata p) external payable onlyPlanter returns (address c) {
        if (coin != address(0)) revert AlreadyPlanted();
        c = launchpad.plant{value: msg.value}(p);
        coin = c;
    }

    /// @notice Hand the deployer share over (wallet / holders / ring). Irrevocable, FeeRouter rules.
    function handOver(PayoutMode mode, address wallet, uint256 ringId) external onlyPlanter {
        if (coin == address(0)) revert NotPlanted();
        feeRouter.handOver(coin, mode, wallet, ringId);
    }

    /// @notice Anyone: pull any `pending` push from the FeeRouter, then credit the whole balance
    ///         to `handle` in the pool.
    function flush() external {
        if (feeRouter.pending(address(this)) > 0) feeRouter.withdrawPending();
        uint256 bal = address(this).balance;
        if (bal > 0) {
            pool.credit{value: bal}(handle);
            emit Flushed(bal);
        }
    }

    /// @dev FeeRouter._push gives 50k gas and no coin id; just accept.
    receive() external payable {}
}
