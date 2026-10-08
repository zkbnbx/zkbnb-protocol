// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {PrivacyBase} from "./GrovePool.t.sol";
import {GrovePool} from "../src/GrovePool.sol";
import {GroveConstants as C} from "../src/libraries/GroveConstants.sol";

/// @notice Drives GrovePool with honest note accounting (the mock verifier accepts any proof, so
///         the handler itself keeps the books a sound circuit would enforce) and records what the
///         invariants check: solvency per asset, nullifier uniqueness, checkpoint monotonicity.
contract PoolHandler is Test {
    GrovePool public gp;
    address public relayer;
    uint256[10] internal denoms;

    // ghost accounting (BNB)
    uint256 public ghostNotes; // value of unspent honest notes
    uint256 public ghostClaimable; // sum of claimable over handles 1..5
    uint256 public ghostRelayerPaid;
    // nullifiers
    uint256 public spentTotal;
    uint256 public spentUnique;
    uint256 public reuseAttempts;
    uint256 public reuseLanded;
    mapping(uint256 => bool) internal seen;
    uint256[] public spentList;
    // checkpoints
    uint64 public lastPeriodSeen;
    uint32 public lastIndexAfterSeen;
    bool public monotonic = true;
    uint256[] public knownRoots;
    uint256 internal knownRoot;

    uint256 internal nfCounter = 10;
    uint256 internal cmCounter = 10_000;

    constructor(GrovePool gp_, address relayer_, uint256[10] memory denoms_) {
        gp = gp_;
        relayer = relayer_;
        denoms = denoms_;
        knownRoot = gp.getLastRoot();
        knownRoots.push(knownRoot);
        lastPeriodSeen = gp.lastCheckpointPeriod();
    }

    function knownRootCount() external view returns (uint256) {
        return knownRoots.length;
    }

    // ------------------------------------------------------------- actions

    function shield(uint96 amt) external {
        uint256 a = bound(uint256(amt), 1, 100 ether);
        vm.deal(address(this), a);
        GrovePool.ExtData memory e = _ext(address(0), int256(a), 0);
        GrovePool.TransferPublic memory s = _pub(e, 0, 0);
        gp.transact{value: a}(_proof(), s, e);
        ghostNotes += a;
        _afterSpend(s);
        _observe();
    }

    function unshield(uint8 denomIdx, uint96 feeSeed) external {
        uint256 amount = denoms[denomIdx % 10];
        uint256 fee = bound(uint256(feeSeed), 0, 0.01 ether);
        if (ghostNotes < amount + fee) return;
        GrovePool.ExtData memory e = _ext(address(0xBEEF), -int256(amount), fee);
        GrovePool.TransferPublic memory s = _pub(e, 0, 0);
        gp.transact(_proof(), s, e);
        ghostNotes -= amount + fee;
        ghostRelayerPaid += fee;
        _afterSpend(s);
        _observe();
    }

    function transfer(uint96 feeSeed) external {
        uint256 fee = bound(uint256(feeSeed), 0, 0.001 ether);
        if (ghostNotes < fee) return;
        GrovePool.ExtData memory e = _ext(address(0), 0, fee);
        GrovePool.TransferPublic memory s = _pub(e, 0, 0);
        gp.transact(_proof(), s, e);
        ghostNotes -= fee;
        ghostRelayerPaid += fee;
        _afterSpend(s);
        _observe();
    }

    function credit(uint8 h, uint96 amt) external {
        uint256 handle = bound(uint256(h), 1, 5);
        uint256 a = bound(uint256(amt), 1, 10 ether);
        vm.deal(address(this), a);
        gp.credit{value: a}(handle);
        ghostClaimable += a;
        _observe();
    }

    function claim(uint8 h, uint96 amt) external {
        uint256 handle = bound(uint256(h), 1, 5);
        uint256 avail = gp.claimable(handle);
        if (avail == 0) return;
        uint256 a = bound(uint256(amt), 1, avail);
        GrovePool.ExtData memory e = _ext(address(0), 0, 0);
        GrovePool.TransferPublic memory s = _pub(e, handle, a);
        gp.transact(_proof(), s, e);
        ghostClaimable -= a;
        ghostNotes += a;
        _afterSpend(s);
        _observe();
    }

    /// @dev Replays an already-spent nullifier; the pool must refuse.
    function doubleSpend(uint256 pick) external {
        if (spentList.length == 0) return;
        uint256 nf = spentList[pick % spentList.length];
        GrovePool.ExtData memory e = _ext(address(0), 0, 0);
        GrovePool.TransferPublic memory s = _pub(e, 0, 0);
        s.inputNullifiers[0] = nf;
        reuseAttempts++;
        try gp.transact(_proof(), s, e) {
            reuseLanded++;
        } catch {}
        _observe();
    }

    function warpAndCheckpoint(uint32 dt) external {
        vm.warp(block.timestamp + bound(uint256(dt), 0, 2 hours));
        gp.checkpoint();
        _observe();
    }

    // ------------------------------------------------------------- helpers

    function _afterSpend(GrovePool.TransferPublic memory s) internal {
        for (uint256 i; i < 2; i++) {
            spentTotal++;
            uint256 nf = s.inputNullifiers[i];
            if (!seen[nf]) {
                seen[nf] = true;
                spentUnique++;
                spentList.push(nf);
            }
        }
    }

    function _observe() internal {
        uint64 period = gp.lastCheckpointPeriod();
        if (period < lastPeriodSeen) monotonic = false;
        if (period > lastPeriodSeen) {
            lastPeriodSeen = period;
        }
        uint256 lr = gp.getLastRoot();
        if (gp.isKnownRoot(lr)) {
            uint32 after_ = gp.rootIndexAfter(lr);
            if (after_ < lastIndexAfterSeen) monotonic = false;
            lastIndexAfterSeen = after_;
            if (lr != knownRoot) {
                knownRoot = lr;
                knownRoots.push(lr);
            }
        }
    }

    function _proof() internal pure returns (GrovePool.Proof memory p) {
        p.a = [uint256(1), 2];
        p.b = [[uint256(3), 4], [uint256(5), 6]];
        p.c = [uint256(7), 8];
    }

    function _ext(address recipient, int256 bnb, uint256 fee) internal view returns (GrovePool.ExtData memory e) {
        e.recipient = recipient;
        e.extAmountBnb = bnb;
        e.relayer = fee > 0 ? relayer : address(0);
        e.fee = fee;
        e.encryptedOutputs = [bytes(""), bytes(""), bytes("")];
    }

    function _pub(GrovePool.ExtData memory e, uint256 handle, uint256 claimAmount)
        internal
        returns (GrovePool.TransferPublic memory s)
    {
        uint256 lr = gp.getLastRoot();
        if (gp.isKnownRoot(lr)) knownRoot = lr;
        s.root = knownRoot;
        s.publicAmount = gp.toField(e.extAmountBnb - int256(e.fee) + int256(claimAmount));
        s.handle = handle;
        s.claimAmount = claimAmount;
        s.extDataHash = gp.hashExtData(e);
        s.inputNullifiers = [++nfCounter, ++nfCounter];
        s.outputCommitments = [++cmCounter, ++cmCounter, ++cmCounter];
    }

    receive() external payable {}
}

contract PrivacyInvariantsTest is PrivacyBase {
    PoolHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new PoolHandler(gp, relayer, DENOMS);
        targetContract(address(handler));
    }

    /// Pool BNB == honest unspent notes + claimable (exact accounting solvency, BNB side).
    function invariant_bnbSolvency() public view {
        assertEq(address(gp).balance, handler.ghostNotes() + handler.ghostClaimable(), "pool BNB");
    }

    /// Pool BNB covers every handle's claimable (the subset the handler touches).
    function invariant_claimableCovered() public view {
        uint256 sum;
        for (uint256 h = 1; h <= 5; h++) {
            sum += gp.claimable(h);
        }
        assertEq(sum, handler.ghostClaimable());
        assertGe(address(gp).balance, sum);
    }

    /// Every nullifier is marked exactly once; a replay never lands.
    function invariant_nullifierUniqueness() public view {
        assertEq(handler.spentTotal(), handler.spentUnique(), "nullifier reused");
        assertEq(handler.reuseLanded(), 0, "double spend landed");
        uint256 n = handler.spentUnique();
        for (uint256 i; i < n && i < 64; i++) {
            assertTrue(gp.isSpent(handler.spentList(i)));
        }
    }

    /// Checkpoint period and indexAfter never decrease; every root once known stays known;
    /// nextIndex stays a multiple of 4.
    function invariant_checkpointMonotonic() public view {
        assertTrue(handler.monotonic(), "checkpoint went backwards");
        assertEq(gp.nextIndex() % 4, 0, "chunk alignment");
        uint256 n = handler.knownRootCount();
        for (uint256 i; i < n && i < 64; i++) {
            assertTrue(gp.isKnownRoot(handler.knownRoots(i)), "known root forgotten");
        }
        assertTrue(gp.isKnownRoot(handler.knownRoots(0)), "genesis forgotten");
    }

    /// Relayer fees left the pool exactly once each.
    function invariant_relayerPaid() public view {
        assertEq(relayer.balance, handler.ghostRelayerPaid());
    }
}
