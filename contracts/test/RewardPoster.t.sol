// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {BaseTest} from "./Base.t.sol";
import {GrovePool} from "../src/GrovePool.sol";
import {HolderRewards} from "../src/HolderRewards.sol";
import {RewardPoster} from "../src/RewardPoster.sol";
import {PayoutMode} from "../src/interfaces/IGrove.sol";
import {GroveConstants as C} from "../src/libraries/GroveConstants.sol";
import {MockVerifier13} from "./mocks/MockVerifierN.sol";

/// @notice Review N1: the run is posted and the pool's share pulled in one transaction, against the
///         real HolderRewards (Merkle proofs) and a real GrovePool.
contract RewardPosterTest is BaseTest {
    GrovePool internal gp;
    RewardPoster internal poster;
    address internal coin;
    address internal operator = makeAddr("operator");

    function setUp() public override {
        super.setUp();
        gp = new GrovePool(address(new MockVerifier13()), poseidonT3, poseidonT4, address(launchpad), address(holderRewards), address(pool), owner);
        poster = new RewardPoster(address(holderRewards), address(gp), operator);
        vm.prank(owner);
        holderRewards.setKeeper(address(poster));

        coin = plantCoin(alice, PayoutMode.Holders);
        buy(bob, coin, 1 ether);
        vm.prank(bob);
        IERC20(coin).transfer(address(gp), 1000 ether); // the pool's coin supply (shielded notes)
        holderRewards.tip{value: 1 ether}(coin);
    }

    /// @dev Two-leaf tree: the pool and carol. OpenZeppelin MerkleProof hashes sorted pairs.
    function _tree(uint256 runId, uint256 poolAmt, uint256 carolAmt)
        internal
        view
        returns (bytes32 root, bytes32[] memory poolProof)
    {
        bytes32 a = holderRewards.leaf(coin, runId, address(gp), poolAmt);
        bytes32 b = holderRewards.leaf(coin, runId, carol, carolAmt);
        root = a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
        poolProof = new bytes32[](1);
        poolProof[0] = b;
    }

    function test_postAndPull_oneTransaction() public {
        (bytes32 root, bytes32[] memory proof) = _tree(0, 0.4 ether, 0.6 ether);
        vm.prank(operator);
        uint256 runId = poster.post(coin, root, 1 ether, 2, "ipfs://run0", 0.4 ether, proof);

        assertEq(runId, 0);
        assertTrue(holderRewards.isClaimed(coin, 0, address(gp)), "pool leaf claimed in the posting tx");
        assertEq(address(gp).balance, 0.4 ether);
        assertEq(gp.accRpt(coin), 0.4 ether * C.RPT_SCALE / 1000 ether);
        // the share is fixed by the pool's supply at post time: a later shield cannot dilute it
        vm.prank(bob);
        IERC20(coin).transfer(address(gp), 1000 ether);
        vm.expectRevert(HolderRewards.AlreadyClaimed.selector);
        gp.pullRewards(coin, 0, 0.4 ether, proof);
    }

    function test_post_withoutPool() public {
        bytes32 root = holderRewards.leaf(coin, 0, carol, 1 ether);
        bytes32[] memory none;
        vm.prank(operator);
        poster.post(coin, root, 1 ether, 1, "ipfs://run0", 0, none);
        assertEq(holderRewards.runCount(coin), 1);
        assertEq(address(gp).balance, 0);
    }

    function test_failedPull_revertsThePost() public {
        (bytes32 root, bytes32[] memory proof) = _tree(0, 0.4 ether, 0.6 ether);
        vm.prank(operator);
        vm.expectRevert(HolderRewards.BadProof.selector);
        poster.post(coin, root, 1 ether, 2, "ipfs://run0", 0.5 ether, proof); // wrong pool amount
        assertEq(holderRewards.runCount(coin), 0, "no run left behind with an unpulled pool leaf");
    }

    function test_onlyOperator() public {
        bytes32[] memory none;
        vm.expectRevert(RewardPoster.NotOperator.selector);
        poster.post(coin, bytes32(0), 1 ether, 1, "", 0, none);
        // and HolderRewards accepts posts only through the poster now
        vm.prank(operator);
        vm.expectRevert(HolderRewards.NotAuthorized.selector);
        holderRewards.postRun(coin, bytes32(0), 1 ether, 1, "");
    }

    function test_constructor_rejectsZero() public {
        vm.expectRevert(RewardPoster.ZeroAddress.selector);
        new RewardPoster(address(holderRewards), address(gp), address(0));
    }
}
