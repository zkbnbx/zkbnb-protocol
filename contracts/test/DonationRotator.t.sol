// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseTest} from "./Base.t.sol";
import {DonationRotator} from "../src/DonationRotator.sol";
import {PayoutMode} from "../src/interfaces/IGrove.sol";

contract DonationRotatorTest is BaseTest {
    uint256[3] pubKeys = [uint256(1111), uint256(2222), uint256(3333)];
    address[3] causeOwners;
    uint256[3] causeIds;
    uint256 ringId;
    address coin;
    address fallbackWallet = makeAddr("fallbackWallet");

    event CauseRegistered(uint256 indexed causeId, string name, uint256 shieldedPubKey, bytes32 encryptionKey, address fallbackWallet, address owner);
    event RingCreated(uint256 indexed ringId, string name, uint256[] causeIds, uint256 epochLength, address creator);
    event CoinBound(address indexed coin, uint256 indexed ringId);
    event Funded(uint256 indexed ringId, address indexed coin, uint256 amount, address from);
    event Donated(uint256 indexed ringId, uint256 amount, address from);
    event DirectDonation(uint256 indexed causeId, uint256 amount, address from, bool shielded, uint256 leafIndex);
    event Settled(uint256 indexed ringId, uint256 indexed epoch, uint256 indexed causeId, uint256 amount, bool shielded, uint256 leafIndex);
    event DepositFor(uint256 indexed pubKey, uint256 amount, uint256 blinding, uint256 index, address indexed from);

    function setUp() public override {
        super.setUp();
        causeOwners = [makeAddr("ownerA"), makeAddr("ownerB"), makeAddr("ownerC")];
        uint256 fee = rotator.registerFee();
        for (uint256 i = 0; i < 3; i++) {
            vm.deal(causeOwners[i], 1 ether);
            vm.prank(causeOwners[i]);
            causeIds[i] = rotator.registerCause{value: fee}(
                string.concat("Cause ", vm.toString(i)), "https://cause", pubKeys[i], bytes32(uint256(100 + i)), address(0)
            );
        }
        uint256[] memory ids = new uint256[](3);
        ids[0] = causeIds[0];
        ids[1] = causeIds[1];
        ids[2] = causeIds[2];
        ringId = rotator.createRing("Grove global ring", ids, 1 days);
        coin = plantCoin(alice, PayoutMode.Donate, address(0), ringId, 0);
    }

    function _blinding(uint256 epoch, uint256 causeId) internal view returns (uint256) {
        return uint256(keccak256(abi.encode("ring", ringId, epoch, causeId))) % FIELD_SIZE;
    }

    function _fundRing(uint256 bnb) internal {
        buy(bob, coin, bnb); // 0.8% of bnb lands in the ring's pot
    }

    // -------------------------------------------------------------- causes

    function test_registerCause_feeToTreasuryAndEvent() public {
        uint256 before = treasury.balance;
        uint256 fee = rotator.registerFee();
        vm.prank(carol);
        vm.expectEmit(true, true, true, true, address(rotator));
        emit CauseRegistered(3, "New", 777, bytes32(uint256(9)), carol, carol);
        uint256 id = rotator.registerCause{value: fee + 0.001 ether}("New", "u", 777, bytes32(uint256(9)), carol);
        assertEq(id, 3);
        assertEq(treasury.balance - before, fee + 0.001 ether, "whole value forwarded to treasury");
        assertEq(rotator.causeCount(), 4);
        DonationRotator.Cause memory c = rotator.getCause(id);
        assertEq(c.name, "New");
        assertEq(c.shieldedPubKey, 777);
        assertEq(c.fallbackWallet, carol);
        assertEq(c.owner, carol);
        assertTrue(c.active);
    }

    function test_registerCause_validation() public {
        uint256 fee = rotator.registerFee();
        vm.startPrank(carol);
        vm.expectRevert(bytes("fee"));
        rotator.registerCause{value: fee - 1}("X", "", 1, 0, address(0));
        vm.expectRevert(bytes("name"));
        rotator.registerCause{value: fee}("", "", 1, 0, address(0));
        vm.expectRevert("field");
        rotator.registerCause{value: fee}("X", "", FIELD_SIZE, 0, address(0));
        vm.expectRevert("payee");
        rotator.registerCause{value: fee}("X", "", 0, 0, address(0));
        vm.stopPrank();
    }

    function test_updateCause_causeOwnerOnly_adminCanOnlyToggle() public {
        vm.prank(carol);
        vm.expectRevert(DonationRotator.NotAuthorized.selector);
        rotator.updateCause(causeIds[0], "n", "u", 1, 0, address(0), true);
        vm.prank(causeOwners[0]);
        rotator.updateCause(causeIds[0], "n", "u", 1, 0, address(0), false);
        assertFalse(rotator.getCause(causeIds[0]).active);
        // the contract owner cannot redirect a cause's money...
        vm.expectRevert(DonationRotator.NotAuthorized.selector);
        rotator.updateCause(causeIds[0], "n2", "u", 999, 0, address(0), true);
        // ...only (de)activate it
        rotator.setCauseActive(causeIds[0], true);
        assertTrue(rotator.getCause(causeIds[0]).active);
        assertEq(rotator.getCause(causeIds[0]).shieldedPubKey, 1);
        vm.prank(carol);
        vm.expectRevert(DonationRotator.NotAuthorized.selector);
        rotator.setCauseActive(causeIds[0], false);
        vm.prank(causeOwners[0]);
        rotator.setCauseActive(causeIds[0], false);
        assertFalse(rotator.getCause(causeIds[0]).active);
        vm.expectRevert(DonationRotator.BadCause.selector);
        rotator.updateCause(99, "n", "u", 1, 0, address(0), true);
        vm.expectRevert(DonationRotator.BadCause.selector);
        rotator.setCauseActive(99, true);
    }

    // --------------------------------------------------------------- rings

    function test_createRing_validation() public {
        uint256[] memory empty;
        vm.expectRevert(DonationRotator.BadRing.selector);
        rotator.createRing("r", empty, 1 days);

        uint256[] memory tooMany = new uint256[](65);
        vm.expectRevert(DonationRotator.BadRing.selector);
        rotator.createRing("r", tooMany, 1 days);

        uint256[] memory one = new uint256[](1);
        uint256 minEpoch = rotator.minEpoch();
        vm.expectRevert(DonationRotator.BadRing.selector);
        rotator.createRing("r", one, minEpoch - 1);

        one[0] = 42;
        vm.expectRevert(DonationRotator.BadCause.selector);
        rotator.createRing("r", one, 1 days);

        uint256[] memory sixtyFour = new uint256[](64);
        uint256 id = rotator.createRing("r", sixtyFour, minEpoch);
        assertEq(id, 1);
    }

    function test_createRing_storesAndEmits() public {
        uint256[] memory ids = new uint256[](2);
        ids[0] = causeIds[1];
        ids[1] = causeIds[0];
        vm.prank(carol);
        vm.expectEmit(true, true, true, true, address(rotator));
        emit RingCreated(1, "two", ids, 2 hours, carol);
        uint256 id = rotator.createRing("two", ids, 2 hours);
        (string memory name, uint256[] memory got, uint256 epochLength, uint256 cursor, uint256 lastSettled, uint256 settled, address creator) =
            rotator.getRing(id);
        assertEq(name, "two");
        assertEq(got.length, 2);
        assertEq(got[0], causeIds[1]);
        assertEq(epochLength, 2 hours);
        assertEq(cursor, 0);
        assertEq(lastSettled, block.timestamp);
        assertEq(settled, 0);
        assertEq(creator, carol);
        assertEq(rotator.ringCount(), 2);
        assertTrue(rotator.ringExists(1));
        assertFalse(rotator.ringExists(2));
        assertEq(rotator.nextCause(id), causeIds[1]);
        assertEq(rotator.nextSettleAt(id), block.timestamp + 2 hours);
    }

    // ------------------------------------------------------------- funding

    function test_plantDonate_bindsCoinAndFeesFundRing() public {
        assertTrue(rotator.coinBound(coin));
        assertEq(rotator.coinRing(coin), ringId);
        vm.expectEmit(true, true, true, true, address(rotator));
        emit Funded(ringId, coin, 0.008 ether, address(feeRouter));
        _fundRing(1 ether);
        assertEq(rotator.pot(ringId), 0.008 ether);
        assertEq(address(rotator).balance, 0.008 ether);
    }

    function test_fund_onlyFeeRouterAndBoundCoins() public {
        vm.prank(bob);
        vm.expectRevert(DonationRotator.NotAuthorized.selector);
        rotator.fund{value: 1 ether}(coin);
        vm.deal(address(feeRouter), 1 ether);
        vm.prank(address(feeRouter));
        vm.expectRevert("unbound");
        rotator.fund{value: 1 ether}(address(0xBEEF));
    }

    function test_bindCoin_onlyFeeRouter() public {
        vm.prank(bob);
        vm.expectRevert(DonationRotator.NotAuthorized.selector);
        rotator.bindCoin(coin, ringId);
        vm.prank(address(feeRouter));
        vm.expectRevert(DonationRotator.BadRing.selector);
        rotator.bindCoin(coin, 9);
    }

    function test_donate_toRing() public {
        vm.prank(carol);
        vm.expectEmit(true, true, true, true, address(rotator));
        emit Donated(ringId, 0.5 ether, carol);
        rotator.donate{value: 0.5 ether}(ringId);
        assertEq(rotator.pot(ringId), 0.5 ether);
        vm.startPrank(carol);
        vm.expectRevert(DonationRotator.BadRing.selector);
        rotator.donate{value: 1}(9);
        vm.expectRevert(DonationRotator.Empty.selector);
        rotator.donate{value: 0}(ringId);
        vm.stopPrank();
    }

    function test_donateToCause_shielded() public {
        bytes32 seed = keccak256(abi.encode("direct", causeIds[1], carol, block.number, uint256(0)));
        uint256 blinding = uint256(seed) % FIELD_SIZE;
        vm.prank(carol);
        vm.expectEmit(true, true, true, true, address(pool));
        emit DepositFor(pubKeys[1], 0.25 ether, blinding, 0, address(rotator));
        vm.expectEmit(true, true, true, true, address(rotator));
        emit DirectDonation(causeIds[1], 0.25 ether, carol, true, 0);
        rotator.donateToCause{value: 0.25 ether}(causeIds[1]);
        assertEq(address(pool).balance, 0.25 ether);
        assertEq(rotator.getCause(causeIds[1]).received, 0.25 ether);
    }

    function test_donateToCause_fallbackWallet() public {
        uint256 id = rotator.registerCause{value: rotator.registerFee()}("Public cause", "", 0, 0, fallbackWallet);
        vm.prank(carol);
        vm.expectEmit(true, true, true, true, address(rotator));
        emit DirectDonation(id, 0.1 ether, carol, false, 0);
        rotator.donateToCause{value: 0.1 ether}(id);
        assertEq(fallbackWallet.balance, 0.1 ether);
        assertEq(address(pool).balance, 0);
    }

    function test_donateToCause_validation() public {
        vm.startPrank(carol);
        vm.expectRevert(DonationRotator.BadCause.selector);
        rotator.donateToCause{value: 1}(99);
        vm.expectRevert(DonationRotator.Empty.selector);
        rotator.donateToCause{value: 0}(causeIds[0]);
        vm.stopPrank();
        vm.prank(causeOwners[0]);
        rotator.updateCause(causeIds[0], "n", "u", pubKeys[0], 0, address(0), false);
        vm.prank(carol);
        vm.expectRevert("inactive");
        rotator.donateToCause{value: 1}(causeIds[0]);
    }

    // -------------------------------------------------------------- settle

    function test_settle_tooSoonThenPaysWholePotShieldedAndRotates() public {
        _fundRing(1 ether);
        uint256 pot = rotator.pot(ringId);
        assertEq(pot, 0.008 ether);

        vm.expectRevert(DonationRotator.TooSoon.selector);
        rotator.settle(ringId);
        vm.warp(block.timestamp + 1 days - 1);
        vm.expectRevert(DonationRotator.TooSoon.selector);
        rotator.settle(ringId);
        vm.warp(block.timestamp + 1);

        // epoch 0 -> cause 0
        vm.expectEmit(true, true, true, true, address(pool));
        emit DepositFor(pubKeys[0], pot, _blinding(0, causeIds[0]), 0, address(rotator));
        vm.expectEmit(true, true, true, true, address(rotator));
        emit Settled(ringId, 0, causeIds[0], pot, true, 0);
        vm.prank(carol); // anyone
        (uint256 causeId, uint256 amount) = rotator.settle(ringId);
        assertEq(causeId, causeIds[0]);
        assertEq(amount, pot);
        assertEq(rotator.pot(ringId), 0);
        assertEq(address(rotator).balance, 0);
        assertEq(address(pool).balance, pot);
        assertEq(rotator.getCause(causeIds[0]).received, pot);
        assertEq(rotator.nextCause(ringId), causeIds[1]);
        (,,, uint256 cursor, uint256 lastSettled, uint256 settled,) = rotator.getRing(ringId);
        assertEq(cursor, 1);
        assertEq(lastSettled, block.timestamp);
        assertEq(settled, 1);

        // epoch 1 -> cause 1
        _fundRing(2 ether);
        vm.warp(block.timestamp + 1 days);
        vm.expectEmit(true, true, true, true, address(pool));
        emit DepositFor(pubKeys[1], 0.016 ether, _blinding(1, causeIds[1]), 1, address(rotator));
        vm.expectEmit(true, true, true, true, address(rotator));
        emit Settled(ringId, 1, causeIds[1], 0.016 ether, true, 1);
        rotator.settle(ringId);

        // epoch 2 -> cause 2
        _fundRing(1 ether);
        vm.warp(block.timestamp + 1 days);
        vm.expectEmit(true, true, true, true, address(rotator));
        emit Settled(ringId, 2, causeIds[2], 0.008 ether, true, 2);
        rotator.settle(ringId);

        // epoch 3 -> back to cause 0 (round-robin)
        _fundRing(1 ether);
        vm.warp(block.timestamp + 1 days);
        vm.expectEmit(true, true, true, true, address(rotator));
        emit Settled(ringId, 3, causeIds[0], 0.008 ether, true, 3);
        rotator.settle(ringId);
        assertEq(rotator.nextCause(ringId), causeIds[1]);
    }

    function test_settle_emptyPotReverts() public {
        vm.warp(block.timestamp + 1 days);
        vm.expectRevert(DonationRotator.Empty.selector);
        rotator.settle(ringId);
        vm.expectRevert(DonationRotator.BadRing.selector);
        rotator.settle(9);
    }

    function test_settle_skipsInactiveCause() public {
        vm.prank(causeOwners[1]);
        rotator.updateCause(causeIds[1], "B", "u", pubKeys[1], 0, address(0), false);

        _fundRing(1 ether);
        vm.warp(block.timestamp + 1 days);
        vm.expectEmit(true, true, true, true, address(rotator));
        emit Settled(ringId, 0, causeIds[0], 0.008 ether, true, 0);
        rotator.settle(ringId);

        _fundRing(1 ether);
        vm.warp(block.timestamp + 1 days);
        vm.expectEmit(true, true, true, true, address(rotator));
        emit Settled(ringId, 1, causeIds[2], 0.008 ether, true, 1); // cause 1 skipped
        (uint256 causeId,) = rotator.settle(ringId);
        assertEq(causeId, causeIds[2]);
        assertEq(rotator.nextCause(ringId), causeIds[0]);
    }

    function test_settle_allInactiveWaits() public {
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(causeOwners[i]);
            rotator.updateCause(causeIds[i], "x", "u", pubKeys[i], 0, address(0), false);
        }
        _fundRing(1 ether);
        vm.warp(block.timestamp + 1 days);
        vm.expectRevert("no active cause");
        rotator.settle(ringId);
        assertEq(rotator.pot(ringId), 0.008 ether, "pot waits");
    }

    function test_settle_causeWithoutKeyIsPaidToFallbackWallet() public {
        uint256 id = rotator.registerCause{value: rotator.registerFee()}("Public cause", "", 0, 0, fallbackWallet);
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        uint256 ring = rotator.createRing("public", ids, 1 hours);
        vm.prank(carol);
        rotator.donate{value: 0.3 ether}(ring);
        vm.warp(block.timestamp + 1 hours);
        vm.expectEmit(true, true, true, true, address(rotator));
        emit Settled(ring, 0, id, 0.3 ether, false, 0);
        (, uint256 amount) = rotator.settle(ring);
        assertEq(amount, 0.3 ether);
        assertEq(fallbackWallet.balance, 0.3 ether);
        assertEq(address(pool).balance, 0);
        assertEq(rotator.getCause(id).received, 0.3 ether);
    }

    // ---------------------------------------------------------------- admin

    function test_admin() public {
        vm.prank(bob);
        vm.expectRevert();
        rotator.setParams(1, 1, bob);
        rotator.setParams(0.01 ether, 2 hours, carol);
        assertEq(rotator.registerFee(), 0.01 ether);
        assertEq(rotator.minEpoch(), 2 hours);
        assertEq(rotator.treasury(), carol);
        vm.prank(bob);
        vm.expectRevert();
        rotator.setFeeRouter(bob);
    }
}
