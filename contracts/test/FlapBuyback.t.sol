// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {FeeRouter} from "../src/FeeRouter.sol";
import {FlapBuyback} from "../src/FlapBuyback.sol";
import {PayoutMode} from "../src/interfaces/IGrove.sol";
import {MockToken, MockFlapPortal, MockFlapDex, MockSink} from "./mocks/MockFlap.sol";

/// @notice FeeRouter with an external (Flap) rootstock and the FlapBuyback adapter, against mocks.
///         The test contract plays the Launchpad, so it can register a coin and collect fees.
contract FlapBuybackTest is Test {
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint8 constant TRADABLE = 1;
    uint8 constant DEX = 4;

    FeeRouter feeRouter;
    FlapBuyback buyback;
    MockFlapPortal portal;
    MockFlapDex dex;
    MockToken token;
    MockToken zec;
    MockSink sink;
    address wbnb = makeAddr("wbnb");
    address treasury = makeAddr("treasury");
    address recovery = makeAddr("recovery");
    address keeper = makeAddr("keeper");
    address creator = makeAddr("creator");
    address alice = makeAddr("alice");
    address coin = makeAddr("coin");

    event Buyback(uint256 bnbIn, uint256 groveBurned);
    event RootstockSet(address coin);
    event RootstockBuybackSet(address buyback);
    event BnbToQuotePathSet(bytes path);

    function setUp() public {
        vm.roll(100);
        token = new MockToken("ZKBNB");
        zec = new MockToken("ZEC");
        portal = new MockFlapPortal();
        portal.setToken(address(token), TRADABLE, address(zec));
        dex = new MockFlapDex(wbnb);
        sink = new MockSink();

        feeRouter = new FeeRouter(treasury, recovery, address(dex), address(this));
        feeRouter.setModules(address(this), address(sink), address(sink), address(sink));
        feeRouter.setKeeper(keeper);
        feeRouter.registerCoin(coin, creator, PayoutMode.Creator, address(0), 0, false);

        buyback = _newBuyback(address(feeRouter));
    }

    function _path() internal view returns (bytes memory) {
        return abi.encodePacked(wbnb, uint24(2500), address(zec));
    }

    function _newBuyback(address router) internal returns (FlapBuyback) {
        return new FlapBuyback(address(token), address(zec), router, address(portal), address(dex), address(dex), _path(), address(this));
    }

    /// @dev Real fee collection: 25% of a collected fee lands in the rootstock pot.
    function _fees(uint256 fee) internal {
        vm.deal(address(this), address(this).balance + fee);
        feeRouter.collect{value: fee}(coin);
    }

    function _wire() internal {
        feeRouter.setExternalRootstock(address(token), address(buyback));
    }

    // ------------------------------------------------------------ setExternalRootstock

    function test_setExternalRootstock_wiresAndEmits() public {
        vm.expectEmit(true, true, true, true, address(feeRouter));
        emit RootstockSet(address(token));
        vm.expectEmit(true, true, true, true, address(feeRouter));
        emit RootstockBuybackSet(address(buyback));
        _wire();
        assertEq(feeRouter.rootstockCoin(), address(token));
        assertEq(address(feeRouter.rootstockBuyback()), address(buyback));
    }

    function test_setExternalRootstock_isOneShot() public {
        _wire();
        FlapBuyback other = _newBuyback(address(feeRouter));
        vm.expectRevert(bytes("set"));
        feeRouter.setExternalRootstock(address(token), address(other));
    }

    function test_setExternalRootstock_rejectsOtherToken() public {
        MockToken t2 = new MockToken("OTHER");
        vm.expectRevert(bytes("buyback token"));
        feeRouter.setExternalRootstock(address(t2), address(buyback));
        vm.expectRevert(bytes("buyback token"));
        feeRouter.setExternalRootstock(address(0), address(buyback));
    }

    function test_setExternalRootstock_rejectsBuybackOfAnotherRouter() public {
        FlapBuyback foreign = _newBuyback(makeAddr("otherFeeRouter"));
        vm.expectRevert(bytes("buyback router"));
        feeRouter.setExternalRootstock(address(token), address(foreign));
    }

    function test_setExternalRootstock_ownerOnly() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        feeRouter.setExternalRootstock(address(token), address(buyback));
    }

    function test_setExternalRootstock_excludesSetRootstock() public {
        address inHouse = makeAddr("inHouseRootstock");
        feeRouter.registerCoin(inHouse, creator, PayoutMode.Creator, address(0), 0, true);
        _wire();
        vm.expectRevert(bytes("set"));
        feeRouter.setRootstock(inHouse);
    }

    function test_setRootstock_excludesSetExternalRootstock() public {
        address inHouse = makeAddr("inHouseRootstock");
        feeRouter.registerCoin(inHouse, creator, PayoutMode.Creator, address(0), 0, true);
        feeRouter.setRootstock(inHouse);
        vm.expectRevert(bytes("set"));
        feeRouter.setExternalRootstock(address(token), address(buyback));
        assertEq(address(feeRouter.rootstockBuyback()), address(0));
    }

    // ------------------------------------------------------------ buybackAndBurn via FlapBuyback

    function test_buyback_onCurve_burnsToDeadAndDebitsPot() public {
        _wire();
        _fees(0.1 ether); // pot 0.025
        assertEq(feeRouter.rootstockPot(), 0.025 ether);
        vm.expectEmit(true, true, true, true, address(feeRouter));
        emit Buyback(0.025 ether, 0.025 ether * 1000);
        vm.prank(keeper);
        uint256 burned = feeRouter.buybackAndBurn(0.025 ether * 1000);
        assertEq(burned, 25 ether);
        assertEq(token.balanceOf(DEAD), burned, "all of it at 0xdEaD");
        assertEq(feeRouter.rootstockPot(), 0);
        assertEq(address(feeRouter).balance, 0);
        assertEq(address(buyback).balance, 0);
        assertEq(token.balanceOf(address(buyback)), 0);
    }

    function test_buyback_onDex_routesV3ThenV2() public {
        _wire();
        portal.setToken(address(token), DEX, address(zec));
        _fees(0.1 ether);
        vm.prank(keeper);
        uint256 burned = feeRouter.buybackAndBurn(1);
        assertEq(burned, 0.025 ether * 2 * 500, "BNB -> ZEC (x2) -> token (x500)");
        assertEq(token.balanceOf(DEAD), burned);
        assertEq(dex.lastPath(), _path());
        assertEq(zec.balanceOf(address(buyback)), 0, "no ZEC left behind");
        assertEq(feeRouter.rootstockPot(), 0);
    }

    function test_buyback_onDex_spendsLeftoverQuote() public {
        _wire();
        portal.setToken(address(token), DEX, address(zec));
        zec.mint(address(buyback), 1 ether); // e.g. a curve buy that refunded ZEC
        _fees(0.1 ether);
        vm.prank(keeper);
        uint256 burned = feeRouter.buybackAndBurn(1);
        assertEq(burned, (0.05 ether + 1 ether) * 500);
        assertEq(zec.balanceOf(address(buyback)), 0);
    }

    function test_buyback_publicCapAndOnePerBlock() public {
        _wire();
        _fees(1 ether); // pot 0.25
        uint256 cap = feeRouter.publicBuybackCap();
        vm.prank(alice);
        uint256 burned = feeRouter.buybackAndBurn(0);
        assertEq(burned, cap * 1000, "public spends the cap only");
        assertEq(feeRouter.rootstockPot(), 0.25 ether - cap);

        vm.prank(alice);
        vm.expectRevert(bytes("one per block"));
        feeRouter.buybackAndBurn(0);

        vm.roll(block.number + 1);
        vm.prank(alice);
        feeRouter.buybackAndBurn(0);
        assertEq(feeRouter.rootstockPot(), 0.25 ether - 2 * cap);
    }

    function test_buyback_keeperUncapped() public {
        _wire();
        _fees(1 ether);
        vm.prank(alice);
        feeRouter.buybackAndBurn(0); // same block: does not block the keeper
        vm.prank(keeper);
        feeRouter.buybackAndBurn(0);
        assertEq(feeRouter.rootstockPot(), 0, "keeper spends the whole pot");
    }

    function test_buyback_slippageReverts() public {
        _wire();
        _fees(0.1 ether);
        vm.prank(keeper);
        vm.expectRevert(bytes("SlippageTooHigh"));
        feeRouter.buybackAndBurn(0.025 ether * 1000 + 1);
        assertEq(feeRouter.rootstockPot(), 0.025 ether, "pot untouched");

        portal.setToken(address(token), DEX, address(zec));
        vm.prank(keeper);
        vm.expectRevert(bytes("INSUFFICIENT_OUTPUT_AMOUNT"));
        feeRouter.buybackAndBurn(0.025 ether * 2 * 500 + 1);
        assertEq(feeRouter.rootstockPot(), 0.025 ether);
    }

    function test_buyback_refundGoesBackToPot() public {
        _wire();
        portal.setRefundBps(4000); // the curve ran out: 40% comes back
        _fees(0.1 ether);
        vm.expectEmit(true, true, true, true, address(feeRouter));
        emit Buyback(0.015 ether, 0.015 ether * 1000);
        vm.prank(keeper);
        feeRouter.buybackAndBurn(0);
        assertEq(feeRouter.rootstockPot(), 0.01 ether, "refund kept for the next buyback");
        assertEq(address(feeRouter).balance, 0.01 ether);
        assertEq(address(buyback).balance, 0);
    }

    /// BNB pushed to the buyback by anyone joins the pot; a donation larger than the spend must not
    /// brick buybacks (the spent amount is clamped, not underflowed).
    function test_buyback_strayBnbDoesNotBrick() public {
        _wire();
        _fees(1 ether);
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = address(buyback).call{value: 1 ether}("");
        assertTrue(ok);
        uint256 potBefore = feeRouter.rootstockPot();
        uint256 cap = feeRouter.publicBuybackCap();
        vm.prank(alice);
        feeRouter.buybackAndBurn(0);
        assertEq(feeRouter.rootstockPot(), potBefore - cap + 1 ether, "the donation joins the pot");
        assertEq(address(buyback).balance, 0);
    }

    function test_buyback_notTradableReverts() public {
        _wire();
        _fees(0.1 ether);
        portal.setToken(address(token), 3, address(zec)); // Killed
        vm.prank(keeper);
        vm.expectRevert(bytes("not tradable"));
        feeRouter.buybackAndBurn(0);
    }

    // ------------------------------------------------------------ FlapBuyback itself

    function test_buyAndBurn_onlyFeeRouter() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(bytes("only feeRouter"));
        buyback.buyAndBurn{value: 1 ether}(0);
        vm.expectRevert(bytes("only feeRouter"));
        buyback.buyAndBurn{value: 1 ether}(0); // not even its owner
    }

    function test_buyAndBurn_emptyReverts() public {
        vm.prank(address(feeRouter));
        vm.expectRevert(bytes("empty"));
        buyback.buyAndBurn(0);
    }

    function test_constructor_checks() public {
        vm.expectRevert(bytes("zero"));
        new FlapBuyback(address(0), address(zec), address(feeRouter), address(portal), address(dex), address(dex), _path(), address(this));
        MockToken unknown = new MockToken("NOPE");
        vm.expectRevert(bytes("not a flap token"));
        new FlapBuyback(address(unknown), address(zec), address(feeRouter), address(portal), address(dex), address(dex), _path(), address(this));
        MockToken usd = new MockToken("USD");
        vm.expectRevert(bytes("quote token"));
        new FlapBuyback(address(token), address(usd), address(feeRouter), address(portal), address(dex), address(dex), abi.encodePacked(wbnb, uint24(500), address(usd)), address(this));
        assertEq(buyback.wbnb(), wbnb);
        assertEq(buyback.bnbToQuotePath(), _path());
        assertEq(buyback.status(), TRADABLE);
    }

    function test_setBnbToQuotePath_validation() public {
        address mid = makeAddr("usdt");
        vm.expectRevert(bytes("path"));
        buyback.setBnbToQuotePath(abi.encodePacked(wbnb, address(zec))); // no fee
        vm.expectRevert(bytes("path"));
        buyback.setBnbToQuotePath(abi.encodePacked(wbnb, uint24(2500), address(zec), uint8(1))); // odd length
        vm.expectRevert(bytes("path"));
        buyback.setBnbToQuotePath("");
        vm.expectRevert(bytes("path ends"));
        buyback.setBnbToQuotePath(abi.encodePacked(mid, uint24(2500), address(zec))); // not from WBNB
        vm.expectRevert(bytes("path ends"));
        buyback.setBnbToQuotePath(abi.encodePacked(wbnb, uint24(2500), mid)); // not to ZEC

        bytes memory twoHop = abi.encodePacked(wbnb, uint24(500), mid, uint24(100), address(zec));
        vm.expectEmit(true, true, true, true, address(buyback));
        emit BnbToQuotePathSet(twoHop);
        buyback.setBnbToQuotePath(twoHop);
        assertEq(buyback.bnbToQuotePath(), twoHop);

        // the new path is what the DEX route uses
        _wire();
        portal.setToken(address(token), DEX, address(zec));
        _fees(0.1 ether);
        vm.prank(keeper);
        feeRouter.buybackAndBurn(0);
        assertEq(dex.lastPath(), twoHop);
    }

    function test_setBnbToQuotePath_ownerOnly() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        buyback.setBnbToQuotePath(_path());
    }

    function test_ownership_twoStep() public {
        address safe = makeAddr("safe");
        buyback.transferOwnership(safe);
        assertEq(buyback.owner(), address(this), "still the deployer until accepted");
        assertEq(buyback.pendingOwner(), safe);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        buyback.acceptOwnership();
        vm.prank(safe);
        buyback.acceptOwnership();
        assertEq(buyback.owner(), safe);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        buyback.setBnbToQuotePath(_path());
    }

    receive() external payable {}
}
