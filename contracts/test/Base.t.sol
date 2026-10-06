// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {GroveCoin} from "../src/GroveCoin.sol";
import {Launchpad} from "../src/Launchpad.sol";
import {FeeRouter} from "../src/FeeRouter.sol";
import {Roots} from "../src/Roots.sol";
import {HolderRewards} from "../src/HolderRewards.sol";
import {DonationRotator} from "../src/DonationRotator.sol";
import {ShieldedPool} from "../src/ShieldedPool.sol";
import {PayoutMode} from "../src/interfaces/IGrove.sol";

import {MockWBNB} from "./mocks/MockWBNB.sol";
import {MockPancakeFactory} from "./mocks/MockPancakeFactory.sol";
import {MockPancakePair} from "./mocks/MockPancakePair.sol";
import {MockPancakeRouter} from "./mocks/MockPancakeRouter.sol";
import {MockVerifier} from "./mocks/MockVerifier.sol";

/// @notice Deploys the whole Grove stack (SPEC §7 order) against mock PancakeSwap contracts.
///         The test contract itself is the owner of every module.
abstract contract BaseTest is Test {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant FEE_BPS = 200;
    uint256 internal constant FIELD_SIZE =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    MockWBNB internal wbnb;
    MockPancakeFactory internal factory;
    MockPancakeRouter internal router;

    address internal poseidonT3;
    address internal poseidonT4;
    MockVerifier internal verifier;
    ShieldedPool internal pool;
    FeeRouter internal feeRouter;
    Roots internal roots;
    HolderRewards internal holderRewards;
    DonationRotator internal rotator;
    Launchpad internal launchpad;
    GroveCoin internal grove;

    address internal owner;
    address internal treasury = makeAddr("treasury");
    address internal recovery = makeAddr("recovery");
    address internal keeper = makeAddr("keeper");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal whale = makeAddr("whale");

    function setUp() public virtual {
        owner = address(this);
        vm.warp(1_750_000_000); // a realistic timestamp (forge defaults to 1)
        vm.roll(50_000_000);

        // Pancake mocks
        wbnb = new MockWBNB();
        factory = new MockPancakeFactory();
        router = new MockPancakeRouter(address(factory), address(wbnb));

        // zk pieces
        poseidonT3 = _deployBytecode("poseidon/PoseidonT3.bin");
        poseidonT4 = _deployBytecode("poseidon/PoseidonT4.bin");
        verifier = new MockVerifier();
        pool = new ShieldedPool(address(verifier), poseidonT3, poseidonT4, owner);

        // Grove modules
        feeRouter = new FeeRouter(treasury, recovery, address(router), owner);
        roots = new Roots(address(feeRouter), address(pool), owner);
        holderRewards = new HolderRewards(address(pool), keeper, owner);
        rotator = new DonationRotator(address(pool), treasury, owner);
        launchpad = new Launchpad(address(feeRouter), address(router), owner);

        // wiring
        feeRouter.setModules(address(launchpad), address(roots), address(holderRewards), address(rotator));
        feeRouter.setKeeper(keeper);
        roots.setHolderRewards(address(holderRewards));
        holderRewards.setSources(address(feeRouter), address(roots));
        rotator.setFeeRouter(address(feeRouter));
        launchpad.setRoots(address(roots));

        // rootstock
        grove = GroveCoin(payable(launchpad.plantRootstock("Grove", "GROVE", _metadata())));
        feeRouter.setRootstock(address(grove));

        vm.deal(alice, 1000 ether);
        vm.deal(bob, 1000 ether);
        vm.deal(carol, 1000 ether);
        vm.deal(whale, 1000 ether);
    }

    // ------------------------------------------------------------- helpers

    function _deployBytecode(string memory path) internal returns (address addr) {
        bytes memory code = vm.parseBytes(string.concat("0x", vm.trim(vm.readFile(path))));
        assembly {
            addr := create(0, add(code, 0x20), mload(code))
        }
        require(addr != address(0), "bytecode deploy failed");
    }

    function _metadata() internal pure returns (Launchpad.Metadata memory) {
        return Launchpad.Metadata({description: "desc", image: "ipfs://img", website: "https://grove", twitter: "", telegram: ""});
    }

    function _params(string memory name, string memory symbol, PayoutMode mode, address wallet, uint256 ringId)
        internal
        pure
        returns (Launchpad.PlantParams memory)
    {
        return Launchpad.PlantParams({
            name: name,
            symbol: symbol,
            metadata: _metadata(),
            payoutMode: mode,
            payoutWallet: wallet,
            ringId: ringId,
            minFirstBuyTokens: 0
        });
    }

    /// @dev Plant a coin as `creator` with an optional first buy (BNB on top of the plant fee).
    function plantCoin(address creator, PayoutMode mode, address wallet, uint256 ringId, uint256 firstBuy)
        internal
        returns (address coin)
    {
        uint256 value = launchpad.plantFee() + firstBuy;
        vm.prank(creator);
        coin = launchpad.plant{value: value}(_params("Test Coin", "TEST", mode, wallet, ringId));
    }

    function plantCoin(address creator, PayoutMode mode) internal returns (address coin) {
        return plantCoin(creator, mode, address(0), 0, 0);
    }

    function buy(address who, address coin, uint256 bnb) internal returns (uint256 tokensOut) {
        vm.prank(who);
        tokensOut = launchpad.buy{value: bnb}(coin, 0);
    }

    function sell(address who, address coin, uint256 tokens) internal returns (uint256 bnbOut) {
        vm.startPrank(who);
        IERC20(coin).approve(address(launchpad), tokens);
        bnbOut = launchpad.sell(coin, tokens, 0);
        vm.stopPrank();
    }

    /// @dev Gross BNB (fee included) that clears the rest of the curve in one buy.
    function grossToClear(address coin) internal view returns (uint256) {
        return launchpad.remainingCost(coin) * BPS / (BPS - FEE_BPS) + 1;
    }

    /// @dev Push a coin through graduation with one whale buy. Returns the pair.
    function graduate(address coin) internal returns (address pair) {
        buy(whale, coin, grossToClear(coin));
        pair = launchpad.pairOf(coin);
        require(pair != address(0), "not graduated");
    }

    function pairOf(address coin) internal view returns (MockPancakePair) {
        return MockPancakePair(launchpad.pairOf(coin));
    }

    receive() external payable {}
}
