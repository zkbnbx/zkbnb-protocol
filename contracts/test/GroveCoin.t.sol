// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BaseTest} from "./Base.t.sol";
import {GroveCoin} from "../src/GroveCoin.sol";
import {PayoutMode} from "../src/interfaces/IGrove.sol";

contract GroveCoinTest is BaseTest {
    GroveCoin coin;
    address pair;

    event TaxSwept(uint256 tokens, uint256 bnb);
    event FeeCollected(address indexed coin, uint256 amount, address source);

    function setUp() public override {
        super.setUp();
        coin = GroveCoin(payable(plantCoin(alice, PayoutMode.Creator)));
        buy(bob, address(coin), 1 ether);
    }

    function _graduateCoin() internal {
        pair = graduate(address(coin));
    }

    // ------------------------------------------------------------ metadata

    function test_metadataAndSupply() public view {
        assertEq(coin.name(), "Test Coin");
        assertEq(coin.symbol(), "TEST");
        assertEq(coin.decimals(), 18);
        assertEq(coin.totalSupply(), coin.TOTAL_SUPPLY());
        assertEq(coin.launchpad(), address(launchpad));
        assertEq(address(coin.feeRouter()), address(feeRouter));
        assertEq(address(coin.router()), address(router));
        assertFalse(coin.isRootstock());
        assertTrue(grove.isRootstock());
        assertTrue(coin.isExempt(address(launchpad)));
        assertTrue(coin.isExempt(address(feeRouter)));
        assertTrue(coin.isExempt(address(coin)));
        assertTrue(coin.isExempt(address(roots)));
        assertEq(coin.allowance(address(coin), address(router)), type(uint256).max);
    }

    // ------------------------------------------------------------ pair tax

    function test_noTaxBeforeGraduation() public {
        uint256 amount = 1000e18;
        vm.prank(bob);
        coin.transfer(carol, amount);
        assertEq(coin.balanceOf(carol), amount);
        assertEq(coin.accruedTax(), 0);
    }

    function test_tax_exactly2PercentFromPair() public {
        _graduateCoin();
        uint256 amount = 1000e18;
        uint256 pairBefore = coin.balanceOf(pair);
        vm.prank(pair);
        coin.transfer(carol, amount);
        assertEq(coin.balanceOf(carol), amount - amount * 2 / 100, "receives 98%");
        assertEq(coin.accruedTax(), amount * 2 / 100, "2% kept on the coin");
        assertEq(pairBefore - coin.balanceOf(pair), amount, "pair gives the full amount");
    }

    function test_tax_exactly2PercentToPair() public {
        _graduateCoin();
        uint256 amount = 500e18;
        uint256 pairBefore = coin.balanceOf(pair);
        vm.prank(bob);
        coin.transfer(pair, amount);
        assertEq(coin.balanceOf(pair) - pairBefore, amount - amount * 2 / 100, "pair receives 98%");
        assertEq(coin.accruedTax(), amount * 2 / 100);
    }

    function test_noTax_walletToWallet() public {
        _graduateCoin();
        uint256 amount = 777e18;
        vm.prank(bob);
        coin.transfer(carol, amount);
        assertEq(coin.balanceOf(carol), amount);
        assertEq(coin.accruedTax(), 0);
    }

    function test_noTax_forExemptAddresses() public {
        _graduateCoin();
        uint256 amount = 100e18;
        address[4] memory exempt = [address(launchpad), address(roots), address(feeRouter), address(coin)];
        for (uint256 i = 0; i < exempt.length; i++) {
            uint256 taxBefore = coin.accruedTax();
            uint256 before = coin.balanceOf(exempt[i]);
            vm.prank(pair);
            coin.transfer(exempt[i], amount);
            assertEq(coin.balanceOf(exempt[i]) - before, amount, "pair -> exempt untaxed");
            if (exempt[i] != address(coin)) {
                vm.prank(exempt[i]);
                coin.transfer(pair, amount);
                assertEq(coin.balanceOf(exempt[i]), before, "exempt -> pair untaxed");
                assertEq(coin.accruedTax(), taxBefore, "no tax accrued");
            }
        }
    }

    function test_setExempt_onlyLaunchpad() public {
        vm.prank(bob);
        vm.expectRevert("launchpad");
        coin.setExempt(bob, true);
        vm.prank(address(launchpad));
        coin.setExempt(bob, true);
        assertTrue(coin.isExempt(bob));
    }

    function test_setPair_onlyLaunchpadAndOnce() public {
        vm.prank(bob);
        vm.expectRevert("launchpad");
        coin.setPair(bob);
        _graduateCoin();
        vm.prank(address(launchpad));
        vm.expectRevert("pair set");
        coin.setPair(bob);
    }

    // ------------------------------------------------------------- sweep

    function _accrueTaxViaRouterSell(uint256 amount) internal {
        address[] memory path = new address[](2);
        path[0] = address(coin);
        path[1] = address(wbnb);
        vm.startPrank(whale);
        coin.approve(address(router), amount);
        router.swapExactTokensForETHSupportingFeeOnTransferTokens(amount, 0, path, whale, block.timestamp);
        vm.stopPrank();
    }

    function test_sweepTax_swapsAndFeeRouterCollects() public {
        _graduateCoin();
        _accrueTaxViaRouterSell(2_000_000e18);
        uint256 tax = coin.accruedTax();
        assertEq(tax, 2_000_000e18 * 2 / 100);

        address[] memory path = new address[](2);
        path[0] = address(coin);
        path[1] = address(wbnb);
        uint256 expectedBnb = router.getAmountsOut(tax, path)[1];

        uint256 collectedBefore = feeRouter.collectedOf(address(coin));
        uint256 rootsBefore = roots.balance(address(coin));
        uint256 potBefore = feeRouter.rootstockPot();

        vm.expectEmit(true, true, true, true, address(feeRouter));
        emit FeeCollected(address(coin), expectedBnb, address(coin));
        vm.expectEmit(true, true, true, true, address(coin));
        emit TaxSwept(tax, expectedBnb);
        vm.prank(carol); // anyone
        uint256 bnb = coin.sweepTax(0);

        assertEq(bnb, expectedBnb);
        assertEq(coin.accruedTax(), 0);
        assertEq(address(coin).balance, 0, "coin keeps no BNB");
        assertEq(feeRouter.collectedOf(address(coin)) - collectedBefore, bnb, "FeeRouter collected the BNB");
        assertEq(roots.balance(address(coin)) - rootsBefore, bnb * 2500 / BPS, "split applied");
        assertEq(feeRouter.rootstockPot() - potBefore, bnb * 2500 / BPS);
    }

    function test_sweepTax_slippage() public {
        _graduateCoin();
        _accrueTaxViaRouterSell(1_000_000e18);
        vm.expectRevert("PancakeRouter: INSUFFICIENT_OUTPUT_AMOUNT");
        coin.sweepTax(1000 ether);
    }

    function test_sweepTax_revertsWithNothing() public {
        _graduateCoin();
        vm.expectRevert("nothing");
        coin.sweepTax(0);
    }

    function test_sweepTax_revertsBeforeGraduation() public {
        // tokens can be pushed onto the coin before graduation, but they cannot be swept yet
        vm.prank(bob);
        coin.transfer(address(coin), 1000e18);
        assertEq(coin.accruedTax(), 1000e18);
        vm.expectRevert("not graduated");
        coin.sweepTax(0);
    }

    function test_burn() public {
        uint256 bal = coin.balanceOf(bob);
        vm.prank(bob);
        coin.burn(bal / 2);
        assertEq(coin.totalSupply(), coin.TOTAL_SUPPLY() - bal / 2);
    }
}
