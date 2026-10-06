// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ShieldedPool} from "./ShieldedPool.sol";
import {DarkVault} from "./DarkVault.sol";
import {ILaunchpadFull} from "./interfaces/IDarkPool.sol";

/// @title DarkPool
/// @notice Factory for counterfactual DarkVaults (privacy/DARKPOOL-SPEC.md §1.2). An order fixes
///         the coin, the BNB, the slippage, the owner key, the deadline and a random nonce; its
///         vault address is CREATE2(hash(order)) and only this factory can put code there, and only
///         by executing that exact order. A shielded-pool withdrawal to that address therefore
///         commits to the trade without naming a wallet; `transactAndFill` does the withdrawal and
///         the buy in one transaction. No owner, no admin, no other state than the vault registry.
contract DarkPool is ReentrancyGuard {
    struct Order {
        address coin;
        uint256 bnbIn; // exactly what the proof withdraws to the vault
        uint256 minTokensOut;
        address owner; // fresh per order, derived from the shielded key in the browser
        uint64 deadline; // unix seconds; 0 = none
        bytes32 nonce; // random, makes the salt unique
    }

    ShieldedPool public immutable pool;
    ILaunchpadFull public immutable launchpad;
    address public immutable vaultImpl; // DarkVault implementation, deployed by this constructor
    mapping(address => bool) public isVault;
    uint256 public vaultCount;

    event VaultCreated(
        address indexed vault,
        address indexed owner,
        address indexed coin,
        uint256 bnbIn,
        uint256 tokensOut,
        bool bought,
        bytes32 nonce
    );

    error AlreadyFilled();
    error NotFunded();
    error BadRecipient();
    error BadAmount();
    error Expired();
    error FillFailed();

    constructor(address pool_, address launchpad_, address router_) {
        pool = ShieldedPool(pool_);
        launchpad = ILaunchpadFull(launchpad_);
        vaultImpl = address(new DarkVault(address(this), launchpad_, pool_, router_));
    }

    // ---------------------------------------------------------------- views

    function orderSalt(Order calldata o) public pure returns (bytes32) {
        return keccak256(abi.encode(o));
    }

    function vaultFor(Order calldata o) public view returns (address) {
        return Clones.predictDeterministicAddress(vaultImpl, orderSalt(o), address(this));
    }

    // ------------------------------------------------------------- mutators

    /// @notice Lenient fill: the vault is always created once its address holds `o.bnbIn`; the buy
    ///         may fail (deadline passed, slippage), in which case the BNB stays in the vault and
    ///         the owner can `buy` again or `shield` it back through `relay`.
    /// @dev Leniency only covers a buy that *reverts* (every genuine failure on that path carries
    ///      revert data: Launchpad / DarkVault custom errors, the router's string reasons, Panic).
    ///      A failure with empty return data is the inner call running out of gas, which the caller
    ///      controls: the whole fill reverts (`FillFailed`) so nobody can register an unbought vault
    ///      by starving the buy of gas and then force the owner to pay for a second `buy`.
    function fill(Order calldata o) external nonReentrant returns (address vault) {
        vault = vaultFor(o);
        if (o.bnbIn == 0) revert BadAmount(); // an unfunded order must never pass the NotFunded gate
        if (vault.code.length != 0) revert AlreadyFilled();
        if (vault.balance < o.bnbIn) revert NotFunded();
        _create(o, vault);
        bool bought;
        uint256 tokensOut;
        try DarkVault(payable(vault)).buyFromFactory(o.bnbIn, o.minTokensOut, _deadline(o)) returns (uint256 out) {
            bought = true;
            tokensOut = out;
        } catch (bytes memory reason) {
            if (reason.length == 0) revert FillFailed();
        }
        emit VaultCreated(vault, o.owner, o.coin, o.bnbIn, tokensOut, bought, o.nonce);
    }

    /// @notice Strict fill: withdraw `o.bnbIn` from the shielded pool to the order's vault address
    ///         and buy, everything or nothing. A failed buy reverts the whole transaction, so the
    ///         nullifiers stay unspent and the user simply re-proves.
    /// @dev The pool binds the proof to `e` but not to msg.sender, so a third party who sees (p, e)
    ///      can submit the bare `pool.transact(p, e)` first. The BNB then sits at `vaultFor(o)` with
    ///      no code and this call reverts `AlreadySpent`; the order is still the only key to that
    ///      address and `fill(o)` recovers it (the client must keep the order until the vault exists).
    function transactAndFill(ShieldedPool.Proof calldata p, ShieldedPool.ExtData calldata e, Order calldata o)
        external
        nonReentrant
        returns (address vault)
    {
        vault = vaultFor(o);
        if (e.recipient != vault) revert BadRecipient();
        if (e.extAmount >= 0 || uint256(-e.extAmount) != o.bnbIn) revert BadAmount();
        if (o.deadline != 0 && block.timestamp > o.deadline) revert Expired();
        if (vault.code.length != 0) revert AlreadyFilled();
        // msg.value 0: the pool pays the vault address and pays e.fee to e.relayer itself
        pool.transact(p, e);
        _create(o, vault);
        uint256 tokensOut = DarkVault(payable(vault)).buyFromFactory(o.bnbIn, o.minTokensOut, _deadline(o));
        emit VaultCreated(vault, o.owner, o.coin, o.bnbIn, tokensOut, true, o.nonce);
    }

    // ------------------------------------------------------------- internals

    function _create(Order calldata o, address vault) internal {
        address created = Clones.cloneDeterministic(vaultImpl, orderSalt(o));
        assert(created == vault);
        DarkVault(payable(vault)).initialize(o.owner, o.coin);
        isVault[vault] = true;
        vaultCount += 1;
    }

    function _deadline(Order calldata o) internal pure returns (uint256) {
        return o.deadline == 0 ? type(uint256).max : o.deadline;
    }
}
