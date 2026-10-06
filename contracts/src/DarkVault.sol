// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPancakeRouter02} from "./interfaces/IPancake.sol";
import {ILaunchpadFull, IShieldedPoolFull, IRootsHarvest} from "./interfaces/IDarkPool.sol";

/// @title DarkVault
/// @notice A one-off position vault for a dark-pool order (privacy/DARKPOOL-SPEC.md §1.1). The
///         shielded pool pays BNB to this address before it exists; the DarkPool factory then puts
///         this code at that address (CREATE2 clone, salt = hash of the order) and executes the buy.
///         Afterwards only `owner` (a fresh key derived from the shielded key in the browser) can
///         act, either directly or through `relay()` with an EIP-712 signature, so no user wallet
///         ever appears on a dark-pool transaction. Sales, harvests and leftover BNB go back into
///         the shielded pool as notes (`depositFor`). No admin, nothing upgradeable.
contract DarkVault is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // immutables live in the implementation bytecode, so every clone shares them
    address public immutable factory; // DarkPool
    ILaunchpadFull public immutable launchpad;
    IShieldedPoolFull public immutable pool;
    IPancakeRouter02 public immutable router;
    address public immutable weth; // router.WETH()

    address public owner; // set once by initialize; 0 on a fresh clone (the impl locks itself to address(1))
    address public coin;
    uint256 public nonce; // relay() nonce, strictly sequential from 0

    /// @dev `relayer` is the address that may submit (and is paid): the signature is over msg.sender, so a mempool
    ///      front-runner who copies the calldata cannot take the fee and make the real submitter's transaction revert.
    bytes32 public constant RELAY_TYPEHASH =
        keccak256("Relay(bytes data,uint256 fee,uint256 deadline,uint256 nonce,address relayer)");

    bool private _inRelay;
    uint256 private _relayFee;

    event Bought(uint256 bnbIn, uint256 tokensOut, bool viaRouter);
    event Sold(uint256 tokensIn, uint256 bnbOut, uint256 fee, uint256 pubKey, uint256 leafIndex, bool viaRouter);
    event Harvested(uint256 tokensBurned, uint256 bnbOut, uint256 fee, uint256 pubKey, uint256 leafIndex);
    event Shielded(uint256 amount, uint256 fee, uint256 pubKey, uint256 leafIndex);
    event Executed(address target, uint256 value, bytes data);
    event Relayed(address indexed relayer, uint256 nonce, uint256 fee, bytes4 selector);

    error NotFactory();
    error NotOwner();
    error AlreadyInitialized();
    error Expired();
    error BadCall();
    error BadSignature();
    error BadTarget();
    error InsufficientBalance();
    error Slippage();
    error FeeExceedsProceeds();
    error FeeUnpaid();

    modifier onlyFactory() {
        if (msg.sender != factory) revert NotFactory();
        _;
    }

    /// @dev Passes for the owner directly, or for the vault's own self-call made by `relay()`.
    modifier onlyOwner() {
        if (msg.sender != owner && !(msg.sender == address(this) && _inRelay)) revert NotOwner();
        _;
    }

    constructor(address factory_, address launchpad_, address pool_, address router_)
        EIP712("zkBNB DarkVault", "1")
    {
        factory = factory_;
        launchpad = ILaunchpadFull(launchpad_);
        pool = IShieldedPoolFull(pool_);
        router = IPancakeRouter02(router_);
        require(ILaunchpadFull(launchpad_).roots() != address(0), "roots");
        weth = IPancakeRouter02(router_).WETH();
        owner = address(1); // the implementation can never be initialised or used
    }

    function initialize(address owner_, address coin_) external onlyFactory {
        if (owner != address(0)) revert AlreadyInitialized();
        require(owner_ != address(0) && coin_ != address(0), "zero");
        owner = owner_;
        coin = coin_;
    }

    /// @notice The pool, the launchpad, Roots and the router pay here.
    receive() external payable {}

    /// @notice Roots is resolved at call time: `Launchpad.setRoots` is not one-shot, so a pinned
    ///         address could go stale for every vault at once.
    function roots() public view returns (IRootsHarvest) {
        return IRootsHarvest(launchpad.roots());
    }

    // ---------------------------------------------------------- factory path

    /// @notice The fill: buy with the BNB the proof paid to this address. Reverts if the deadline has
    ///         passed or the buy fails; the factory decides whether that is fatal (`transactAndFill`)
    ///         or leaves the BNB in the vault for the owner (`fill`).
    function buyFromFactory(uint256 bnbIn, uint256 minTokensOut, uint256 deadline)
        external
        onlyFactory
        returns (uint256 tokensOut)
    {
        return _buy(bnbIn, minTokensOut, deadline);
    }

    // ------------------------------------------------------------ owner path

    /// @notice Retry a buy with BNB sitting in the vault. The relay fee is taken from what is left.
    function buy(uint256 bnbIn, uint256 minTokensOut) external onlyOwner {
        _buy(bnbIn, minTokensOut, block.timestamp);
    }

    /// @notice Sell `tokens` (curve or router) and pay the proceeds minus the relay fee into the
    ///         shielded pool as a note owned by `pubKey`.
    function sell(uint256 tokens, uint256 minBnbOut, uint256 pubKey, uint256 blinding) external onlyOwner {
        address c = coin;
        uint256 before = address(this).balance;
        bool viaRouter = launchpad.isGraduated(c);
        if (!viaRouter) {
            IERC20(c).forceApprove(address(launchpad), tokens);
            launchpad.sell(c, tokens, minBnbOut);
        } else {
            IERC20(c).forceApprove(address(router), tokens);
            address[] memory path = new address[](2);
            path[0] = c;
            path[1] = weth;
            router.swapExactTokensForETHSupportingFeeOnTransferTokens(tokens, minBnbOut, path, address(this), block.timestamp);
        }
        uint256 proceeds = address(this).balance - before;
        if (proceeds < minBnbOut) revert Slippage();
        uint256 leafIndex = _depositProceeds(proceeds, pubKey, blinding);
        emit Sold(tokens, proceeds, _relayFee, pubKey, leafIndex, viaRouter);
    }

    /// @notice Burn `tokens` through Roots (the public harvest, paid to the vault) and pay the BNB
    ///         minus the relay fee into the shielded pool.
    function harvest(uint256 tokens, uint256 minBnb, uint256 pubKey, uint256 blinding) external onlyOwner {
        IRootsHarvest r = roots();
        IERC20(coin).forceApprove(address(r), tokens);
        uint256 before = address(this).balance;
        r.harvest(coin, tokens, minBnb);
        uint256 bnb = address(this).balance - before;
        uint256 leafIndex = _depositProceeds(bnb, pubKey, blinding);
        emit Harvested(tokens, bnb, _relayFee, pubKey, leafIndex);
    }

    /// @notice Pay BNB held by the vault into the shielded pool. `amount == 0` means the whole
    ///         balance minus the relay fee.
    function shield(uint256 amount, uint256 pubKey, uint256 blinding) external onlyOwner {
        uint256 bal = address(this).balance;
        uint256 fee = _relayFee;
        if (amount == 0) {
            if (bal <= fee) revert InsufficientBalance();
            amount = bal - fee;
        } else if (amount + fee > bal) {
            revert InsufficientBalance();
        }
        uint256 leafIndex = pool.depositFor{value: amount}(pubKey, blinding);
        emit Shielded(amount, fee, pubKey, leafIndex);
    }

    /// @notice Escape hatch: any call from the vault (claim rewards, move tokens out...). The relay
    ///         fee is taken from whatever BNB the vault holds afterwards.
    function exec(address target, uint256 value, bytes calldata data) external onlyOwner {
        if (target == address(this)) revert BadTarget();
        (bool ok, bytes memory ret) = target.call{value: value}(data);
        if (!ok) _bubble(ret);
        emit Executed(target, value, data);
    }

    // -------------------------------------------------------- meta-transaction

    /// @notice The owner signed for one submitter: execute `data` on this vault and pay `fee` from
    ///         the vault's BNB to `msg.sender`. The signature covers msg.sender (`relayer` in the
    ///         typed data), so only the submitter the owner named can land it.
    function relay(bytes calldata data, uint256 fee, uint256 deadline, bytes calldata sig) external nonReentrant {
        if (block.timestamp > deadline) revert Expired();
        if (data.length < 4) revert BadCall();
        bytes4 selector = bytes4(data[:4]);
        if (selector == this.relay.selector || selector == this.buyFromFactory.selector || selector == this.initialize.selector) {
            revert BadCall();
        }
        uint256 n = nonce;
        if (ECDSA.recover(relayDigest(data, fee, deadline, n, msg.sender), sig) != owner) revert BadSignature();
        nonce = n + 1;

        _inRelay = true;
        _relayFee = fee;
        (bool ok, bytes memory ret) = address(this).call(data);
        if (!ok) _bubble(ret);
        _inRelay = false;
        _relayFee = 0;

        if (fee > 0) {
            (ok,) = msg.sender.call{value: fee}("");
            if (!ok) revert FeeUnpaid();
        }
        emit Relayed(msg.sender, n, fee, selector);
    }

    /// @notice The EIP-712 digest the owner signs for `relay(data, fee, deadline, sig)` submitted by `relayer`.
    function relayDigest(bytes calldata data, uint256 fee, uint256 deadline, uint256 nonce_, address relayer)
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(RELAY_TYPEHASH, keccak256(data), fee, deadline, nonce_, relayer)));
    }

    // ------------------------------------------------------------- internals

    function _buy(uint256 bnbIn, uint256 minTokensOut, uint256 deadline) internal returns (uint256 tokensOut) {
        if (block.timestamp > deadline) revert Expired();
        if (bnbIn > address(this).balance) revert InsufficientBalance();
        address c = coin;
        uint256 before = IERC20(c).balanceOf(address(this));
        bool viaRouter = launchpad.isGraduated(c);
        if (!viaRouter) {
            launchpad.buy{value: bnbIn}(c, minTokensOut);
        } else {
            address[] memory path = new address[](2);
            path[0] = weth;
            path[1] = c;
            router.swapExactETHForTokensSupportingFeeOnTransferTokens{value: bnbIn}(minTokensOut, path, address(this), deadline);
        }
        tokensOut = IERC20(c).balanceOf(address(this)) - before;
        // the fee-on-transfer swap variant does not check the minimum itself
        if (tokensOut < minTokensOut) revert Slippage();
        emit Bought(bnbIn, tokensOut, viaRouter);
    }

    /// @dev Deposit `proceeds - _relayFee` into the pool for `pubKey`, leaving the fee for relay().
    function _depositProceeds(uint256 proceeds, uint256 pubKey, uint256 blinding) internal returns (uint256 leafIndex) {
        uint256 fee = _relayFee;
        if (proceeds <= fee) revert FeeExceedsProceeds();
        leafIndex = pool.depositFor{value: proceeds - fee}(pubKey, blinding);
    }

    function _bubble(bytes memory ret) internal pure {
        assembly {
            revert(add(ret, 0x20), mload(ret))
        }
    }
}
