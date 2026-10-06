// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BaseTest} from "./Base.t.sol";
import {Launchpad} from "../src/Launchpad.sol";
import {GroveCoin} from "../src/GroveCoin.sol";
import {PayoutMode} from "../src/interfaces/IGrove.sol";
import {MockPancakePair} from "./mocks/MockPancakePair.sol";

contract LaunchpadTest is BaseTest {
    address coin;

    event Graduated(address indexed coin, address pair, uint256 bnb, uint256 tokens);

    function setUp() public override {
        super.setUp();
        coin = plantCoin(alice, PayoutMode.Creator);
    }

    // ------------------------------------------------------------- planting

    function test_plant_chargesPlantFeeToTreasury() public {
        uint256 before = treasury.balance;
        uint256 fee = launchpad.plantFee();
        address c = plantCoin(bob, PayoutMode.Creator);
        assertEq(treasury.balance - before, fee, "plant fee");
        assertTrue(launchpad.isCoin(c));
        (address creator,,,,,,,, address pair, PayoutMode mode,) = launchpad.info(c);
        assertEq(creator, bob);
        assertEq(pair, address(0));
        assertEq(uint8(mode), uint8(PayoutMode.Creator));
        assertEq(IERC20(c).balanceOf(address(launchpad)), launchpad.TOTAL_SUPPLY());
    }

    function test_plant_revertsBelowPlantFee() public {
        uint256 fee = launchpad.plantFee();
        vm.prank(bob);
        vm.expectRevert(Launchpad.BadParams.selector);
        launchpad.plant{value: fee - 1}(_params("A", "A", PayoutMode.Creator, address(0), 0));
    }

    function test_plant_walletModeNeedsWallet() public {
        uint256 fee = launchpad.plantFee();
        vm.prank(bob);
        vm.expectRevert(Launchpad.BadParams.selector);
        launchpad.plant{value: fee}(_params("A", "A", PayoutMode.Wallet, address(0), 0));
    }

    function test_plant_withFirstBuy() public {
        uint256 firstBuy = 0.5 ether;
        address c = plantCoin(bob, PayoutMode.Creator, address(0), 0, firstBuy);
        (,,,uint256 realBnb, uint256 sold, uint256 buys,,,,,) = launchpad.info(c);
        assertEq(buys, 1);
        assertEq(realBnb, firstBuy - firstBuy * FEE_BPS / BPS);
        assertEq(IERC20(c).balanceOf(bob), sold);
        assertGt(sold, 0);
    }

    // -------------------------------------------------------------- trading

    function test_firstBuy_works() public {
        uint256 bnbIn = 1 ether;
        (uint256 quoted, uint256 used, uint256 fee) = launchpad.quoteBuy(coin, bnbIn);
        assertEq(used, bnbIn);
        assertEq(fee, bnbIn * FEE_BPS / BPS);
        uint256 out = buy(bob, coin, bnbIn);
        assertEq(out, quoted);
        assertEq(IERC20(coin).balanceOf(bob), out);
        (,,, uint256 realBnb, uint256 sold, uint256 buys,,,,,) = launchpad.info(coin);
        assertEq(realBnb, bnbIn - fee);
        assertEq(sold, out);
        assertEq(buys, 1);
        assertEq(address(launchpad).balance, bnbIn - fee, "launchpad holds the real BNB");
    }

    function test_buy_revertsOnZeroValue() public {
        vm.prank(bob);
        vm.expectRevert(Launchpad.ZeroAmount.selector);
        launchpad.buy{value: 0}(coin, 0);
    }

    function test_buy_revertsOnUnknownCoin() public {
        vm.prank(bob);
        vm.expectRevert(Launchpad.NotCoin.selector);
        launchpad.buy{value: 1 ether}(address(0x1234), 0);
    }

    function test_buy_slippage() public {
        (uint256 quoted,,) = launchpad.quoteBuy(coin, 1 ether);
        vm.prank(bob);
        vm.expectRevert(Launchpad.Slippage.selector);
        launchpad.buy{value: 1 ether}(coin, quoted + 1);
    }

    function test_quotes_matchExecutedTrades() public {
        buy(carol, coin, 2 ether); // move off the origin
        uint256 bnbIn = 0.731 ether;
        (uint256 qOut, uint256 qUsed, uint256 qFee) = launchpad.quoteBuy(coin, bnbIn);
        uint256 balBefore = bob.balance;
        uint256 out = buy(bob, coin, bnbIn);
        assertEq(out, qOut, "buy quote");
        assertEq(balBefore - bob.balance, qUsed, "bnb used");
        assertEq(feeRouter.collectedOf(coin) > 0, true);

        uint256 tokensIn = out / 3;
        (uint256 qNet, uint256 qGross, uint256 qSellFee) = launchpad.quoteSell(coin, tokensIn);
        assertEq(qSellFee, qGross * FEE_BPS / BPS);
        uint256 collectedBefore = feeRouter.collectedOf(coin);
        uint256 got = sell(bob, coin, tokensIn);
        assertEq(got, qNet, "sell quote");
        assertEq(feeRouter.collectedOf(coin) - collectedBefore, qSellFee, "sell fee collected");
        qFee; // buy fee is asserted via collectedOf in test_firstBuy_works
    }

    function test_roundTrip_losesExactlyTheFees() public {
        buy(carol, coin, 3 ether); // some prior state so the curve is not at origin
        uint256 bnbIn = 1 ether;
        uint256 start = bob.balance;
        uint256 collected0 = feeRouter.collectedOf(coin);

        uint256 out = buy(bob, coin, bnbIn);
        uint256 buyFee = bnbIn * FEE_BPS / BPS;
        (, uint256 gross, uint256 sellFee) = launchpad.quoteSell(coin, out);
        sell(bob, coin, out);

        uint256 lost = start - bob.balance;
        uint256 fees = feeRouter.collectedOf(coin) - collected0;
        assertEq(fees, buyFee + sellFee, "fees collected");
        // gross out can be at most the net paid in (integer rounding may shave a few wei)
        uint256 netIn = bnbIn - buyFee;
        assertLe(gross, netIn);
        assertLe(netIn - gross, 10, "rounding dust");
        assertEq(lost, fees + (netIn - gross), "round trip loses exactly the fees (+ rounding dust)");
        assertEq(IERC20(coin).balanceOf(bob), 0);
    }

    function test_sell_revertsOnZero() public {
        vm.prank(bob);
        vm.expectRevert(Launchpad.ZeroAmount.selector);
        launchpad.sell(coin, 0, 0);
    }

    function test_sell_slippage() public {
        uint256 out = buy(bob, coin, 1 ether);
        (uint256 net,,) = launchpad.quoteSell(coin, out);
        vm.startPrank(bob);
        IERC20(coin).approve(address(launchpad), out);
        vm.expectRevert(Launchpad.Slippage.selector);
        launchpad.sell(coin, out, net + 1);
        vm.stopPrank();
    }

    // ------------------------------------------------------------ the curve

    /// @dev Documents the exact numbers of the curve.
    function test_curveNumbers() public {
        uint256 net = launchpad.remainingCost(coin);
        uint256 gross = grossToClear(coin);
        console2.log("BNB (net of fee) to clear the curve:", net);
        console2.log("BNB (gross, fee included) to clear the curve:", gross);
        console2.log("start price (wei per token):", launchpad.price(coin));
        // exact: 4e18 * 793.1e6 / 279.9e6, ceil
        uint256 vTokLeft = 279_900_000e18;
        uint256 expectedNet = (uint256(4 ether) * 793_100_000e18 + vTokLeft - 1) / vTokLeft;
        assertEq(net, expectedNet);
        assertEq(net, 11334047874240800286);
        assertEq(gross, 11565354973715102333);
        assertApproxEqRel(net, 11.33 ether, 0.001e18); // within 0.1% of 11.33 BNB

        graduate(coin);
        MockPancakePair pair = pairOf(coin);
        (uint112 r0, uint112 r1,) = pair.getReserves();
        (uint256 rTok, uint256 rBnb) = pair.token0() == coin ? (r0, r1) : (r1, r0);
        console2.log("end price on the curve (wei per token):", (uint256(4 ether) + net) * 1e18 / vTokLeft);
        console2.log("pool price (wei per token):", rBnb * 1e18 / rTok);
        console2.log("pool BNB:", rBnb);
        assertEq(rTok, launchpad.LP_TOKENS());
        assertGe(rBnb, net);
    }

    function test_buy_refundsExcessAndSellsOutExactly() public {
        buy(carol, coin, 1 ether);
        uint256 gross = grossToClear(coin);
        uint256 excess = 5 ether;
        uint256 before = whale.balance;
        uint256 out = buy(whale, coin, gross + excess);
        assertEq(before - whale.balance, gross, "only the gross cost is taken, excess refunded");
        (,,, uint256 realBnb, uint256 sold,,,,,,) = launchpad.info(coin);
        assertEq(sold, launchpad.CURVE_TOKENS(), "sold out at exactly CURVE_TOKENS");
        assertEq(realBnb, 0, "realBnb zeroed after graduation");
        assertEq(IERC20(coin).balanceOf(whale), out);
        assertTrue(launchpad.isGraduated(coin));
    }

    function test_quoteBuy_capsAtRemainingCurve() public view {
        (uint256 out, uint256 used, uint256 fee) = launchpad.quoteBuy(coin, 100 ether);
        assertEq(out, launchpad.CURVE_TOKENS());
        assertEq(used, grossToClear(coin));
        assertEq(fee, used * FEE_BPS / BPS);
    }

    function test_price_isMonotonicInSoldTokens() public {
        uint256 last = launchpad.price(coin);
        for (uint256 i = 0; i < 20; i++) {
            buy(bob, coin, 0.4 ether);
            uint256 p = launchpad.price(coin);
            assertGt(p, last, "price rises with every buy");
            last = p;
        }
        uint256 bal = IERC20(coin).balanceOf(bob);
        sell(bob, coin, bal / 2);
        assertLt(launchpad.price(coin), last, "price falls on sell");
    }

    function testFuzz_price_monotonic(uint96 a, uint96 b) public {
        a = uint96(bound(a, 0.001 ether, 5 ether));
        b = uint96(bound(b, 0.001 ether, 5 ether));
        uint256 p0 = launchpad.price(coin);
        buy(bob, coin, a);
        uint256 p1 = launchpad.price(coin);
        buy(bob, coin, b);
        uint256 p2 = launchpad.price(coin);
        assertGe(p1, p0);
        assertGe(p2, p1);
    }

    // ------------------------------------------------------------- stages

    function test_stage_transitions() public {
        assertEq(launchpad.stage(coin), 0, "Seed");
        for (uint256 i = 0; i < 9; i++) buy(bob, coin, 0.01 ether);
        assertEq(launchpad.stage(coin), 0, "still Seed at 9 buys");
        buy(bob, coin, 0.01 ether);
        assertEq(launchpad.stage(coin), 1, "Sapling at 10 buys");
        graduate(coin);
        assertEq(launchpad.stage(coin), 2, "Orchard");
    }

    function test_curveProgress() public {
        assertEq(launchpad.curveProgress(coin), 0);
        graduate(coin);
        assertEq(launchpad.curveProgress(coin), BPS);
    }

    // ---------------------------------------------------------- graduation

    function test_graduation_createsPairAddsLiquidityBurnsLp() public {
        buy(carol, coin, 2 ether);
        uint256 gross = grossToClear(coin);
        (, uint256 used, uint256 fee) = launchpad.quoteBuy(coin, gross);
        (,,, uint256 realBefore,,,,,,,) = launchpad.info(coin);
        uint256 bnbAtGraduation = realBefore + used - fee;
        address expectedPair = vm.computeCreateAddress(address(factory), vm.getNonce(address(factory)));

        vm.expectEmit(true, true, true, true, address(launchpad));
        emit Graduated(coin, expectedPair, bnbAtGraduation, launchpad.LP_TOKENS());
        buy(whale, coin, gross);

        address pair = launchpad.pairOf(coin);
        assertEq(pair, expectedPair);
        assertEq(factory.getPair(coin, address(wbnb)), pair, "pair registered in factory");
        assertEq(GroveCoin(payable(coin)).pair(), pair, "pair set on the coin");
        assertEq(IERC20(coin).balanceOf(pair), launchpad.LP_TOKENS(), "LP_TOKENS in the pair");
        assertEq(wbnb.balanceOf(pair), bnbAtGraduation, "all real BNB in the pair");
        assertEq(address(launchpad).balance, 0, "launchpad holds no BNB after graduation");
        assertGt(MockPancakePair(pair).balanceOf(launchpad.DEAD()), 0, "LP tokens sent to 0xdead");
        assertEq(MockPancakePair(pair).balanceOf(address(launchpad)), 0);
        assertEq(IERC20(coin).balanceOf(address(launchpad)), 0, "dust burned / nothing left on the launchpad");
        assertEq(
            IERC20(coin).totalSupply(),
            launchpad.CURVE_TOKENS() + launchpad.LP_TOKENS(),
            "supply = sold on curve + LP"
        );
        (,, uint64 graduatedAt,,,,,,,,) = launchpad.info(coin);
        assertEq(graduatedAt, block.timestamp);
    }

    function test_graduation_tradesRevertAfterwards() public {
        uint256 bal = IERC20(coin).balanceOf(whale);
        graduate(coin);
        bal = IERC20(coin).balanceOf(whale);
        vm.startPrank(whale);
        vm.expectRevert(Launchpad.Graduated_.selector);
        launchpad.buy{value: 1 ether}(coin, 0);
        IERC20(coin).approve(address(launchpad), bal);
        vm.expectRevert(Launchpad.Graduated_.selector);
        launchpad.sell(coin, bal, 0);
        vm.stopPrank();
    }

    function test_graduation_quotesAfterStillViewable() public {
        graduate(coin);
        assertEq(launchpad.remainingCost(coin), 0);
    }

    function test_graduatedCoin_tradesOnPancakeWithTax() public {
        address pair = graduate(coin);
        // sell through the router: 2% of the tokens stay on the coin as tax
        uint256 amount = 1_000_000e18;
        address[] memory path = new address[](2);
        path[0] = coin;
        path[1] = address(wbnb);
        vm.startPrank(whale);
        IERC20(coin).approve(address(router), amount);
        uint256 bnbBefore = whale.balance;
        router.swapExactTokensForETHSupportingFeeOnTransferTokens(amount, 0, path, whale, block.timestamp);
        vm.stopPrank();
        assertEq(GroveCoin(payable(coin)).accruedTax(), amount * FEE_BPS / BPS);
        assertGt(whale.balance, bnbBefore);
        assertGt(IERC20(coin).balanceOf(pair), launchpad.LP_TOKENS());
    }

    // ---------------------------------------------------------------- admin

    function test_setPlantFee_ownerOnly() public {
        vm.prank(bob);
        vm.expectRevert();
        launchpad.setPlantFee(1);
        launchpad.setPlantFee(0.01 ether);
        assertEq(launchpad.plantFee(), 0.01 ether);
    }

    function test_coinsList() public view {
        assertEq(launchpad.coinCount(), 2); // GROVE + coin
        assertEq(launchpad.allCoins()[1], coin);
    }
}
