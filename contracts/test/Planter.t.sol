// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {StdStorage, stdStorage} from "forge-std/StdStorage.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {PrivacyBase} from "./GrovePool.t.sol";
import {GrovePool} from "../src/GrovePool.sol";
import {Planter} from "../src/Planter.sol";
import {CreatorStub} from "../src/CreatorStub.sol";
import {Roots} from "../src/Roots.sol";
import {PayoutMode} from "../src/interfaces/IGrove.sol";
import {GroveConstants as C} from "../src/libraries/GroveConstants.sol";

contract PlanterTest is PrivacyBase {
    using stdStorage for StdStorage;

    event Credited(uint256 indexed handle, uint256 amount);
    event HarvestedToHandle(address indexed coin, uint256 tokens, uint256 bnb, uint256 handle);

    uint256 constant HANDLE = 424242;
    address coin;
    CreatorStub stub;

    function setUp() public override {
        super.setUp();
        shield(1 ether);
        (coin,) = plantPrivately(HANDLE);
        stub = CreatorStub(payable(planter.stubOf(coin)));
    }

    function test_stubIsCreator_andDeployerShareFlowsToStub() public {
        (address cfgCreator,,,,,,,) = feeRouter.configOf(coin);
        assertEq(cfgCreator, address(stub));
        assertEq(stub.planter(), address(planter));
        assertEq(address(stub.pool()), address(gp));
        uint256 before = address(stub).balance;
        buy(bob, coin, 1 ether);
        // deployer share = fee - roots - rootstock - treasury = 2% * 40% of 1 BNB
        uint256 fee = 1 ether * 200 / 10_000;
        uint256 expected = fee - fee * 2500 / 10_000 - fee * 2500 / 10_000 - fee * 1000 / 10_000;
        assertEq(address(stub).balance, before + expected, "creator share pushed to the stub");
    }

    function test_flush_creditsHandle() public {
        buy(bob, coin, 1 ether);
        uint256 bal = address(stub).balance;
        assertGt(bal, 0);
        vm.expectEmit(true, true, true, true, address(gp));
        emit Credited(HANDLE, bal);
        vm.prank(carol);
        stub.flush();
        assertEq(address(stub).balance, 0);
        assertEq(gp.claimable(HANDLE), bal);
        // nothing to flush is a no-op
        stub.flush();
        assertEq(gp.claimable(HANDLE), bal);
    }

    function test_flush_drainsPendingPath() public {
        // simulate a failed push: FeeRouter.pending[stub] = 0.1 BNB (what a 50k-gas revert would leave)
        uint256 amt = 0.1 ether;
        stdstore.target(address(feeRouter)).sig("pending(address)").with_key(address(stub)).checked_write(amt);
        stdstore.target(address(feeRouter)).sig("totalPending()").checked_write(amt);
        vm.deal(address(feeRouter), address(feeRouter).balance + amt);
        assertEq(feeRouter.pending(address(stub)), amt);
        stub.flush();
        assertEq(feeRouter.pending(address(stub)), 0);
        assertEq(gp.claimable(HANDLE), amt);
    }

    function test_stub_onlyPlanter() public {
        vm.expectRevert(CreatorStub.NotPlanter.selector);
        stub.handOver(PayoutMode.Holders, address(0), 0);
        vm.expectRevert(CreatorStub.NotPlanter.selector);
        stub.plant{value: 0}(_params("x", "x", PayoutMode.Creator, address(0), 0));
        vm.prank(address(planter));
        vm.expectRevert(CreatorStub.AlreadyPlanted.selector);
        stub.plant{value: 0}(_params("x", "x", PayoutMode.Creator, address(0), 0));
    }

    function test_handOver_viaPool_toHolders() public {
        GrovePool.ExtData memory e = _ext(address(0), 0, 0, 0, abi.encode(C.ACTION_HANDOVER, coin, PayoutMode.Holders, address(0), uint256(0)));
        GrovePool.TransferPublic memory s = _pub(e, address(0), 0, HANDLE, 0);
        _transact(s, e, 0);
        (, PayoutMode mode,,,,, bool handedOver,) = feeRouter.configOf(coin);
        assertTrue(mode == PayoutMode.Holders);
        assertTrue(handedOver);
        // second hand-over is refused by the FeeRouter
        s = _pub(e, address(0), 0, HANDLE, 0);
        vm.expectRevert();
        _transact(s, e, 0);
        // unknown coin
        e = _ext(address(0), 0, 0, 0, abi.encode(C.ACTION_HANDOVER, bob, PayoutMode.Holders, address(0), uint256(0)));
        s = _pub(e, address(0), 0, HANDLE, 0);
        vm.expectRevert(Planter.UnknownCoin.selector);
        _transact(s, e, 0);
    }

    function test_harvestToHandle_burnsAndCredits() public {
        buy(alice, coin, 2 ether); // roots get 2% * 25%
        uint256 tokens = 1_000_000e18;
        uint256 expected = roots.harvestValue(coin, tokens);
        assertGt(expected, 0);
        uint256 supplyBefore = IERC20(coin).totalSupply();
        vm.startPrank(alice);
        IERC20(coin).approve(address(planter), tokens);
        vm.expectEmit(true, true, true, true, address(planter));
        emit HarvestedToHandle(coin, tokens, expected, 77);
        planter.harvestToHandle(coin, tokens, expected, 77);
        vm.stopPrank();
        assertEq(gp.claimable(77), expected);
        assertEq(IERC20(coin).totalSupply(), supplyBefore - tokens, "burned");
        assertEq(address(planter).balance, 0);

        vm.startPrank(alice);
        IERC20(coin).approve(address(planter), tokens);
        vm.expectRevert(Roots.Slippage.selector);
        planter.harvestToHandle(coin, tokens, type(uint256).max, 77);
        vm.expectRevert(Planter.BadHandle.selector);
        planter.harvestToHandle(coin, tokens, 0, 0);
        vm.stopPrank();
    }

    function test_predictStub_andNonce() public {
        assertEq(planter.stubNonce(), 1);
        assertEq(planter.predictStub(HANDLE, 0), address(stub));
        // a second plant for the same handle gets a different stub (nonce 1)
        (address coin2,) = plantPrivately(HANDLE);
        assertEq(planter.predictStub(HANDLE, 1), planter.stubOf(coin2));
        assertTrue(planter.stubOf(coin2) != address(stub));
    }
}
