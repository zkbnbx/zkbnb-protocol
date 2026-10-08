// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {Launchpad} from "./Launchpad.sol";
import {CreatorStub} from "./CreatorStub.sol";
import {PayoutMode} from "./interfaces/IGrove.sol";
import {ILaunchpadPrivacy, IFeeRouterFull, IGrovePoolModule, IRootsHarvestV2 as IRootsHarvest} from "./interfaces/IGroveV2.sol";
import {GroveConstants as C} from "./libraries/GroveConstants.sol";

/// @title Private planting and creator income (spec section 2.8 / 4.4)
/// @notice `plantFor` is reachable only from the pool (a transfer proof unshielding exactly the
///         plant fee to this contract); it deploys a CreatorStub per coin so the public creator is
///         a fresh contract and the creator's income flows to a handle. `handOver` is likewise pool
///         only, authorised by a proof over the stub's handle. `harvestToHandle` is the public
///         wallet path into a handle.
contract Planter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IGrovePoolModule public immutable pool;
    ILaunchpadPrivacy public immutable launchpad;
    IFeeRouterFull public immutable feeRouter;
    IRootsHarvest public immutable roots;

    mapping(address coin => address) public stubOf;
    uint256 public stubNonce;

    event PlantedPrivately(address indexed coin, address stub, uint256 handle);
    event HandedOverPrivately(address indexed coin, PayoutMode mode, address wallet, uint256 ringId);
    event HarvestedToHandle(address indexed coin, uint256 tokens, uint256 bnb, uint256 handle);

    error NotPool();
    error BadPayload();
    error BadPlantValue();
    error WalletModeRefused();
    error UnknownCoin();
    error WrongHandle();
    error BadHandle();

    modifier onlyPool() {
        if (msg.sender != address(pool)) revert NotPool();
        _;
    }

    constructor(address pool_, address launchpad_, address feeRouter_, address roots_) {
        pool = IGrovePoolModule(pool_);
        launchpad = ILaunchpadPrivacy(launchpad_);
        feeRouter = IFeeRouterFull(feeRouter_);
        roots = IRootsHarvest(roots_);
    }

    /// @notice payload = abi.encode(ACTION_PLANT, Launchpad.PlantParams, uint256 handle).
    function plantFor(bytes calldata payload) external payable onlyPool nonReentrant returns (address coin) {
        (uint256 action, Launchpad.PlantParams memory p, uint256 handle) =
            abi.decode(payload, (uint256, Launchpad.PlantParams, uint256));
        if (action != C.ACTION_PLANT) revert BadPayload();
        if (msg.value != launchpad.plantFee()) revert BadPlantValue();
        if (p.payoutMode == PayoutMode.Wallet) revert WalletModeRefused();
        if (handle == 0 || handle >= C.FIELD_SIZE) revert BadHandle();

        bytes32 salt = keccak256(abi.encode(handle, stubNonce++));
        CreatorStub stub = new CreatorStub{salt: salt}(address(this), address(pool), address(launchpad), address(feeRouter), handle);
        coin = stub.plant{value: msg.value}(p);
        stubOf[coin] = address(stub);
        emit PlantedPrivately(coin, address(stub), handle);
    }

    /// @notice Pool only; the pool has verified a proof that owns `handle`.
    function handOver(address coin, uint256 handle, PayoutMode mode, address wallet, uint256 ringId) external onlyPool {
        address stub = stubOf[coin];
        if (stub == address(0)) revert UnknownCoin();
        if (CreatorStub(payable(stub)).handle() != handle) revert WrongHandle();
        CreatorStub(payable(stub)).handOver(mode, wallet, ringId);
        emit HandedOverPrivately(coin, mode, wallet, ringId);
    }

    /// @notice Public wallet -> roots harvest -> handle credit. Wallet and amount are public here;
    ///         the destination key is not.
    function harvestToHandle(address coin, uint256 tokens, uint256 minBnb, uint256 handle) external nonReentrant {
        if (handle == 0 || handle >= C.FIELD_SIZE) revert BadHandle();
        IERC20(coin).safeTransferFrom(msg.sender, address(this), tokens);
        IERC20(coin).forceApprove(address(roots), tokens);
        uint256 bnb = roots.harvest(coin, tokens, minBnb);
        pool.credit{value: bnb}(handle);
        emit HarvestedToHandle(coin, tokens, bnb, handle);
    }

    /// @notice CREATE2 address of the stub a plant for `handle` at `nonce` would deploy.
    function predictStub(uint256 handle, uint256 nonce) external view returns (address) {
        bytes32 salt = keccak256(abi.encode(handle, nonce));
        bytes32 initHash = keccak256(
            abi.encodePacked(
                type(CreatorStub).creationCode,
                abi.encode(address(this), address(pool), address(launchpad), address(feeRouter), handle)
            )
        );
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initHash)))));
    }

    /// @dev Roots pays harvests here before they are credited.
    receive() external payable {}
}
