// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseTest} from "./Base.t.sol";
import {HolderRewards} from "../src/HolderRewards.sol";
import {PayoutMode} from "../src/interfaces/IGrove.sol";

contract HolderRewardsTest is BaseTest {
    address coin;
    address dave = makeAddr("dave");

    // snapshot: 4 holders, 1 BNB
    address[4] holders;
    uint256[4] amounts = [0.4 ether, 0.3 ether, 0.2 ether, 0.1 ether];
    bytes32[] leaves;
    bytes32 root;

    event Funded(address indexed coin, uint256 amount, address from);
    event RunPosted(address indexed coin, uint256 indexed runId, bytes32 root, uint256 amount, uint256 holders, string uri);
    event Claimed(address indexed coin, uint256 indexed runId, address indexed account, uint256 amount, bool shielded, uint256 leafIndex);
    event Swept(address indexed coin, uint256 indexed runId, uint256 amount);
    event DepositFor(uint256 indexed pubKey, uint256 amount, uint256 blinding, uint256 index, address indexed from);

    function setUp() public override {
        super.setUp();
        coin = plantCoin(alice, PayoutMode.Holders);
        holders = [alice, bob, carol, dave];
        _buildTree(0);
    }

    // ------------------------------------------------------ merkle helpers

    function _hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function _buildTree(uint256 runId) internal {
        delete leaves;
        for (uint256 i = 0; i < 4; i++) {
            leaves.push(keccak256(abi.encode(coin, runId, holders[i], amounts[i])));
        }
        root = _hashPair(_hashPair(leaves[0], leaves[1]), _hashPair(leaves[2], leaves[3]));
    }

    function _proof(uint256 i) internal view returns (bytes32[] memory proof) {
        proof = new bytes32[](2);
        proof[0] = leaves[i ^ 1];
        proof[1] = _hashPair(leaves[(i ^ 2) & ~uint256(1)], leaves[((i ^ 2) & ~uint256(1)) + 1]);
    }

    function _postRun() internal returns (uint256 runId) {
        holderRewards.tip{value: 1 ether}(coin);
        vm.prank(keeper);
        runId = holderRewards.postRun(coin, root, 1 ether, 4, "ipfs://run");
    }

    // ---------------------------------------------------------------- fund

    function test_fund_authorizedSourcesOnly() public {
        vm.prank(bob);
        vm.expectRevert(HolderRewards.NotAuthorized.selector);
        holderRewards.fund{value: 1 ether}(coin);

        vm.deal(address(feeRouter), 1 ether);
        vm.prank(address(feeRouter));
        vm.expectEmit(true, true, true, true, address(holderRewards));
        emit Funded(coin, 0.3 ether, address(feeRouter));
        holderRewards.fund{value: 0.3 ether}(coin);

        vm.deal(address(roots), 1 ether);
        vm.prank(address(roots));
        holderRewards.fund{value: 0.2 ether}(coin);
        assertEq(holderRewards.pot(coin), 0.5 ether);
    }

    function test_fund_viaTrades() public {
        buy(bob, coin, 10 ether);
        assertEq(holderRewards.pot(coin), 0.08 ether);
    }

    function test_tip_anyone() public {
        vm.prank(carol);
        vm.expectEmit(true, true, true, true, address(holderRewards));
        emit Funded(coin, 0.5 ether, carol);
        holderRewards.tip{value: 0.5 ether}(coin);
        assertEq(holderRewards.pot(coin), 0.5 ether);
    }

    // ------------------------------------------------------------- postRun

    function test_postRun_keeperOnly() public {
        holderRewards.tip{value: 1 ether}(coin);
        vm.prank(bob);
        vm.expectRevert(HolderRewards.NotAuthorized.selector);
        holderRewards.postRun(coin, root, 1 ether, 4, "");
    }

    function test_postRun_movesPotIntoRun() public {
        holderRewards.tip{value: 1.5 ether}(coin);
        vm.prank(keeper);
        vm.expectEmit(true, true, true, true, address(holderRewards));
        emit RunPosted(coin, 0, root, 1 ether, 4, "ipfs://run");
        uint256 runId = holderRewards.postRun(coin, root, 1 ether, 4, "ipfs://run");
        assertEq(runId, 0);
        assertEq(holderRewards.pot(coin), 0.5 ether);
        assertEq(holderRewards.runCount(coin), 1);
        HolderRewards.Run memory r = holderRewards.getRun(coin, 0);
        assertEq(r.root, root);
        assertEq(r.amount, 1 ether);
        assertEq(r.claimed, 0);
        assertEq(r.holders, 4);
        assertEq(r.postedAt, block.timestamp);
        assertEq(r.uri, "ipfs://run");
        assertEq(holderRewards.lastRunAt(coin), block.timestamp);
    }

    function test_postRun_tooSoonWithinAnHour() public {
        _postRun();
        holderRewards.tip{value: 1 ether}(coin);
        vm.prank(keeper);
        vm.expectRevert(HolderRewards.TooSoon.selector);
        holderRewards.postRun(coin, root, 1 ether, 4, "");
        vm.warp(block.timestamp + 1 hours - 1);
        vm.prank(keeper);
        vm.expectRevert(HolderRewards.TooSoon.selector);
        holderRewards.postRun(coin, root, 1 ether, 4, "");
        vm.warp(block.timestamp + 1);
        vm.prank(keeper);
        uint256 id = holderRewards.postRun(coin, root, 1 ether, 4, "");
        assertEq(id, 1);
    }

    function test_postRun_potTooSmall() public {
        holderRewards.tip{value: 0.04 ether}(coin);
        vm.startPrank(keeper);
        vm.expectRevert(HolderRewards.PotTooSmall.selector);
        holderRewards.postRun(coin, root, 0.04 ether, 4, ""); // < minPot (0.05)
        vm.expectRevert(HolderRewards.PotTooSmall.selector);
        holderRewards.postRun(coin, root, 0.05 ether, 4, ""); // > pot
        vm.stopPrank();
    }

    // --------------------------------------------------------------- claim

    function test_claim_public() public {
        uint256 runId = _postRun();
        uint256 before = alice.balance;
        vm.prank(alice);
        vm.expectEmit(true, true, true, true, address(holderRewards));
        emit Claimed(coin, runId, alice, 0.4 ether, false, 0);
        holderRewards.claim(coin, runId, 0.4 ether, _proof(0));
        assertEq(alice.balance - before, 0.4 ether);
        assertTrue(holderRewards.isClaimed(coin, runId, alice));
        assertEq(holderRewards.getRun(coin, runId).claimed, 0.4 ether);

        // everyone else can claim too
        vm.prank(bob);
        holderRewards.claim(coin, runId, 0.3 ether, _proof(1));
        vm.prank(carol);
        holderRewards.claim(coin, runId, 0.2 ether, _proof(2));
        vm.prank(dave);
        holderRewards.claim(coin, runId, 0.1 ether, _proof(3));
        assertEq(holderRewards.getRun(coin, runId).claimed, 1 ether);
        assertEq(address(holderRewards).balance, 0);
    }

    function test_claim_shielded() public {
        uint256 runId = _postRun();
        uint256 pubKey = 42;
        uint256 blinding = 7;
        uint256 before = bob.balance;
        vm.expectEmit(true, true, true, true, address(pool));
        emit DepositFor(pubKey, 0.3 ether, blinding, 0, address(holderRewards));
        vm.expectEmit(true, true, true, true, address(holderRewards));
        emit Claimed(coin, runId, bob, 0.3 ether, true, 0);
        vm.prank(bob);
        holderRewards.claimShielded(coin, runId, 0.3 ether, _proof(1), pubKey, blinding);
        assertEq(bob.balance, before);
        assertEq(address(pool).balance, 0.3 ether);
        assertTrue(holderRewards.isClaimed(coin, runId, bob));
    }

    function test_claim_doubleClaimReverts() public {
        uint256 runId = _postRun();
        vm.startPrank(alice);
        holderRewards.claim(coin, runId, 0.4 ether, _proof(0));
        vm.expectRevert(HolderRewards.AlreadyClaimed.selector);
        holderRewards.claim(coin, runId, 0.4 ether, _proof(0));
        vm.expectRevert(HolderRewards.AlreadyClaimed.selector);
        holderRewards.claimShielded(coin, runId, 0.4 ether, _proof(0), 1, 1);
        vm.stopPrank();
    }

    function test_claim_badProofOrAmountReverts() public {
        uint256 runId = _postRun();
        vm.startPrank(alice);
        vm.expectRevert(HolderRewards.BadProof.selector);
        holderRewards.claim(coin, runId, 0.5 ether, _proof(0)); // wrong amount
        vm.expectRevert(HolderRewards.BadProof.selector);
        holderRewards.claim(coin, runId, 0.4 ether, _proof(1)); // someone else's proof
        vm.stopPrank();
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(HolderRewards.BadProof.selector);
        holderRewards.claim(coin, runId, 0.4 ether, _proof(0)); // not in the tree
    }

    function test_leaf_matchesSpec() public view {
        assertEq(holderRewards.leaf(coin, 0, alice, 0.4 ether), keccak256(abi.encode(coin, uint256(0), alice, uint256(0.4 ether))));
    }

    function test_claims_areScopedPerRun() public {
        uint256 run0 = _postRun();
        vm.warp(block.timestamp + 1 hours);
        _buildTree(1);
        uint256 run1 = _postRun();
        vm.startPrank(alice);
        _buildTree(0);
        holderRewards.claim(coin, run0, 0.4 ether, _proof(0));
        _buildTree(1);
        holderRewards.claim(coin, run1, 0.4 ether, _proof(0));
        vm.stopPrank();
        assertTrue(holderRewards.isClaimed(coin, run0, alice));
        assertTrue(holderRewards.isClaimed(coin, run1, alice));
    }

    // --------------------------------------------------------------- sweep

    function test_sweepExpired_rollsUnclaimedBackIntoPot() public {
        uint256 runId = _postRun();
        vm.prank(alice);
        holderRewards.claim(coin, runId, 0.4 ether, _proof(0));

        vm.expectRevert(HolderRewards.WindowOpen.selector);
        holderRewards.sweepExpired(coin, runId);

        vm.warp(block.timestamp + holderRewards.claimWindow());
        vm.expectEmit(true, true, true, true, address(holderRewards));
        emit Swept(coin, runId, 0.6 ether);
        holderRewards.sweepExpired(coin, runId);
        assertEq(holderRewards.pot(coin), 0.6 ether);
        assertEq(holderRewards.getRun(coin, runId).claimed, 1 ether);

        vm.expectRevert("nothing");
        holderRewards.sweepExpired(coin, runId);

        // late claims fail: the run is fully accounted
        vm.prank(bob);
        vm.expectRevert(bytes("over"));
        holderRewards.claim(coin, runId, 0.3 ether, _proof(1));
    }

    // ---------------------------------------------------------------- admin

    function test_admin() public {
        vm.prank(bob);
        vm.expectRevert();
        holderRewards.setKeeper(bob);
        holderRewards.setKeeper(bob);
        assertEq(holderRewards.keeper(), bob);
        holderRewards.setParams(0.1 ether, 7 days);
        assertEq(holderRewards.minPot(), 0.1 ether);
        assertEq(holderRewards.claimWindow(), 7 days);
    }
}
