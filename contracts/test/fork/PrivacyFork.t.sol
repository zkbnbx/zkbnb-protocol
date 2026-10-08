// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {GrovePool} from "../../src/GrovePool.sol";
import {DarkCurve} from "../../src/DarkCurve.sol";
import {Planter} from "../../src/Planter.sol";
import {RewardPoster} from "../../src/RewardPoster.sol";
import {Launchpad} from "../../src/Launchpad.sol";
import {HolderRewards} from "../../src/HolderRewards.sol";
import {PayoutMode} from "../../src/interfaces/IGrove.sol";
import {GroveConstants as C} from "../../src/libraries/GroveConstants.sol";
import {BabyJubjub as B} from "../../src/libraries/BabyJubjub.sol";
import {MockVerifier13, MockVerifier17, MockVerifier5, MockVerifier8} from "../mocks/MockVerifierN.sol";
import {DeployPrivacy} from "../../script/DeployPrivacy.s.sol";

/// @notice Privacy stage 2 against the LIVE chain-56 contracts (STATUS.md "Fork test"): a fresh GrovePool,
///         DarkCurve, Planter and RewardPoster wired to the deployed Launchpad, FeeRouter, Roots, HolderRewards
///         and v1 pool from deployments/56.json, on a fork. Proof verifiers are accept-all stand-ins (real
///         proofs are covered by PrivacyFixtures.t.sol); what this checks is every call into live code:
///         curve and PancakeSwap settlement, fees and taxes, Roots.harvest, HolderRewards runs, private
///         planting, and the deploy script's chain-56 gate.
///
///         Skipped unless BSC_FORK_RPC is set (no network in normal runs):
///           BSC_FORK_RPC=https://bsc-rpc.publicnode.com forge test --match-path test/fork/PrivacyFork.t.sol
contract PrivacyForkTest is Test {
    using stdJson for string;

    bool internal forked;
    Launchpad internal launchpad;
    HolderRewards internal holderRewards;
    address internal feeRouter;
    address internal roots;
    address internal treasury;
    address internal v1pool;

    GrovePool internal gp;
    DarkCurve internal dc;
    Planter internal planter;
    RewardPoster internal poster;

    uint256 internal constant EC_SK = 12345;
    uint256[2] internal ecPk;
    uint256 internal nfCounter = 1;
    uint256 internal cmCounter = 1_000_000;
    uint256 internal kCounter = 1000;
    address internal alice = makeAddr("fork-alice");
    address internal whale = makeAddr("fork-whale");
    address internal carol = makeAddr("fork-carol");

    mapping(uint8 => uint256) internal sumU;

    function setUp() public {
        string memory rpc = vm.envOr("BSC_FORK_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        forked = true;

        string memory json = vm.readFile("deployments/56.json");
        launchpad = Launchpad(payable(json.readAddress(".launchpad")));
        holderRewards = HolderRewards(payable(json.readAddress(".holderRewards")));
        feeRouter = json.readAddress(".feeRouter");
        roots = json.readAddress(".roots");
        treasury = json.readAddress(".treasury");
        v1pool = json.readAddress(".shieldedPool");

        (uint256 x, uint256 y) = B.toAffine(B.mul(B.base8(), EC_SK));
        ecPk = [x, y];
        gp = new GrovePool(
            address(new MockVerifier13()),
            json.readAddress(".poseidonT3"),
            json.readAddress(".poseidonT4"),
            address(launchpad),
            address(holderRewards),
            v1pool,
            address(this)
        );
        dc = new DarkCurve(
            address(gp), roots, treasury, address(new MockVerifier17()), address(new MockVerifier5()), address(new MockVerifier8()), ecPk, address(this)
        );
        planter = new Planter(address(gp), address(launchpad), feeRouter, roots);
        gp.setModules(address(dc), address(planter));
        gp.addUnshieldDenomination(0.01 ether);
        gp.addTokenLot(1e5 * 1e18);
        poster = new RewardPoster(address(holderRewards), address(gp), holderRewards.keeper());

        vm.deal(alice, 100 ether);
        vm.deal(whale, 10_000 ether);
        vm.deal(address(this), 100 ether);
        shield(20 ether);
    }

    modifier onFork() {
        vm.skip(!forked, "set BSC_FORK_RPC to run the chain-56 fork tests");
        _;
    }

    // ------------------------------------------------------------- helpers

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

    function _ext(address recipient, int256 bnb, int256 coinAmt, bytes memory payload) internal pure returns (GrovePool.ExtData memory e) {
        e.recipient = recipient;
        e.extAmountBnb = bnb;
        e.extAmountCoin = coinAmt;
        e.payload = payload;
        e.encryptedOutputs = [bytes("enc0"), bytes("enc1"), bytes("enc2")];
    }

    function _pub(GrovePool.ExtData memory e, address coin) internal returns (GrovePool.TransferPublic memory s) {
        s.root = gp.getLastRoot();
        if (!gp.isKnownRoot(s.root)) {
            vm.warp(block.timestamp + C.CHECKPOINT_PERIOD);
            gp.checkpoint();
        }
        s.publicAmount = gp.toField(e.extAmountBnb);
        s.coin = coin;
        s.publicAmountCoin = gp.toField(e.extAmountCoin);
        s.extDataHash = gp.hashExtData(e);
        s.inputNullifiers = [_nf(), _nf()];
        s.outputCommitments = [_cm(), _cm(), _cm()];
    }

    function shield(uint256 amount) internal {
        GrovePool.ExtData memory e = _ext(address(0), int256(amount), 0, "");
        gp.transact{value: amount}(_proof(), _pub(e, address(0)), e);
    }

    function _shieldLot(address who, address coin) internal {
        vm.startPrank(who);
        IERC20(coin).approve(address(gp), type(uint256).max);
        GrovePool.ExtData memory e = _ext(address(0), 0, int256(1e5 * 1e18), "");
        gp.transact(_proof(), _pub(e, coin), e);
        vm.stopPrank();
    }

    function _plant(PayoutMode mode) internal returns (address coin) {
        Launchpad.PlantParams memory p = Launchpad.PlantParams({
            name: "Fork Coin",
            symbol: "FORK",
            metadata: Launchpad.Metadata({description: "d", image: "i", website: "w", twitter: "", telegram: ""}),
            payoutMode: mode,
            payoutWallet: address(0),
            ringId: 0,
            minFirstBuyTokens: 0
        });
        vm.prank(alice);
        coin = launchpad.plant{value: launchpad.plantFee()}(p);
        vm.prank(alice);
        launchpad.buy{value: 2 ether}(coin, 0);
    }

    function _knownRoot() internal returns (uint256 r) {
        r = gp.getLastRoot();
        if (!gp.isKnownRoot(r)) {
            vm.warp(block.timestamp + C.CHECKPOINT_PERIOD);
            gp.checkpoint();
        }
    }

    function _submit(address coin, uint8 dir, uint256 u) internal {
        DarkCurve.IntentPublic memory s;
        DarkCurve.IntentExt memory e;
        e.encryptedOutputs = [bytes("i0"), bytes("i1"), bytes("i2")];
        uint256 k = ++kCounter;
        B.Point memory pk = B.fromAffine(ecPk[0], ecPk[1]);
        (s.c1[0], s.c1[1]) = B.toAffine(B.mul(B.base8(), k));
        (s.c2[0], s.c2[1]) = B.toAffine(B.add(B.mul(B.base8(), u), B.mul(pk, k)));
        s.root = _knownRoot();
        s.publicAmount = C.FIELD_SIZE - C.INTENT_FEE;
        s.coin = coin;
        s.accRpt = gp.accRpt(coin);
        s.dir = dir;
        s.ecPk = ecPk;
        s.extDataHash = dc.hashIntentExt(e);
        s.inputNullifiers = [_nf(), _nf()];
        s.outputCommitments = [_cm(), _cm(), _cm()];
        dc.submitIntent(_proof(), s, e);
        sumU[dir] += u;
    }

    function _openArgs(address coin, uint8 dir, uint256 minOut)
        internal
        returns (uint32[3] memory seq, uint256[3] memory u, GrovePool.Proof[3] memory proofs, uint256[3] memory mo)
    {
        vm.warp(block.timestamp + C.T_MAX);
        seq = [dc.cur(coin, 0), dc.cur(coin, 1), dc.cur(coin, 2)];
        u[dir] = sumU[dir];
        mo[dir] = minOut;
        proofs = [_proof(), _proof(), _proof()];
    }

    function _open(address coin, uint8 dir, uint256 minOut) internal {
        (uint32[3] memory seq, uint256[3] memory u, GrovePool.Proof[3] memory proofs, uint256[3] memory mo) = _openArgs(coin, dir, minOut);
        dc.openEpoch(coin, uint8(1 << dir), seq, u, proofs, mo);
        sumU[dir] = 0;
    }

    // ------------------------------------------------------------- tests

    /// @notice A batched BUY, then SELL and HARVEST, settle on the live bonding curve and Roots.
    function test_fork_batchesOnLiveCurve() public onFork {
        address coin = _plant(PayoutMode.Creator);
        assertTrue(gp.isCoin(coin), "live launchpad coin is a pool coin");

        uint256 tok0 = IERC20(coin).balanceOf(address(gp));
        uint256 bnb0 = address(gp).balance;
        _submit(coin, 0, 5000);
        _submit(coin, 0, 6000);
        _submit(coin, 0, 7000);
        _open(coin, 0, 1);
        assertEq(dc.epochOf(coin, 0, 0).status, 2, "BUY opened");
        assertGt(IERC20(coin).balanceOf(address(gp)), tok0, "tokens bought into the pool");
        assertLe(address(gp).balance, bnb0 - 18_000 * C.UNIT_BNB + 1 ether, "BNB left the pool");

        _submit(coin, 1, 20_000);
        uint256 bnb1 = address(gp).balance; // after the intent fee
        _open(coin, 1, 1);
        assertEq(dc.epochOf(coin, 1, 0).status, 2, "SELL opened");
        assertGt(address(gp).balance, bnb1, "sell proceeds into the pool");

        _submit(coin, 2, 10_000);
        uint256 bnb2 = address(gp).balance;
        _open(coin, 2, 0);
        assertEq(dc.epochOf(coin, 2, 0).status, 2, "HARVEST opened");
        assertGe(address(gp).balance, bnb2, "harvest proceeds into the pool");
    }

    /// @notice After graduation the same batches settle through the real PancakeSwap V2 router and pair.
    function test_fork_batchesOnRealPancake() public onFork {
        address coin = _plant(PayoutMode.Creator);
        uint256 gross = launchpad.remainingCost(coin) * 10_000 / (10_000 - launchpad.FEE_BPS()) + 1;
        vm.prank(whale);
        launchpad.buy{value: gross}(coin, 0);
        assertTrue(launchpad.pairOf(coin) != address(0), "graduated");

        uint256 tok0 = IERC20(coin).balanceOf(address(gp));
        _submit(coin, 0, 50_000);
        _open(coin, 0, 1);
        assertGt(IERC20(coin).balanceOf(address(gp)), tok0, "bought through PancakeSwap");

        _submit(coin, 1, 20_000);
        uint256 bnb1 = address(gp).balance; // after the intent fee
        _open(coin, 1, 1);
        assertGt(address(gp).balance, bnb1, "sold through PancakeSwap (fee-on-transfer path)");
    }

    /// @notice Review N2 on live venues: an open with an impossible minOut reverts and leaves the epoch openable.
    function test_fork_minOutIsEnforcedByTheVenue() public onFork {
        address coin = _plant(PayoutMode.Creator);
        _submit(coin, 0, 5000);
        (uint32[3] memory seq, uint256[3] memory u, GrovePool.Proof[3] memory proofs, uint256[3] memory mo) =
            _openArgs(coin, 0, type(uint128).max);
        vm.expectRevert();
        dc.openEpoch(coin, 1, seq, u, proofs, mo);
        assertEq(dc.epochOf(coin, 0, 0).status, 1, "still collecting");
    }

    /// @notice Review N1 against the live HolderRewards: the Safe points its keeper at the RewardPoster, and a run
    ///         is posted and the pool's share pulled in one transaction.
    function test_fork_rewardPoster_liveHolderRewards() public onFork {
        address coin = _plant(PayoutMode.Holders);
        _shieldLot(alice, coin);

        vm.prank(holderRewards.owner());
        holderRewards.setKeeper(address(poster));

        uint256 amount = holderRewards.minPot() + 0.1 ether;
        holderRewards.tip{value: amount}(coin);
        uint256 poolAmt = amount / 4;
        bytes32 a = holderRewards.leaf(coin, 0, address(gp), poolAmt);
        bytes32 b = holderRewards.leaf(coin, 0, carol, amount - poolAmt);
        bytes32 root = a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = b;

        uint256 bnb0 = address(gp).balance;
        vm.prank(poster.operator());
        poster.post(coin, root, amount, 2, "fork://run0", poolAmt, proof);
        assertTrue(holderRewards.isClaimed(coin, 0, address(gp)), "pool leaf pulled in the posting tx");
        assertEq(address(gp).balance, bnb0 + poolAmt);
        assertGt(gp.accRpt(coin), 0);
    }

    /// @notice Private planting through the live Launchpad and FeeRouter: the public creator is a fresh stub.
    function test_fork_plantPrivately() public onFork {
        uint256 fee = launchpad.plantFee();
        bytes memory payload = abi.encode(
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
            uint256(777)
        );
        GrovePool.ExtData memory e = _ext(address(planter), -int256(fee), 0, payload);
        uint256 n = launchpad.coinCount();
        gp.transact(_proof(), _pub(e, address(0)), e);
        address coin = launchpad.coins(n);
        address stub = planter.stubOf(coin);
        assertTrue(stub != address(0), "creator stub deployed");
        assertTrue(gp.isCoin(coin), "privately planted coin is a pool coin");
    }

    /// @notice The deploy script refuses chain 56 without the ceremony gate (a fork reports chain id 56).
    function test_fork_deployScriptRefusesDevKeysOn56() public onFork {
        assertEq(block.chainid, 56);
        DeployPrivacy script = new DeployPrivacy();
        vm.expectRevert(bytes("chain 56: run through `deploy.sh 56 --privacy` (ceremony gate not passed)"));
        script.run();
    }

    receive() external payable {}
}
