// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IGroveCoin, IShieldedPool, IHolderRewards} from "./interfaces/IGrove.sol";

/// @title Roots
/// @notice Every coin has roots: a BNB vault fed by 0.50% of each trade. Burn coins to harvest
///         your share: `roots × burned ÷ totalUnburnedSupply`. The ratio never drops from a
///         harvest. Harvests can be paid publicly or as a shielded note.
contract Roots is Ownable2Step, ReentrancyGuard {
    address public immutable feeRouter;
    IShieldedPool public immutable pool;
    IHolderRewards public holderRewards;

    uint256 public cap = 50 ether;
    mapping(address => uint256) public balance;
    mapping(address => uint256) public totalHarvested;
    mapping(address => uint256) public totalBurned;

    event Deposited(address indexed coin, uint256 amount, uint256 overflow);
    event Harvested(address indexed coin, address indexed harvester, uint256 tokensBurned, uint256 bnb, bool shielded, uint256 leafIndex);
    event CapSet(uint256 cap);
    event HolderRewardsSet(address holderRewards);

    error NotFeeRouter();
    error Dust();
    error Slippage();

    constructor(address feeRouter_, address pool_, address owner_) Ownable(owner_) {
        feeRouter = feeRouter_;
        pool = IShieldedPool(pool_);
    }

    function setCap(uint256 cap_) external onlyOwner {
        cap = cap_;
        emit CapSet(cap_);
    }

    /// @dev One-shot: the cap overflow is routed here, re-pointing it later is an admin drain path.
    function setHolderRewards(address hr) external onlyOwner {
        require(address(holderRewards) == address(0) && hr != address(0), "set");
        holderRewards = IHolderRewards(hr);
        emit HolderRewardsSet(hr);
    }

    /// @notice BNB a harvest of `tokens` would pay right now.
    function harvestValue(address coin, uint256 tokens) public view returns (uint256) {
        uint256 supply = IGroveCoin(coin).totalSupply();
        if (supply == 0) return 0;
        return balance[coin] * tokens / supply;
    }

    /// @notice BNB per 1e18 tokens (whole token), for display.
    function valuePerToken(address coin) external view returns (uint256) {
        return harvestValue(coin, 1e18);
    }

    function deposit(address coin) external payable {
        if (msg.sender != feeRouter) revert NotFeeRouter();
        uint256 room = cap > balance[coin] ? cap - balance[coin] : 0;
        uint256 kept = msg.value <= room ? msg.value : room;
        uint256 overflow = msg.value - kept;
        balance[coin] += kept;
        if (overflow > 0) {
            // nothing is lost: what the roots cannot hold goes to that coin's holder-reward pot
            holderRewards.fund{value: overflow}(coin);
        }
        emit Deposited(coin, kept, overflow);
    }

    /// @notice Burn `tokens` of `coin` and receive your share of its roots in BNB.
    function harvest(address coin, uint256 tokens, uint256 minBnb) external nonReentrant returns (uint256 bnb) {
        bnb = _burn(coin, tokens, minBnb);
        (bool ok,) = msg.sender.call{value: bnb}("");
        require(ok, "send");
        emit Harvested(coin, msg.sender, tokens, bnb, false, 0);
    }

    /// @notice Same as `harvest`, but the BNB lands in the shielded pool as a note owned by
    ///         `pubKey`. This transaction still shows your wallet and the amount; what becomes
    ///         private is everything you do with that BNB afterwards.
    function harvestShielded(address coin, uint256 tokens, uint256 minBnb, uint256 pubKey, uint256 blinding)
        external
        nonReentrant
        returns (uint256 bnb, uint256 leafIndex)
    {
        bnb = _burn(coin, tokens, minBnb);
        leafIndex = pool.depositFor{value: bnb}(pubKey, blinding);
        emit Harvested(coin, msg.sender, tokens, bnb, true, leafIndex);
    }

    function _burn(address coin, uint256 tokens, uint256 minBnb) internal returns (uint256 bnb) {
        bnb = harvestValue(coin, tokens);
        if (bnb == 0) revert Dust();
        if (bnb < minBnb) revert Slippage();
        IGroveCoin(coin).burnFrom(msg.sender, tokens);
        balance[coin] -= bnb;
        totalHarvested[coin] += bnb;
        totalBurned[coin] += tokens;
    }
}
