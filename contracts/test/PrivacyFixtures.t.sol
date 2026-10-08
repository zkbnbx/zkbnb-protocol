// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {GrovePool} from "../src/GrovePool.sol";
import {DarkCurve} from "../src/DarkCurve.sol";
import {PayoutMode} from "../src/interfaces/IGrove.sol";
import {GroveConstants as C} from "../src/libraries/GroveConstants.sol";
import {BabyJubjub as B} from "../src/libraries/BabyJubjub.sol";
import {Groth16VerifierTransfer} from "../src/verifiers/Groth16VerifierTransfer.sol";
import {Groth16VerifierIntent} from "../src/verifiers/Groth16VerifierIntent.sol";
import {Groth16VerifierClaim} from "../src/verifiers/Groth16VerifierClaim.sol";
import {Groth16VerifierOpen} from "../src/verifiers/Groth16VerifierOpen.sol";
import {console2} from "forge-std/console2.sol";
import {ShieldedPool} from "../src/ShieldedPool.sol";
import {Groth16Verifier} from "../src/Groth16Verifier.sol";
import {MockVerifier} from "./mocks/MockVerifier.sol";
import {MockVerifier13, MockVerifier17, MockVerifier5, MockVerifier7} from "./mocks/MockVerifierN.sol";

// ----------------------------------------------------------------------------------------------
// Minimal stand-ins. The fixture binds fixed addresses into its extDataHash values (coin 0x3333…,
// recipient 0x1111…, relayer 0x2222…, planter 0x4444…), so the coin and the planter are etched at
// those addresses and the Launchpad is a mock that recognises the fixture coin.
// ----------------------------------------------------------------------------------------------

/// @notice ERC20 etched at the fixture coin address.
contract PFToken is ERC20 {
    constructor() ERC20("Fixture", "FIX") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract PFRouter {
    function WETH() external pure returns (address) {
        return address(0xBEEF);
    }
}

/// @notice Launchpad surface used by GrovePool / DarkCurve: the fixture coin exists, is on the
///         curve (not graduated) at a constant price, and `sell` pays a settable BNB amount.
contract PFLaunchpad {
    address public immutable router;
    address public immutable roots;
    address public immutable coin;
    uint256 public constant plantFee = 0.005 ether;
    uint256 public constant VIRTUAL_BNB = 30 ether;
    uint256 public sellPayout;

    constructor(address router_, address roots_, address coin_) {
        router = router_;
        roots = roots_;
        coin = coin_;
    }

    function info(address c)
        external
        view
        returns (address, uint64, uint64, uint256, uint256, uint256, uint256, uint256, address, PayoutMode, uint256)
    {
        return (c == coin ? address(0xC0FFEE) : address(0), 0, 0, 0, 0, 0, 0, 0, address(0), PayoutMode.Creator, 0);
    }

    function price(address) external pure returns (uint256) {
        return 1e9;
    }

    function isGraduated(address) external pure returns (bool) {
        return false;
    }

    function setSellPayout(uint256 v) external {
        sellPayout = v;
    }

    function sell(address c, uint256 tokensIn, uint256) external returns (uint256) {
        IERC20(c).transferFrom(msg.sender, address(this), tokensIn);
        (bool ok,) = msg.sender.call{value: sellPayout}("");
        require(ok, "pay");
        return sellPayout;
    }

    receive() external payable {}
}

/// @notice Etched at the fixture planter address; records the pool's calls.
contract PFPlanter {
    uint256 public plants;
    uint256 public plantValue;
    bytes32 public plantPayloadHash;
    uint256 public handOvers;
    address public hoCoin;
    uint256 public hoHandle;
    PayoutMode public hoMode;
    address public hoWallet;
    uint256 public hoRing;

    function plantFor(bytes calldata payload) external payable returns (address) {
        plants++;
        plantValue += msg.value;
        plantPayloadHash = keccak256(payload);
        return address(0);
    }

    function handOver(address coin, uint256 handle, PayoutMode mode, address wallet, uint256 ringId) external {
        handOvers++;
        hoCoin = coin;
        hoHandle = handle;
        hoMode = mode;
        hoWallet = wallet;
        hoRing = ringId;
    }
}

contract PFHolderRewards {
    function claim(address, uint256, uint256 amount, bytes32[] calldata) external {
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "pay");
    }

    receive() external payable {}
}

/// @title Real-proof integration of the stage-2 fixtures (WORKPLAN 1.3 / HANDOFF-STAGE2 step 3)
/// @notice Loads `test/fixtures/v2/*.json`, deploys the dev-key Groth16 verifiers exported by
///         `circuits/scripts/setup-v2.sh` (never deploy these keys), and checks that
///         (1) every fixture proof verifies, directly and through the contracts' signal builders,
///         (2) changing any single public input makes it fail, and
///         (3) replaying the scenario through GrovePool / DarkCurve reproduces the fixture's tree
///             roots and has each transaction's expected state effect.
///         Two things in the scenario are synthetic and are simulated here, not executed: the
///         result leaves (fixed totals, inserted through the module hook) and the SELL epoch-0
///         close that precedes `intent_sell_voided` (the `cur` counter is advanced in storage).
///         `test_openEpochSell_realProof` executes that SELL open for real with the fixture proof.
contract PrivacyFixturesTest is Test {
    address internal constant COIN = 0x3333333333333333333333333333333333333333;
    address internal constant RECIPIENT = 0x1111111111111111111111111111111111111111;
    address internal constant RELAYER = 0x2222222222222222222222222222222222222222;
    address internal constant PLANTER = 0x4444444444444444444444444444444444444444;
    address internal constant HANDOVER_WALLET = 0x5555555555555555555555555555555555555555;
    uint256 internal constant ACC_RPT = 123456789012345;
    uint256 internal constant N_CASES = 19;
    /// @dev storage slot of `DarkCurve.cur` (`forge inspect DarkCurve storageLayout`).
    uint256 internal constant CUR_SLOT = 5;

    uint8 internal constant K_TRANSFER = 0;
    uint8 internal constant K_INTENT = 1;
    uint8 internal constant K_CLAIM = 2;
    uint8 internal constant K_OPEN = 3;

    string[19] internal NAMES = [
        "shield",
        "transfer_bnb",
        "shield_coin",
        "transfer_coin_with_dividend",
        "unshield_denom",
        "plant_private",
        "handle_claim_full",
        "handle_claim_partial",
        "handover",
        "intent_buy",
        "intent_sell_with_fee_note",
        "intent_harvest",
        "intent_sell_voided",
        "open_buy",
        "open_sell",
        "claim_buy",
        "claim_sell",
        "claim_harvest",
        "claim_voided_sell"
    ];

    string internal js;
    string internal poseidonJs;

    Groth16VerifierTransfer internal vT;
    Groth16VerifierIntent internal vI;
    Groth16VerifierClaim internal vC;
    Groth16VerifierOpen internal vO;
    PFLaunchpad internal lp;
    PFHolderRewards internal hr;
    GrovePool internal gp;
    DarkCurve internal dc;
    address internal treasury = makeAddr("treasury");
    address internal rootsAddr = makeAddr("roots");

    function setUp() public {
        js = vm.readFile("test/fixtures/v2/scenario.json");
        poseidonJs = vm.readFile("test/fixtures/v2/poseidon_vectors.json");
        vm.warp(1_760_000_000);

        address t3 = _deployBytecode("poseidon/PoseidonT3.bin");
        address t4 = _deployBytecode("poseidon/PoseidonT4.bin");
        vT = new Groth16VerifierTransfer();
        vI = new Groth16VerifierIntent();
        vC = new Groth16VerifierClaim();
        vO = new Groth16VerifierOpen();

        vm.etch(COIN, address(new PFToken()).code);
        vm.etch(PLANTER, address(new PFPlanter()).code);
        lp = new PFLaunchpad(address(new PFRouter()), rootsAddr, COIN);
        hr = new PFHolderRewards();
        vm.deal(address(hr), 1_000 ether);
        vm.deal(address(lp), 10 ether);

        gp = new GrovePool(address(vT), t3, t4, address(lp), address(hr), address(0), address(this));
        dc = new DarkCurve(address(gp), rootsAddr, treasury, address(vI), address(vC), address(vO), _pair(".coordinator.ecPk"), address(this));
        gp.setModules(address(dc), PLANTER);
        gp.addUnshieldDenomination(_u(_p(4, ".denomination")));
        gp.addTokenLot(uint256(vm.parseJsonInt(js, _p(2, ".ext.extAmountCoin"))));

        PFToken(COIN).mint(address(this), 10_000_000 ether);
        IERC20(COIN).approve(address(gp), type(uint256).max);
    }

    // ================================================================== tests

    function test_fixtureMetadata_matchesContracts() public view {
        for (uint256 i; i < N_CASES; i++) {
            assertEq(vm.parseJsonString(js, _p(i, ".name")), NAMES[i], "case order");
        }
        assertEq(vm.parseJsonAddress(js, ".coin"), COIN);
        assertEq(vm.parseJsonAddress(js, ".recipient"), RECIPIENT);
        assertEq(vm.parseJsonAddress(js, ".relayer"), RELAYER);
        assertEq(vm.parseJsonAddress(js, ".planter"), PLANTER);
        assertEq(_u(".plantFee"), lp.plantFee());
        assertEq(_u(".intentFee"), C.INTENT_FEE);
        assertEq(_u(".accRpt"), ACC_RPT);
        assertEq(_u(".fieldSize"), C.FIELD_SIZE);
        assertEq(_u(".zeroLeaf"), C.ZERO_LEAF);
        assertEq(_u(".levels"), uint256(gp.levels()));
        assertEq(_u(".emptyRoot"), gp.getLastRoot(), "empty root");
        assertTrue(gp.isKnownRoot(_u(".emptyRoot")));
        // poseidon_vectors.json against the contracts' hashing
        assertEq(gp.hashLeftRight(1, 2), vm.parseJsonUint(poseidonJs, ".poseidon2_1_2"));
        uint256 ek = vm.parseJsonUint(poseidonJs, ".epochKey_coin_3_sell"); // epochKey(COIN, seq 3, SELL)
        assertEq(dc.epochKey(COIN, 3, 1), ek, "epochKey vector");
        assertEq(
            dc.intentLeaf(vm.parseJsonUint(poseidonJs, ".note.commitment"), ek),
            vm.parseJsonUint(poseidonJs, ".intentLeaf"),
            "intentLeaf vector"
        );
        assertEq(dc.resultLeaf(ek, 1, 0, 1, 40), vm.parseJsonUint(poseidonJs, ".voidResultLeaf_rpt40"), "void leaf vector");
        assertEq(
            dc.resultLeaf(
                vm.parseJsonUint(poseidonJs, ".epochKey_coin_3_sell"),
                vm.parseJsonUint(poseidonJs, ".totals.totalIn"),
                vm.parseJsonUint(poseidonJs, ".totals.totalOut"),
                vm.parseJsonUint(poseidonJs, ".totals.totalRefund"),
                vm.parseJsonUint(poseidonJs, ".totals.rptAtSettle")
            ),
            vm.parseJsonUint(poseidonJs, ".resultLeaf"),
            "resultLeaf vector"
        );
    }

    /// @notice Every fixture proof verifies against its dev verifier, and through the contract
    ///         wrapper that builds the public-signal array in the frozen order (WORKPLAN 1.2).
    function test_everyFixtureProofVerifies() public view {
        for (uint256 i; i < N_CASES; i++) {
            (uint8 kind, uint256[] memory sig) = _signals(i);
            GrovePool.Proof memory p = _proof(i);
            assertTrue(_verifyRaw(kind, p, sig), string.concat("raw verify: ", NAMES[i]));
            assertTrue(_verifyViaContract(kind, i, p), string.concat("contract verify: ", NAMES[i]));
        }
    }

    /// @notice Changing any single public input (by +1 mod p) makes every fixture proof fail.
    function test_tamperedPublicInputFails() public view {
        uint256 checked;
        for (uint256 i; i < N_CASES; i++) {
            (uint8 kind, uint256[] memory sig) = _signals(i);
            GrovePool.Proof memory p = _proof(i);
            for (uint256 j; j < sig.length; j++) {
                uint256 orig = sig[j];
                sig[j] = addmod(orig, 1, C.FIELD_SIZE);
                assertFalse(_verifyRaw(kind, p, sig), string.concat("tampered signal accepted: ", NAMES[i], " #", vm.toString(j)));
                sig[j] = orig;
                checked++;
            }
            // a proof of another case with this case's signals
            GrovePool.Proof memory other = _proof(i == 0 ? 1 : i - 1);
            if (keccak256(abi.encode(other)) != keccak256(abi.encode(p))) {
                assertFalse(_verifyRaw(kind, other, sig), string.concat("foreign proof accepted: ", NAMES[i]));
            }
        }
        assertEq(checked, 13 * 9 + 17 * 4 + 7 * 2 + 5 * 4, "signals checked");
    }

    /// @notice Full scenario through the contracts: roots, nullifiers, balances, handles, planter
    ///         hooks, intent leaves and ElGamal sums, result leaves, claims.
    function test_scenarioReplay_stateEffects() public {
        for (uint256 i; i < N_CASES; i++) {
            _step(i);
        }
        assertEq(gp.getLastRoot(), _u(".finalRoot"), "final root");
        assertEq(uint256(gp.nextIndex()), vm.parseJsonUintArray(js, ".leaves").length, "leaf count");
    }

    /// @notice The SELL epoch-0 open executed for real with the fixture `open_sell` proof: a wrong
    ///         `u` is refused, the right one settles and writes exactly the fixture's result leaf.
    function test_openEpochSell_realProof() public {
        for (uint256 i; i <= 11; i++) {
            _step(i); // through intent_harvest; SELL epoch 0 holds bob's intent only
        }
        uint256 expectedOut = _u(".results[1].totals.totalOut");
        lp.setSellPayout(expectedOut);
        vm.warp(block.timestamp + C.CHECKPOINT_PERIOD);
        assertTrue(dc.isOpenable(COIN, 1, 0));

        GrovePool.Proof[3] memory proofs;
        proofs[1] = _proof(14);
        uint32[3] memory seq;
        uint256[3] memory u = [uint256(0), 50_001, 0];
        uint256[3] memory minOut;
        vm.expectRevert(DarkCurve.InvalidProof.selector);
        dc.openEpoch(COIN, 2, seq, u, proofs, minOut);

        u[1] = _u(_p(14, ".pub.u"));
        uint256 poolBnb = address(gp).balance;
        uint256 poolTok = IERC20(COIN).balanceOf(address(gp));
        uint32 idx = gp.nextIndex();
        vm.recordLogs();
        dc.openEpoch(COIN, 2, seq, u, proofs, minOut);

        assertEq(dc.epochOf(COIN, 1, 0).status, 2, "opened");
        assertEq(dc.cur(COIN, 1), 1, "seq advanced");
        assertEq(IERC20(COIN).balanceOf(address(gp)), poolTok - _u(".results[1].totals.totalIn"), "tokens sold");
        assertEq(address(gp).balance, poolBnb + expectedOut, "proceeds to pool");
        assertEq(uint256(gp.nextIndex()), uint256(idx) + 4, "one result chunk");
        assertEq(_firstNewCommitment(vm.getRecordedLogs()), _u(".results[1].leaf"), "result leaf == fixture");
    }

    // ============================================================ replay

    function _step(uint256 i) internal {
        if (i == 3) {
            // knownAccRpt: pull a HolderRewards run so accRpt[coin] becomes the fixture's ACC_RPT
            gp.pullRewards(COIN, 1, _u(_p(3, ".owed")), new bytes32[](0));
            assertEq(gp.accRpt(COIN), ACC_RPT, "accRpt");
        } else if (i == 6) {
            gp.credit{value: _u(_p(6, ".claimable"))}(_u(".alice.handle1"));
        } else if (i == 7) {
            gp.credit{value: _u(_p(7, ".claimable"))}(_u(".alice.handle2"));
        } else if (i == 12) {
            // SIMULATED: the fixture closes SELL epoch 0 before this seq-1 intent but writes its
            // result leaf later (index 52). Advance cur[coin][SELL] to 1 without a chunk.
            vm.store(address(dc), keccak256(abi.encode(COIN, CUR_SLOT)), bytes32(uint256(1) << 32));
            assertEq(dc.cur(COIN, 1), 1);
            assertEq(dc.cur(COIN, 0), 0);
            assertEq(dc.cur(COIN, 2), 0);
        } else if (i == 15) {
            _insertResults();
        }

        uint8 kind = _kind(i);
        if (kind == K_TRANSFER) _doTransfer(i);
        else if (kind == K_INTENT) _doIntent(i);
        else if (kind == K_CLAIM) _doClaim(i);
        else _checkOpen(i);
    }

    /// @dev New checkpoint period, record the current root; it must be the fixture's root.
    function _advance(uint256 root, uint256 i) internal {
        vm.warp(block.timestamp + C.CHECKPOINT_PERIOD);
        gp.checkpoint();
        assertEq(gp.getLastRoot(), root, string.concat("pool root == fixture root: ", NAMES[i]));
        assertTrue(gp.isKnownRoot(root));
        assertEq(uint256(gp.nextIndex()), _u(_p(i, ".chunkStart")), "chunk start");
    }

    function _afterChunk(uint256 i) internal view {
        assertEq(gp.getLastRoot(), _u(_p(i, ".checkpointAfter.root")), string.concat("root after: ", NAMES[i]));
        assertEq(uint256(gp.nextIndex()), _u(_p(i, ".checkpointAfter.indexAfter")), "index after");
    }

    struct Bal {
        uint256 pool;
        uint256 poolCoin;
        uint256 recipient;
        uint256 relayer;
        uint256 treasury;
        uint256 dc;
        uint256 claimable;
    }

    function _doTransfer(uint256 i) internal {
        GrovePool.Proof memory p = _proof(i);
        GrovePool.TransferPublic memory s = _tPub(i);
        GrovePool.ExtData memory e = _tExt(i);
        _advance(s.root, i);
        uint256 value = e.extAmountBnb > 0 ? uint256(e.extAmountBnb) : 0;

        GrovePool.TransferPublic memory t = _tPub(i);
        t.outputCommitments[2] = addmod(t.outputCommitments[2], 1, C.FIELD_SIZE);
        vm.expectRevert(GrovePool.InvalidProof.selector);
        gp.transact{value: value}(p, t, e);

        Bal memory b = _bal(e.recipient, e.relayer, s.handle);
        gp.transact{value: value}(p, s, e);

        assertTrue(gp.isSpent(s.inputNullifiers[0]) && gp.isSpent(s.inputNullifiers[1]), "nullifiers spent");
        _afterChunk(i);
        uint256 out = e.extAmountBnb < 0 ? uint256(-e.extAmountBnb) : 0;
        assertEq(address(gp).balance, b.pool + value - out - e.fee, "pool BNB");
        if (out > 0) assertEq(e.recipient.balance, b.recipient + out, "recipient BNB");
        if (e.fee > 0) assertEq(RELAYER.balance, b.relayer + e.fee, "relayer fee");
        int256 coinDelta = e.extAmountCoin;
        assertEq(int256(IERC20(COIN).balanceOf(address(gp))), int256(b.poolCoin) + coinDelta, "pool coin");
        if (s.handle != 0) assertEq(gp.claimable(s.handle), b.claimable - s.claimAmount, "claimable");

        if (i == 5) {
            assertEq(PFPlanter(PLANTER).plants(), 1);
            assertEq(PFPlanter(PLANTER).plantValue(), _u(_p(5, ".plantFee")));
            assertEq(PFPlanter(PLANTER).plantPayloadHash(), keccak256(e.payload));
        } else if (i == 6) {
            assertEq(gp.claimable(s.handle), 0, "full claim zeroes the handle");
        } else if (i == 7) {
            assertEq(gp.claimable(s.handle), _u(_p(7, ".claimable")) - s.claimAmount, "partial claim leaves the rest");
            assertGt(gp.claimable(s.handle), 0);
        } else if (i == 8) {
            assertEq(PFPlanter(PLANTER).handOvers(), 1);
            assertEq(PFPlanter(PLANTER).hoCoin(), COIN);
            assertEq(PFPlanter(PLANTER).hoHandle(), _u(".alice.handle3"));
            assertEq(uint256(PFPlanter(PLANTER).hoMode()), _u(_p(8, ".mode")));
            assertEq(PFPlanter(PLANTER).hoWallet(), HANDOVER_WALLET);
            assertEq(PFPlanter(PLANTER).hoRing(), 0);
        }
    }

    function _doIntent(uint256 i) internal {
        GrovePool.Proof memory p = _proof(i);
        DarkCurve.IntentPublic memory s = _iPub(i);
        DarkCurve.IntentExt memory e = _iExt(i);
        _advance(s.root, i);
        uint32 seq = uint32(_u(_p(i, ".seq")));
        assertEq(dc.cur(COIN, s.dir), seq, "epoch seq");
        assertEq(s.outputCommitments[0], _u(_p(i, ".intentCommitment")));
        uint256 leaf = dc.intentLeaf(s.outputCommitments[0], dc.epochKey(s.coin, seq, s.dir));
        assertEq(leaf, _u(_p(i, ".intentLeaf")), "intent leaf");
        assertEq(leaf, vm.parseJsonUintArray(js, _p(i, ".chunk"))[0], "chunk[0] is the stamped leaf");

        DarkCurve.IntentPublic memory t = _iPub(i);
        t.outputCommitments[2] = addmod(t.outputCommitments[2], 1, C.FIELD_SIZE);
        vm.expectRevert(DarkCurve.InvalidProof.selector);
        dc.submitIntent(p, t, e);

        uint32 countBefore = dc.epochOf(COIN, s.dir, seq).count;
        Bal memory b = _bal(address(0), e.relayer, 0);
        dc.submitIntent(p, s, e);

        assertTrue(gp.isSpent(s.inputNullifiers[0]) && gp.isSpent(s.inputNullifiers[1]), "nullifiers spent");
        assertTrue(dc.seenC1(s.c1[0]), "c1 recorded");
        _afterChunk(i);
        DarkCurve.Epoch memory ep = dc.epochOf(COIN, s.dir, seq);
        assertEq(ep.count, countBefore + 1, "count");
        assertEq(ep.status, 1, "collecting");
        if (countBefore == 0) {
            (uint256 x1, uint256 y1) = B.toAffine(ep.c1);
            (uint256 x2, uint256 y2) = B.toAffine(ep.c2);
            assertEq(x1, s.c1[0]);
            assertEq(y1, s.c1[1]);
            assertEq(x2, s.c2[0]);
            assertEq(y2, s.c2[1]);
        }
        assertEq(treasury.balance, b.treasury + C.INTENT_FEE, "intent fee");
        if (e.fee > 0) assertEq(RELAYER.balance, b.relayer + e.fee, "relayer fee");
        assertEq(address(gp).balance, b.pool - e.fee - C.INTENT_FEE, "pool BNB");
        assertEq(IERC20(COIN).balanceOf(address(gp)), b.poolCoin, "escrow stays in the pool");
    }

    function _doClaim(uint256 i) internal {
        GrovePool.Proof memory p = _proof(i);
        DarkCurve.ClaimPublic memory s = _cPub(i);
        DarkCurve.ClaimExt memory e = _cExt(i);
        _advance(s.root, i);

        DarkCurve.ClaimPublic memory t = _cPub(i);
        t.outputCommitments[1] = addmod(t.outputCommitments[1], 1, C.FIELD_SIZE);
        vm.expectRevert(DarkCurve.InvalidProof.selector);
        dc.claim(p, t, e);

        Bal memory b = _bal(address(0), e.relayer, 0);
        dc.claim(p, s, e);

        assertTrue(gp.isSpent(s.nullifier), "claim nullifier spent");
        _afterChunk(i);
        assertEq(address(gp).balance, b.pool, "claims move no BNB");
        assertEq(IERC20(COIN).balanceOf(address(gp)), b.poolCoin, "claims move no tokens");
        assertEq(address(dc).balance, b.dc, "no reimbursement without budget");

        vm.expectRevert(DarkCurve.AlreadySpent.selector);
        dc.claim(p, s, e);
    }

    /// @dev Open proofs: verify through DarkCurve, wrong u fails, fixture sum == stated (c1, c2),
    ///      and the on-chain epoch sum holds the ciphertexts the scenario actually submitted.
    function _checkOpen(uint256 i) internal view {
        GrovePool.Proof memory p = _proof(i);
        uint256[2] memory ecPk = _pair(_p(i, ".pub.ecPk"));
        uint256[2] memory c1 = _pair(_p(i, ".pub.c1"));
        uint256[2] memory c2 = _pair(_p(i, ".pub.c2"));
        uint256 u = _u(_p(i, ".pub.u"));
        (uint256[2] memory pk,) = dc.activeCoordinatorKey();
        assertEq(pk[0], ecPk[0]);
        assertEq(pk[1], ecPk[1]);
        assertTrue(dc.verifyOpen(p, ecPk, c1, c2, u), "open proof");
        assertFalse(dc.verifyOpen(p, ecPk, c1, c2, u + 1), "wrong u");

        uint256 n = i == 13 ? 3 : 1;
        B.Point memory s1 = B.identity();
        B.Point memory s2 = B.identity();
        for (uint256 k; k < n; k++) {
            string memory base = string.concat(".ciphertexts[", vm.toString(k), "]");
            uint256[2] memory a1 = _pair(_p(i, string.concat(base, ".c1")));
            uint256[2] memory a2 = _pair(_p(i, string.concat(base, ".c2")));
            s1 = B.add(s1, B.fromAffine(a1[0], a1[1]));
            s2 = B.add(s2, B.fromAffine(a2[0], a2[1]));
        }
        _assertAffine(s1, c1, "sum c1");
        _assertAffine(s2, c2, "sum c2");

        uint8 dir = uint8(_u(_p(i, ".dir")));
        DarkCurve.Epoch memory ep = dc.epochOf(COIN, dir, uint32(_u(_p(i, ".seq"))));
        if (i == 14) {
            _assertAffine(ep.c1, c1, "on-chain SELL sum c1");
            _assertAffine(ep.c2, c2, "on-chain SELL sum c2");
        } else {
            // open_buy adds two encryptions that have no intent proof in the fixture
            assertEq(ep.count, 1);
            _assertAffine(ep.c1, _pair(_p(i, ".ciphertexts[0].c1")), "on-chain BUY c1");
            _assertAffine(ep.c2, _pair(_p(i, ".ciphertexts[0].c2")), "on-chain BUY c2");
        }
    }

    /// @dev SIMULATED: the fixture's result leaves carry fixed totals, so they are inserted through
    ///      the module hook. Each leaf is recomputed with DarkCurve.resultLeaf first.
    function _insertResults() internal {
        assertEq(gp.accRpt(COIN), ACC_RPT);
        uint256[4] memory r;
        for (uint256 k; k < 4; k++) {
            string memory base = string.concat(".results[", vm.toString(k), "]");
            uint256 ek = dc.epochKey(COIN, uint32(_u(string.concat(base, ".seq"))), uint8(_u(string.concat(base, ".dir"))));
            r[k] = dc.resultLeaf(
                ek,
                _u(string.concat(base, ".totals.totalIn")),
                _u(string.concat(base, ".totals.totalOut")),
                _u(string.concat(base, ".totals.totalRefund")),
                _u(string.concat(base, ".totals.rptAtSettle"))
            );
            assertEq(r[k], _u(string.concat(base, ".leaf")), "result leaf");
            assertEq(_u(string.concat(base, ".totals.rptAtSettle")), gp.accRpt(COIN), "rptAtSettle");
        }
        // the voided leaf is exactly what voidEpoch writes: (1, 0, 1, accRpt)
        assertEq(r[3], dc.resultLeaf(dc.epochKey(COIN, 1, 1), 1, 0, 1, gp.accRpt(COIN)), "void leaf");

        assertEq(uint256(gp.nextIndex()), _u(".resultChunks[0].start"));
        vm.startPrank(address(dc));
        gp.insertChunk([r[0], r[1], r[2], C.ZERO_LEAF], new bytes[](0));
        assertEq(uint256(gp.nextIndex()), _u(".resultChunks[1].start"));
        gp.insertChunk([r[3], C.ZERO_LEAF, C.ZERO_LEAF, C.ZERO_LEAF], new bytes[](0));
        vm.stopPrank();
        assertEq(gp.getLastRoot(), _u(".checkpointAfterResults.root"), "root after results");
        assertEq(uint256(gp.nextIndex()), _u(".checkpointAfterResults.indexAfter"));
    }

    // ============================================================ gas (contracts/gas-v2.json)

    /// @notice Inputs for `contracts/scripts/gas-v2.mjs`: the extra cost of the real (dev-key) Groth16
    ///         verifiers over the `MockVerifierN` stand-ins that GrovePool.t.sol / DarkCurve.t.sol run
    ///         with, and the calldata cost of every relayed kind, both measured on the fixture proofs.
    ///         Logged as "gasv2 <key> <value>" (`forge test -vv`). The pairing cost does not depend on
    ///         the key, so the ceremony verifiers cost the same.
    function test_gas_realVerifierAndCalldata() public {
        address[4] memory mocks =
            [address(new MockVerifier13()), address(new MockVerifier17()), address(new MockVerifier5()), address(new MockVerifier7())];
        uint256[4] memory delta;
        uint256 cdTransfer;
        uint256 cdPlant;
        uint256 cdIntent;
        uint256 cdClaim;
        for (uint256 i; i < N_CASES; i++) {
            (uint8 kind, uint256[] memory sig) = _signals(i);
            GrovePool.Proof memory p = _proof(i);
            (uint256 gReal, bool okReal) = _verifyGas(kind, _realVerifier(kind), p, sig);
            (uint256 gMock, bool okMock) = _verifyGas(kind, mocks[kind], p, sig);
            assertTrue(okReal && okMock, string.concat("verify: ", NAMES[i]));
            assertGt(gReal, gMock, "real verifier costs more than the mock");
            if (gReal - gMock > delta[kind]) delta[kind] = gReal - gMock;
            if (kind == K_TRANSFER) {
                uint256 cd = _calldataGas(abi.encodeCall(GrovePool.transact, (p, _tPub(i), _tExt(i))));
                if (i == 5) cdPlant = cd;
                else if (cd > cdTransfer) cdTransfer = cd;
            } else if (kind == K_INTENT) {
                uint256 cd = _calldataGas(abi.encodeCall(DarkCurve.submitIntent, (p, _iPub(i), _iExt(i))));
                if (cd > cdIntent) cdIntent = cd;
            } else if (kind == K_CLAIM) {
                uint256 cd = _calldataGas(abi.encodeCall(DarkCurve.claim, (p, _cPub(i), _cExt(i))));
                if (cd > cdClaim) cdClaim = cd;
            }
        }
        // openEpoch with all three directions (the open fixtures are BUY and SELL; HARVEST reuses the SELL proof)
        GrovePool.Proof[3] memory op = [_proof(13), _proof(14), _proof(14)];
        uint32[3] memory seq = [uint32(_u(_p(13, ".seq"))), uint32(_u(_p(14, ".seq"))), uint32(_u(_p(14, ".seq")))];
        uint256[3] memory u = [_u(_p(13, ".pub.u")), _u(_p(14, ".pub.u")), _u(_p(14, ".pub.u"))];
        uint256[3] memory minOut = [uint256(1 ether), 1 ether, 1 ether];
        uint256 cdOpen3 = _calldataGas(abi.encodeCall(DarkCurve.openEpoch, (COIN, uint8(7), seq, u, op, minOut)));
        uint256 cdVoid = _calldataGas(abi.encodeCall(DarkCurve.voidEpoch, (COIN, uint8(1), uint32(0))));

        // v1 migration: the live v1 verifier (7 signals) on the v1 withdraw fixture, output 2 bound to the handle
        (ShieldedPool.Proof memory vp, ShieldedPool.ExtData memory ve) = _v1Withdraw(vm.readFile("test/fixtures/pool.json"));
        uint256 handle = _u(".alice.handle1");
        ve.encryptedOutput2 = abi.encode(handle);
        uint256[7] memory s7 = [
            vp.root,
            vp.publicAmount,
            uint256(vp.extDataHash),
            vp.inputNullifiers[0],
            vp.inputNullifiers[1],
            vp.outputCommitments[0],
            vp.outputCommitments[1]
        ];
        Groth16Verifier v1Real = new Groth16Verifier();
        MockVerifier v1Mock = new MockVerifier();
        uint256 g0 = gasleft();
        bool ok1 = v1Real.verifyProof(vp.a, vp.b, vp.c, s7);
        uint256 g1 = gasleft();
        v1Mock.verifyProof(vp.a, vp.b, vp.c, s7);
        uint256 g2 = gasleft();
        assertTrue(ok1, "v1 fixture proof verifies");
        uint256 cdMigrate = _calldataGas(abi.encodeCall(GrovePool.migrateFromV1, (vp, ve, handle)));

        console2.log("gasv2 verifyDelta.transfer", delta[K_TRANSFER]);
        console2.log("gasv2 verifyDelta.intent", delta[K_INTENT]);
        console2.log("gasv2 verifyDelta.claim", delta[K_CLAIM]);
        console2.log("gasv2 verifyDelta.open", delta[K_OPEN]);
        console2.log("gasv2 verifyDelta.v1", (g0 - g1) - (g1 - g2));
        console2.log("gasv2 calldata.transfer", cdTransfer);
        console2.log("gasv2 calldata.plant", cdPlant);
        console2.log("gasv2 calldata.intent", cdIntent);
        console2.log("gasv2 calldata.claim", cdClaim);
        console2.log("gasv2 calldata.v1migrate", cdMigrate);
        console2.log("gasv2 calldata.openEpoch3", cdOpen3);
        console2.log("gasv2 calldata.voidEpoch", cdVoid);
    }

    function _realVerifier(uint8 kind) internal view returns (address) {
        if (kind == K_TRANSFER) return address(vT);
        if (kind == K_INTENT) return address(vI);
        if (kind == K_CLAIM) return address(vC);
        return address(vO);
    }

    /// @dev Gas of the verifier call alone (the signal array is built before the measurement).
    function _verifyGas(uint8 kind, address v, GrovePool.Proof memory p, uint256[] memory s)
        internal
        view
        returns (uint256 g, bool ok)
    {
        if (kind == K_TRANSFER) {
            uint256[13] memory f;
            for (uint256 j; j < 13; j++) f[j] = s[j];
            g = gasleft();
            ok = Groth16VerifierTransfer(v).verifyProof(p.a, p.b, p.c, f);
        } else if (kind == K_INTENT) {
            uint256[17] memory f;
            for (uint256 j; j < 17; j++) f[j] = s[j];
            g = gasleft();
            ok = Groth16VerifierIntent(v).verifyProof(p.a, p.b, p.c, f);
        } else if (kind == K_CLAIM) {
            uint256[5] memory f;
            for (uint256 j; j < 5; j++) f[j] = s[j];
            g = gasleft();
            ok = Groth16VerifierClaim(v).verifyProof(p.a, p.b, p.c, f);
        } else {
            uint256[7] memory f;
            for (uint256 j; j < 7; j++) f[j] = s[j];
            g = gasleft();
            ok = Groth16VerifierOpen(v).verifyProof(p.a, p.b, p.c, f);
        }
        g -= gasleft();
    }

    /// @dev Intrinsic calldata cost: 4 gas per zero byte, 16 per non-zero byte.
    function _calldataGas(bytes memory cd) internal pure returns (uint256 g) {
        for (uint256 k; k < cd.length; k++) {
            g += cd[k] == 0 ? 4 : 16;
        }
    }

    function _v1Withdraw(string memory pj) internal pure returns (ShieldedPool.Proof memory p, ShieldedPool.ExtData memory e) {
        uint256[] memory a = vm.parseJsonUintArray(pj, ".withdraw.proof.a");
        uint256[] memory b0 = vm.parseJsonUintArray(pj, ".withdraw.proof.b[0]");
        uint256[] memory b1 = vm.parseJsonUintArray(pj, ".withdraw.proof.b[1]");
        uint256[] memory c = vm.parseJsonUintArray(pj, ".withdraw.proof.c");
        uint256[] memory n = vm.parseJsonUintArray(pj, ".withdraw.proof.inputNullifiers");
        uint256[] memory o = vm.parseJsonUintArray(pj, ".withdraw.proof.outputCommitments");
        p.a = [a[0], a[1]];
        p.b = [[b0[0], b0[1]], [b1[0], b1[1]]];
        p.c = [c[0], c[1]];
        p.root = vm.parseJsonUint(pj, ".withdraw.proof.root");
        p.publicAmount = vm.parseJsonUint(pj, ".withdraw.proof.publicAmount");
        p.extDataHash = vm.parseJsonBytes32(pj, ".withdraw.proof.extDataHash");
        p.inputNullifiers = [n[0], n[1]];
        p.outputCommitments = [o[0], o[1]];
        e.recipient = vm.parseJsonAddress(pj, ".withdraw.extData.recipient");
        e.extAmount = vm.parseJsonInt(pj, ".withdraw.extData.extAmount");
        e.relayer = vm.parseJsonAddress(pj, ".withdraw.extData.relayer");
        e.fee = vm.parseJsonUint(pj, ".withdraw.extData.fee");
        e.encryptedOutput1 = vm.parseJsonBytes(pj, ".withdraw.extData.encryptedOutput1");
        e.encryptedOutput2 = vm.parseJsonBytes(pj, ".withdraw.extData.encryptedOutput2");
    }

    // ============================================================ parsing

    function _p(uint256 i, string memory k) internal pure returns (string memory) {
        return string.concat(".cases[", vm.toString(i), "]", k);
    }

    function _u(string memory path) internal view returns (uint256) {
        return vm.parseJsonUint(js, path);
    }

    function _pair(string memory path) internal view returns (uint256[2] memory r) {
        uint256[] memory a = vm.parseJsonUintArray(js, path);
        require(a.length == 2, "pair");
        r = [a[0], a[1]];
    }

    function _kind(uint256 i) internal view returns (uint8) {
        bytes32 k = keccak256(bytes(vm.parseJsonString(js, _p(i, ".kind"))));
        if (k == keccak256("transfer")) return K_TRANSFER;
        if (k == keccak256("intent")) return K_INTENT;
        if (k == keccak256("claim")) return K_CLAIM;
        if (k == keccak256("open")) return K_OPEN;
        revert("kind");
    }

    function _proof(uint256 i) internal view returns (GrovePool.Proof memory p) {
        p.a = _pair(_p(i, ".proof.a"));
        p.b = [_pair(_p(i, ".proof.b[0]")), _pair(_p(i, ".proof.b[1]"))];
        p.c = _pair(_p(i, ".proof.c"));
    }

    function _nf(uint256 i) internal view returns (uint256[2] memory) {
        return _pair(_p(i, ".pub.inputNullifiers"));
    }

    function _oc3(uint256 i) internal view returns (uint256[3] memory r) {
        uint256[] memory a = vm.parseJsonUintArray(js, _p(i, ".pub.outputCommitments"));
        require(a.length == 3, "oc3");
        r = [a[0], a[1], a[2]];
    }

    function _enc3(uint256 i) internal view returns (bytes[3] memory r) {
        bytes[] memory a = vm.parseJsonBytesArray(js, _p(i, ".ext.encryptedOutputs"));
        require(a.length == 3, "enc3");
        r = [a[0], a[1], a[2]];
    }

    function _tPub(uint256 i) internal view returns (GrovePool.TransferPublic memory s) {
        s.root = _u(_p(i, ".pub.root"));
        s.publicAmount = _u(_p(i, ".pub.publicAmount"));
        s.coin = vm.parseJsonAddress(js, _p(i, ".pub.coin"));
        s.publicAmountCoin = _u(_p(i, ".pub.publicAmountCoin"));
        s.accRpt = _u(_p(i, ".pub.accRpt"));
        s.handle = _u(_p(i, ".pub.handle"));
        s.claimAmount = _u(_p(i, ".pub.claimAmount"));
        s.extDataHash = vm.parseJsonBytes32(js, _p(i, ".pub.extDataHash"));
        s.inputNullifiers = _nf(i);
        s.outputCommitments = _oc3(i);
    }

    function _tExt(uint256 i) internal view returns (GrovePool.ExtData memory e) {
        e.recipient = vm.parseJsonAddress(js, _p(i, ".ext.recipient"));
        e.extAmountBnb = vm.parseJsonInt(js, _p(i, ".ext.extAmountBnb"));
        e.extAmountCoin = vm.parseJsonInt(js, _p(i, ".ext.extAmountCoin"));
        e.relayer = vm.parseJsonAddress(js, _p(i, ".ext.relayer"));
        e.fee = _u(_p(i, ".ext.fee"));
        e.payload = vm.parseJsonBytes(js, _p(i, ".ext.payload"));
        e.encryptedOutputs = _enc3(i);
    }

    function _iPub(uint256 i) internal view returns (DarkCurve.IntentPublic memory s) {
        s.root = _u(_p(i, ".pub.root"));
        s.publicAmount = _u(_p(i, ".pub.publicAmount"));
        s.coin = vm.parseJsonAddress(js, _p(i, ".pub.coin"));
        s.accRpt = _u(_p(i, ".pub.accRpt"));
        s.dir = uint8(_u(_p(i, ".pub.dir")));
        s.ecPk = _pair(_p(i, ".pub.ecPk"));
        s.c1 = _pair(_p(i, ".pub.c1"));
        s.c2 = _pair(_p(i, ".pub.c2"));
        s.extDataHash = vm.parseJsonBytes32(js, _p(i, ".pub.extDataHash"));
        s.inputNullifiers = _nf(i);
        s.outputCommitments = _oc3(i);
    }

    function _iExt(uint256 i) internal view returns (DarkCurve.IntentExt memory e) {
        e.relayer = vm.parseJsonAddress(js, _p(i, ".ext.relayer"));
        e.fee = _u(_p(i, ".ext.fee"));
        e.encryptedOutputs = _enc3(i);
    }

    function _cPub(uint256 i) internal view returns (DarkCurve.ClaimPublic memory s) {
        s.root = _u(_p(i, ".pub.root"));
        s.nullifier = _u(_p(i, ".pub.nullifier"));
        s.outputCommitments = _pair(_p(i, ".pub.outputCommitments"));
        s.extDataHash = vm.parseJsonBytes32(js, _p(i, ".pub.extDataHash"));
    }

    function _cExt(uint256 i) internal view returns (DarkCurve.ClaimExt memory e) {
        e.relayer = vm.parseJsonAddress(js, _p(i, ".ext.relayer"));
        bytes[] memory a = vm.parseJsonBytesArray(js, _p(i, ".ext.encryptedOutputs"));
        require(a.length == 2, "enc2");
        e.encryptedOutputs = [a[0], a[1]];
    }

    // ============================================================ signals

    /// @dev Public signals in the frozen order of PRIVACY-WORKPLAN.md section 1.2, built here
    ///      independently of the contracts.
    function _signals(uint256 i) internal view returns (uint8 kind, uint256[] memory sig) {
        kind = _kind(i);
        if (kind == K_TRANSFER) {
            GrovePool.TransferPublic memory s = _tPub(i);
            sig = new uint256[](13);
            (sig[0], sig[1], sig[2], sig[3], sig[4], sig[5], sig[6]) =
                (s.root, s.publicAmount, uint256(uint160(s.coin)), s.publicAmountCoin, s.accRpt, s.handle, s.claimAmount);
            (sig[7], sig[8], sig[9]) = (uint256(s.extDataHash), s.inputNullifiers[0], s.inputNullifiers[1]);
            (sig[10], sig[11], sig[12]) = (s.outputCommitments[0], s.outputCommitments[1], s.outputCommitments[2]);
        } else if (kind == K_INTENT) {
            DarkCurve.IntentPublic memory s = _iPub(i);
            sig = new uint256[](17);
            (sig[0], sig[1], sig[2], sig[3], sig[4]) = (s.root, s.publicAmount, uint256(uint160(s.coin)), s.accRpt, uint256(s.dir));
            (sig[5], sig[6], sig[7], sig[8], sig[9], sig[10]) = (s.ecPk[0], s.ecPk[1], s.c1[0], s.c1[1], s.c2[0], s.c2[1]);
            (sig[11], sig[12], sig[13]) = (uint256(s.extDataHash), s.inputNullifiers[0], s.inputNullifiers[1]);
            (sig[14], sig[15], sig[16]) = (s.outputCommitments[0], s.outputCommitments[1], s.outputCommitments[2]);
        } else if (kind == K_CLAIM) {
            DarkCurve.ClaimPublic memory s = _cPub(i);
            sig = new uint256[](5);
            (sig[0], sig[1], sig[2], sig[3], sig[4]) =
                (s.root, s.nullifier, s.outputCommitments[0], s.outputCommitments[1], uint256(s.extDataHash));
        } else {
            uint256[2] memory ecPk = _pair(_p(i, ".pub.ecPk"));
            uint256[2] memory c1 = _pair(_p(i, ".pub.c1"));
            uint256[2] memory c2 = _pair(_p(i, ".pub.c2"));
            sig = new uint256[](7);
            (sig[0], sig[1], sig[2], sig[3], sig[4], sig[5], sig[6]) = (ecPk[0], ecPk[1], c1[0], c1[1], c2[0], c2[1], _u(_p(i, ".pub.u")));
        }
    }

    function _verifyRaw(uint8 kind, GrovePool.Proof memory p, uint256[] memory s) internal view returns (bool) {
        if (kind == K_TRANSFER) {
            uint256[13] memory f;
            for (uint256 j; j < 13; j++) f[j] = s[j];
            return vT.verifyProof(p.a, p.b, p.c, f);
        } else if (kind == K_INTENT) {
            uint256[17] memory f;
            for (uint256 j; j < 17; j++) f[j] = s[j];
            return vI.verifyProof(p.a, p.b, p.c, f);
        } else if (kind == K_CLAIM) {
            uint256[5] memory f;
            for (uint256 j; j < 5; j++) f[j] = s[j];
            return vC.verifyProof(p.a, p.b, p.c, f);
        }
        uint256[7] memory g;
        for (uint256 j; j < 7; j++) g[j] = s[j];
        return vO.verifyProof(p.a, p.b, p.c, g);
    }

    function _verifyViaContract(uint8 kind, uint256 i, GrovePool.Proof memory p) internal view returns (bool) {
        if (kind == K_TRANSFER) return gp.verifyTransfer(p, _tPub(i));
        if (kind == K_INTENT) return dc.verifyIntent(p, _iPub(i));
        if (kind == K_CLAIM) return dc.verifyClaim(p, _cPub(i));
        return dc.verifyOpen(p, _pair(_p(i, ".pub.ecPk")), _pair(_p(i, ".pub.c1")), _pair(_p(i, ".pub.c2")), _u(_p(i, ".pub.u")));
    }

    // ============================================================ helpers

    function _bal(address recipient, address relayer_, uint256 handle) internal view returns (Bal memory b) {
        b.pool = address(gp).balance;
        b.poolCoin = IERC20(COIN).balanceOf(address(gp));
        b.recipient = recipient.balance;
        b.relayer = relayer_ == address(0) ? 0 : relayer_.balance;
        b.treasury = treasury.balance;
        b.dc = address(dc).balance;
        b.claimable = handle == 0 ? 0 : gp.claimable(handle);
    }

    function _assertAffine(B.Point memory pt, uint256[2] memory xy, string memory err) internal view {
        (uint256 x, uint256 y) = B.toAffine(pt);
        assertEq(x, xy[0], err);
        assertEq(y, xy[1], err);
    }

    function _firstNewCommitment(Vm.Log[] memory logs) internal view returns (uint256) {
        bytes32 sigHash = keccak256("NewCommitment(uint256,uint32,bytes)");
        for (uint256 k; k < logs.length; k++) {
            if (logs[k].emitter == address(gp) && logs[k].topics.length > 1 && logs[k].topics[0] == sigHash) {
                return uint256(logs[k].topics[1]);
            }
        }
        revert("no NewCommitment");
    }

    function _deployBytecode(string memory path) internal returns (address addr) {
        bytes memory code = vm.parseBytes(string.concat("0x", vm.trim(vm.readFile(path))));
        assembly {
            addr := create(0, add(code, 0x20), mload(code))
        }
        require(addr != address(0), "bytecode deploy failed");
    }
}
