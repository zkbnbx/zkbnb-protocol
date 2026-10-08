// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/Test.sol";
import {StdStorage, stdStorage} from "forge-std/StdStorage.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {BaseTest} from "./Base.t.sol";
import {GrovePool} from "../src/GrovePool.sol";
import {Planter} from "../src/Planter.sol";
import {CreatorStub} from "../src/CreatorStub.sol";
import {ShieldedPool} from "../src/ShieldedPool.sol";
import {Launchpad} from "../src/Launchpad.sol";
import {MerkleTreeWithHistoryV2} from "../src/MerkleTreeWithHistoryV2.sol";
import {IPoseidonT3, IPoseidonT4, PayoutMode} from "../src/interfaces/IGrove.sol";
import {IVerifier13} from "../src/interfaces/IGroveV2.sol";
import {GroveConstants as C} from "../src/libraries/GroveConstants.sol";
import {MockVerifier13, MockVerifier17, MockVerifier5, MockVerifier7} from "./mocks/MockVerifierN.sol";

/// @notice HolderRewards stand-in: `claim` pays `amount` to the caller, no proofs.
contract MockHolderRewardsClaim {
    function claim(address, uint256, uint256 amount, bytes32[] calldata) external {
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "pay");
    }

    receive() external payable {}
}

/// @notice v1-style single-leaf incremental tree over ZERO_LEAF, the reference for chunk inserts.
contract RefTree {
    IPoseidonT3 immutable hasher;
    uint32 immutable levels;
    mapping(uint256 => uint256) filled;
    mapping(uint256 => uint256) zeros;
    uint32 public next;
    uint256 public root;

    constructor(uint32 levels_, address hasher_) {
        levels = levels_;
        hasher = IPoseidonT3(hasher_);
        uint256 z = C.ZERO_LEAF;
        for (uint32 i; i < levels_; i++) {
            zeros[i] = z;
            filled[i] = z;
            z = hasher.poseidon([z, z]);
        }
        root = z;
    }

    function insert(uint256 leaf) external {
        uint32 idx = next;
        uint256 cur = leaf;
        for (uint32 i; i < levels; i++) {
            if (idx % 2 == 0) {
                filled[i] = cur;
                cur = hasher.poseidon([cur, zeros[i]]);
            } else {
                cur = hasher.poseidon([filled[i], cur]);
            }
            idx /= 2;
        }
        root = cur;
        next++;
    }
}

/// @notice Shared stage-2 fixture: the stage-1 stack from BaseTest plus GrovePool, Planter and the
///         four mock verifiers. INTEGRATION HOOK: `_verifiers()` is the one place to swap the mocks
///         for the dev verifiers exported by WP-circuits.
abstract contract PrivacyBase is BaseTest {
    using stdStorage for StdStorage;

    MockVerifier13 internal v13;
    MockVerifier17 internal v17;
    MockVerifier5 internal v5;
    MockVerifier7 internal v7;
    MockHolderRewardsClaim internal hrMock;
    GrovePool internal gp;
    Planter internal planter;
    address internal darkCurveAddr;

    address internal relayer = makeAddr("relayer");
    uint256 internal nfCounter = 1;
    uint256 internal cmCounter = 1_000_000;

    uint256[10] internal DENOMS =
        [0.01 ether, 0.02 ether, 0.05 ether, 0.1 ether, 0.2 ether, 0.5 ether, 1 ether, 2 ether, 5 ether, 10 ether];
    uint256[10] internal LOTS = [1e5 * 1e18, 2e5 * 1e18, 5e5 * 1e18, 1e6 * 1e18, 2e6 * 1e18, 5e6 * 1e18, 1e7 * 1e18, 2e7 * 1e18, 5e7 * 1e18, 1e8 * 1e18];

    function setUp() public virtual override {
        super.setUp();
        _verifiers();
        hrMock = new MockHolderRewardsClaim();
        vm.deal(address(hrMock), 100 ether);
        gp = new GrovePool(address(v13), poseidonT3, poseidonT4, address(launchpad), address(hrMock), address(pool), owner);
        planter = new Planter(address(gp), address(launchpad), address(feeRouter), address(roots));
        darkCurveAddr = _deployDarkCurve();
        gp.setModules(darkCurveAddr, address(planter));
        for (uint256 i; i < 10; i++) {
            gp.addUnshieldDenomination(DENOMS[i]);
            gp.addTokenLot(LOTS[i]);
        }
    }

    function _verifiers() internal virtual {
        v13 = new MockVerifier13();
        v17 = new MockVerifier17();
        v5 = new MockVerifier5();
        v7 = new MockVerifier7();
    }

    /// @dev Overridden by DarkCurve tests; the pool tests only need an address that is a module.
    function _deployDarkCurve() internal virtual returns (address) {
        return makeAddr("darkCurveModule");
    }

    // ------------------------------------------------------------- builders

    function _proof() internal pure returns (GrovePool.Proof memory p) {
        p.a = [uint256(1), 2];
        p.b = [[uint256(3), 4], [uint256(5), 6]];
        p.c = [uint256(7), 8];
    }

    function _nf() internal returns (uint256) {
        return ++nfCounter;
    }

    function _cm() internal returns (uint256) {
        return ++cmCounter;
    }

    function _ext(address recipient, int256 bnb, int256 coinAmt, uint256 fee, bytes memory payload)
        internal
        view
        returns (GrovePool.ExtData memory e)
    {
        e.recipient = recipient;
        e.extAmountBnb = bnb;
        e.extAmountCoin = coinAmt;
        e.relayer = fee > 0 ? relayer : address(0);
        e.fee = fee;
        e.payload = payload;
        e.encryptedOutputs = [bytes("enc0"), bytes("enc1"), bytes("enc2")];
    }

    function _pub(GrovePool.ExtData memory e, address coin, uint256 accRpt, uint256 handle, uint256 claimAmount)
        internal
        returns (GrovePool.TransferPublic memory s)
    {
        s.root = gp.getLastRoot();
        if (!gp.isKnownRoot(s.root)) {
            vm.warp(block.timestamp + C.CHECKPOINT_PERIOD);
            gp.checkpoint();
        }
        s.publicAmount = gp.toField(e.extAmountBnb - int256(e.fee) + int256(claimAmount));
        s.coin = coin;
        s.publicAmountCoin = gp.toField(e.extAmountCoin);
        s.accRpt = accRpt;
        s.handle = handle;
        s.claimAmount = claimAmount;
        s.extDataHash = gp.hashExtData(e);
        s.inputNullifiers = [_nf(), _nf()];
        s.outputCommitments = [_cm(), _cm(), _cm()];
    }

    function _transact(GrovePool.TransferPublic memory s, GrovePool.ExtData memory e, uint256 value) internal returns (uint256 gasUsed) {
        uint256 g = gasleft();
        gp.transact{value: value}(_proof(), s, e);
        gasUsed = g - gasleft();
    }

    function shield(uint256 amount) internal returns (uint256 gasUsed) {
        GrovePool.ExtData memory e = _ext(address(0), int256(amount), 0, 0, "");
        GrovePool.TransferPublic memory s = _pub(e, address(0), 0, 0, 0);
        return _transact(s, e, amount);
    }

    function unshield(address to, uint256 amount, uint256 fee) internal returns (uint256 gasUsed) {
        GrovePool.ExtData memory e = _ext(to, -int256(amount), 0, fee, "");
        GrovePool.TransferPublic memory s = _pub(e, address(0), 0, 0, 0);
        return _transact(s, e, 0);
    }

    function _plantPayload(uint256 handle) internal pure returns (bytes memory) {
        return abi.encode(
            C.ACTION_PLANT,
            Launchpad.PlantParams({
                name: "Private Coin",
                symbol: "PRIV",
                metadata: Launchpad.Metadata({description: "d", image: "i", website: "w", twitter: "", telegram: ""}),
                payoutMode: PayoutMode.Creator,
                payoutWallet: address(0),
                ringId: 0,
                minFirstBuyTokens: 0
            }),
            handle
        );
    }

    function plantPrivately(uint256 handle) internal returns (address coin, uint256 gasUsed) {
        uint256 fee = launchpad.plantFee();
        GrovePool.ExtData memory e = _ext(address(planter), -int256(fee), 0, 0, _plantPayload(handle));
        GrovePool.TransferPublic memory s = _pub(e, address(0), 0, 0, 0);
        uint256 n = launchpad.coinCount();
        gasUsed = _transact(s, e, 0);
        coin = launchpad.coins(n);
    }

    /// @dev Shield against an explicit (known) root; never warps.
    function _shieldAt(uint256 root, uint256 amount) internal {
        GrovePool.ExtData memory e = _ext(address(0), int256(amount), 0, 0, "");
        GrovePool.TransferPublic memory s;
        s.root = root;
        s.publicAmount = gp.toField(e.extAmountBnb);
        s.extDataHash = gp.hashExtData(e);
        s.inputNullifiers = [_nf(), _nf()];
        s.outputCommitments = [_cm(), _cm(), _cm()];
        gp.transact{value: amount}(_proof(), s, e);
    }

    function _setNextIndex(uint32 v) internal {
        stdstore.target(address(gp)).sig("nextIndex()").checked_write(uint256(v));
    }
}

contract GrovePoolTest is PrivacyBase {
    event Transact(int256 extAmountBnb, address coin, int256 extAmountCoin, address recipient, address relayer, uint256 fee);
    event NewCommitment(uint256 indexed commitment, uint32 index, bytes encryptedOutput);
    event HandleClaimed(uint256 indexed handle, uint256 claimAmount);
    event CommitmentDropped(uint256 indexed commitment);
    event Checkpoint(uint256 root, uint32 indexAfter, uint64 period);

    // ------------------------------------------------------------ constants

    function test_constants_tagsMatchKeccak() public pure {
        uint256 p = C.FIELD_SIZE;
        assertEq(uint256(keccak256(bytes(C.LABEL_ZERO_LEAF))) % p, C.ZERO_LEAF, "ZERO_LEAF");
        assertEq(uint256(keccak256(bytes(C.LABEL_INTENT))) % p, C.INTENT_TAG, "INTENT_TAG");
        assertEq(uint256(keccak256(bytes(C.LABEL_HANDLE))) % p, C.HANDLE_TAG, "HANDLE_TAG");
        assertEq(uint256(keccak256(bytes(C.LABEL_OWNER))) % p, C.OWNER_TAG, "OWNER_TAG");
        assertEq(uint256(keccak256(bytes(C.LABEL_RESULT))) % p, C.RESULT_TAG, "RESULT_TAG");
        assertEq(C.UNIT_BNB, 1e13);
        assertEq(C.UNIT_TOKEN, 1e18);
        assertEq(C.MIN_U_BNB * C.UNIT_BNB, 0.05 ether);
        assertEq(C.INTENT_FEE, 0.002 ether);
        assertEq(C.MAX_INTENTS * (uint256(2) ** C.U_BITS), C.MAX_U_SUM);
        assertEq(C.LEVELS, 23);
        assertEq(C.CHECKPOINT_PERIOD, 600);
    }

    // ----------------------------------------------------------------- tree

    function test_tree_genesisRootKnown_andShape() public view {
        assertTrue(gp.isKnownRoot(gp.getLastRoot()));
        assertEq(gp.levels(), 23);
        assertEq(gp.nextIndex(), 0);
        assertEq(gp.ZERO_VALUE(), C.ZERO_LEAF);
        assertEq(gp.zeros(0), C.ZERO_LEAF);
        assertEq(gp.rootIndexAfter(gp.getLastRoot()), 1);
    }

    function test_tree_chunkInsertMatchesSingleLeafReference() public {
        RefTree ref = new RefTree(23, poseidonT3);
        assertEq(ref.root(), gp.getLastRoot(), "genesis");
        for (uint256 n; n < 5; n++) {
            uint256 a = shield(1 ether);
            assertLt(a, 1_200_000, "shield gas");
            // read back the three commitments from the counter; fourth slot is ZERO_LEAF
            ref.insert(cmCounter - 2);
            ref.insert(cmCounter - 1);
            ref.insert(cmCounter);
            ref.insert(C.ZERO_LEAF);
            assertEq(gp.getLastRoot(), ref.root(), "root after chunk");
            assertEq(gp.nextIndex(), (n + 1) * 4);
        }
    }

    function test_tree_checkpoints() public {
        uint256 genesis = gp.getLastRoot();
        shield(1 ether);
        uint256 r1 = gp.getLastRoot();
        assertFalse(gp.isKnownRoot(r1), "fresh root is not known inside the period");
        gp.checkpoint();
        assertFalse(gp.isKnownRoot(r1), "checkpoint() is a no-op inside the period");

        vm.warp(block.timestamp + C.CHECKPOINT_PERIOD);
        vm.expectEmit(true, true, true, true);
        emit Checkpoint(r1, 4, uint64(block.timestamp / C.CHECKPOINT_PERIOD));
        gp.checkpoint();
        assertTrue(gp.isKnownRoot(r1));
        assertEq(gp.rootIndexAfter(r1), 5);
        assertTrue(gp.isKnownRoot(genesis), "genesis stays known");

        // a non-checkpoint root never becomes known (proofs pinned to the known root r1)
        _shieldAt(r1, 1 ether);
        uint256 r2 = gp.getLastRoot();
        _shieldAt(r1, 1 ether);
        uint256 r3 = gp.getLastRoot();
        vm.warp(block.timestamp + C.CHECKPOINT_PERIOD);
        // the insert checkpoints the PRE-insert root (r3), not the one it produces
        _shieldAt(r1, 1 ether);
        assertTrue(gp.isKnownRoot(r3), "pre-insert root checkpointed at the boundary");
        assertFalse(gp.isKnownRoot(r2), "a root between checkpoints is never known");
        assertFalse(gp.isKnownRoot(gp.getLastRoot()), "the root the boundary insert produced is not yet known");

        // an old checkpoint is still known 300 chunks later, r2 still is not
        for (uint256 i; i < 300; i++) {
            _shieldAt(r1, 0.01 ether);
        }
        assertFalse(gp.isKnownRoot(r2));
        assertTrue(gp.isKnownRoot(r1));
        assertTrue(gp.isKnownRoot(r3));
        assertEq(gp.nextIndex() % 4, 0);
    }

    function test_tree_fullDropsCommitmentsButPaysOut() public {
        shield(10 ether);
        _setNextIndex(uint32(2 ** 23 - 4));
        assertEq(gp.chunksLeft(), 1);
        shield(1 ether); // last chunk
        assertEq(gp.chunksLeft(), 0);
        GrovePool.ExtData memory e = _ext(bob, -1 ether, 0, 0, "");
        GrovePool.TransferPublic memory s = _pub(e, address(0), 0, 0, 0);
        uint256 before = bob.balance;
        vm.expectEmit(true, true, true, true);
        emit CommitmentDropped(s.outputCommitments[0]);
        _transact(s, e, 0);
        assertEq(bob.balance, before + 1 ether);
        vm.expectRevert(MerkleTreeWithHistoryV2.TreeFull.selector);
        vm.prank(darkCurveAddr);
        gp.insertChunk([uint256(1), 2, 3, 4], new bytes[](0));
    }

    // --------------------------------------------------------------- shield

    function test_shield_valueAndLimit() public {
        GrovePool.ExtData memory e = _ext(address(0), 1 ether, 0, 0, "");
        GrovePool.TransferPublic memory s = _pub(e, address(0), 0, 0, 0);
        vm.expectRevert(GrovePool.BadValue.selector);
        gp.transact{value: 0.5 ether}(_proof(), s, e);

        e = _ext(address(0), 101 ether, 0, 0, "");
        s = _pub(e, address(0), 0, 0, 0);
        vm.expectRevert(GrovePool.OverLimit.selector);
        gp.transact{value: 101 ether}(_proof(), s, e);

        e = _ext(address(0), 1 ether, 0, 0, "");
        s = _pub(e, address(0), 0, 0, 0);
        vm.expectEmit(true, true, true, true);
        emit NewCommitment(s.outputCommitments[0], 0, "enc0");
        vm.expectEmit(true, true, true, true);
        emit NewCommitment(s.outputCommitments[1], 1, "enc1");
        vm.expectEmit(true, true, true, true);
        emit NewCommitment(s.outputCommitments[2], 2, "enc2");
        vm.expectEmit(true, true, true, true);
        emit Transact(1 ether, address(0), 0, address(0), address(0), 0);
        uint256 g = _transact(s, e, 1 ether);
        console2.log("gas transact shield", g);
        assertEq(address(gp).balance, 1 ether);
        assertTrue(gp.isSpent(s.inputNullifiers[0]));
    }

    function test_verifier_receivesSignalsInFrozenOrder() public {
        GrovePool.ExtData memory e = _ext(address(0), 1 ether, 0, 0, "");
        GrovePool.TransferPublic memory s = _pub(e, address(0), 0, 7, 0);
        gp.credit{value: 1 wei}(7);
        s = _pub(e, address(0), 0, 7, 1);
        uint256[13] memory sig = [
            s.root,
            s.publicAmount,
            0,
            0,
            0,
            7,
            1,
            uint256(s.extDataHash),
            s.inputNullifiers[0],
            s.inputNullifiers[1],
            s.outputCommitments[0],
            s.outputCommitments[1],
            s.outputCommitments[2]
        ];
        GrovePool.Proof memory p = _proof();
        vm.expectCall(address(v13), abi.encodeCall(IVerifier13.verifyProof, (p.a, p.b, p.c, sig)));
        gp.transact{value: 1 ether}(p, s, e);
    }

    function test_invalidProof_unknownRoot_doubleSpend() public {
        shield(1 ether);
        GrovePool.ExtData memory e = _ext(address(0), 0, 0, 0, "");
        GrovePool.TransferPublic memory s = _pub(e, address(0), 0, 0, 0);
        v13.setResult(false);
        vm.expectRevert(GrovePool.InvalidProof.selector);
        _transact(s, e, 0);
        v13.setResult(true);

        s.root = 12345;
        vm.expectRevert(GrovePool.UnknownRoot.selector);
        _transact(s, e, 0);

        s = _pub(e, address(0), 0, 0, 0);
        uint256 g = _transact(s, e, 0);
        console2.log("gas transact private transfer", g);
        GrovePool.TransferPublic memory s2 = _pub(e, address(0), 0, 0, 0);
        s2.inputNullifiers[0] = s.inputNullifiers[1];
        vm.expectRevert(GrovePool.AlreadySpent.selector);
        _transact(s2, e, 0);
        s2.inputNullifiers[0] = s2.inputNullifiers[1];
        vm.expectRevert(GrovePool.AlreadySpent.selector);
        _transact(s2, e, 0);

        s2 = _pub(e, address(0), 0, 0, 0);
        s2.extDataHash = bytes32(uint256(1));
        vm.expectRevert(GrovePool.BadExtDataHash.selector);
        _transact(s2, e, 0);
        s2 = _pub(e, address(0), 0, 0, 0);
        s2.publicAmount += 1;
        vm.expectRevert(GrovePool.BadPublicAmount.selector);
        _transact(s2, e, 0);
    }

    // ------------------------------------------------------------- unshield

    function test_unshield_requiresDenomination_paysRecipientAndRelayer_noSender() public {
        shield(10 ether);
        GrovePool.ExtData memory e = _ext(bob, -0.03 ether, 0, 0, "");
        GrovePool.TransferPublic memory s = _pub(e, address(0), 0, 0, 0);
        vm.expectRevert(GrovePool.NotDenomination.selector);
        _transact(s, e, 0);

        e = _ext(bob, -1 ether, 0, 0.001 ether, "");
        s = _pub(e, address(0), 0, 0, 0);
        uint256 bobBefore = bob.balance;
        vm.expectEmit(true, true, true, true);
        emit Transact(-1 ether, address(0), 0, bob, relayer, 0.001 ether);
        vm.prank(carol); // the relayer wallet submits; the event must not name it
        gp.transact(_proof(), s, e);
        assertEq(bob.balance, bobBefore + 1 ether);
        assertEq(relayer.balance, 0.001 ether);
        assertEq(address(gp).balance, 10 ether - 1.001 ether);

        // fee without relayer
        e = _ext(bob, -1 ether, 0, 0.001 ether, "");
        e.relayer = address(0);
        s = _pub(e, address(0), 0, 0, 0);
        vm.expectRevert(GrovePool.BadValue.selector);
        _transact(s, e, 0);
        // msg.value on an unshield
        e = _ext(bob, -1 ether, 0, 0, "");
        s = _pub(e, address(0), 0, 0, 0);
        vm.expectRevert(GrovePool.BadValue.selector);
        _transact(s, e, 1);
    }

    function test_unshield_gasLog() public {
        shield(10 ether);
        uint256 g = unshield(bob, 1 ether, 0.0005 ether);
        console2.log("gas transact unshield", g);
    }

    // --------------------------------------------------------------- tokens

    function _coinWithTokens(address who, uint256 bnb) internal returns (address coin) {
        coin = plantCoin(alice, PayoutMode.Creator);
        buy(who, coin, bnb);
        vm.prank(who);
        IERC20(coin).approve(address(gp), type(uint256).max);
    }

    function test_token_shieldUnshieldInLots_andCoinRules() public {
        address coin = _coinWithTokens(alice, 2 ether);
        uint256 lot = LOTS[0];
        assertGt(IERC20(coin).balanceOf(alice), lot);

        // not a lot
        GrovePool.ExtData memory e = _ext(address(0), 0, int256(lot + 1), 0, "");
        GrovePool.TransferPublic memory s = _pub(e, coin, 0, 0, 0);
        vm.prank(alice);
        vm.expectRevert(GrovePool.NotDenomination.selector);
        gp.transact(_proof(), s, e);

        // a non-coin address
        e = _ext(address(0), 0, int256(lot), 0, "");
        s = _pub(e, bob, 0, 0, 0);
        vm.prank(alice);
        vm.expectRevert(GrovePool.NotCoin.selector);
        gp.transact(_proof(), s, e);

        // coin == 0 => publicAmountCoin, accRpt and extAmountCoin must be 0
        e = _ext(address(0), 0, int256(lot), 0, "");
        s = _pub(e, address(0), 0, 0, 0);
        vm.prank(alice);
        vm.expectRevert(GrovePool.BadPublicAmount.selector);
        gp.transact(_proof(), s, e);
        e = _ext(address(0), 0, 0, 0, "");
        s = _pub(e, address(0), 5, 0, 0);
        vm.expectRevert(GrovePool.BadPublicAmount.selector);
        gp.transact(_proof(), s, e);

        // shield a lot
        e = _ext(address(0), 0, int256(lot), 0, "");
        s = _pub(e, coin, 0, 0, 0);
        vm.prank(alice);
        gp.transact(_proof(), s, e);
        assertEq(IERC20(coin).balanceOf(address(gp)), lot);

        // unshield a lot to bob
        e = _ext(bob, 0, -int256(lot), 0, "");
        s = _pub(e, coin, 0, 0, 0);
        gp.transact(_proof(), s, e);
        assertEq(IERC20(coin).balanceOf(bob), lot);
        assertEq(IERC20(coin).balanceOf(address(gp)), 0);
    }

    function test_pullRewards_bumpsAccRpt_knownValuesStayValid() public {
        address coin = _coinWithTokens(alice, 2 ether);
        uint256 lot = LOTS[0];
        GrovePool.ExtData memory e = _ext(address(0), 0, int256(lot), 0, "");
        GrovePool.TransferPublic memory s = _pub(e, coin, 0, 0, 0);
        vm.prank(alice);
        gp.transact(_proof(), s, e);

        assertTrue(gp.knownAccRpt(coin, 0));
        assertFalse(gp.knownAccRpt(coin, 1));
        bytes32[] memory proof;
        gp.pullRewards(coin, 0, 1 ether, proof);
        uint256 rpt1 = 1 ether * 1e18 / lot;
        assertEq(gp.accRpt(coin), rpt1);
        assertTrue(gp.knownAccRpt(coin, rpt1));
        assertEq(address(gp).balance, 1 ether);

        gp.pullRewards(coin, 1, 0.5 ether, proof);
        uint256 rpt2 = rpt1 + 0.5 ether * 1e18 / lot;
        assertEq(gp.accRpt(coin), rpt2);

        // stale but known accepted, unknown rejected
        e = _ext(address(0), 0, 0, 0, "");
        s = _pub(e, coin, rpt1, 0, 0);
        gp.transact(_proof(), s, e);
        s = _pub(e, coin, rpt2, 0, 0);
        gp.transact(_proof(), s, e);
        s = _pub(e, coin, rpt1 + 1, 0, 0);
        vm.expectRevert(GrovePool.UnknownAccRpt.selector);
        gp.transact(_proof(), s, e);
    }

    // -------------------------------------------------------------- handles

    function test_handles_creditAndClaim() public {
        uint256 handle = 777;
        vm.expectRevert(GrovePool.BadValue.selector);
        gp.credit{value: 0}(handle);
        vm.expectRevert(GrovePool.BadValue.selector);
        gp.credit{value: 1}(0);
        vm.prank(bob);
        gp.credit{value: 1 ether}(handle);
        assertEq(gp.claimable(handle), 1 ether);

        // claimAmount > claimable
        GrovePool.ExtData memory e = _ext(address(0), 0, 0, 0, "");
        GrovePool.TransferPublic memory s = _pub(e, address(0), 0, handle, 1 ether + 1);
        vm.expectRevert(GrovePool.BadClaimAmount.selector);
        _transact(s, e, 0);
        // claimAmount with handle == 0
        s = _pub(e, address(0), 0, 0, 1);
        vm.expectRevert(GrovePool.BadClaimAmount.selector);
        _transact(s, e, 0);

        // partial claim; a 1-wei credit lands between proving and execution and does not break it
        s = _pub(e, address(0), 0, handle, 0.4 ether);
        gp.credit{value: 1 wei}(handle);
        vm.expectEmit(true, true, true, true);
        emit HandleClaimed(handle, 0.4 ether);
        _transact(s, e, 0);
        assertEq(gp.claimable(handle), 0.6 ether + 1 wei);

        // full claim of the rest, with a relayer fee folded into publicAmount
        e = _ext(address(0), 0, 0, 0.001 ether, "");
        s = _pub(e, address(0), 0, handle, 0.6 ether + 1 wei);
        assertEq(s.publicAmount, 0.6 ether + 1 wei - 0.001 ether);
        _transact(s, e, 0);
        assertEq(gp.claimable(handle), 0);
        assertEq(relayer.balance, 0.001 ether);
    }

    // -------------------------------------------------------------- v1 path

    function test_migrateFromV1_creditsHandle() public {
        // fund the v1 pool and build a v1 withdrawal to the new pool (MockVerifier accepts it)
        vm.deal(address(pool), 5 ether);
        ShieldedPool.ExtData memory ve = ShieldedPool.ExtData({
            recipient: address(gp),
            extAmount: -1 ether,
            relayer: relayer,
            fee: 0.001 ether,
            encryptedOutput1: "",
            encryptedOutput2: abi.encode(uint256(4242)) // binds the handle (review finding R1)
        });
        ShieldedPool.Proof memory vp;
        vp.root = pool.getLastRoot();
        vp.publicAmount = pool.calculatePublicAmount(ve.extAmount, ve.fee);
        vp.extDataHash = pool.hashExtData(ve);
        vp.inputNullifiers = [uint256(11), 12];
        vp.outputCommitments = [uint256(13), 14];

        vm.expectRevert(GrovePool.BadValue.selector);
        gp.migrateFromV1(vp, ve, 0);

        uint256 g = gasleft();
        gp.migrateFromV1(vp, ve, 4242);
        console2.log("gas migrateFromV1", g - gasleft());
        assertEq(gp.claimable(4242), 1 ether);
        assertEq(address(gp).balance, 1 ether);
        assertEq(relayer.balance, 0.001 ether);

        // recipient must be the new pool
        ve.recipient = bob;
        vp.extDataHash = pool.hashExtData(ve);
        vm.expectRevert(GrovePool.BadValue.selector);
        gp.migrateFromV1(vp, ve, 4242);
    }

    // ------------------------------------------------- review findings (STATUS.md "Review")

    function _v1Migration(uint256 boundHandle)
        internal
        returns (ShieldedPool.Proof memory vp, ShieldedPool.ExtData memory ve)
    {
        vm.deal(address(pool), 5 ether);
        ve = ShieldedPool.ExtData({
            recipient: address(gp),
            extAmount: -1 ether,
            relayer: relayer,
            fee: 0.001 ether,
            encryptedOutput1: "",
            encryptedOutput2: abi.encode(boundHandle)
        });
        vp.root = pool.getLastRoot();
        vp.publicAmount = pool.calculatePublicAmount(ve.extAmount, ve.fee);
        vp.extDataHash = pool.hashExtData(ve);
        vp.inputNullifiers = [uint256(21), 22];
        vp.outputCommitments = [uint256(23), 24];
    }

    /// R1: the v1 proof of a migration must not be replayable with another handle, and a direct
    ///     v1 withdrawal to the pool must not strand the BNB on no handle.
    function test_review_R1_migrateFromV1_handleBound_noDirectV1Payout() public {
        (ShieldedPool.Proof memory vp, ShieldedPool.ExtData memory ve) = _v1Migration(4242);

        // a relayer or mempool watcher replays the same v1 proof with its own handle
        vm.expectRevert(GrovePool.MigrationNotBound.selector);
        gp.migrateFromV1(vp, ve, 666);
        // an unbound request (dummy ciphertext slot not carrying the handle) is refused outright
        (ShieldedPool.Proof memory vp2, ShieldedPool.ExtData memory ve2) = _v1Migration(4242);
        ve2.encryptedOutput2 = "";
        vp2.extDataHash = pool.hashExtData(ve2);
        vm.expectRevert(GrovePool.MigrationNotBound.selector);
        gp.migrateFromV1(vp2, ve2, 4242);
        // or front-runs with the v1 withdrawal itself: the pool refuses v1 BNB outside a migration
        vm.expectRevert();
        pool.transact(vp, ve);
        assertFalse(pool.nullifierHashes(21), "v1 spend reverted whole");

        // the bound handle still migrates
        gp.migrateFromV1(vp, ve, 4242);
        assertEq(gp.claimable(4242), 1 ether);
        assertEq(gp.claimable(666), 0);
        assertEq(address(gp).balance, 1 ether);

        // and v1 can no longer pay the pool afterwards
        vm.deal(address(pool), 1 ether);
        vm.prank(address(pool));
        (bool ok,) = address(gp).call{value: 1 ether}("");
        assertFalse(ok, "v1 payout outside a migration");
    }

    /// R2: the relayer fee goes to any address, so uncapped it is an unshield of any size that skips
    ///     the on-chain denominations.
    function test_review_R2_relayerFeeCapped_noDenominationBypass() public {
        shield(1 ether);
        // 0.37 BNB "fee" to an address the user controls, no unshield at all
        GrovePool.ExtData memory e = _ext(address(0), 0, 0, 0.37 ether, "");
        GrovePool.TransferPublic memory s = _pub(e, address(0), 0, 0, 0);
        vm.expectRevert(GrovePool.OverLimit.selector);
        gp.transact(_proof(), s, e);
        e = _ext(address(0), 0, 0, C.MAX_RELAYER_FEE + 1, "");
        s = _pub(e, address(0), 0, 0, 0);
        vm.expectRevert(GrovePool.OverLimit.selector);
        gp.transact(_proof(), s, e);
        // a denominated unshield cannot carry an oversized fee either
        e = _ext(bob, -0.1 ether, 0, 0.05 ether, "");
        s = _pub(e, address(0), 0, 0, 0);
        vm.expectRevert(GrovePool.OverLimit.selector);
        gp.transact(_proof(), s, e);
        // the cap itself is accepted
        uint256 before = relayer.balance;
        e = _ext(address(0), 0, 0, C.MAX_RELAYER_FEE, "");
        s = _pub(e, address(0), 0, 0, 0);
        gp.transact(_proof(), s, e);
        assertEq(relayer.balance, before + C.MAX_RELAYER_FEE);
    }

    /// R5: a run spread over dust supply would jump accRpt by amount * 1e18 / dust, past the
    ///     circuits' Num2Bits(128) on (accRpt - rpt0).
    function test_review_R5_pullRewards_refusesDustSupply() public {
        address coin = _coinWithTokens(alice, 2 ether);
        bytes32[] memory proof;
        vm.expectRevert(bytes("supply"));
        gp.pullRewards(coin, 0, 1 ether, proof);
        vm.prank(alice);
        IERC20(coin).transfer(address(gp), 3); // 3 wei of rounding dust
        vm.expectRevert(bytes("supply"));
        gp.pullRewards(coin, 0, 1 ether, proof); // would have set accRpt = 3.3e35
        vm.prank(alice);
        IERC20(coin).transfer(address(gp), C.MIN_REWARD_SUPPLY - 3);
        gp.pullRewards(coin, 0, 1 ether, proof);
        assertEq(gp.accRpt(coin), 1 ether * 1e18 / C.MIN_REWARD_SUPPLY);
        assertLt(gp.accRpt(coin), uint256(1) << 128);
    }

    function test_receive_rejectsRandomSenders() public {
        vm.prank(bob);
        (bool ok,) = address(gp).call{value: 1 ether}("");
        assertFalse(ok);
        vm.prank(darkCurveAddr);
        vm.deal(darkCurveAddr, 1 ether);
        (ok,) = address(gp).call{value: 1 ether}("");
        assertTrue(ok);
    }

    // -------------------------------------------------------- private plant

    function test_privatePlant_endToEnd() public {
        shield(1 ether);
        uint256 handle = 9001;
        uint256 treasuryBefore = treasury.balance;
        (address coin, uint256 g) = plantPrivately(handle);
        console2.log("gas transact private plant", g);
        address stub = planter.stubOf(coin);
        assertTrue(stub != address(0));
        assertEq(CreatorStub(payable(stub)).handle(), handle);
        assertEq(CreatorStub(payable(stub)).coin(), coin);
        (address creator,,,,,,,,,,) = launchpad.info(coin);
        assertEq(creator, stub, "Planted.creator == stub");
        (address cfgCreator, PayoutMode mode,,,,, bool handedOver,) = feeRouter.configOf(coin);
        assertEq(cfgCreator, stub);
        assertTrue(mode == PayoutMode.Creator);
        assertFalse(handedOver);
        assertEq(treasury.balance, treasuryBefore + launchpad.plantFee());
        assertEq(address(gp).balance, 1 ether - launchpad.plantFee());
        assertEq(planter.predictStub(handle, 0), stub);
    }

    function test_privatePlant_badValue_badPayload_walletMode() public {
        shield(1 ether);
        // any plant amount other than plantFee reverts BadPlantValue (0.01 BNB IS a denomination)
        GrovePool.ExtData memory e = _ext(address(planter), -0.01 ether, 0, 0, _plantPayload(1));
        GrovePool.TransferPublic memory s = _pub(e, address(0), 0, 0, 0);
        vm.expectRevert(GrovePool.BadPlantValue.selector);
        _transact(s, e, 0);

        // a hand-over payload sent to the planter with the plant fee reverts
        uint256 fee = launchpad.plantFee();
        e = _ext(address(planter), -int256(fee), 0, 0, abi.encode(C.ACTION_HANDOVER, bob, PayoutMode.Wallet, bob, 0));
        s = _pub(e, address(0), 0, 0, 0);
        vm.expectRevert(GrovePool.BadPayload.selector);
        _transact(s, e, 0);

        // empty payload to the planter
        e = _ext(address(planter), -int256(fee), 0, 0, "");
        s = _pub(e, address(0), 0, 0, 0);
        vm.expectRevert(GrovePool.BadPayload.selector);
        _transact(s, e, 0);

        // a plant payload never reaches handOver (zero-value transfer with recipient != planter)
        e = _ext(address(0), 0, 0, 0, _plantPayload(1));
        s = _pub(e, address(0), 0, 5, 0);
        vm.expectRevert(GrovePool.BadPayload.selector);
        _transact(s, e, 0);

        // wallet mode refused by the planter
        bytes memory wallet = abi.encode(
            C.ACTION_PLANT,
            Launchpad.PlantParams({
                name: "W",
                symbol: "W",
                metadata: _metadata(),
                payoutMode: PayoutMode.Wallet,
                payoutWallet: bob,
                ringId: 0,
                minFirstBuyTokens: 0
            }),
            uint256(1)
        );
        e = _ext(address(planter), -int256(fee), 0, 0, wallet);
        s = _pub(e, address(0), 0, 0, 0);
        vm.expectRevert(Planter.WalletModeRefused.selector);
        _transact(s, e, 0);

        // planter is pool-only
        vm.expectRevert(Planter.NotPool.selector);
        planter.plantFor{value: fee}(_plantPayload(1));
    }

    function test_handOver_throughPoolOnly_withMatchingHandle() public {
        shield(1 ether);
        uint256 handle = 31337;
        (address coin,) = plantPrivately(handle);

        // wrong handle
        GrovePool.ExtData memory e = _ext(address(0), 0, 0, 0, abi.encode(C.ACTION_HANDOVER, coin, PayoutMode.Wallet, bob, uint256(0)));
        GrovePool.TransferPublic memory s = _pub(e, address(0), 0, handle + 1, 0);
        vm.expectRevert(Planter.WrongHandle.selector);
        _transact(s, e, 0);
        // handle 0 with a payload
        s = _pub(e, address(0), 0, 0, 0);
        vm.expectRevert(GrovePool.BadPayload.selector);
        _transact(s, e, 0);
        // not through the pool
        vm.expectRevert(Planter.NotPool.selector);
        planter.handOver(coin, handle, PayoutMode.Wallet, bob, 0);

        s = _pub(e, address(0), 0, handle, 0);
        _transact(s, e, 0);
        (, PayoutMode mode, address wallet,,,, bool handedOver,) = feeRouter.configOf(coin);
        assertTrue(mode == PayoutMode.Wallet);
        assertEq(wallet, bob);
        assertTrue(handedOver);
    }

    // ---------------------------------------------------------------- admin

    function test_admin_modulesOnce_denomsAddOnly_hooksModuleOnly() public {
        vm.expectRevert(GrovePool.ModulesAlreadySet.selector);
        gp.setModules(bob, carol);
        vm.prank(bob);
        vm.expectRevert();
        gp.addUnshieldDenomination(3 ether);
        gp.addUnshieldDenomination(3 ether);
        assertTrue(gp.unshieldDenom(3 ether));

        vm.prank(bob);
        vm.expectRevert(GrovePool.NotModule.selector);
        gp.insertChunk([uint256(1), 2, 3, 4], new bytes[](0));
        vm.prank(bob);
        vm.expectRevert(GrovePool.NotModule.selector);
        gp.markSpent(1);
        vm.prank(bob);
        vm.expectRevert(GrovePool.NotModule.selector);
        gp.moveOut(address(0), 1, bob);

        // module hooks
        bytes[] memory enc = new bytes[](1);
        enc[0] = "x";
        vm.startPrank(darkCurveAddr);
        vm.expectEmit(true, true, true, true);
        emit NewCommitment(1, 0, "x");
        vm.expectEmit(true, true, true, true);
        emit NewCommitment(2, 1, "");
        uint32 first = gp.insertChunk([uint256(1), 2, C.ZERO_LEAF, C.ZERO_LEAF], enc);
        assertEq(first, 0);
        assertEq(gp.nextIndex(), 4);
        gp.markSpent(99);
        vm.expectRevert(GrovePool.AlreadySpent.selector);
        gp.markSpent(99);
        vm.stopPrank();
        assertTrue(gp.isSpent(99));

        shield(1 ether);
        vm.prank(darkCurveAddr);
        gp.moveOut(address(0), 0.25 ether, bob);
        assertEq(address(gp).balance, 0.75 ether);
    }
}
