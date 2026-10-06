// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BaseTest} from "./Base.t.sol";
import {Roots} from "../src/Roots.sol";
import {PayoutMode} from "../src/interfaces/IGrove.sol";

contract RootsTest is BaseTest {
    address coin;

    event Deposited(address indexed coin, uint256 amount, uint256 overflow);
    event Harvested(address indexed coin, address indexed harvester, uint256 tokensBurned, uint256 bnb, bool shielded, uint256 leafIndex);
    event DepositFor(uint256 indexed pubKey, uint256 amount, uint256 blinding, uint256 index, address indexed from);

    function setUp() public override {
        super.setUp();
        coin = plantCoin(alice, PayoutMode.Holders);
        buy(bob, coin, 4 ether); // roots = 0.02 BNB
    }

    function _approveRoots(address who) internal {
        vm.prank(who);
        IERC20(coin).approve(address(roots), type(uint256).max);
    }

    // ------------------------------------------------------------- deposit

    function test_deposit_onlyFeeRouter() public {
        vm.prank(bob);
        vm.expectRevert(Roots.NotFeeRouter.selector);
        roots.deposit{value: 1 ether}(coin);
    }

    function test_deposit_fromFeeRouterAccumulates() public {
        assertEq(roots.balance(coin), 0.02 ether);
        assertEq(address(roots).balance, 0.02 ether);
        vm.expectEmit(true, true, true, true, address(roots));
        emit Deposited(coin, 0.005 ether, 0);
        buy(carol, coin, 1 ether);
        assertEq(roots.balance(coin), 0.025 ether);
    }

    function test_capOverflow_goesToHolderRewardsPot() public {
        // a Creator-mode coin so the holder pot only ever receives roots overflow
        address c = plantCoin(alice, PayoutMode.Creator);
        buy(bob, c, 4 ether); // roots[c] = 0.02
        roots.setCap(0.022 ether);
        assertEq(holderRewards.pot(c), 0);
        vm.expectEmit(true, true, true, true, address(roots));
        emit Deposited(c, 0.002 ether, 0.003 ether);
        buy(carol, c, 1 ether); // toRoots 0.005: 0.002 fits, 0.003 overflows
        assertEq(roots.balance(c), 0.022 ether);
        assertEq(holderRewards.pot(c), 0.003 ether, "overflow lands in the holder pot");

        // cap full: everything overflows, nothing lost
        vm.expectEmit(true, true, true, true, address(roots));
        emit Deposited(c, 0, 0.005 ether);
        buy(carol, c, 1 ether);
        assertEq(roots.balance(c), 0.022 ether);
        assertEq(holderRewards.pot(c), 0.008 ether);
        assertEq(address(roots).balance, 0.022 ether + 0.02 ether, "this coin's cap + the setUp coin's roots");
    }

    // ------------------------------------------------------------- harvest

    function test_harvestValue_formula() public view {
        uint256 tokens = IERC20(coin).balanceOf(bob);
        uint256 expected = roots.balance(coin) * tokens / IERC20(coin).totalSupply();
        assertEq(roots.harvestValue(coin, tokens), expected);
        assertEq(roots.valuePerToken(coin), roots.balance(coin) * 1e18 / IERC20(coin).totalSupply());
    }

    function test_harvest_burnsAndPays() public {
        _approveRoots(bob);
        uint256 tokens = IERC20(coin).balanceOf(bob) / 2;
        uint256 expected = roots.harvestValue(coin, tokens);
        assertGt(expected, 0);
        uint256 supplyBefore = IERC20(coin).totalSupply();
        uint256 rootsBefore = roots.balance(coin);
        uint256 bnbBefore = bob.balance;

        vm.expectEmit(true, true, true, true, address(roots));
        emit Harvested(coin, bob, tokens, expected, false, 0);
        vm.prank(bob);
        uint256 bnb = roots.harvest(coin, tokens, expected);

        assertEq(bnb, expected);
        assertEq(bob.balance - bnbBefore, bnb, "paid");
        assertEq(supplyBefore - IERC20(coin).totalSupply(), tokens, "burned");
        assertEq(rootsBefore - roots.balance(coin), bnb);
        assertEq(roots.totalHarvested(coin), bnb);
        assertEq(roots.totalBurned(coin), tokens);
    }

    function test_harvest_needsApproval() public {
        vm.prank(bob);
        vm.expectRevert();
        roots.harvest(coin, 1e18, 0);
    }

    function test_harvest_dustReverts() public {
        _approveRoots(bob);
        assertEq(roots.harvestValue(coin, 1), 0);
        vm.prank(bob);
        vm.expectRevert(Roots.Dust.selector);
        roots.harvest(coin, 1, 0);
    }

    function test_harvest_slippage() public {
        _approveRoots(bob);
        uint256 tokens = 1_000_000e18;
        uint256 v = roots.harvestValue(coin, tokens);
        vm.prank(bob);
        vm.expectRevert(Roots.Slippage.selector);
        roots.harvest(coin, tokens, v + 1);
    }

    function test_harvestShielded_depositsIntoPool() public {
        _approveRoots(bob);
        uint256 tokens = IERC20(coin).balanceOf(bob) / 4;
        uint256 expected = roots.harvestValue(coin, tokens);
        uint256 pubKey = 0x1234abcd;
        uint256 blinding = 0x9999;
        uint256 bnbBefore = bob.balance;

        vm.expectEmit(true, true, true, true, address(pool));
        emit DepositFor(pubKey, expected, blinding, 0, address(roots));
        vm.expectEmit(true, true, true, true, address(roots));
        emit Harvested(coin, bob, tokens, expected, true, 0);
        vm.prank(bob);
        (uint256 bnb, uint256 leafIndex) = roots.harvestShielded(coin, tokens, 0, pubKey, blinding);

        assertEq(bnb, expected);
        assertEq(leafIndex, 0);
        assertEq(bob.balance, bnbBefore, "nothing paid to the wallet");
        assertEq(address(pool).balance, bnb, "BNB sits in the pool");
        assertEq(pool.nextIndex(), 1);

        // second shielded harvest gets the next leaf
        vm.prank(bob);
        (, uint256 leaf2) = roots.harvestShielded(coin, tokens, 0, pubKey, blinding + 1);
        assertEq(leaf2, 1);
    }

    function test_harvestShielded_rejectsOutOfFieldKey() public {
        _approveRoots(bob);
        vm.prank(bob);
        vm.expectRevert("field");
        roots.harvestShielded(coin, 1_000_000e18, 0, FIELD_SIZE, 0);
    }

    // ---------------------------------------------------------- invariant

    function _ratio() internal view returns (uint256) {
        return roots.balance(coin) * 1e18 / IERC20(coin).totalSupply();
    }

    /// @dev Random buys / sells / harvests: a harvest never lowers roots-per-token.
    function testFuzz_harvestNeverLowersRatio(uint8[12] memory actions, uint96[12] memory amounts) public {
        _approveRoots(bob);
        _approveRoots(carol);
        for (uint256 i = 0; i < actions.length; i++) {
            uint256 a = actions[i] % 3;
            address who = i % 2 == 0 ? bob : carol;
            if (a == 0) {
                buy(who, coin, bound(amounts[i], 0.001 ether, 0.3 ether));
            } else if (a == 1) {
                uint256 bal = IERC20(coin).balanceOf(who);
                if (bal == 0) continue;
                uint256 t = bound(amounts[i], 1, bal);
                (uint256 net,,) = launchpad.quoteSell(coin, t);
                if (net == 0) continue;
                sell(who, coin, t);
            } else {
                uint256 bal = IERC20(coin).balanceOf(who);
                if (bal == 0) continue;
                uint256 t = bound(amounts[i], 1, bal);
                if (roots.harvestValue(coin, t) == 0) continue;
                uint256 before = _ratio();
                vm.prank(who);
                roots.harvest(coin, t, 0);
                assertGe(_ratio(), before, "ratio dropped across a harvest");
            }
        }
    }

    function test_harvest_ratioNeverDecreases_sequence() public {
        _approveRoots(bob);
        for (uint256 i = 0; i < 25; i++) {
            uint256 t = IERC20(coin).balanceOf(bob) / 7 + 1;
            uint256 before = _ratio();
            vm.prank(bob);
            roots.harvest(coin, t, 0);
            assertGe(_ratio(), before);
        }
    }

    // ---------------------------------------------------------------- admin

    function test_admin_ownerOnly() public {
        vm.startPrank(bob);
        vm.expectRevert();
        roots.setCap(1);
        vm.expectRevert();
        roots.setHolderRewards(bob);
        vm.stopPrank();
        roots.setCap(1 ether);
        assertEq(roots.cap(), 1 ether);
    }
}
