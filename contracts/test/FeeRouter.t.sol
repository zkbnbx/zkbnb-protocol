// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BaseTest} from "./Base.t.sol";
import {Launchpad} from "../src/Launchpad.sol";
import {FeeRouter} from "../src/FeeRouter.sol";
import {PayoutMode} from "../src/interfaces/IGrove.sol";

/// @dev A payee that can refuse BNB (simulates a creator wallet whose receive reverts).
contract Rejecter {
    bool public accept;

    function setAccept(bool a) external {
        accept = a;
    }

    function plant(Launchpad lp, Launchpad.PlantParams memory p) external payable returns (address) {
        return lp.plant{value: msg.value}(p);
    }

    function withdraw(FeeRouter fr) external {
        fr.withdrawPending();
    }

    receive() external payable {
        require(accept, "no thanks");
    }
}

contract FeeRouterTest is BaseTest {
    address coin;
    uint256 causeA;
    uint256 ringId;

    event FeeSplit(address indexed coin, uint256 toRoots, uint256 toRootstock, uint256 toTreasury, uint256 toDeployer, PayoutMode mode);
    event FeeCollected(address indexed coin, uint256 amount, address source);
    event PayoutModeHandedOver(address indexed coin, PayoutMode mode, address wallet, uint256 ringId);
    event Buyback(uint256 bnbIn, uint256 groveBurned);

    function setUp() public override {
        super.setUp();
        coin = plantCoin(alice, PayoutMode.Creator);
        causeA = rotator.registerCause{value: rotator.registerFee()}("Cause A", "https://a", 1234, bytes32(uint256(1)), address(0));
        uint256[] memory ids = new uint256[](1);
        ids[0] = causeA;
        ringId = rotator.createRing("ring", ids, 1 days);
    }

    // --------------------------------------------------------------- split

    function test_split_exact25_25_10_40() public {
        uint256 bnbIn = 1 ether;
        uint256 fee = bnbIn * FEE_BPS / BPS; // 0.02
        uint256 tBefore = treasury.balance;
        uint256 aBefore = alice.balance;

        vm.expectEmit(true, true, true, true, address(feeRouter));
        emit FeeCollected(coin, fee, address(launchpad));
        vm.expectEmit(true, true, true, true, address(feeRouter));
        emit FeeSplit(coin, fee * 25 / 100, fee * 25 / 100, fee * 10 / 100, fee * 40 / 100, PayoutMode.Creator);
        buy(bob, coin, bnbIn);

        assertEq(fee, 0.02 ether);
        assertEq(roots.balance(coin), 0.005 ether, "roots 25%");
        assertEq(feeRouter.rootstockPot(), 0.005 ether, "rootstock 25%");
        assertEq(treasury.balance - tBefore, 0.002 ether, "treasury 10%");
        assertEq(alice.balance - aBefore, 0.008 ether, "creator 40%");
        assertEq(feeRouter.collectedOf(coin), fee);
        assertEq(address(feeRouter).balance, 0.005 ether, "only the rootstock pot stays here");
    }

    function test_mode_Wallet_pushesToWallet() public {
        address c = plantCoin(alice, PayoutMode.Wallet, carol, 0, 0);
        uint256 before = carol.balance;
        buy(bob, c, 1 ether);
        assertEq(carol.balance - before, 0.008 ether);
        (,, address wallet,,,, bool handedOver,) = feeRouter.configOf(c);
        assertEq(wallet, carol);
        assertTrue(handedOver);
    }

    function test_mode_Holders_fundsHolderRewardsPot() public {
        address c = plantCoin(alice, PayoutMode.Holders, address(0), 0, 0);
        buy(bob, c, 1 ether);
        assertEq(holderRewards.pot(c), 0.008 ether);
        assertEq(address(holderRewards).balance, 0.008 ether);
    }

    function test_mode_Donate_fundsBoundRing() public {
        address c = plantCoin(alice, PayoutMode.Donate, address(0), ringId, 0);
        assertTrue(rotator.coinBound(c));
        assertEq(rotator.coinRing(c), ringId);
        buy(bob, c, 1 ether);
        assertEq(rotator.pot(ringId), 0.008 ether);
    }

    function test_mode_Donate_unknownRingReverts() public {
        uint256 value = launchpad.plantFee();
        vm.prank(alice);
        vm.expectRevert(bytes("ring"));
        launchpad.plant{value: value}(_params("X", "X", PayoutMode.Donate, address(0), 99));
    }

    function test_rootstock_wholeFeeToTreasury() public {
        uint256 tBefore = treasury.balance;
        uint256 potBefore = feeRouter.rootstockPot();
        uint256 fee = 1 ether * FEE_BPS / BPS;
        vm.expectEmit(true, true, true, true, address(feeRouter));
        emit FeeSplit(address(grove), 0, 0, fee, 0, PayoutMode.Creator);
        buy(bob, address(grove), 1 ether);
        assertEq(treasury.balance - tBefore, fee);
        assertEq(roots.balance(address(grove)), 0);
        assertEq(feeRouter.rootstockPot(), potBefore);
    }

    function test_collect_unauthorizedCallerReverts() public {
        vm.deal(bob, 1 ether);
        vm.prank(bob);
        vm.expectRevert(FeeRouter.NotAuthorized.selector);
        feeRouter.collect{value: 1 ether}(coin);
    }

    function test_collect_unregisteredCoinReverts() public {
        vm.deal(address(launchpad), 1 ether);
        vm.prank(address(launchpad));
        vm.expectRevert(FeeRouter.NotRegistered.selector);
        feeRouter.collect{value: 1}(address(0xBEEF));
    }

    function test_collect_zeroIsNoop() public {
        vm.prank(address(launchpad));
        feeRouter.collect{value: 0}(coin);
        assertEq(feeRouter.collectedOf(coin), 0);
    }

    function test_registerCoin_onlyLaunchpad() public {
        vm.prank(bob);
        vm.expectRevert(FeeRouter.NotAuthorized.selector);
        feeRouter.registerCoin(address(0xBEEF), bob, PayoutMode.Creator, address(0), 0, false);
    }

    // ------------------------------------------------------------- shares

    function test_setShares_rootsBelowMinReverts() public {
        vm.expectRevert(FeeRouter.BadShares.selector);
        feeRouter.setShares(2499, 2501, 1000, 4000);
    }

    function test_setShares_treasuryAboveMaxReverts() public {
        vm.expectRevert(FeeRouter.BadShares.selector);
        feeRouter.setShares(2500, 2500, 2001, 2999);
    }

    function test_setShares_sumMustBe10000() public {
        vm.expectRevert(FeeRouter.BadShares.selector);
        feeRouter.setShares(2500, 2500, 1000, 3999);
        vm.expectRevert(FeeRouter.BadShares.selector);
        feeRouter.setShares(2500, 2500, 1000, 4001);
    }

    function test_setShares_ownerOnly() public {
        vm.prank(bob);
        vm.expectRevert();
        feeRouter.setShares(2500, 2500, 1000, 4000);
    }

    function test_setShares_validAndApplied() public {
        feeRouter.setShares(4000, 2000, 2000, 2000);
        uint256 aBefore = alice.balance;
        uint256 tBefore = treasury.balance;
        buy(bob, coin, 1 ether); // fee 0.02
        assertEq(roots.balance(coin), 0.008 ether);
        assertEq(feeRouter.rootstockPot(), 0.004 ether);
        assertEq(treasury.balance - tBefore, 0.004 ether);
        assertEq(alice.balance - aBefore, 0.004 ether);
    }

    // ------------------------------------------------------------ handover

    function test_handOver_creatorOnly() public {
        vm.prank(bob);
        vm.expectRevert(FeeRouter.NotAuthorized.selector);
        feeRouter.handOver(coin, PayoutMode.Wallet, carol, 0);
    }

    function test_handOver_toWallet_isIrrevocable() public {
        vm.prank(alice);
        vm.expectEmit(true, true, true, true, address(feeRouter));
        emit PayoutModeHandedOver(coin, PayoutMode.Wallet, carol, 0);
        feeRouter.handOver(coin, PayoutMode.Wallet, carol, 0);

        uint256 before = carol.balance;
        buy(bob, coin, 1 ether);
        assertEq(carol.balance - before, 0.008 ether);

        vm.prank(alice);
        vm.expectRevert(FeeRouter.HandedOver.selector);
        feeRouter.handOver(coin, PayoutMode.Holders, address(0), 0);
    }

    function test_handOver_toHolders() public {
        vm.prank(alice);
        feeRouter.handOver(coin, PayoutMode.Holders, address(0), 0);
        buy(bob, coin, 1 ether);
        assertEq(holderRewards.pot(coin), 0.008 ether);
    }

    function test_handOver_toDonate_bindsRing() public {
        vm.prank(alice);
        feeRouter.handOver(coin, PayoutMode.Donate, address(0), ringId);
        assertTrue(rotator.coinBound(coin));
        buy(bob, coin, 1 ether);
        assertEq(rotator.pot(ringId), 0.008 ether);
    }

    function test_handOver_validation() public {
        vm.startPrank(alice);
        vm.expectRevert(bytes("mode"));
        feeRouter.handOver(coin, PayoutMode.Creator, address(0), 0);
        vm.expectRevert("wallet");
        feeRouter.handOver(coin, PayoutMode.Wallet, address(0), 0);
        vm.expectRevert(bytes("ring"));
        feeRouter.handOver(coin, PayoutMode.Donate, address(0), 42);
        vm.stopPrank();
        vm.prank(alice);
        vm.expectRevert(FeeRouter.NotRegistered.selector);
        feeRouter.handOver(address(0xBEEF), PayoutMode.Holders, address(0), 0);
    }

    function test_handOver_alreadyHandedOverAtPlant() public {
        address c = plantCoin(alice, PayoutMode.Holders, address(0), 0, 0);
        vm.prank(alice);
        vm.expectRevert(FeeRouter.HandedOver.selector);
        feeRouter.handOver(c, PayoutMode.Wallet, carol, 0);
    }

    function test_handOver_rootstockReverts() public {
        vm.expectRevert(FeeRouter.HandedOver.selector);
        feeRouter.handOver(address(grove), PayoutMode.Holders, address(0), 0);
    }

    // ------------------------------------------------------------- pending

    function test_revertingCreator_landsInPendingAndWithdraws() public {
        Rejecter r = new Rejecter();
        vm.deal(address(r), 1 ether);
        uint256 fee = launchpad.plantFee();
        address c = r.plant{value: fee}(launchpad, _params("R", "R", PayoutMode.Creator, address(0), 0));

        buy(bob, c, 1 ether);
        assertEq(feeRouter.pending(address(r)), 0.008 ether, "push failed -> pending");
        assertEq(address(feeRouter).balance, 0.005 ether + 0.008 ether);

        vm.expectRevert(bytes("send"));
        r.withdraw(feeRouter);

        r.setAccept(true);
        uint256 before = address(r).balance;
        r.withdraw(feeRouter);
        assertEq(address(r).balance - before, 0.008 ether);
        assertEq(feeRouter.pending(address(r)), 0);

        vm.expectRevert("nothing");
        r.withdraw(feeRouter);
    }

    function test_revertingWallet_landsInPending() public {
        Rejecter r = new Rejecter();
        address c = plantCoin(alice, PayoutMode.Wallet, address(r), 0, 0);
        buy(bob, c, 1 ether);
        assertEq(feeRouter.pending(address(r)), 0.008 ether);
    }

    // --------------------------------------------------------- roots pause

    function test_rootsPaused_sendsRootsShareToRecovery() public {
        feeRouter.setRootsPaused(coin, true);
        uint256 before = recovery.balance;
        buy(bob, coin, 1 ether);
        assertEq(recovery.balance - before, 0.005 ether);
        assertEq(roots.balance(coin), 0);
        feeRouter.setRootsPaused(coin, false);
        buy(bob, coin, 1 ether);
        assertEq(roots.balance(coin), 0.005 ether);
        assertEq(recovery.balance - before, 0.005 ether);
    }

    // ------------------------------------------------------------ buyback

    function test_buybackAndBurn_onCurve() public {
        buy(bob, coin, 4 ether); // rootstockPot = 0.02
        uint256 pot = feeRouter.rootstockPot();
        assertEq(pot, 0.02 ether);
        uint256 supplyBefore = grove.totalSupply();
        (uint256 expectedOut,,) = launchpad.quoteBuy(address(grove), pot);

        vm.expectEmit(true, true, true, true, address(feeRouter));
        emit Buyback(pot, expectedOut);
        vm.prank(carol); // anyone
        uint256 burned = feeRouter.buybackAndBurn(0);

        assertEq(burned, expectedOut);
        assertEq(supplyBefore - grove.totalSupply(), burned, "GROVE burned");
        assertEq(feeRouter.rootstockPot(), 0, "pot zeroed");
        assertEq(grove.balanceOf(address(feeRouter)), 0);
        assertEq(address(feeRouter).balance, 0);
    }

    function test_buybackAndBurn_onCurve_refundKeptWhenClearingCurve() public {
        // push GROVE to one wei short of graduation, then make the pot bigger than what is left
        uint256 gross = grossToClear(address(grove));
        buy(whale, address(grove), gross - 0.05 ether);
        assertFalse(launchpad.isGraduated(address(grove)));
        buy(bob, coin, 10.5 ether); // rootstockPot = 0.0525 BNB (coin stays on its curve)
        uint256 pot = feeRouter.rootstockPot();
        uint256 need = grossToClear(address(grove));
        assertGt(pot, need);

        uint256 supplyBefore = grove.totalSupply();
        vm.prank(keeper); // the pot is above the public per-call cap
        feeRouter.buybackAndBurn(0);
        assertTrue(launchpad.isGraduated(address(grove)), "buyback graduated GROVE");
        assertLt(grove.totalSupply(), supplyBefore);
        assertEq(feeRouter.rootstockPot(), pot - need, "refund stays in the pot");
        assertEq(address(feeRouter).balance, feeRouter.rootstockPot());
    }

    function test_buybackAndBurn_afterGraduation() public {
        graduate(address(grove));
        buy(bob, coin, 4 ether);
        uint256 pot = feeRouter.rootstockPot();
        uint256 supplyBefore = grove.totalSupply();
        address[] memory path = new address[](2);
        path[0] = address(wbnb);
        path[1] = address(grove);
        uint256 expectedOut = router.getAmountsOut(pot, path)[1];

        uint256 burned = feeRouter.buybackAndBurn(0);
        assertEq(burned, expectedOut, "FeeRouter is exempt: no pair-tax on the buyback");
        assertEq(supplyBefore - grove.totalSupply(), burned);
        assertEq(feeRouter.rootstockPot(), 0);
    }

    function test_buybackAndBurn_slippage() public {
        buy(bob, coin, 1 ether);
        vm.expectRevert(Launchpad.Slippage.selector);
        feeRouter.buybackAndBurn(type(uint256).max);
    }

    function test_buybackAndBurn_emptyReverts() public {
        vm.expectRevert("empty");
        feeRouter.buybackAndBurn(0);
    }

    function test_buybackAndBurn_noRootstockReverts() public {
        FeeRouter fr = new FeeRouter(treasury, recovery, address(router), owner);
        vm.expectRevert("no rootstock");
        fr.buybackAndBurn(0);
    }

    // ---------------------------------------------------------------- admin

    function test_setRootstock_onceAndMustBeRootstock() public {
        vm.expectRevert(bytes("set"));
        feeRouter.setRootstock(address(grove));
        FeeRouter fr = new FeeRouter(treasury, recovery, address(router), owner);
        vm.expectRevert("not rootstock");
        fr.setRootstock(coin);
    }

    function test_setTreasury() public {
        vm.expectRevert(bytes("zero"));
        feeRouter.setTreasury(address(0));
        feeRouter.setTreasury(carol);
        assertEq(feeRouter.treasury(), carol);
        vm.prank(bob);
        vm.expectRevert();
        feeRouter.setTreasury(bob);
    }

    function test_constructor_rejectsZero() public {
        vm.expectRevert(bytes("zero"));
        new FeeRouter(address(0), recovery, address(router), owner);
    }
}
