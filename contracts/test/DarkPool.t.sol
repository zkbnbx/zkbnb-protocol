// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {BaseTest} from "./Base.t.sol";
import {DarkPool} from "../src/DarkPool.sol";
import {DarkVault} from "../src/DarkVault.sol";
import {Launchpad} from "../src/Launchpad.sol";
import {ShieldedPool} from "../src/ShieldedPool.sol";
import {PayoutMode} from "../src/interfaces/IGrove.sol";

/// @notice privacy/DARKPOOL-SPEC.md §1.5. MockVerifier accepts any proof, so a shielded withdrawal
///         is forged by building ExtData / Proof consistently (like Security.t.sol's _withdrawProof)
///         after dealing BNB to the pool.
contract DarkPoolTest is BaseTest {
    DarkPool internal darkPool;
    DarkVault internal impl;
    address internal coin;
    address internal vaultOwner;
    uint256 internal vaultOwnerPk;
    address internal relayer = makeAddr("relayer");
    address internal submitter = makeAddr("submitter");
    address internal attacker = makeAddr("attacker");

    uint256 internal constant PUBKEY = 1234;
    uint256 internal constant BLINDING = 99;
    uint256 internal constant FEE = 0.001 ether;

    event Trade(
        address indexed coin,
        address indexed trader,
        bool isBuy,
        uint256 bnb,
        uint256 tokens,
        uint256 fee,
        uint256 priceAfter,
        uint256 realBnbAfter
    );
    event DepositFor(uint256 indexed pubKey, uint256 amount, uint256 blinding, uint256 index, address indexed from);
    event VaultCreated(
        address indexed vault,
        address indexed owner,
        address indexed coin,
        uint256 bnbIn,
        uint256 tokensOut,
        bool bought,
        bytes32 nonce
    );
    event Sold(uint256 tokensIn, uint256 bnbOut, uint256 fee, uint256 pubKey, uint256 leafIndex, bool viaRouter);
    event Harvested(uint256 tokensBurned, uint256 bnbOut, uint256 fee, uint256 pubKey, uint256 leafIndex);
    event Shielded(uint256 amount, uint256 fee, uint256 pubKey, uint256 leafIndex);
    event Relayed(address indexed relayer, uint256 nonce, uint256 fee, bytes4 selector);

    function setUp() public override {
        super.setUp();
        darkPool = new DarkPool(address(pool), address(launchpad), address(router));
        impl = DarkVault(payable(darkPool.vaultImpl()));
        (vaultOwner, vaultOwnerPk) = makeAddrAndKey("vaultOwner");
        coin = plantCoin(alice, PayoutMode.Holders);
        buy(bob, coin, 2 ether); // some volume so the coin's roots hold BNB
        vm.deal(address(pool), 100 ether);
    }

    // ------------------------------------------------------------- helpers

    function _order(uint256 bnbIn, uint256 minTokensOut, uint64 deadline, bytes32 nonce)
        internal
        view
        returns (DarkPool.Order memory)
    {
        return DarkPool.Order({
            coin: coin,
            bnbIn: bnbIn,
            minTokensOut: minTokensOut,
            owner: vaultOwner,
            deadline: deadline,
            nonce: nonce
        });
    }

    /// @dev A forged withdrawal of `amount` to `recipient`, `fee` to `relayer`, nullifiers n0 / n0+1.
    function _proof(address recipient, uint256 amount, uint256 fee, uint256 n0)
        internal
        view
        returns (ShieldedPool.Proof memory p, ShieldedPool.ExtData memory e)
    {
        e = ShieldedPool.ExtData({
            recipient: recipient,
            extAmount: -SafeCast.toInt256(amount),
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

    /// @dev Buy `bnbIn` of `coin` through the dark pool on the curve, relayer fee FEE.
    function _fill(uint256 bnbIn, uint256 n0) internal returns (DarkVault vault, DarkPool.Order memory o) {
        o = _order(bnbIn, 0, 0, keccak256(abi.encode("order", n0)));
        address predicted = darkPool.vaultFor(o);
        (ShieldedPool.Proof memory p, ShieldedPool.ExtData memory e) = _proof(predicted, bnbIn, FEE, n0);
        vm.prank(relayer);
        vault = DarkVault(payable(darkPool.transactAndFill(p, e, o)));
        assertEq(address(vault), predicted);
    }

    function _sign(DarkVault vault, bytes memory data, uint256 fee, uint256 deadline, uint256 pk)
        internal
        view
        returns (bytes memory)
    {
        // every relay in these tests is submitted by `submitter`: the digest binds that address
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, vault.relayDigest(data, fee, deadline, vault.nonce(), submitter));
        return abi.encodePacked(r, s, v);
    }

    /// @dev Owner-signed relay submitted by `submitter`.
    function _relay(DarkVault vault, bytes memory data, uint256 fee) internal {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(vault, data, fee, deadline, vaultOwnerPk);
        vm.prank(submitter);
        vault.relay(data, fee, deadline, sig);
    }

    // ------------------------------------------------------ 1. vaultFor

    function test_vaultFor_stableAndBoundToEveryField() public view {
        DarkPool.Order memory o = _order(1 ether, 5, 123, bytes32(uint256(7)));
        address base = darkPool.vaultFor(o);
        assertEq(darkPool.vaultFor(o), base, "stable");
        assertEq(base.code.length, 0, "counterfactual");

        DarkPool.Order memory m = o;
        m.coin = address(grove);
        assertTrue(darkPool.vaultFor(m) != base, "coin");
        m = o;
        m.bnbIn = 1 ether + 1;
        assertTrue(darkPool.vaultFor(m) != base, "bnbIn");
        m = o;
        m.minTokensOut = 6;
        assertTrue(darkPool.vaultFor(m) != base, "minTokensOut");
        m = o;
        m.owner = bob;
        assertTrue(darkPool.vaultFor(m) != base, "owner");
        m = o;
        m.deadline = 124;
        assertTrue(darkPool.vaultFor(m) != base, "deadline");
        m = o;
        m.nonce = bytes32(uint256(8));
        assertTrue(darkPool.vaultFor(m) != base, "nonce");
    }

    // -------------------------------------------- 2. transactAndFill, curve

    function test_transactAndFill_onCurve() public {
        uint256 bnbIn = 1 ether;
        (uint256 expectedOut,,) = launchpad.quoteBuy(coin, bnbIn);
        DarkPool.Order memory o = _order(bnbIn, expectedOut, 0, bytes32(uint256(1)));
        address vault = darkPool.vaultFor(o);
        (ShieldedPool.Proof memory p, ShieldedPool.ExtData memory e) = _proof(vault, bnbIn, FEE, 10);
        uint256 poolBefore = address(pool).balance;
        uint256 relayerBefore = relayer.balance;

        vm.expectEmit(true, true, false, false, address(launchpad));
        emit Trade(coin, vault, true, 0, 0, 0, 0, 0);
        vm.expectEmit(true, true, true, true, address(darkPool));
        emit VaultCreated(vault, vaultOwner, coin, bnbIn, expectedOut, true, o.nonce);
        vm.prank(relayer);
        address created = darkPool.transactAndFill(p, e, o);

        assertEq(created, vault, "returns the predicted vault");
        assertTrue(darkPool.isVault(vault), "isVault");
        assertEq(darkPool.vaultCount(), 1);
        assertEq(IERC20(coin).balanceOf(vault), expectedOut, "vault holds the tokens");
        assertEq(vault.balance, 0, "all BNB spent");
        assertEq(relayer.balance - relayerBefore, FEE, "relayer got e.fee");
        assertEq(poolBefore - address(pool).balance, bnbIn + FEE, "pool paid vault + fee");
        assertTrue(pool.isSpent(10) && pool.isSpent(11), "nullifiers spent");
        DarkVault v = DarkVault(payable(vault));
        assertEq(v.owner(), vaultOwner);
        assertEq(v.coin(), coin);
        assertEq(v.nonce(), 0);
    }

    // ------------------------------------------ 3. transactAndFill, router

    function test_transactAndFill_afterGraduation_viaRouter() public {
        graduate(coin);
        assertTrue(launchpad.isGraduated(coin));
        uint256 bnbIn = 0.5 ether;
        address[] memory path = new address[](2);
        path[0] = address(wbnb);
        path[1] = coin;
        uint256 quoted = router.getAmountsOut(bnbIn, path)[1];
        uint256 minOut = quoted * 97 / 100; // the pair tax takes 2% on the way out of the pair

        DarkPool.Order memory o = _order(bnbIn, minOut, 0, bytes32(uint256(2)));
        address vault = darkPool.vaultFor(o);
        (ShieldedPool.Proof memory p, ShieldedPool.ExtData memory e) = _proof(vault, bnbIn, FEE, 20);
        vm.prank(relayer);
        darkPool.transactAndFill(p, e, o);

        uint256 got = IERC20(coin).balanceOf(vault);
        assertGe(got, minOut, "minTokensOut respected");
        assertLe(got, quoted, "taxed on the way");
        assertTrue(darkPool.isVault(vault));

        // too-high minTokensOut: the router refuses and nothing happens
        DarkPool.Order memory bad = _order(bnbIn, quoted * 2, 0, bytes32(uint256(3)));
        address badVault = darkPool.vaultFor(bad);
        (p, e) = _proof(badVault, bnbIn, FEE, 30);
        vm.prank(relayer);
        vm.expectRevert(bytes("PancakeRouter: INSUFFICIENT_OUTPUT_AMOUNT"));
        darkPool.transactAndFill(p, e, bad);
        assertFalse(pool.isSpent(30));
        assertEq(badVault.code.length, 0);
    }

    // ------------------------------------- 4. slippage reverts everything

    function test_transactAndFill_slippageRevertsWhole() public {
        uint256 bnbIn = 1 ether;
        (uint256 expectedOut,,) = launchpad.quoteBuy(coin, bnbIn);
        DarkPool.Order memory o = _order(bnbIn, expectedOut + 1, 0, bytes32(uint256(4)));
        address vault = darkPool.vaultFor(o);
        (ShieldedPool.Proof memory p, ShieldedPool.ExtData memory e) = _proof(vault, bnbIn, FEE, 40);
        uint256 poolBefore = address(pool).balance;

        vm.prank(relayer);
        vm.expectRevert(Launchpad.Slippage.selector);
        darkPool.transactAndFill(p, e, o);

        assertFalse(pool.isSpent(40), "nullifier 0 unspent");
        assertFalse(pool.isSpent(41), "nullifier 1 unspent");
        assertEq(address(pool).balance, poolBefore, "pool balance intact");
        assertEq(vault.code.length, 0, "no vault");
        assertEq(vault.balance, 0);
        assertFalse(darkPool.isVault(vault));
        assertEq(darkPool.vaultCount(), 0);

        // the user re-proves with a looser order: same nullifiers still work
        o.minTokensOut = expectedOut;
        vault = darkPool.vaultFor(o);
        (p, e) = _proof(vault, bnbIn, FEE, 40);
        vm.prank(relayer);
        darkPool.transactAndFill(p, e, o);
        assertEq(IERC20(coin).balanceOf(vault), expectedOut);
    }

    // ------------------------------------ 5. recipient / amount binding

    function test_transactAndFill_recipientAndAmountMustMatch() public {
        uint256 bnbIn = 1 ether;
        DarkPool.Order memory o = _order(bnbIn, 0, 0, bytes32(uint256(5)));
        address vault = darkPool.vaultFor(o);

        (ShieldedPool.Proof memory p, ShieldedPool.ExtData memory e) = _proof(bob, bnbIn, FEE, 50);
        vm.expectRevert(DarkPool.BadRecipient.selector);
        darkPool.transactAndFill(p, e, o);

        (p, e) = _proof(vault, bnbIn - 1, FEE, 50);
        vm.expectRevert(DarkPool.BadAmount.selector);
        darkPool.transactAndFill(p, e, o);

        // a deposit (extAmount > 0) is never a fill
        (p, e) = _proof(vault, bnbIn, FEE, 50);
        e.extAmount = SafeCast.toInt256(bnbIn);
        vm.expectRevert(DarkPool.BadAmount.selector);
        darkPool.transactAndFill(p, e, o);

        // past the order's deadline
        DarkPool.Order memory late = _order(bnbIn, 0, uint64(block.timestamp - 1), bytes32(uint256(6)));
        (p, e) = _proof(darkPool.vaultFor(late), bnbIn, FEE, 50);
        vm.expectRevert(DarkPool.Expired.selector);
        darkPool.transactAndFill(p, e, late);

        // a vault that already exists cannot be filled again
        (p, e) = _proof(vault, bnbIn, FEE, 50);
        darkPool.transactAndFill(p, e, o);
        (p, e) = _proof(vault, bnbIn, FEE, 60);
        vm.expectRevert(DarkPool.AlreadyFilled.selector);
        darkPool.transactAndFill(p, e, o);
        assertFalse(pool.isSpent(60), "checked before the proof is consumed");
    }

    // ----------------------------------------------------------- 6. fill

    function test_fill_needsFundingAndOnlyOnce() public {
        uint256 bnbIn = 1 ether;
        DarkPool.Order memory o = _order(bnbIn, 0, 0, bytes32(uint256(7)));
        address vault = darkPool.vaultFor(o);

        vm.expectRevert(DarkPool.NotFunded.selector);
        darkPool.fill(o);

        vm.deal(vault, bnbIn - 1);
        vm.expectRevert(DarkPool.NotFunded.selector);
        darkPool.fill(o);

        vm.deal(vault, bnbIn);
        (uint256 expectedOut,,) = launchpad.quoteBuy(coin, bnbIn);
        vm.expectEmit(true, true, true, true, address(darkPool));
        emit VaultCreated(vault, vaultOwner, coin, bnbIn, expectedOut, true, o.nonce);
        vm.prank(carol); // anyone can fill
        address created = darkPool.fill(o);
        assertEq(created, vault);
        assertEq(IERC20(coin).balanceOf(vault), expectedOut);
        assertEq(vault.balance, 0);
        assertTrue(darkPool.isVault(vault));

        vm.deal(vault, bnbIn);
        vm.expectRevert(DarkPool.AlreadyFilled.selector);
        darkPool.fill(o);
    }

    // ------------------------------------- 7. fill past deadline + shield

    function test_fill_pastDeadline_keepsBnb_thenShieldBack() public {
        uint256 bnbIn = 1 ether;
        DarkPool.Order memory o = _order(bnbIn, 0, uint64(block.timestamp + 100), bytes32(uint256(8)));
        address vaultAddr = darkPool.vaultFor(o);
        vm.deal(vaultAddr, bnbIn);
        vm.warp(block.timestamp + 101);

        vm.expectEmit(true, true, true, true, address(darkPool));
        emit VaultCreated(vaultAddr, vaultOwner, coin, bnbIn, 0, false, o.nonce);
        darkPool.fill(o);
        DarkVault vault = DarkVault(payable(vaultAddr));
        assertTrue(darkPool.isVault(vaultAddr));
        assertEq(vault.owner(), vaultOwner);
        assertEq(IERC20(coin).balanceOf(vaultAddr), 0, "nothing bought");
        assertEq(vaultAddr.balance, bnbIn, "BNB stays in the vault");

        // the owner shields it back through a relay; the submitter is paid the fee
        uint256 poolBefore = address(pool).balance;
        uint256 submitterBefore = submitter.balance;
        bytes memory data = abi.encodeCall(DarkVault.shield, (0, PUBKEY, BLINDING));
        vm.expectEmit(true, true, true, true, address(pool));
        emit DepositFor(PUBKEY, bnbIn - FEE, BLINDING, pool.nextIndex(), vaultAddr);
        vm.expectEmit(true, true, true, true, vaultAddr);
        emit Shielded(bnbIn - FEE, FEE, PUBKEY, pool.nextIndex());
        vm.expectEmit(true, true, true, true, vaultAddr);
        emit Relayed(submitter, 0, FEE, DarkVault.shield.selector);
        _relay(vault, data, FEE);

        assertEq(address(pool).balance - poolBefore, bnbIn - FEE, "amount - fee into the pool");
        assertEq(submitter.balance - submitterBefore, FEE, "fee to the submitter");
        assertEq(vaultAddr.balance, 0);
        assertEq(vault.nonce(), 1);
    }

    // ---------------------------------------------------- 8. relay(sell)

    function test_relay_sell_onCurve() public {
        (DarkVault vault, ) = _fill(1 ether, 80);
        uint256 tokens = IERC20(coin).balanceOf(address(vault));
        (uint256 net,,) = launchpad.quoteSell(coin, tokens);
        assertGt(net, FEE);
        uint256 poolBefore = address(pool).balance;
        uint256 submitterBefore = submitter.balance;
        uint256 idx = pool.nextIndex();

        bytes memory data = abi.encodeCall(DarkVault.sell, (tokens, net, PUBKEY, BLINDING));
        vm.expectEmit(true, true, true, true, address(pool));
        emit DepositFor(PUBKEY, net - FEE, BLINDING, idx, address(vault));
        vm.expectEmit(true, true, true, true, address(vault));
        emit Sold(tokens, net, FEE, PUBKEY, idx, false);
        vm.expectEmit(true, true, true, true, address(vault));
        emit Relayed(submitter, 0, FEE, DarkVault.sell.selector);
        _relay(vault, data, FEE);

        assertEq(address(pool).balance - poolBefore, net - FEE, "proceeds minus fee in the pool");
        assertEq(submitter.balance - submitterBefore, FEE, "fee paid to msg.sender");
        assertEq(IERC20(coin).balanceOf(address(vault)), 0);
        assertEq(address(vault).balance, 0, "nothing left behind");
        assertEq(vault.nonce(), 1, "nonce incremented");
    }

    function test_relay_sell_afterGraduation_viaRouter() public {
        (DarkVault vault, ) = _fill(1 ether, 81);
        graduate(coin);
        uint256 tokens = IERC20(coin).balanceOf(address(vault));
        uint256 poolBefore = address(pool).balance;
        uint256 submitterBefore = submitter.balance;

        _relay(vault, abi.encodeCall(DarkVault.sell, (tokens, 1, PUBKEY, BLINDING)), FEE);

        assertGt(address(pool).balance - poolBefore, 0, "router proceeds minus fee in the pool");
        assertEq(submitter.balance - submitterBefore, FEE);
        assertEq(IERC20(coin).balanceOf(address(vault)), 0);
        assertEq(address(vault).balance, 0);
    }

    function test_relay_sell_feeMustFitInProceeds() public {
        (DarkVault vault, ) = _fill(1 ether, 82);
        uint256 tokens = IERC20(coin).balanceOf(address(vault));
        (uint256 net,,) = launchpad.quoteSell(coin, tokens);
        bytes memory data = abi.encodeCall(DarkVault.sell, (tokens, 0, PUBKEY, BLINDING));
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(vault, data, net, deadline, vaultOwnerPk);
        vm.prank(submitter);
        vm.expectRevert(DarkVault.FeeExceedsProceeds.selector);
        vault.relay(data, net, deadline, sig);
    }

    // ------------------------------------------------ 9. relay rejections

    function test_relay_rejections() public {
        (DarkVault vault, ) = _fill(1 ether, 90);
        vm.deal(address(vault), 1 ether); // BNB to shield / to pay fees from
        bytes memory data = abi.encodeCall(DarkVault.shield, (0.1 ether, PUBKEY, BLINDING));
        uint256 deadline = block.timestamp + 1 hours;

        // replay: the same signature a second time
        bytes memory sig = _sign(vault, data, FEE, deadline, vaultOwnerPk);
        vm.prank(submitter);
        vault.relay(data, FEE, deadline, sig);
        assertEq(vault.nonce(), 1);
        vm.prank(submitter);
        vm.expectRevert(DarkVault.BadSignature.selector);
        vault.relay(data, FEE, deadline, sig);

        // wrong signer
        (, uint256 strangerPk) = makeAddrAndKey("stranger");
        sig = _sign(vault, data, FEE, deadline, strangerPk);
        vm.prank(submitter);
        vm.expectRevert(DarkVault.BadSignature.selector);
        vault.relay(data, FEE, deadline, sig);

        // signature over different fee / deadline / data
        sig = _sign(vault, data, FEE, deadline, vaultOwnerPk);
        vm.prank(submitter);
        vm.expectRevert(DarkVault.BadSignature.selector);
        vault.relay(data, FEE + 1, deadline, sig);
        vm.prank(submitter);
        vm.expectRevert(DarkVault.BadSignature.selector);
        vault.relay(data, FEE, deadline + 1, sig);
        vm.prank(submitter);
        vm.expectRevert(DarkVault.BadSignature.selector);
        vault.relay(abi.encodeCall(DarkVault.shield, (0.2 ether, PUBKEY, BLINDING)), FEE, deadline, sig);

        // malformed signature
        vm.prank(submitter);
        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureLength.selector, 3));
        vault.relay(data, FEE, deadline, hex"010203");

        // expired
        sig = _sign(vault, data, FEE, block.timestamp - 1, vaultOwnerPk);
        vm.prank(submitter);
        vm.expectRevert(DarkVault.Expired.selector);
        vault.relay(data, FEE, block.timestamp - 1, sig);

        // forbidden selectors and short data
        bytes[4] memory bad = [
            abi.encodeCall(DarkVault.initialize, (bob, coin)),
            abi.encodeCall(DarkVault.buyFromFactory, (1, 0, type(uint256).max)),
            abi.encodeCall(DarkVault.relay, (data, 0, deadline, sig)),
            bytes(hex"0102")
        ];
        for (uint256 i; i < bad.length; i++) {
            sig = _sign(vault, bad[i], 0, deadline, vaultOwnerPk);
            vm.prank(submitter);
            vm.expectRevert(DarkVault.BadCall.selector);
            vault.relay(bad[i], 0, deadline, sig);
        }

        // the inner revert bubbles: slippage on sell
        uint256 tokens = IERC20(coin).balanceOf(address(vault));
        data = abi.encodeCall(DarkVault.sell, (tokens, type(uint256).max, PUBKEY, BLINDING));
        sig = _sign(vault, data, FEE, deadline, vaultOwnerPk);
        vm.prank(submitter);
        vm.expectRevert(Launchpad.Slippage.selector);
        vault.relay(data, FEE, deadline, sig);
        assertEq(vault.nonce(), 1, "a reverted relay consumes nothing");

        // the fee must be payable: buy spends everything, nothing left for the submitter
        data = abi.encodeCall(DarkVault.buy, (address(vault).balance, 0));
        sig = _sign(vault, data, FEE, deadline, vaultOwnerPk);
        vm.prank(submitter);
        vm.expectRevert(DarkVault.FeeUnpaid.selector);
        vault.relay(data, FEE, deadline, sig);
    }

    // ------------------------------------------------- 10. relay(harvest)

    function test_relay_harvest_burnsViaRoots() public {
        (DarkVault vault, ) = _fill(1 ether, 100);
        uint256 tokens = IERC20(coin).balanceOf(address(vault)) / 2;
        uint256 expected = roots.harvestValue(coin, tokens);
        assertGt(expected, 0, "roots hold something to harvest");
        uint256 fee = expected / 10; // the roots of a young coin are small: fee sized to fit
        uint256 supplyBefore = IERC20(coin).totalSupply();
        uint256 rootsBefore = roots.balance(coin);
        uint256 poolBefore = address(pool).balance;
        uint256 submitterBefore = submitter.balance;
        uint256 idx = pool.nextIndex();

        bytes memory data = abi.encodeCall(DarkVault.harvest, (tokens, expected, PUBKEY, BLINDING));
        vm.expectEmit(true, true, true, true, address(pool));
        emit DepositFor(PUBKEY, expected - fee, BLINDING, idx, address(vault));
        vm.expectEmit(true, true, true, true, address(vault));
        emit Harvested(tokens, expected, fee, PUBKEY, idx);
        _relay(vault, data, fee);

        assertEq(supplyBefore - IERC20(coin).totalSupply(), tokens, "burned");
        assertEq(rootsBefore - roots.balance(coin), expected);
        assertEq(address(pool).balance - poolBefore, expected - fee);
        assertEq(submitter.balance - submitterBefore, fee);
        assertEq(address(vault).balance, 0);
    }

    // ---------------------------------------------------- 11. relay(exec)

    function test_relay_exec_movesTokensOut() public {
        (DarkVault vault, ) = _fill(1 ether, 110);
        uint256 tokens = IERC20(coin).balanceOf(address(vault));
        vm.deal(address(vault), FEE); // exec leaves the fee to whatever BNB the vault holds
        uint256 submitterBefore = submitter.balance;

        bytes memory inner = abi.encodeCall(IERC20.transfer, (bob, tokens));
        uint256 bobBefore = IERC20(coin).balanceOf(bob);
        _relay(vault, abi.encodeCall(DarkVault.exec, (coin, 0, inner)), FEE);

        assertEq(IERC20(coin).balanceOf(bob) - bobBefore, tokens, "tokens moved out");
        assertEq(IERC20(coin).balanceOf(address(vault)), 0);
        assertEq(submitter.balance - submitterBefore, FEE);
        assertEq(address(vault).balance, 0);

        // exec cannot target the vault itself, and inner reverts bubble
        bytes memory self = abi.encodeCall(DarkVault.exec, (address(vault), 0, ""));
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(vault, self, 0, deadline, vaultOwnerPk);
        vm.prank(submitter);
        vm.expectRevert(DarkVault.BadTarget.selector);
        vault.relay(self, 0, deadline, sig);

        bytes memory failing = abi.encodeCall(DarkVault.exec, (coin, 0, inner)); // nothing left to transfer
        sig = _sign(vault, failing, 0, deadline, vaultOwnerPk);
        vm.prank(submitter);
        vm.expectRevert();
        vault.relay(failing, 0, deadline, sig);
    }

    // ------------------------------------------- 12. direct owner calls

    function test_directOwnerCall_noSignature_strangerReverts() public {
        (DarkVault vault, ) = _fill(1 ether, 120);
        vm.deal(address(vault), 1 ether);

        // stranger
        vm.prank(bob);
        vm.expectRevert(DarkVault.NotOwner.selector);
        vault.shield(0, PUBKEY, BLINDING);
        vm.prank(bob);
        vm.expectRevert(DarkVault.NotOwner.selector);
        vault.buy(0.5 ether, 0);
        vm.prank(bob);
        vm.expectRevert(DarkVault.NotOwner.selector);
        vault.sell(1, 0, PUBKEY, BLINDING);
        vm.prank(bob);
        vm.expectRevert(DarkVault.NotOwner.selector);
        vault.harvest(1, 0, PUBKEY, BLINDING);
        vm.prank(bob);
        vm.expectRevert(DarkVault.NotOwner.selector);
        vault.exec(coin, 0, "");

        // owner: buy with the vault's BNB, then shield the rest, no fee involved
        uint256 tokensBefore = IERC20(coin).balanceOf(address(vault));
        vm.prank(vaultOwner);
        vault.buy(0.5 ether, 0);
        assertGt(IERC20(coin).balanceOf(address(vault)), tokensBefore, "bought more");
        assertEq(address(vault).balance, 0.5 ether);

        uint256 poolBefore = address(pool).balance;
        vm.expectEmit(true, true, true, true, address(vault));
        emit Shielded(0.5 ether, 0, PUBKEY, pool.nextIndex());
        vm.prank(vaultOwner);
        vault.shield(0, PUBKEY, BLINDING);
        assertEq(address(pool).balance - poolBefore, 0.5 ether);
        assertEq(address(vault).balance, 0);
        assertEq(vault.nonce(), 0, "direct calls do not touch the relay nonce");
    }

    // --------------------------------------- 13. initialize / impl / factory

    function test_initialize_once_implLocked_factoryOnly() public {
        (DarkVault vault, ) = _fill(1 ether, 130);

        vm.prank(address(darkPool));
        vm.expectRevert(DarkVault.AlreadyInitialized.selector);
        vault.initialize(bob, coin);

        vm.prank(bob);
        vm.expectRevert(DarkVault.NotFactory.selector);
        vault.initialize(bob, coin);

        assertEq(impl.owner(), address(1), "implementation locked");
        vm.prank(address(darkPool));
        vm.expectRevert(DarkVault.AlreadyInitialized.selector);
        impl.initialize(bob, coin);
        vm.prank(bob);
        vm.expectRevert(DarkVault.NotOwner.selector);
        impl.shield(0, PUBKEY, BLINDING);

        vm.deal(address(vault), 1 ether);
        vm.prank(bob);
        vm.expectRevert(DarkVault.NotFactory.selector);
        vault.buyFromFactory(1 ether, 0, type(uint256).max);
        vm.prank(vaultOwner);
        vm.expectRevert(DarkVault.NotFactory.selector);
        vault.buyFromFactory(1 ether, 0, type(uint256).max);

        assertEq(impl.factory(), address(darkPool));
        assertEq(address(impl.roots()), address(roots));
        assertEq(impl.weth(), address(wbnb));
    }

    // ------------------------------------------------------------ 14. gas

    function test_gas_transactAndFill_onCurve() public {
        uint256 bnbIn = 1 ether;
        DarkPool.Order memory o = _order(bnbIn, 0, 0, bytes32(uint256(14)));
        address vault = darkPool.vaultFor(o);
        (ShieldedPool.Proof memory p, ShieldedPool.ExtData memory e) = _proof(vault, bnbIn, FEE, 140);
        vm.prank(relayer);
        uint256 g = gasleft();
        darkPool.transactAndFill(p, e, o);
        uint256 used = g - gasleft();
        // ~1.87M: ShieldedPool.transact alone is ~1.53M (two Merkle inserts, 40 Poseidon hashes) with
        // the mock verifier; the dark-pool part (clone + initialize + curve buy + registry) is ~0.34M.
        // The real Groth16 verifier adds ~0.25M, so the relayer's fill quote must budget ~2.2M+.
        console2.log("transactAndFill gas on the curve (mock verifier):", used);
        assertLt(used, 2_500_000, "transactAndFill gas regression");
    }

    // ------------------------------------------------- 15. review round
    // Contract-security review of the dark-pool work (findings 1, 2, 5, 6).

    /// @dev Finding 1: the pool binds the proof to ExtData, not to msg.sender, so anyone who sees
    ///      (p, e) can submit the bare withdrawal first. The BNB then sits at the counterfactual
    ///      address, transactAndFill reverts AlreadySpent, and only `fill(o)` with the full order
    ///      recovers it (a guessed nonce is a different address). The client keeps the order until
    ///      the vault exists for exactly this case.
    function test_review_directTransactStrandsBnb_fillRecovers() public {
        uint256 bnbIn = 1 ether;
        (uint256 expectedOut,,) = launchpad.quoteBuy(coin, bnbIn);
        DarkPool.Order memory o = _order(bnbIn, expectedOut, uint64(block.timestamp + 600), bytes32(uint256(151)));
        address vault = darkPool.vaultFor(o);
        (ShieldedPool.Proof memory p, ShieldedPool.ExtData memory e) = _proof(vault, bnbIn, FEE, 150);

        vm.prank(attacker);
        pool.transact(p, e);
        assertEq(vault.balance, bnbIn, "BNB paid to the counterfactual address");
        assertEq(vault.code.length, 0, "no vault code");
        assertFalse(darkPool.isVault(vault));
        assertTrue(pool.isSpent(150) && pool.isSpent(151), "the user's notes are spent");

        vm.prank(relayer);
        vm.expectRevert(ShieldedPool.AlreadySpent.selector);
        darkPool.transactAndFill(p, e, o);

        // a guessed nonce is a different address (memory structs alias, so build a fresh one)
        DarkPool.Order memory guess = _order(bnbIn, expectedOut, o.deadline, bytes32(uint256(152)));
        vm.expectRevert(DarkPool.NotFunded.selector);
        darkPool.fill(guess);

        // the order itself is the key: the lenient fill still buys while the deadline holds
        vm.expectEmit(true, true, true, true, address(darkPool));
        emit VaultCreated(vault, vaultOwner, coin, bnbIn, expectedOut, true, o.nonce);
        darkPool.fill(o);
        assertEq(IERC20(coin).balanceOf(vault), expectedOut, "recovered and bought");
        assertEq(vault.balance, 0);
        assertEq(DarkVault(payable(vault)).owner(), vaultOwner);
    }

    /// @dev Finding 2: a buy that dies without revert data (out of gas) must not create an
    ///      unbought vault. Before the fix a 1 BNB curve fill with ~261k-334k gas registered the
    ///      vault with bought = false; now it reverts FillFailed. Sweep the stipend: every call
    ///      either reverts (creating nothing) or buys.
    function test_review_fill_outOfGasBuyReverts_FillFailed() public {
        uint256 bnbIn = 1 ether;
        DarkPool.Order memory o = _order(bnbIn, 0, 0, bytes32(uint256(153)));
        address vault = darkPool.vaultFor(o);
        vm.deal(vault, bnbIn);

        vm.prank(attacker);
        vm.expectRevert(DarkPool.FillFailed.selector);
        darkPool.fill{gas: 300_000}(o);
        assertEq(vault.code.length, 0, "nothing created");
        assertEq(vault.balance, bnbIn, "BNB untouched");
        assertFalse(darkPool.isVault(vault));

        bool sawFillFailed;
        bool sawBuy;
        for (uint256 g = 450_000; g >= 150_000; g -= 2_000) {
            uint256 s = vm.snapshotState();
            vm.prank(attacker);
            (bool ok, bytes memory ret) = address(darkPool).call{gas: g}(abi.encodeCall(DarkPool.fill, (o)));
            if (ok) {
                assertGt(IERC20(coin).balanceOf(vault), 0, "a successful fill always buys");
                sawBuy = true;
            } else {
                assertEq(vault.code.length, 0, "a failed fill creates nothing");
                if (keccak256(ret) == keccak256(abi.encodeWithSelector(DarkPool.FillFailed.selector))) sawFillFailed = true;
            }
            vm.revertToState(s);
        }
        assertTrue(sawBuy, "sweep reached the buying side");
        assertTrue(sawFillFailed, "sweep crossed the former grief window");
    }

    /// @dev Finding 2, the other side: a genuine revert (slippage) is still lenient.
    function test_review_fill_slippageStaysLenient() public {
        uint256 bnbIn = 1 ether;
        (uint256 expectedOut,,) = launchpad.quoteBuy(coin, bnbIn);
        DarkPool.Order memory o = _order(bnbIn, expectedOut + 1, 0, bytes32(uint256(154)));
        address vault = darkPool.vaultFor(o);
        vm.deal(vault, bnbIn);

        vm.expectEmit(true, true, true, true, address(darkPool));
        emit VaultCreated(vault, vaultOwner, coin, bnbIn, 0, false, o.nonce);
        darkPool.fill(o);
        assertEq(vault.balance, bnbIn, "BNB stays in the vault");
        assertEq(IERC20(coin).balanceOf(vault), 0);
        assertTrue(darkPool.isVault(vault));
    }

    /// @dev Finding 5: an order with bnbIn == 0 would pass the NotFunded gate and let anyone
    ///      register empty vaults for any owner / coin.
    function test_review_fill_zeroBnbInReverts() public {
        DarkPool.Order memory o = _order(0, 0, 0, bytes32(uint256(155)));
        address vault = darkPool.vaultFor(o);
        vm.expectRevert(DarkPool.BadAmount.selector);
        darkPool.fill(o);
        vm.deal(vault, 1 ether); // even funded, the order itself is invalid
        vm.expectRevert(DarkPool.BadAmount.selector);
        darkPool.fill(o);
        assertEq(vault.code.length, 0);
        assertEq(darkPool.vaultCount(), 0);
    }

    /// @dev Finding 6d: two vaults share an owner key and sit at nonce 0; a relay signed for one
    ///      must not work on the other (OZ EIP712 rebuilds the domain separator per clone).
    function test_review_relay_signatureBoundToVault() public {
        (DarkVault a,) = _fill(1 ether, 160);
        (DarkVault b,) = _fill(1 ether, 162);
        assertEq(a.owner(), b.owner());
        assertEq(a.nonce(), 0);
        assertEq(b.nonce(), 0);
        vm.deal(address(a), 1 ether);
        vm.deal(address(b), 1 ether);

        bytes memory data = abi.encodeCall(DarkVault.shield, (0, PUBKEY, BLINDING));
        uint256 deadline = block.timestamp + 1 hours;
        assertTrue(a.relayDigest(data, FEE, deadline, 0, submitter) != b.relayDigest(data, FEE, deadline, 0, submitter), "per-clone domain");
        bytes memory sig = _sign(a, data, FEE, deadline, vaultOwnerPk);

        vm.prank(submitter);
        vm.expectRevert(DarkVault.BadSignature.selector);
        b.relay(data, FEE, deadline, sig);
        assertEq(address(b).balance, 1 ether);

        vm.prank(submitter);
        a.relay(data, FEE, deadline, sig);
        assertEq(a.nonce(), 1);
        assertEq(b.nonce(), 0);
    }

    /// @dev Finding 6e: a relay signature does not survive a chain-id fork.
    function test_review_relay_signatureBoundToChain() public {
        (DarkVault vault,) = _fill(1 ether, 164);
        vm.deal(address(vault), 1 ether);
        bytes memory data = abi.encodeCall(DarkVault.shield, (0, PUBKEY, BLINDING));
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(vault, data, FEE, deadline, vaultOwnerPk);

        bytes32 homeDigest = vault.relayDigest(data, FEE, deadline, 0, submitter);
        vm.chainId(block.chainid + 1); // (the optimizer re-reads CHAINID, so do not cache and restore it)
        assertTrue(vault.relayDigest(data, FEE, deadline, 0, submitter) != homeDigest, "domain follows the chain id");
        vm.prank(submitter);
        vm.expectRevert(DarkVault.BadSignature.selector);
        vault.relay(data, FEE, deadline, sig);
        assertEq(vault.nonce(), 0);

        // signed on this chain it works
        sig = _sign(vault, data, FEE, deadline, vaultOwnerPk);
        vm.prank(submitter);
        vault.relay(data, FEE, deadline, sig);
        assertEq(vault.nonce(), 1);
    }

    /// @dev Finding 6f: the lenient fill on a graduated coin; the router's revert is swallowed,
    ///      the BNB stays and the owner can retry with a sane minimum.
    function test_review_fill_graduated_routerRevertStaysLenient() public {
        graduate(coin);
        uint256 bnbIn = 0.5 ether;
        DarkPool.Order memory o = _order(bnbIn, type(uint128).max, 0, bytes32(uint256(165)));
        address vaultAddr = darkPool.vaultFor(o);
        vm.deal(vaultAddr, bnbIn);

        vm.expectEmit(true, true, true, true, address(darkPool));
        emit VaultCreated(vaultAddr, vaultOwner, coin, bnbIn, 0, false, o.nonce);
        darkPool.fill(o);
        assertEq(vaultAddr.balance, bnbIn, "BNB stays after the router refused");
        assertEq(IERC20(coin).balanceOf(vaultAddr), 0);
        assertTrue(darkPool.isVault(vaultAddr));

        vm.prank(vaultOwner);
        DarkVault(payable(vaultAddr)).buy(bnbIn, 1);
        assertGt(IERC20(coin).balanceOf(vaultAddr), 0, "owner retry bought through the router");
        assertEq(vaultAddr.balance, 0);
    }

    /// @dev Finding 6g: a buy that clears the curve graduates the coin inside buyFromFactory; the
    ///      launchpad refunds bnbIn - used to the vault and VaultCreated still reports the order's bnbIn.
    function test_review_transactAndFill_curveClearingBuy_refundStaysInVault() public {
        uint256 bnbIn = grossToClear(coin) + 1 ether;
        (uint256 out, uint256 used,) = launchpad.quoteBuy(coin, bnbIn);
        assertLt(used, bnbIn, "more than the curve needs");
        vm.deal(address(pool), bnbIn + 10 ether);
        DarkPool.Order memory o = _order(bnbIn, out, 0, bytes32(uint256(166)));
        address vault = darkPool.vaultFor(o);
        (ShieldedPool.Proof memory p, ShieldedPool.ExtData memory e) = _proof(vault, bnbIn, FEE, 170);

        vm.expectEmit(true, true, true, true, address(darkPool));
        emit VaultCreated(vault, vaultOwner, coin, bnbIn, out, true, o.nonce);
        vm.prank(relayer);
        darkPool.transactAndFill(p, e, o);

        assertTrue(launchpad.isGraduated(coin), "graduated inside the fill");
        assertEq(IERC20(coin).balanceOf(vault), out);
        assertEq(vault.balance, bnbIn - used, "the refund landed in the vault");
    }

    /// @dev Finding 6h: harvest after graduation (the burn goes to address(0), untaxed).
    function test_review_relay_harvest_afterGraduation() public {
        (DarkVault vault,) = _fill(1 ether, 172);
        graduate(coin);
        uint256 tokens = IERC20(coin).balanceOf(address(vault)) / 2;
        uint256 expected = roots.harvestValue(coin, tokens);
        assertGt(expected, 0);
        uint256 fee = expected / 10;
        uint256 supplyBefore = IERC20(coin).totalSupply();
        uint256 poolBefore = address(pool).balance;

        _relay(vault, abi.encodeCall(DarkVault.harvest, (tokens, expected, PUBKEY, BLINDING)), fee);

        assertEq(supplyBefore - IERC20(coin).totalSupply(), tokens, "burned in full, no pair tax");
        assertEq(address(pool).balance - poolBefore, expected - fee);
        assertEq(address(vault).balance, 0);
    }

    /// @dev Finding 6i: shield(amount) boundary against the relay fee.
    function test_review_shield_amountPlusFeeBoundary() public {
        (DarkVault vault,) = _fill(1 ether, 174);
        vm.deal(address(vault), 1 ether);
        uint256 deadline = block.timestamp + 1 hours;

        bytes memory over = abi.encodeCall(DarkVault.shield, (1 ether - FEE + 1, PUBKEY, BLINDING));
        bytes memory sig = _sign(vault, over, FEE, deadline, vaultOwnerPk);
        vm.prank(submitter);
        vm.expectRevert(DarkVault.InsufficientBalance.selector);
        vault.relay(over, FEE, deadline, sig);

        uint256 poolBefore = address(pool).balance;
        _relay(vault, abi.encodeCall(DarkVault.shield, (1 ether - FEE, PUBKEY, BLINDING)), FEE);
        assertEq(address(pool).balance - poolBefore, 1 ether - FEE, "amount + fee == balance works");
        assertEq(address(vault).balance, 0);

        // amount 0 with only the fee left: nothing to shield
        vm.deal(address(vault), FEE);
        bytes memory all = abi.encodeCall(DarkVault.shield, (0, PUBKEY, BLINDING));
        sig = _sign(vault, all, FEE, deadline, vaultOwnerPk);
        vm.prank(submitter);
        vm.expectRevert(DarkVault.InsufficientBalance.selector);
        vault.relay(all, FEE, deadline, sig);
    }

    /// @dev Finding 6j: exec with value, and the fee that must be left behind afterwards.
    function test_review_exec_withValue_feeInterplay() public {
        (DarkVault vault,) = _fill(1 ether, 176);
        vm.deal(address(vault), 0.3 ether + FEE);
        uint256 bobBefore = bob.balance;
        uint256 submitterBefore = submitter.balance;

        _relay(vault, abi.encodeCall(DarkVault.exec, (bob, 0.3 ether, "")), FEE);
        assertEq(bob.balance - bobBefore, 0.3 ether, "value sent");
        assertEq(submitter.balance - submitterBefore, FEE);
        assertEq(address(vault).balance, 0);

        // sending everything out leaves nothing for the fee: the whole relay reverts
        vm.deal(address(vault), 0.3 ether);
        bytes memory data = abi.encodeCall(DarkVault.exec, (bob, 0.3 ether, ""));
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(vault, data, FEE, deadline, vaultOwnerPk);
        vm.prank(submitter);
        vm.expectRevert(DarkVault.FeeUnpaid.selector);
        vault.relay(data, FEE, deadline, sig);
        assertEq(address(vault).balance, 0.3 ether, "nothing moved");
        assertEq(vault.nonce(), 1);
    }

    /// @dev Finding 6k: an exec target cannot re-enter relay (guard) nor act as the owner
    ///      (msg.sender is the target, not the vault).
    function test_review_exec_targetCannotReenter() public {
        (DarkVault vault,) = _fill(1 ether, 178);
        vm.deal(address(vault), 1 ether);
        Reenterer r = new Reenterer();
        uint256 deadline = block.timestamp + 1 hours;

        bytes memory data =
            abi.encodeCall(DarkVault.exec, (address(r), 0, abi.encodeCall(Reenterer.relayBack, (vault, deadline))));
        bytes memory sig = _sign(vault, data, 0, deadline, vaultOwnerPk);
        vm.prank(submitter);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        vault.relay(data, 0, deadline, sig);

        data = abi.encodeCall(DarkVault.exec, (address(r), 0, abi.encodeCall(Reenterer.sellBack, (vault))));
        sig = _sign(vault, data, 0, deadline, vaultOwnerPk);
        vm.prank(submitter);
        vm.expectRevert(DarkVault.NotOwner.selector);
        vault.relay(data, 0, deadline, sig);

        assertEq(vault.nonce(), 0, "nothing consumed");
        assertEq(address(vault).balance, 1 ether);
    }

    // ------------------------------------------------- 16. integration round

    /// @dev A relay signature names its submitter: copying the relayer's pending calldata gets BadSignature.
    function test_integration_relay_signatureBoundToSubmitter() public {
        (DarkVault vault,) = _fill(1 ether, 1600);
        bytes memory data = abi.encodeCall(DarkVault.shield, (0, PUBKEY, BLINDING));
        vm.deal(address(vault), 1 ether);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(vault, data, FEE, deadline, vaultOwnerPk); // signed for submitter
        vm.prank(attacker);
        vm.expectRevert(DarkVault.BadSignature.selector);
        vault.relay(data, FEE, deadline, sig);
        assertEq(vault.nonce(), 0, "nothing consumed by the front-runner");
        vm.prank(submitter);
        vault.relay(data, FEE, deadline, sig);
        assertEq(vault.nonce(), 1);
        assertEq(submitter.balance, FEE, "fee goes to the named submitter");
    }

    /// @dev Roots is read from the Launchpad at call time, so a rotated Roots is followed by every vault.
    function test_integration_rootsResolvedAtCallTime() public {
        (DarkVault vault,) = _fill(1 ether, 1700);
        assertEq(address(vault.roots()), address(roots));
        address newRoots = makeAddr("newRoots");
        launchpad.setRoots(newRoots);
        assertEq(address(vault.roots()), newRoots, "follows Launchpad.setRoots");
        assertEq(address(impl.roots()), newRoots);
    }
}

/// @dev exec() target that tries to call back into the vault.
contract Reenterer {
    function relayBack(DarkVault vault, uint256 deadline) external {
        vault.relay(abi.encodeCall(DarkVault.shield, (0, 1, 1)), 0, deadline, hex"00");
    }

    function sellBack(DarkVault vault) external {
        vault.sell(1, 0, 1, 1);
    }
}
