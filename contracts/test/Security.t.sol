// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BaseTest} from "./Base.t.sol";
import {Launchpad} from "../src/Launchpad.sol";
import {GroveCoin} from "../src/GroveCoin.sol";
import {FeeRouter} from "../src/FeeRouter.sol";
import {Roots} from "../src/Roots.sol";
import {DonationRotator} from "../src/DonationRotator.sol";
import {ShieldedPool} from "../src/ShieldedPool.sol";
import {PayoutMode} from "../src/interfaces/IGrove.sol";
import {MockPancakePair} from "./mocks/MockPancakePair.sol";

/// @dev A payee that refuses BNB.
contract Rejecter {
    receive() external payable {
        revert("no thanks");
    }
}

/// @dev A shielded pool that cannot take notes (stands in for a full tree / broken pool).
contract RevertingPool {
    function depositFor(uint256, uint256) external payable returns (uint256) {
        revert("tree full");
    }
}

/// Regression tests for the pre-launch security review (contracts/SECURITY-REVIEW.md).
contract SecurityTest is BaseTest {
    address attacker = makeAddr("attacker");

    event CommitmentDropped(uint256 indexed commitment);
    event PayoutDeferred(uint256 indexed causeId, address indexed to, uint256 amount, bool poolFailed);

    function setUp() public override {
        super.setUp();
        vm.deal(attacker, 1000 ether);
    }

    // ------------------------------------------------------------------ helpers

    function _endPrice(uint256 bnbRaised) internal view returns (uint256) {
        return (launchpad.VIRTUAL_BNB() + bnbRaised) * 1e18 / (launchpad.VIRTUAL_TOKENS() - launchpad.CURVE_TOKENS());
    }

    function _reserves(address coin, address pair) internal view returns (uint256 rTok, uint256 rBnb) {
        (uint112 r0, uint112 r1,) = MockPancakePair(pair).getReserves();
        (rTok, rBnb) = MockPancakePair(pair).token0() == coin ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
    }

    /// Attacker pre-creates the pair and seeds it with `tokens` + `bnbWei`, either synced only or
    /// with LP minted to the attacker. Returns the pair.
    function _seedPair(address coin, uint256 tokens, uint256 bnbWei, bool mintLp) internal returns (address pair) {
        pair = factory.createPair(coin, address(wbnb));
        vm.startPrank(attacker);
        if (tokens > 0) IERC20(coin).transfer(pair, tokens);
        if (bnbWei > 0) {
            wbnb.deposit{value: bnbWei}();
            wbnb.transfer(pair, bnbWei);
        }
        if (mintLp) MockPancakePair(pair).mint(attacker);
        else MockPancakePair(pair).sync();
        vm.stopPrank();
    }

    /// Clears the curve and checks the graduation invariants: it happened, all raised BNB (at least)
    /// is in the pool, and even if the pool opened above the curve's end price (someone donated BNB)
    /// and holders sell it back down to that price, at least the raised BNB stays in the pool.
    function _graduateAndCheck(address coin, address expectedPair) internal returns (uint256 bnbRaised) {
        uint256 gross = grossToClear(coin);
        (, uint256 used, uint256 fee) = launchpad.quoteBuy(coin, gross);
        (,,, uint256 realBefore,,,,,,,) = launchpad.info(coin);
        bnbRaised = realBefore + used - fee;

        buy(whale, coin, gross);

        address pair = launchpad.pairOf(coin);
        assertTrue(pair != address(0), "graduated");
        if (expectedPair != address(0)) assertEq(pair, expectedPair, "the pre-created pair is used");
        assertEq(GroveCoin(payable(coin)).pair(), pair);
        assertEq(IERC20(coin).balanceOf(address(launchpad)), 0, "launchpad keeps no tokens");
        (uint256 rTok, uint256 rBnb) = _reserves(coin, pair);
        assertGe(rBnb, bnbRaised, "all raised BNB is in the pool");
        uint256 bnbAtEndPrice = Math.sqrt(rTok * rBnb / 1e18 * _endPrice(bnbRaised)); // k conserved
        assertGe(bnbAtEndPrice + 1, bnbRaised * 999 / 1000, "raised BNB stays once arbed to the end price");
        assertGt(MockPancakePair(pair).balanceOf(launchpad.DEAD()), 0, "LP burned");
    }

    // ================================================================ Launchpad

    /// Before the fix: addLiquidityETH(min = LP_TOKENS, min = bnb) against a synced pair reverted
    /// forever (INSUFFICIENT_*_AMOUNT) -> the coin could never graduate (1 wei of WBNB was enough).
    function test_graduation_survivesPreSeededPair_syncOnly() public {
        address coin = plantCoin(alice, PayoutMode.Creator);
        buy(attacker, coin, 0.05 ether);
        address pair = _seedPair(coin, 1_000_000e18, 1, false); // 1M tokens : 1 wei, synced, no LP
        uint256 raised = _graduateAndCheck(coin, pair);
        (uint256 rTok, uint256 rBnb) = _reserves(coin, pair);
        assertEq(rBnb, raised + 1, "the donated wei is absorbed");
        assertEq(rTok, launchpad.LP_TOKENS() + 1_000_000e18, "donated tokens are absorbed by the pool");
    }

    function test_graduation_survivesPreSeededPair_oneSidedTokensOnly() public {
        address coin = plantCoin(alice, PayoutMode.Creator);
        buy(attacker, coin, 0.05 ether);
        address pair = _seedPair(coin, 5_000_000e18, 0, false);
        _graduateAndCheck(coin, pair);
    }

    function test_graduation_survivesPreSeededPair_oneSidedBnbOnly() public {
        address coin = plantCoin(alice, PayoutMode.Creator);
        address pair = _seedPair(coin, 0, 0.5 ether, false);
        uint256 raised = _graduateAndCheck(coin, pair);
        (, uint256 rBnb) = _reserves(coin, pair);
        assertEq(rBnb, raised + 0.5 ether, "donated BNB belongs to the pool");
    }

    function test_graduation_emptyPreCreatedPair() public {
        address coin = plantCoin(alice, PayoutMode.Creator);
        address pair = factory.createPair(coin, address(wbnb));
        _graduateAndCheck(coin, pair);
    }

    /// Token-heavy LP seeded by the attacker (20M tokens bought for ~0.08 BNB + 1 wei). With loose
    /// router mins his LP would have been worth ~1 BNB of the raised BNB; with strict mins graduation
    /// reverted. Now the launchpad buys his tokens for dust first, and his LP share is ~nothing.
    function test_graduation_preSeededLp_tokenHeavy_attackerGainsNothing() public {
        address coin = plantCoin(alice, PayoutMode.Creator);
        uint256 got = buy(attacker, coin, 0.1 ether);
        assertGt(got, 20_000_000e18);
        address pair = _seedPair(coin, 20_000_000e18, 1, true);
        uint256 lp = MockPancakePair(pair).balanceOf(attacker);
        assertGt(lp, 0);

        uint256 raised = _graduateAndCheck(coin, pair);

        MockPancakePair p = MockPancakePair(pair);
        uint256 share = lp * 1e18 / p.totalSupply(); // attacker's fraction of the pool, 1e18 = 100%
        assertLt(share, 1e12, "attacker owns < 0.0001% of the pool");
        (, uint256 rBnb) = _reserves(coin, pair);
        assertLt(share * rBnb / 1e18, 1e13, "attacker's redeemable BNB is dust (< 0.00001 BNB)");
        assertGe(rBnb, raised, "no raised BNB left the pool");
    }

    /// BNB-heavy LP (1e12 token-wei + 2 BNB): tokens are overpriced there, so the launchpad sells a
    /// few tokens into it and captures the mispricing for the pool.
    function test_graduation_preSeededLp_bnbHeavy_mispricingCapturedByPool() public {
        address coin = plantCoin(alice, PayoutMode.Creator);
        buy(attacker, coin, 0.01 ether);
        address pair = _seedPair(coin, 1e12, 2 ether, true);
        uint256 lp = MockPancakePair(pair).balanceOf(attacker);

        uint256 raised = _graduateAndCheck(coin, pair);

        (, uint256 rBnb) = _reserves(coin, pair);
        assertGt(rBnb, raised + 1.9 ether, "the attacker's BNB ended up in the pool");
        uint256 share = lp * 1e18 / MockPancakePair(pair).totalSupply();
        assertLt(share, 1e12);
    }

    /// Fuzz: whatever ratio the attacker seeds (with LP), graduation goes through, the pool holds
    /// at least the raised BNB, and the attacker's LP is worth less than what he put in.
    function testFuzz_graduation_preSeededLp(uint96 tokenSeed, uint96 bnbSeed) public {
        address coin = plantCoin(alice, PayoutMode.Creator);
        uint256 bought = buy(attacker, coin, 0.5 ether); // ~120M tokens, cost 0.5 BNB
        uint256 tokens = bound(tokenSeed, 1e9, bought);
        uint256 bnbWei = bound(bnbSeed, 1e9, 5 ether);
        address pair = _seedPair(coin, tokens, bnbWei, true);
        uint256 lp = MockPancakePair(pair).balanceOf(attacker);

        uint256 raised = _graduateAndCheck(coin, pair);

        (uint256 rTok, uint256 rBnb) = _reserves(coin, pair);
        uint256 total = MockPancakePair(pair).totalSupply();
        // value of the attacker's LP at the (fair) pool price, in BNB, vs what he deposited at that price
        uint256 price = rBnb * 1e18 / rTok;
        uint256 lpValue = (lp * rBnb / total) + (lp * rTok / total) * price / 1e18;
        uint256 deposited = bnbWei + tokens * price / 1e18;
        assertLe(lpValue, deposited * 1005 / 1000 + 1, "LP worth at most what was deposited (+ swap fee dust)");
        assertGe(rBnb, raised);
    }

    // ================================================================ GroveCoin.sweepTax

    function _accrueTax(GroveCoin coin, uint256 amount) internal {
        address[] memory path = new address[](2);
        path[0] = address(coin);
        path[1] = address(wbnb);
        vm.startPrank(whale);
        coin.approve(address(router), amount);
        router.swapExactTokensForETHSupportingFeeOnTransferTokens(amount, 0, path, whale, block.timestamp);
        vm.stopPrank();
    }

    function test_sweepTax_publicCallerIsCappedAndRateLimited_keeperIsNot() public {
        GroveCoin coin = GroveCoin(payable(plantCoin(alice, PayoutMode.Creator)));
        address pair = graduate(address(coin));
        _accrueTax(coin, 300_000_000e18); // 6M tokens of tax, pair now holds ~500M
        uint256 tax = coin.accruedTax();
        uint256 cap = coin.balanceOf(pair) * coin.PUBLIC_SWEEP_BPS() / BPS;
        assertGt(tax, cap, "tax pile is above the public cap");

        vm.prank(carol);
        coin.sweepTax(0);
        assertEq(coin.accruedTax(), tax - cap, "public sweep limited to 1% of the pair");

        vm.prank(carol);
        vm.expectRevert("one per block");
        coin.sweepTax(0);

        vm.roll(block.number + 1);
        vm.prank(carol);
        coin.sweepTax(0);
        assertLt(coin.accruedTax(), tax - cap);

    }

    function test_sweepTax_keeperSweepsAboveTheCap() public {
        GroveCoin coin = GroveCoin(payable(plantCoin(alice, PayoutMode.Creator)));
        address pair = graduate(address(coin));
        _accrueTax(coin, 300_000_000e18);
        assertGt(coin.accruedTax(), coin.balanceOf(pair) * coin.PUBLIC_SWEEP_BPS() / BPS);
        vm.prank(keeper);
        coin.sweepTax(0);
        assertEq(coin.accruedTax(), 0, "keeper sweeps the whole pile");
    }

    // ================================================================ FeeRouter

    function test_buybackAndBurn_publicCallerIsCappedAndRateLimited_keeperIsNot() public {
        address coin = plantCoin(alice, PayoutMode.Creator);
        buy(bob, coin, 11 ether); // fee 0.22 -> rootstock pot 0.055
        uint256 pot = feeRouter.rootstockPot();
        uint256 cap = feeRouter.publicBuybackCap();
        assertGt(pot, cap);

        vm.prank(carol);
        feeRouter.buybackAndBurn(0);
        assertEq(feeRouter.rootstockPot(), pot - cap, "public buyback spends at most the cap");

        vm.prank(carol);
        vm.expectRevert("one per block");
        feeRouter.buybackAndBurn(0);

        vm.prank(keeper);
        feeRouter.buybackAndBurn(0);
        assertEq(feeRouter.rootstockPot(), 0, "keeper spends the rest");
        assertEq(address(feeRouter).balance, feeRouter.totalPending());
    }

    /// A push that fails *during* a buyback (rootstock fee -> reverting treasury) used to be counted
    /// as curve refund and added to rootstockPot as well: the same BNB booked twice.
    function test_buybackAndBurn_failedPushDuringBuybackIsNotDoubleCounted() public {
        Rejecter r = new Rejecter();
        address coin = plantCoin(alice, PayoutMode.Creator);
        feeRouter.setTreasury(address(r));
        buy(bob, coin, 1 ether); // treasury share 0.002 -> pending; rootstock pot 0.005
        assertEq(feeRouter.pending(address(r)), 0.002 ether);
        assertEq(feeRouter.totalPending(), 0.002 ether);
        uint256 pot = feeRouter.rootstockPot();

        vm.prank(keeper);
        feeRouter.buybackAndBurn(0); // buys GROVE on the curve: its 2% fee -> treasury -> fails -> pending
        uint256 groveFee = pot * FEE_BPS / BPS;
        assertEq(feeRouter.pending(address(r)), 0.002 ether + groveFee);
        assertEq(feeRouter.rootstockPot(), 0, "the failed push is not booked as a curve refund");
        assertEq(address(feeRouter).balance, feeRouter.totalPending() + feeRouter.rootstockPot(), "balance == pot + owed");
    }

    function test_setModules_isOneShot() public {
        vm.expectRevert(bytes("set"));
        feeRouter.setModules(address(launchpad), address(roots), address(holderRewards), address(rotator));
        FeeRouter fr = new FeeRouter(treasury, recovery, address(router), owner);
        vm.expectRevert(bytes("zero"));
        fr.setModules(address(launchpad), address(0), address(holderRewards), address(rotator));
    }

    function test_setKeeper_ownerOnly() public {
        vm.prank(bob);
        vm.expectRevert();
        feeRouter.setKeeper(bob);
        feeRouter.setKeeper(bob);
        assertEq(feeRouter.keeper(), bob);
    }

    // ================================================================ Roots

    function test_roots_setHolderRewards_isOneShot() public {
        vm.expectRevert(bytes("set"));
        roots.setHolderRewards(bob);
        Roots r = new Roots(address(feeRouter), address(pool), owner);
        vm.expectRevert(bytes("set"));
        r.setHolderRewards(address(0));
        r.setHolderRewards(address(holderRewards));
        assertEq(address(r.holderRewards()), address(holderRewards));
    }

    // ================================================================ DonationRotator

    function test_settle_revertingFallbackWalletDoesNotBlockTheRing() public {
        Rejecter bad = new Rejecter();
        uint256 badCause = rotator.registerCause{value: rotator.registerFee()}("bad", "", 0, 0, address(bad));
        uint256 goodCause = rotator.registerCause{value: rotator.registerFee()}("good", "", 0, 0, carol);
        uint256[] memory ids = new uint256[](2);
        ids[0] = badCause;
        ids[1] = goodCause;
        uint256 ring = rotator.createRing("r", ids, 1 hours);
        rotator.donate{value: 1 ether}(ring);
        vm.warp(block.timestamp + 1 hours);

        vm.expectEmit(true, true, true, true, address(rotator));
        emit PayoutDeferred(badCause, address(bad), 1 ether, false);
        (uint256 paid,) = rotator.settle(ring);
        assertEq(paid, badCause);
        assertEq(rotator.pending(address(bad)), 1 ether, "owed to the reverting wallet");
        assertEq(rotator.pot(ring), 0);

        // the ring keeps rotating
        rotator.donate{value: 0.5 ether}(ring);
        vm.warp(block.timestamp + 1 hours);
        uint256 before = carol.balance;
        (paid,) = rotator.settle(ring);
        assertEq(paid, goodCause);
        assertEq(carol.balance - before, 0.5 ether);

        vm.prank(address(bad));
        vm.expectRevert(bytes("send"));
        rotator.withdrawPending();
        vm.prank(carol);
        vm.expectRevert(bytes("nothing"));
        rotator.withdrawPending();
    }

    function test_settle_poolFailureFallsBackToWalletOrOwner() public {
        RevertingPool deadPool = new RevertingPool();
        DonationRotator rot = new DonationRotator(address(deadPool), treasury, owner);
        uint256 fee = rot.registerFee();
        vm.prank(carol);
        uint256 withWallet = rot.registerCause{value: fee}("a", "", 1234, 0, bob);
        vm.prank(carol);
        uint256 keyOnly = rot.registerCause{value: fee}("b", "", 5678, 0, address(0));
        uint256[] memory ids = new uint256[](2);
        ids[0] = withWallet;
        ids[1] = keyOnly;
        uint256 ring = rot.createRing("r", ids, 1 hours);

        rot.donate{value: 1 ether}(ring);
        vm.warp(block.timestamp + 1 hours);
        uint256 bobBefore = bob.balance;
        rot.settle(ring);
        assertEq(bob.balance - bobBefore, 1 ether, "pool failed -> fallback wallet paid publicly");

        rot.donate{value: 0.3 ether}(ring);
        vm.warp(block.timestamp + 1 hours);
        uint256 carolBefore = carol.balance;
        rot.settle(ring);
        assertEq(carol.balance - carolBefore, 0.3 ether, "pool failed, no wallet -> cause owner paid");
    }

    function test_createRing_rejectsAbsurdEpoch() public {
        uint256 id = rotator.registerCause{value: rotator.registerFee()}("c", "", 1, 0, address(0));
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        uint256 maxEpoch = rotator.MAX_EPOCH();
        vm.expectRevert(DonationRotator.BadRing.selector);
        rotator.createRing("r", ids, type(uint256).max);
        vm.expectRevert(DonationRotator.BadRing.selector);
        rotator.createRing("r", ids, maxEpoch + 1);
        rotator.createRing("r", ids, maxEpoch);
    }

    // ================================================================ ShieldedPool

    function test_depositFor_rejectsZeroPubKey() public {
        vm.expectRevert("field");
        pool.depositFor{value: 1 ether}(0, 1);
    }

    function _withdrawProof(uint256 amount, uint256 fee, address relayer, uint256 n0)
        internal
        view
        returns (ShieldedPool.Proof memory p, ShieldedPool.ExtData memory e)
    {
        e = ShieldedPool.ExtData({
            recipient: bob,
            extAmount: -int256(amount),
            relayer: relayer,
            fee: fee,
            encryptedOutput1: hex"01",
            encryptedOutput2: hex"02"
        });
        p.root = pool.getLastRoot();
        p.publicAmount = pool.calculatePublicAmount(e.extAmount, e.fee);
        p.extDataHash = pool.hashExtData(e);
        p.inputNullifiers = [n0, n0 + 1];
        p.outputCommitments = [uint256(777), uint256(888)];
    }

    function test_transact_feeNeedsRelayer() public {
        pool.depositFor{value: 1 ether}(1234, 1);
        (ShieldedPool.Proof memory p, ShieldedPool.ExtData memory e) = _withdrawProof(0.5 ether, 0.01 ether, address(0), 11);
        vm.expectRevert(ShieldedPool.BadValue.selector);
        pool.transact(p, e); // MockVerifier accepts everything; the relayer check is what rejects
    }

    function test_setMaxDeposit_onlyKnob_withdrawLimitsAreConstants() public {
        assertEq(pool.maxExtAmount(), 2 ** 248);
        assertEq(pool.maxFee(), 2 ** 248);
        vm.prank(bob);
        vm.expectRevert();
        pool.setMaxDeposit(1);
        pool.setMaxDeposit(1 ether);
        assertEq(pool.maxDeposit(), 1 ether);
    }

    /// A full tree must not lock the pool: withdrawals still go through, output notes are dropped
    /// (CommitmentDropped) instead of inserted.
    function test_transact_whenTreeIsFull_withdrawsAndDropsOutputs() public {
        pool.depositFor{value: 1 ether}(1234, 1);
        // slot 3 of MerkleTreeWithHistory packs currentRootIndex (uint32) | nextIndex (uint32) << 32
        bytes32 slot = bytes32(uint256(3));
        uint256 packed = uint256(vm.load(address(pool), slot));
        assertEq(uint32(packed), pool.currentRootIndex(), "slot layout: currentRootIndex");
        assertEq(uint32(packed >> 32), pool.nextIndex(), "slot layout: nextIndex");
        uint32 full = uint32(2 ** 20);
        vm.store(address(pool), slot, bytes32((packed & ~(uint256(type(uint32).max) << 32)) | (uint256(full - 1) << 32)));
        assertEq(pool.nextIndex(), full - 1, "one slot left: not enough for a 2-output transact");
        pool.depositFor{value: 1}(1234, 2); // the last single slot is still usable by depositFor
        assertEq(pool.nextIndex(), full);

        (ShieldedPool.Proof memory p, ShieldedPool.ExtData memory e) = _withdrawProof(0.5 ether, 0, address(0), 21);
        uint256 before = bob.balance;
        vm.expectEmit(true, true, true, true, address(pool));
        emit CommitmentDropped(777);
        vm.expectEmit(true, true, true, true, address(pool));
        emit CommitmentDropped(888);
        pool.transact(p, e);
        assertEq(bob.balance - before, 0.5 ether, "withdrawal paid");
        assertEq(pool.nextIndex(), full, "nothing inserted");
        assertTrue(pool.isSpent(21));

        vm.expectRevert("tree full");
        pool.depositFor{value: 1}(1234, 3);
        (p, e) = _withdrawProof(0.5 ether, 0, address(0), 31);
        pool.transact(p, e);
        assertEq(bob.balance - before, 1 ether, "a second withdrawal still works");
    }
}
