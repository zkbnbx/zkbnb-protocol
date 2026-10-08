// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {PrivacyBase} from "./GrovePool.t.sol";
import {GrovePool} from "../src/GrovePool.sol";
import {DarkCurve} from "../src/DarkCurve.sol";
import {PayoutMode} from "../src/interfaces/IGrove.sol";
import {IVerifier17, IVerifier5, IVerifier8} from "../src/interfaces/IGroveV2.sol";
import {GroveConstants as C} from "../src/libraries/GroveConstants.sol";
import {BabyJubjub as B} from "../src/libraries/BabyJubjub.sol";

contract DarkCurveTest is PrivacyBase {
    using stdJson for string;
    event IntentSubmitted(address indexed coin, uint8 indexed dir, uint32 seq, uint32 count, uint256 intentLeaf);
    event EpochOpened(
        address indexed coin,
        uint8 indexed dir,
        uint32 seq,
        uint256 u,
        uint256 totalIn,
        uint256 totalOut,
        uint256 refund,
        uint256 spotAfter,
        uint256 rptAtSettle
    );
    event EpochVoided(address indexed coin, uint8 indexed dir, uint32 seq);
    event Claimed(address relayer, uint256 reimbursed);
    event NewCommitment(uint256 indexed commitment, uint32 index, bytes encryptedOutput);

    uint256 constant EC_SK = 12345;
    DarkCurve dc;
    uint256[2] ecPk;
    uint256 kCounter = 1000;
    address coin;

    // per-(coin,dir) expected sums
    mapping(uint8 => B.Point) sumC1;
    mapping(uint8 => B.Point) sumC2;
    mapping(uint8 => uint256) sumU;

    function _deployDarkCurve() internal override returns (address) {
        (uint256 x, uint256 y) = _affine(B.mul(B.base8(), EC_SK));
        ecPk = [x, y];
        dc = new DarkCurve(address(gp), address(roots), treasury, address(v17), address(v5), address(v8), ecPk, owner);
        return address(dc);
    }

    function setUp() public override {
        super.setUp();
        coin = plantCoin(alice, PayoutMode.Creator);
        // public flow so Roots has a balance for this coin and alice holds tokens
        buy(alice, coin, 2 ether);
        buy(bob, coin, 1 ether);
        shield(50 ether); // pool BNB for escrow and fees
        // pool holds a token lot (SELL / HARVEST escrow)
        vm.prank(alice);
        IERC20(coin).approve(address(gp), type(uint256).max);
        GrovePool.ExtData memory e = _ext(address(0), 0, int256(LOTS[2]), 0, "");
        GrovePool.TransferPublic memory s = _pub(e, coin, 0, 0, 0);
        vm.prank(alice);
        gp.transact(_proof(), s, e);
        pinnedRoot = s.root; // checkpointed by _pub; the root after this insert is not known yet
        for (uint8 d; d < 3; d++) {
            sumC1[d] = B.identity();
            sumC2[d] = B.identity();
        }
    }

    // ------------------------------------------------------------- helpers

    function _affine(B.Point memory p) internal view returns (uint256, uint256) {
        return B.toAffine(p);
    }

    uint256 pinnedRoot;

    /// Latest checkpointed root (never warps: the mock verifier does not care which checkpoint).
    function _knownRoot() internal returns (uint256) {
        uint256 lr = gp.getLastRoot();
        if (gp.isKnownRoot(lr)) pinnedRoot = lr;
        return pinnedRoot;
    }

    function _unit(uint8 dir) internal pure returns (uint256) {
        return dir == 0 ? C.UNIT_BNB : C.UNIT_TOKEN;
    }

    /// Builds an honest intent: C1 = k*B8, C2 = u*B8 + k*ecPk, publicAmount = -(fee + INTENT_FEE).
    function _intent(address c, uint8 dir, uint256 u, uint256 fee)
        internal
        returns (DarkCurve.IntentPublic memory s, DarkCurve.IntentExt memory e)
    {
        e.relayer = fee > 0 ? relayer : address(0);
        e.fee = fee;
        e.encryptedOutputs = [bytes("i0"), bytes("i1"), bytes("i2")];
        uint256 k = ++kCounter;
        B.Point memory pk = B.fromAffine(ecPk[0], ecPk[1]);
        B.Point memory c1 = B.mul(B.base8(), k);
        B.Point memory c2 = B.add(B.mul(B.base8(), u), B.mul(pk, k));
        (s.c1[0], s.c1[1]) = _affine(c1);
        (s.c2[0], s.c2[1]) = _affine(c2);
        s.root = _knownRoot();
        s.publicAmount = C.FIELD_SIZE - (fee + C.INTENT_FEE);
        s.coin = c;
        s.accRpt = 0;
        s.dir = dir;
        s.ecPk = ecPk;
        s.extDataHash = dc.hashIntentExt(e);
        s.inputNullifiers = [_nf(), _nf()];
        s.outputCommitments = [_cm(), _cm(), _cm()];
    }

    function _submit(uint8 dir, uint256 u) internal returns (uint256 gasUsed) {
        (DarkCurve.IntentPublic memory s, DarkCurve.IntentExt memory e) = _intent(coin, dir, u, 0.0005 ether);
        uint256 g = gasleft();
        dc.submitIntent(_proof(), s, e);
        gasUsed = g - gasleft();
        sumC1[dir] = B.add(sumC1[dir], B.fromAffine(s.c1[0], s.c1[1]));
        sumC2[dir] = B.add(sumC2[dir], B.fromAffine(s.c2[0], s.c2[1]));
        sumU[dir] += u;
    }

    function _open(uint8 mask) internal returns (uint256 gasUsed) {
        uint32[3] memory seq = [dc.cur(coin, 0), dc.cur(coin, 1), dc.cur(coin, 2)];
        uint256[3] memory u = [sumU[0], sumU[1], sumU[2]];
        GrovePool.Proof[3] memory proofs = [_proof(), _proof(), _proof()];
        uint256[3] memory minOut;
        uint256 g = gasleft();
        dc.openEpoch(coin, mask, seq, u, proofs, minOut);
        gasUsed = g - gasleft();
        for (uint8 d; d < 3; d++) {
            if (mask & (1 << d) != 0) {
                sumU[d] = 0;
                sumC1[d] = B.identity();
                sumC2[d] = B.identity();
            }
        }
    }

    function _assertSum(uint8 dir, uint32 seq) internal view {
        DarkCurve.Epoch memory ep = dc.epochOf(coin, dir, seq);
        (uint256 x1, uint256 y1) = _affine(ep.c1);
        (uint256 ex1, uint256 ey1) = _affine(sumC1[dir]);
        assertEq(x1, ex1, "c1.x");
        assertEq(y1, ey1, "c1.y");
        (uint256 x2, uint256 y2) = _affine(ep.c2);
        (uint256 ex2, uint256 ey2) = _affine(sumC2[dir]);
        assertEq(x2, ex2, "c2.x");
        assertEq(y2, ey2, "c2.y");
    }

    function _claim(uint256 budgetBefore) internal returns (DarkCurve.ClaimPublic memory s, uint256 gasUsed) {
        DarkCurve.ClaimExt memory e;
        e.relayer = relayer;
        e.encryptedOutputs = [bytes("c0"), bytes("c1")];
        s.root = _knownRoot();
        s.nullifier = _nf();
        s.outputCommitments = [_cm(), _cm()];
        s.extDataHash = dc.hashClaimExt(e);
        uint256 g = gasleft();
        dc.claim(_proof(), s, e);
        gasUsed = g - gasleft();
        budgetBefore; // silence
    }

    // -------------------------------------------------------------- intents

    function test_submitIntent_insertsStampedChunk_sums_fees() public {
        uint256 u = C.MIN_U_BNB;
        (DarkCurve.IntentPublic memory s, DarkCurve.IntentExt memory e) = _intent(coin, 0, u, 0.0005 ether);
        uint256 leaf = dc.intentLeaf(s.outputCommitments[0], dc.epochKey(coin, 0, 0));
        uint256 tBefore = treasury.balance;
        uint256 poolBefore = address(gp).balance;
        uint256 idx = gp.nextIndex();

        vm.expectEmit(true, true, true, true, address(gp));
        emit NewCommitment(leaf, uint32(idx), "i0");
        vm.expectEmit(true, true, true, true, address(gp));
        emit NewCommitment(s.outputCommitments[1], uint32(idx + 1), "i1");
        vm.expectEmit(true, true, true, true, address(gp));
        emit NewCommitment(s.outputCommitments[2], uint32(idx + 2), "i2");
        vm.expectEmit(true, true, true, true, address(dc));
        emit IntentSubmitted(coin, 0, 0, 1, leaf);
        uint256 g = gasleft();
        dc.submitIntent(_proof(), s, e);
        console2.log("gas submitIntent", g - gasleft());
        sumC1[0] = B.fromAffine(s.c1[0], s.c1[1]);
        sumC2[0] = B.fromAffine(s.c2[0], s.c2[1]);
        sumU[0] = u;

        assertEq(treasury.balance, tBefore + C.INTENT_FEE, "INTENT_FEE to treasury");
        assertEq(relayer.balance, 0.0005 ether, "relayer fee");
        assertEq(address(gp).balance, poolBefore - C.INTENT_FEE - 0.0005 ether);
        assertTrue(gp.isSpent(s.inputNullifiers[0]) && gp.isSpent(s.inputNullifiers[1]));
        assertTrue(dc.seenC1(s.c1[0]));
        DarkCurve.Epoch memory ep = dc.epochOf(coin, 0, 0);
        assertEq(ep.count, 1);
        assertEq(ep.status, 1);
        assertEq(ep.startedAt, block.timestamp);
        (uint256 price, uint256 vB) = dc.spot(coin);
        assertEq(ep.refPrice, price);
        assertEq(ep.refVb, vB);
        assertEq(launchpad.price(coin), price);
        _assertSum(0, 0);

        // second and third intents accumulate
        _submit(0, 7_000);
        _submit(0, 123_456);
        _assertSum(0, 0);
        assertEq(dc.epochOf(coin, 0, 0).count, 3);
        // decrypting the sum gives (sum u)*B8
        DarkCurve.Epoch memory ep2 = dc.epochOf(coin, 0, 0);
        B.Point memory m = B.add(ep2.c2, B.neg(B.mul(ep2.c1, EC_SK)));
        assertTrue(B.eq(m, B.mul(B.base8(), sumU[0])), "sum decrypts");
    }

    function test_submitIntent_rejections() public {
        (DarkCurve.IntentPublic memory s, DarkCurve.IntentExt memory e) = _intent(coin, 0, 5000, 0);
        dc.submitIntent(_proof(), s, e);

        // reused C1
        (DarkCurve.IntentPublic memory s2, DarkCurve.IntentExt memory e2) = _intent(coin, 0, 5000, 0);
        s2.c1 = s.c1;
        vm.expectRevert(DarkCurve.ReusedRandomness.selector);
        dc.submitIntent(_proof(), s2, e2);

        // wrong key
        (s2, e2) = _intent(coin, 0, 5000, 0);
        (s2.ecPk[0], s2.ecPk[1]) = _affine(B.mul(B.base8(), 999));
        vm.expectRevert(DarkCurve.WrongKey.selector);
        dc.submitIntent(_proof(), s2, e2);

        // not a coin, bad dir
        (s2, e2) = _intent(bob, 0, 5000, 0);
        vm.expectRevert(DarkCurve.NotCoin.selector);
        dc.submitIntent(_proof(), s2, e2);
        (s2, e2) = _intent(coin, 3, 5000, 0);
        vm.expectRevert(DarkCurve.BadDir.selector);
        dc.submitIntent(_proof(), s2, e2);

        // unknown accRpt; a stale-but-known one is accepted
        (s2, e2) = _intent(coin, 1, 50_000, 0);
        s2.accRpt = 42;
        vm.expectRevert(DarkCurve.UnknownAccRpt.selector);
        dc.submitIntent(_proof(), s2, e2);
        bytes32[] memory proof;
        gp.pullRewards(coin, 0, 1 ether, proof);
        uint256 rpt1 = gp.accRpt(coin);
        gp.pullRewards(coin, 1, 1 ether, proof);
        (s2, e2) = _intent(coin, 1, 50_000, 0);
        s2.accRpt = rpt1;
        dc.submitIntent(_proof(), s2, e2);

        // wrong publicAmount
        (s2, e2) = _intent(coin, 0, 5000, 0);
        s2.publicAmount = C.FIELD_SIZE - 1;
        vm.expectRevert(DarkCurve.BadPublicAmount.selector);
        dc.submitIntent(_proof(), s2, e2);

        // bad ext hash, unknown root, spent nullifier, invalid proof
        (s2, e2) = _intent(coin, 0, 5000, 0);
        s2.extDataHash = bytes32(uint256(5));
        vm.expectRevert(DarkCurve.BadExtDataHash.selector);
        dc.submitIntent(_proof(), s2, e2);
        (s2, e2) = _intent(coin, 0, 5000, 0);
        s2.root = 7;
        vm.expectRevert(DarkCurve.UnknownRoot.selector);
        dc.submitIntent(_proof(), s2, e2);
        (s2, e2) = _intent(coin, 0, 5000, 0);
        s2.inputNullifiers[1] = s.inputNullifiers[0];
        vm.expectRevert(DarkCurve.AlreadySpent.selector);
        dc.submitIntent(_proof(), s2, e2);
        (s2, e2) = _intent(coin, 0, 5000, 0);
        v17.setResult(false);
        vm.expectRevert(DarkCurve.InvalidProof.selector);
        dc.submitIntent(_proof(), s2, e2);
        v17.setResult(true);

        // an off-curve ciphertext is rejected by the library
        (s2, e2) = _intent(coin, 0, 5000, 0);
        s2.c2[0] = 1;
        vm.expectRevert(B.NotOnCurve.selector);
        dc.submitIntent(_proof(), s2, e2);

        // EpochFull with maxIntents = 1 (BUY already has 1)
        DarkCurve.Params memory p = _params();
        p.maxIntents = 1;
        dc.setParams(p);
        (s2, e2) = _intent(coin, 0, 5000, 0);
        vm.expectRevert(DarkCurve.EpochFull.selector);
        dc.submitIntent(_proof(), s2, e2);
    }

    function test_verifier_signalOrders() public {
        (DarkCurve.IntentPublic memory s, DarkCurve.IntentExt memory e) = _intent(coin, 1, 60_000, 0);
        GrovePool.Proof memory p = _proof();
        uint256[17] memory sig = [
            s.root,
            s.publicAmount,
            uint256(uint160(coin)),
            0,
            1,
            s.ecPk[0],
            s.ecPk[1],
            s.c1[0],
            s.c1[1],
            s.c2[0],
            s.c2[1],
            uint256(s.extDataHash),
            s.inputNullifiers[0],
            s.inputNullifiers[1],
            s.outputCommitments[0],
            s.outputCommitments[1],
            s.outputCommitments[2]
        ];
        vm.expectCall(address(v17), abi.encodeCall(IVerifier17.verifyProof, (p.a, p.b, p.c, sig)));
        dc.submitIntent(p, s, e);
        sumU[1] = 60_000;
        sumC1[1] = B.fromAffine(s.c1[0], s.c1[1]);
        sumC2[1] = B.fromAffine(s.c2[0], s.c2[1]);

        // open: [ecPkX, ecPkY, c1X, c1Y, c2X, c2Y, u, minOut] (_open sends minOut 0)
        vm.warp(block.timestamp + C.T_MAX);
        uint256[8] memory osig = [ecPk[0], ecPk[1], s.c1[0], s.c1[1], s.c2[0], s.c2[1], uint256(60_000), 0];
        vm.expectCall(address(v8), abi.encodeCall(IVerifier8.verifyProof, (p.a, p.b, p.c, osig)));
        _open(2);

        // claim: [root, nullifier, out0, out1, extDataHash]
        DarkCurve.ClaimExt memory ce;
        ce.encryptedOutputs = [bytes(""), bytes("")];
        DarkCurve.ClaimPublic memory cs;
        vm.warp(block.timestamp + C.CHECKPOINT_PERIOD);
        gp.checkpoint();
        cs.root = gp.getLastRoot();
        cs.nullifier = 555;
        cs.outputCommitments = [uint256(556), 557];
        cs.extDataHash = dc.hashClaimExt(ce);
        vm.expectCall(address(v5), abi.encodeCall(IVerifier5.verifyProof, (p.a, p.b, p.c, [cs.root, cs.nullifier, cs.outputCommitments[0], cs.outputCommitments[1], uint256(cs.extDataHash)])));
        dc.claim(p, cs, ce);
    }

    // ------------------------------------------------------------ openable

    function test_isOpenable_perDirection_byK_andByTmax() public {
        for (uint256 i; i < 7; i++) {
            _submit(0, 5000 + i);
        }
        _submit(1, 50_000);
        assertFalse(dc.isOpenable(coin, 0, 0), "before T_MIN");
        vm.warp(block.timestamp + C.T_MIN);
        assertTrue(dc.isOpenable(coin, 0, 0), "7 buys >= K at T_MIN");
        assertFalse(dc.isOpenable(coin, 1, 0), "1 sell < K");
        assertFalse(dc.isOpenable(coin, 2, 0), "no harvest epoch");
        vm.warp(block.timestamp + C.T_MAX);
        assertTrue(dc.isOpenable(coin, 1, 0), "any count at T_MAX");
        uint32[3] memory seq;
        uint256[3] memory u;
        GrovePool.Proof[3] memory proofs;
        uint256[3] memory minOut;
        vm.expectRevert(abi.encodeWithSelector(DarkCurve.NotOpenable.selector, uint8(2)));
        dc.openEpoch(coin, 4, seq, u, proofs, minOut);
        vm.expectRevert(DarkCurve.EmptyMask.selector);
        dc.openEpoch(coin, 0, seq, u, proofs, minOut);
        seq[0] = 1;
        vm.expectRevert(abi.encodeWithSelector(DarkCurve.WrongSeq.selector, uint8(0)));
        dc.openEpoch(coin, 1, seq, u, proofs, minOut);
    }

    // ---------------------------------------------------------------- open

    function test_openEpoch_allThreeDirections_order_fees_resultLeaves() public {
        _submit(1, 60_000); // 60k tokens
        _submit(1, 50_000);
        _submit(2, 100_000); // harvest 100k tokens
        _submit(0, 20_000); // 0.2 BNB
        _submit(0, 30_000); // 0.3 BNB
        vm.warp(block.timestamp + C.T_MAX);

        uint256 T = 110_000 * C.UNIT_TOKEN;
        uint256 H = 100_000 * C.UNIT_TOKEN;
        uint256 Bn = 50_000 * C.UNIT_BNB;
        (uint256 sellNet, uint256 sellGross, uint256 sellFee) = launchpad.quoteSell(coin, T);
        uint256 collectedBefore = feeRouter.collectedOf(coin);
        uint256 poolBnbBefore = address(gp).balance;
        uint256 poolTokBefore = IERC20(coin).balanceOf(address(gp));
        uint256 harvestBnb = roots.harvestValue(coin, H);
        uint256 rootsBefore = roots.balance(coin);
        uint256 idx = gp.nextIndex();

        // events in SELL -> HARVEST -> BUY order are emitted at the end in direction order; the venue
        // Trade events carry the execution order instead, so check balances + leaves here.
        uint256 g = _open(7);
        console2.log("gas openEpoch (3 directions)", g);

        // the sell fee deposits 25% into roots before the harvest, the harvest then takes its share,
        // and the BUY that follows deposits 25% of its 2% fee
        uint256 rootsIn = (sellFee + Bn * 200 / 10_000) * 2500 / 10_000;
        assertLt(roots.balance(coin), rootsBefore + rootsIn, "harvest took BNB out of roots");
        assertGt(roots.balance(coin), rootsBefore - harvestBnb, "harvest paid at most the pre-sell value plus deposits");
        uint256 rpt = gp.accRpt(coin);
        DarkCurve.Epoch memory epS = dc.epochOf(coin, 1, 0);
        assertEq(epS.status, 2);
        assertEq(dc.cur(coin, 0), 1);
        assertEq(dc.cur(coin, 1), 1);
        assertEq(dc.cur(coin, 2), 1);
        // result leaves in the chunk, in direction order BUY, SELL, HARVEST
        assertEq(gp.nextIndex(), idx + 4);
        // sell proceeds and harvest proceeds landed in the pool, buy spent B (less refund)
        assertGt(address(gp).balance, poolBnbBefore - Bn, "pool received sell + harvest BNB");
        assertEq(address(dc).balance, 0, "DarkCurve keeps nothing");
        assertEq(IERC20(coin).balanceOf(address(dc)), 0);
        assertGt(IERC20(coin).balanceOf(address(gp)), poolTokBefore - T - H, "bought tokens landed");
        // FeeRouter saw 2% of the sell gross plus 2% of the buy used
        uint256 collected = feeRouter.collectedOf(coin) - collectedBefore;
        assertGe(collected, sellFee + Bn * 200 / 10_000 - 1);
        assertLe(collected, sellFee + Bn * 200 / 10_000 + 1);
        sellNet;
        sellGross;
        assertEq(rpt, 0);
    }

    function test_openEpoch_resultLeafMatchesTotals_andEvents() public {
        _submit(0, 20_000);
        vm.warp(block.timestamp + C.T_MAX);
        uint256 Bn = 20_000 * C.UNIT_BNB;
        (uint256 tokensOut, uint256 used,) = launchpad.quoteBuy(coin, Bn);
        uint256 ek = dc.epochKey(coin, 0, 0);
        uint256 leaf = dc.resultLeaf(ek, Bn, tokensOut, Bn - used, 0);
        uint256 idx = gp.nextIndex();
        // EpochOpened is emitted per direction before the result chunk is inserted
        vm.expectEmit(true, true, false, false, address(dc));
        emit EpochOpened(coin, 0, 0, 20_000, Bn, tokensOut, Bn - used, 0, 0);
        vm.expectEmit(true, true, true, true, address(gp));
        emit NewCommitment(leaf, uint32(idx), "");
        _open(1);
        assertEq(IERC20(coin).balanceOf(address(gp)) - LOTS[2], tokensOut);
    }

    function test_openEpoch_graduatesInsideOpen_thenRouterPaths() public {
        shield(20 ether);
        uint256 need = grossToClear(coin);
        uint256 u = need / C.UNIT_BNB + 1;
        _submit(0, u);
        vm.warp(block.timestamp + C.T_MAX);
        uint256 tokBefore = IERC20(coin).balanceOf(address(gp));
        uint256 bnbBefore = address(gp).balance;
        _open(1);
        assertTrue(launchpad.isGraduated(coin), "graduated inside the open");
        assertGt(IERC20(coin).balanceOf(address(gp)), tokBefore);
        // refund = B - used came back to the pool
        assertGt(address(gp).balance, bnbBefore - u * C.UNIT_BNB, "refund forwarded");
        assertEq(address(dc).balance, 0);

        // after graduation: SELL through the router (fee-on-transfer path) and BUY through the router
        _submit(1, 60_000);
        _submit(0, 10_000);
        vm.warp(block.timestamp + C.T_MAX);
        (uint256 price0,) = dc.spot(coin);
        assertGt(price0, 0);
        uint256 poolBnb = address(gp).balance;
        uint256 poolTok = IERC20(coin).balanceOf(address(gp));
        _open(3);
        assertGt(address(gp).balance, poolBnb - 10_000 * C.UNIT_BNB, "router sell proceeds");
        assertGt(IERC20(coin).balanceOf(address(gp)), poolTok - 60_000 * C.UNIT_TOKEN, "router buy tokens");
        assertEq(dc.cur(coin, 0), 2);
        assertEq(dc.cur(coin, 1), 1);
    }

    // ---------------------------------------------------------------- band

    function test_band_pumpBlocksBuyOnly_floorProtectsFreshCoin() public {
        _submit(0, 5000);
        _submit(1, 50_000);
        _submit(2, 50_000);
        // a small pump (< 0.5 BNB of vB) on a fresh coin moves price > 10% but is under the floor
        (uint256 p0, uint256 v0) = dc.spot(coin);
        buy(carol, coin, 0.4 ether);
        (uint256 p1, uint256 v1) = dc.spot(coin);
        assertGt(p1, p0 * 11_000 / 10_000, "price moved > 10%");
        assertLt(v1 - v0, 0.5 ether, "under the floor");
        vm.warp(block.timestamp + C.T_MAX);
        uint32[3] memory seq;
        uint256[3] memory u = [sumU[0], sumU[1], sumU[2]];
        GrovePool.Proof[3] memory proofs = [_proof(), _proof(), _proof()];
        uint256[3] memory minOut;
        // dry run: must not revert with BandExceeded (snapshot to keep state)
        uint256 snap = vm.snapshotState();
        dc.openEpoch(coin, 7, seq, u, proofs, minOut);
        vm.revertToState(snap);

        // a real pump: > 10% and > 0.5 BNB
        buy(carol, coin, 1 ether);
        vm.expectRevert(abi.encodeWithSelector(DarkCurve.BandExceeded.selector, uint8(0)));
        dc.openEpoch(coin, 7, seq, u, proofs, minOut);
        // SELL + HARVEST open without BUY
        dc.openEpoch(coin, 6, seq, u, proofs, minOut);
        assertEq(dc.cur(coin, 0), 0);
        assertEq(dc.cur(coin, 1), 1);
        assertEq(dc.cur(coin, 2), 1);
    }

    function test_band_dumpBlocksSellOnly_harvestNever() public {
        buy(whale, coin, 3 ether);
        _submit(0, 5000);
        _submit(1, 50_000);
        _submit(2, 50_000);
        (uint256 p0, uint256 v0) = dc.spot(coin);
        sell(whale, coin, IERC20(coin).balanceOf(whale) / 2);
        (uint256 p1, uint256 v1) = dc.spot(coin);
        assertLt(p1, p0 * 9_000 / 10_000, "dumped > 10%");
        assertGt(v0 - v1, 0.5 ether);
        vm.warp(block.timestamp + C.T_MAX);
        uint32[3] memory seq;
        uint256[3] memory u = [sumU[0], sumU[1], sumU[2]];
        GrovePool.Proof[3] memory proofs = [_proof(), _proof(), _proof()];
        uint256[3] memory minOut;
        vm.expectRevert(abi.encodeWithSelector(DarkCurve.BandExceeded.selector, uint8(1)));
        dc.openEpoch(coin, 7, seq, u, proofs, minOut);
        dc.openEpoch(coin, 5, seq, u, proofs, minOut); // BUY + HARVEST
        assertEq(dc.cur(coin, 1), 0);
        assertEq(dc.cur(coin, 0), 1);
        assertEq(dc.cur(coin, 2), 1);
    }

    function test_open_revertingVenueLeavesStateUnchanged() public {
        _submit(1, 50_000);
        _submit(0, 5000);
        vm.warp(block.timestamp + C.T_MAX);
        uint32[3] memory seq;
        uint256[3] memory u = [sumU[0], sumU[1], sumU[2]];
        GrovePool.Proof[3] memory proofs = [_proof(), _proof(), _proof()];
        uint256[3] memory minOut = [uint256(0), type(uint256).max, 0]; // SELL slippage must revert
        uint256 idx = gp.nextIndex();
        vm.expectRevert();
        dc.openEpoch(coin, 3, seq, u, proofs, minOut);
        assertEq(gp.nextIndex(), idx);
        assertEq(dc.cur(coin, 1), 0);
        // BUY opens alone
        dc.openEpoch(coin, 1, seq, u, proofs, [uint256(0), 0, 0]);
        assertEq(dc.cur(coin, 0), 1);
    }

    // ---------------------------------------------------------------- void

    function test_voidEpoch_afterGrace_insertsRefundLeaf() public {
        _submit(1, 50_000);
        vm.expectRevert(DarkCurve.NotVoidable.selector);
        dc.voidEpoch(coin, 1, 0);
        vm.warp(block.timestamp + C.T_MAX + C.GRACE);
        vm.expectRevert(DarkCurve.NotVoidable.selector);
        dc.voidEpoch(coin, 1, 0);
        vm.warp(block.timestamp + 1);
        vm.expectRevert(abi.encodeWithSelector(DarkCurve.WrongSeq.selector, uint8(1)));
        dc.voidEpoch(coin, 1, 1);
        vm.expectRevert(DarkCurve.NotVoidable.selector);
        dc.voidEpoch(coin, 0, 0); // never started

        uint256 leaf = dc.resultLeaf(dc.epochKey(coin, 0, 1), 1, 0, 1, gp.accRpt(coin));
        uint256 idx = gp.nextIndex();
        vm.expectEmit(true, true, true, true, address(gp));
        emit NewCommitment(leaf, uint32(idx), "");
        vm.expectEmit(true, true, true, true, address(dc));
        emit EpochVoided(coin, 1, 0);
        uint256 g = gasleft();
        dc.voidEpoch(coin, 1, 0);
        console2.log("gas voidEpoch", g - gasleft());
        assertEq(dc.cur(coin, 1), 1);
        assertEq(dc.epochOf(coin, 1, 0).status, 3);
        // the pool still holds the escrowed tokens
        assertEq(IERC20(coin).balanceOf(address(gp)), LOTS[2]);
    }

    // --------------------------------------------------------------- claims

    function test_claim_marksNullifier_insertsChunk_reimburses() public {
        vm.txGasPrice(1 gwei);
        dc.fundClaimBudget{value: 0.0001 ether}();
        assertEq(dc.claimBudget(), 0.0001 ether);
        uint256 idx = gp.nextIndex();
        uint256 relBefore = relayer.balance;
        (DarkCurve.ClaimPublic memory s, uint256 g) = _claim(0);
        console2.log("gas claim", g);
        assertTrue(gp.isSpent(s.nullifier));
        assertEq(gp.nextIndex(), idx + 4);
        // claimGas * 1 gwei = 0.0006 > budget: capped at the budget
        assertEq(relayer.balance, relBefore + 0.0001 ether);
        assertEq(dc.claimBudget(), 0);

        // zero budget still succeeds and pays nothing
        vm.warp(block.timestamp + C.CHECKPOINT_PERIOD);
        gp.checkpoint();
        vm.expectEmit(true, true, true, true, address(dc));
        emit Claimed(relayer, 0);
        _claim(0);

        // budget larger than the cap: pays claimGas * min(gasprice, maxReimburseGasPrice)
        dc.fundClaimBudget{value: 1 ether}();
        vm.txGasPrice(10 gwei);
        (, uint32 claimGas) = _claimGas();
        relBefore = relayer.balance;
        _claim(0);
        assertEq(relayer.balance, relBefore + uint256(claimGas) * 5 gwei);

        // replay and unknown root
        DarkCurve.ClaimExt memory e;
        e.encryptedOutputs = [bytes(""), bytes("")];
        s.extDataHash = dc.hashClaimExt(e);
        vm.expectRevert(DarkCurve.AlreadySpent.selector);
        dc.claim(_proof(), s, e);
        s.nullifier = 99_999;
        s.root = 1;
        vm.expectRevert(DarkCurve.UnknownRoot.selector);
        dc.claim(_proof(), s, e);
        s.root = gp.getLastRoot();
        vm.warp(block.timestamp + C.CHECKPOINT_PERIOD);
        gp.checkpoint();
        s.extDataHash = bytes32(uint256(1));
        vm.expectRevert(DarkCurve.BadExtDataHash.selector);
        dc.claim(_proof(), s, e);
        s.extDataHash = dc.hashClaimExt(e);
        v5.setResult(false);
        vm.expectRevert(DarkCurve.InvalidProof.selector);
        dc.claim(_proof(), s, e);
    }

    function _claimGas() internal view returns (uint256, uint32 claimGas) {
        (,,,,,,, claimGas) = dc.params();
        return (0, claimGas);
    }

    // ---------------------------------------------------------------- admin

    function _params() internal view returns (DarkCurve.Params memory p) {
        (p.tMin, p.tMax, p.k, p.grace, p.bandBps, p.maxIntents, p.bandFloorWei, p.claimGas) = dc.params();
    }

    function test_setParams_bounds() public {
        DarkCurve.Params memory p = _params();
        assertEq(p.tMin, 60);
        assertEq(p.tMax, 300);
        assertEq(p.k, 5);
        assertEq(p.grace, 1800);
        assertEq(p.bandBps, 1000);
        assertEq(p.maxIntents, 256);
        assertEq(p.bandFloorWei, 0.5 ether);

        p.claimGas = 299_999;
        vm.expectRevert(DarkCurve.OutOfBounds.selector);
        dc.setParams(p);
        p.claimGas = 3_000_001;
        vm.expectRevert(DarkCurve.OutOfBounds.selector);
        dc.setParams(p);
        p.claimGas = 1_000_000;
        p.bandFloorWei = 0.05 ether;
        vm.expectRevert(DarkCurve.OutOfBounds.selector);
        dc.setParams(p);
        p.bandFloorWei = 5 ether;
        p.tMin = 29;
        vm.expectRevert(DarkCurve.OutOfBounds.selector);
        dc.setParams(p);
        p.tMin = 600;
        p.tMax = 600;
        vm.expectRevert(DarkCurve.OutOfBounds.selector);
        dc.setParams(p);
        p.tMax = 1800;
        p.maxIntents = 257;
        vm.expectRevert(DarkCurve.OutOfBounds.selector);
        dc.setParams(p);
        p.maxIntents = 256;
        p.grace = 86_401;
        vm.expectRevert(DarkCurve.OutOfBounds.selector);
        dc.setParams(p);
        p.grace = 86_400;
        p.bandBps = 2501;
        vm.expectRevert(DarkCurve.OutOfBounds.selector);
        dc.setParams(p);
        p.bandBps = 2500;
        dc.setParams(p);
        vm.prank(bob);
        vm.expectRevert();
        dc.setParams(p);
        vm.prank(bob);
        vm.expectRevert();
        dc.setMaxReimburseGasPrice(1);
        dc.setMaxReimburseGasPrice(1 gwei);
        assertEq(dc.maxReimburseGasPrice(), 1 gwei);
    }

    function test_coordinatorKeyRotation_overlap_onePerEpoch() public {
        (uint256 nx, uint256 ny) = _affine(B.mul(B.base8(), 777));
        uint256[2] memory newPk = [nx, ny];
        vm.expectRevert(DarkCurve.OutOfBounds.selector);
        dc.setCoordinatorKey(newPk, uint64(block.timestamp + C.OVERLAP - 1));
        vm.expectRevert(DarkCurve.WrongKey.selector);
        dc.setCoordinatorKey([uint256(1), 1], uint64(block.timestamp + 1 hours));
        uint64 switchAt = uint64(block.timestamp + 1 hours);
        dc.setCoordinatorKey(newPk, switchAt);
        vm.expectRevert(DarkCurve.PendingKey.selector);
        dc.setCoordinatorKey(newPk, switchAt + 1);

        // old key accepted, new key rejected before the overlap
        _submit(0, 5000);
        (DarkCurve.IntentPublic memory s, DarkCurve.IntentExt memory e) = _intent(coin, 1, 50_000, 0);
        s.ecPk = newPk;
        vm.expectRevert(DarkCurve.WrongKey.selector);
        dc.submitIntent(_proof(), s, e);

        // inside the overlap: new key accepted on a fresh direction, rejected on the BUY epoch
        vm.warp(switchAt - C.OVERLAP);
        (s, e) = _intent(coin, 1, 50_000, 0);
        s.ecPk = newPk;
        dc.submitIntent(_proof(), s, e);
        assertEq(dc.epochOf(coin, 1, 0).keyId, 1);
        (s, e) = _intent(coin, 0, 5000, 0);
        s.ecPk = newPk;
        vm.expectRevert(DarkCurve.WrongKey.selector);
        dc.submitIntent(_proof(), s, e);
        (s, e) = _intent(coin, 0, 5000, 0);
        dc.submitIntent(_proof(), s, e); // old key still fine on its epoch
        sumC1[0] = B.add(sumC1[0], B.fromAffine(s.c1[0], s.c1[1]));
        sumC2[0] = B.add(sumC2[0], B.fromAffine(s.c2[0], s.c2[1]));
        sumU[0] += 5000;
        (uint256[2] memory active, uint32 gen) = dc.activeCoordinatorKey();
        assertEq(gen, 0);
        assertEq(active[0], ecPk[0]);

        // after switchAt: old key rejected everywhere, new is current
        vm.warp(switchAt);
        (active, gen) = dc.activeCoordinatorKey();
        assertEq(gen, 1);
        assertEq(active[0], newPk[0]);
        (s, e) = _intent(coin, 2, 50_000, 0);
        vm.expectRevert(DarkCurve.WrongKey.selector);
        dc.submitIntent(_proof(), s, e);
        (s, e) = _intent(coin, 2, 50_000, 0);
        s.ecPk = newPk;
        dc.submitIntent(_proof(), s, e);
        assertEq(dc.keyGen(), 1);
        // the BUY epoch (old key) still opens against its recorded key
        vm.warp(block.timestamp + C.T_MAX);
        uint32[3] memory seq;
        uint256[3] memory u = [sumU[0], 0, 0];
        GrovePool.Proof[3] memory proofs = [_proof(), _proof(), _proof()];
        uint256[3] memory minOut = [uint256(1), 0, 0];
        uint256[8] memory osig;
        (osig[2], osig[3]) = _affine(sumC1[0]);
        (osig[4], osig[5]) = _affine(sumC2[0]);
        osig[0] = ecPk[0];
        osig[1] = ecPk[1];
        osig[6] = sumU[0];
        osig[7] = 1; // the direction's minOut is the last signal (review N2)
        vm.expectCall(address(v8), abi.encodeCall(IVerifier8.verifyProof, (proofs[0].a, proofs[0].b, proofs[0].c, osig)));
        dc.openEpoch(coin, 1, seq, u, proofs, minOut);
    }

    // ------------------------------------------------- review findings (STATUS.md "Review")

    /// R3: with a uint8 generation counter the 256th rotation (about 8.5 months of the daily
    ///     rotation the spec asks for) panicked in `_promoteKey`, bricking intents and rotations.
    function test_review_R3_keyRotation_pastUint8() public {
        for (uint256 i; i < 300; i++) {
            uint64 switchAt = uint64(block.timestamp + C.OVERLAP);
            dc.setCoordinatorKey(ecPk, switchAt);
            vm.warp(switchAt);
        }
        (, uint32 gen) = dc.activeCoordinatorKey();
        assertEq(gen, 300);
        _submit(0, 5000); // promotes and is accepted under the current key
        assertEq(dc.keyGen(), 300);
        assertEq(dc.epochOf(coin, 0, 0).keyId, 300);
        // and the epoch still opens against its recorded key
        vm.warp(block.timestamp + C.T_MAX);
        _open(1);
        assertEq(dc.epochOf(coin, 0, 0).status, 2);
    }

    /// R2 (intent side): the intent relayer fee is capped like the pool's.
    function test_review_R2_intentFeeCapped() public {
        (DarkCurve.IntentPublic memory s, DarkCurve.IntentExt memory e) = _intent(coin, 0, 5000, 0.37 ether);
        vm.expectRevert(DarkCurve.FeeTooHigh.selector);
        dc.submitIntent(_proof(), s, e);
        (s, e) = _intent(coin, 0, 5000, C.MAX_RELAYER_FEE + 1);
        vm.expectRevert(DarkCurve.FeeTooHigh.selector);
        dc.submitIntent(_proof(), s, e);
        uint256 before = relayer.balance;
        (s, e) = _intent(coin, 0, 5000, C.MAX_RELAYER_FEE);
        dc.submitIntent(_proof(), s, e);
        assertEq(relayer.balance, before + C.MAX_RELAYER_FEE);
    }

    /// R4: the Coordinator key must be a non-identity point of the prime-order subgroup. The
    ///     identity makes C2 = u*B8 (every intent amount public); a key outside the subgroup can
    ///     never be opened (every epoch voids).
    function test_review_R4_coordinatorKeyMustBeInSubgroup() public {
        uint64 at = uint64(block.timestamp + 1 hours);
        vm.expectRevert(DarkCurve.WrongKey.selector);
        dc.setCoordinatorKey([uint256(0), 1], at); // identity
        vm.expectRevert(DarkCurve.WrongKey.selector);
        dc.setCoordinatorKey([uint256(0), C.FIELD_SIZE - 1], at); // order 2
        // pk + (0, -1) = (-x, -y): on the curve, order 2l
        uint256[2] memory mixed = [C.FIELD_SIZE - ecPk[0], C.FIELD_SIZE - ecPk[1]];
        vm.expectRevert(DarkCurve.WrongKey.selector);
        dc.setCoordinatorKey(mixed, at);
        vm.expectRevert(DarkCurve.WrongKey.selector);
        new DarkCurve(address(gp), address(roots), treasury, address(v17), address(v5), address(v8), [uint256(0), 1], owner);
        // a subgroup key (sk * B8) is accepted
        (uint256 nx, uint256 ny) = _affine(B.mul(B.base8(), 777));
        dc.setCoordinatorKey([nx, ny], at);
    }

    function test_views_epochsOf_spot() public {
        _submit(0, 5000);
        address[] memory coins = new address[](2);
        coins[0] = coin;
        coins[1] = address(grove);
        DarkCurve.Epoch[3][] memory eps = dc.epochsOf(coins);
        assertEq(eps.length, 2);
        assertEq(eps[0][0].count, 1);
        assertEq(eps[0][1].count, 0);
        assertEq(eps[1][0].count, 0);
        (uint256 price, uint256 vB) = dc.spot(coin);
        (,,, uint256 realBnb,,,,,,,) = launchpad.info(coin);
        assertEq(vB, 4 ether + realBnb);
        assertEq(price, launchpad.price(coin));
    }

    /// Fixture (WP section 1.3): contracts/test/fixtures/v2/poseidon_vectors.json from WP-circuits.
    function test_fixture_poseidonVectors() public {
        string memory json;
        try vm.readFile("test/fixtures/v2/poseidon_vectors.json") returns (string memory j) {
            json = j;
        } catch {
            vm.skip(true);
            return;
        }
        // tree constants on a fresh pool
        GrovePool fresh = new GrovePool(address(v13), poseidonT3, poseidonT4, address(launchpad), address(hrMock), address(pool), owner);
        assertEq(fresh.getLastRoot(), json.readUint(".emptyRoot"), "emptyRoot");
        assertEq(fresh.ZERO_VALUE(), json.readUint(".zeroLeaf"));
        uint256[] memory zeros = json.readUintArray(".zeros");
        for (uint256 i; i < 23; i++) {
            assertEq(fresh.zeros(i), zeros[i], "zeros[i]");
        }
        // chunk root: insert [1, 2, ZERO, ZERO] at index 0 through the module hook
        fresh.setModules(address(this), address(planter));
        uint256[] memory leaves = json.readUintArray(".chunk.leaves");
        fresh.insertChunk([leaves[0], leaves[1], leaves[2], leaves[3]], new bytes[](0));
        assertEq(fresh.getLastRoot(), json.readUint(".chunk.root"), "chunk root");

        // intent leaf and result leaves (epochKey for the fixture coin, seq 3, SELL)
        address fcoin = 0x3333333333333333333333333333333333333333;
        uint256 ek = dc.epochKey(fcoin, 3, 1);
        assertEq(ek, json.readUint(".epochKey_coin_3_sell"), "epochKey");
        assertEq(dc.intentLeaf(json.readUint(".note.commitment"), ek), json.readUint(".intentLeaf"), "intentLeaf");
        assertEq(dc.resultLeaf(ek, 10, 20, 30, 40), json.readUint(".resultLeaf"), "resultLeaf");
        assertEq(dc.resultLeaf(ek, 1, 0, 1, 40), json.readUint(".voidResultLeaf_rpt40"), "void result leaf");
    }
}
