// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DeployBase} from "../../script/Deploy.s.sol";
import {Launchpad} from "../../src/Launchpad.sol";
import {GroveCoin} from "../../src/GroveCoin.sol";
import {FeeRouter} from "../../src/FeeRouter.sol";
import {Roots} from "../../src/Roots.sol";
import {HolderRewards} from "../../src/HolderRewards.sol";
import {DonationRotator} from "../../src/DonationRotator.sol";
import {ShieldedPool} from "../../src/ShieldedPool.sol";
import {PayoutMode} from "../../src/interfaces/IGrove.sol";
import {IPancakeRouter02, IPancakeFactory, IPancakePair, IWETH} from "../../src/interfaces/IPancake.sol";

interface ISync {
    function sync() external;
}

/// @title Mainnet fork rehearsal
/// @notice Deploys the real stack with the real deploy-script code onto a fork of BNB Smart Chain
///         mainnet and runs the whole lifecycle against the live PancakeSwap V2 factory/router/WBNB
///         and real Groth16 proofs. Skipped unless BSC_FORK_URL is set:
///         BSC_FORK_URL=https://bnb-mainnet.g.alchemy.com/v2/<key> forge test --match-path test/fork/* -vv
contract MainnetForkTest is Test, DeployBase {
    using stdJson for string;

    uint256 constant BPS = 10_000;
    uint256 constant FEE_BPS = 200;

    bool forked;
    Deployment d;
    Launchpad launchpad;
    FeeRouter feeRouter;
    Roots roots;
    HolderRewards holderRewards;
    DonationRotator rotator;
    ShieldedPool pool;
    IPancakeRouter02 router;
    IPancakeFactory factory;
    address wbnb;
    string json;

    address deployer = _actor("deployer");
    address treasury = _actor("treasury");
    address recovery = _actor("recovery");
    address keeper = _actor("keeper");
    address creator = _actor("creator");
    address whale = _actor("whale");
    address alice = _actor("alice");
    address bob = _actor("bob");
    address attacker = _actor("attacker");
    address causeOwner = _actor("causeOwner");

    /// Fresh, never-before-seen addresses. Plain makeAddr("bob") keys are public words and on real
    /// BNB mainnet several of them carry EIP-7702 sweeper delegations that drain any BNB sent there.
    function _actor(string memory name) internal returns (address a) {
        a = makeAddr(string.concat("zkbnb-mainnet-fork-v1-", name));
        vm.etch(a, "");
    }

    function setUp() public {
        string memory url = vm.envOr("BSC_FORK_URL", string(""));
        if (bytes(url).length == 0) {
            // report SKIPPED, not a vacuous PASS, when no mainnet fork is configured
            vm.skip(true, "set BSC_FORK_URL to run the mainnet fork rehearsal");
            return;
        }
        vm.createSelectFork(url);
        require(block.chainid == 56, "fork is not BNB mainnet");
        forked = true;
        address[10] memory all = [deployer, treasury, recovery, keeper, creator, whale, alice, bob, attacker, causeOwner];
        for (uint256 i; i < all.length; i++) vm.etch(all[i], "");

        vm.deal(deployer, 10 ether);
        vm.startPrank(deployer);
        d = _deployStack(_routerFor(56), treasury, recovery, keeper, deployer, deployer);
        vm.stopPrank();

        launchpad = Launchpad(payable(d.launchpad));
        feeRouter = FeeRouter(payable(d.feeRouter));
        roots = Roots(payable(d.roots));
        holderRewards = HolderRewards(payable(d.holderRewards));
        rotator = DonationRotator(payable(d.donationRotator));
        pool = ShieldedPool(payable(d.shieldedPool));
        router = IPancakeRouter02(d.router);
        factory = IPancakeFactory(router.factory());
        wbnb = router.WETH();
        json = vm.readFile("test/fixtures/pool.json");

        for (uint256 i; i < 6; i++) {
            vm.deal([creator, whale, alice, bob, attacker, causeOwner][i], 100 ether);
        }
    }

    modifier onlyFork() {
        if (!forked) {
            console2.log("skipped: set BSC_FORK_URL to run the mainnet fork rehearsal");
            return;
        }
        _;
    }

    // ------------------------------------------------------------------ helpers

    function _plant(PayoutMode mode, uint256 ringId, string memory sym) internal returns (address coin) {
        Launchpad.PlantParams memory p = Launchpad.PlantParams({
            name: string.concat("Fork ", sym),
            symbol: sym,
            metadata: Launchpad.Metadata({description: "fork rehearsal", image: "", website: "", twitter: "", telegram: ""}),
            payoutMode: mode,
            payoutWallet: address(0),
            ringId: ringId,
            minFirstBuyTokens: 0
        });
        uint256 fee = launchpad.plantFee();
        vm.prank(creator);
        coin = launchpad.plant{value: fee}(p);
    }

    function _buy(address who, address coin, uint256 bnb) internal returns (uint256 out) {
        vm.prank(who);
        out = launchpad.buy{value: bnb}(coin, 0);
    }

    function _grossToClear(address coin) internal view returns (uint256) {
        return launchpad.remainingCost(coin) * BPS / (BPS - FEE_BPS) + 1;
    }

    function _reserves(address coin, address pair) internal view returns (uint256 rTok, uint256 rBnb) {
        (uint112 r0, uint112 r1,) = IPancakePair(pair).getReserves();
        (rTok, rBnb) = IPancakePair(pair).token0() == coin ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
    }

    function _path(address a, address b) internal pure returns (address[] memory p) {
        p = new address[](2);
        p[0] = a;
        p[1] = b;
    }

    // ------------------------------------------------------------------ tests

    function test_fork_deploymentWiring() public view {
        if (!forked) return;
        assertEq(d.router, 0x10ED43C718714eb63d5aA57B78B54704E256024E, "real PancakeSwap V2 router");
        assertEq(feeRouter.launchpad(), d.launchpad);
        assertEq(feeRouter.keeper(), keeper);
        assertEq(feeRouter.rootstockCoin(), d.grove);
        assertEq(GroveCoin(payable(d.grove)).symbol(), "ZKBNB");
        assertEq(pool.getLastRoot(), json.readUint(".emptyRoot"), "empty tree root matches the JS library");
        console2.log("deployed at fork block", d.startBlock);
    }

    /// Full curve -> real PancakeSwap graduation -> real swaps with the 2% pair-tax -> keeper sweep ->
    /// roots harvest (public + shielded) -> holder pot funded -> rootstock buyback.
    function test_fork_fullLifecycle_onRealPancakeSwap() public onlyFork {
        address coin = _plant(PayoutMode.Holders, 0, "LIFE");
        _buy(alice, coin, 1 ether);
        _buy(bob, coin, 0.5 ether);

        uint256 gross = _grossToClear(coin);
        uint256 g0 = gasleft();
        _buy(whale, coin, gross + 1 ether); // overshoot: the excess must be refunded
        uint256 gasGraduation = g0 - gasleft();

        address pair = launchpad.pairOf(coin);
        assertTrue(pair != address(0), "graduated");
        assertEq(pair, factory.getPair(coin, wbnb), "the canonical PancakeSwap pair");
        assertEq(GroveCoin(payable(coin)).pair(), pair);
        (uint256 rTok, uint256 rBnb) = _reserves(coin, pair);
        assertEq(rTok, launchpad.LP_TOKENS(), "206.9M tokens in the pool");
        assertApproxEqRel(rBnb, 11.334 ether, 0.001e18, "~11.334 BNB raised in the pool");
        assertGt(IERC20(pair).balanceOf(launchpad.DEAD()), 0, "LP burned to 0xdead");
        assertEq(IERC20(coin).balanceOf(address(launchpad)), 0);
        assertEq(100 ether - whale.balance, gross, "whale paid exactly the quoted cost; the 1 BNB overshoot was refunded");
        console2.log("gas: graduating buy on real PancakeSwap", gasGraduation);

        // real router: buy and sell with fee-on-transfer support, tax lands in the coin
        uint256 taxBefore = GroveCoin(payable(coin)).accruedTax();
        vm.prank(alice);
        router.swapExactETHForTokensSupportingFeeOnTransferTokens{value: 2 ether}(0, _path(wbnb, coin), alice, block.timestamp);
        uint256 aliceTokens = IERC20(coin).balanceOf(alice);
        vm.startPrank(alice);
        IERC20(coin).approve(address(router), aliceTokens / 2);
        router.swapExactTokensForETHSupportingFeeOnTransferTokens(aliceTokens / 2, 0, _path(coin, wbnb), alice, block.timestamp);
        vm.stopPrank();
        uint256 tax = GroveCoin(payable(coin)).accruedTax() - taxBefore;
        assertGt(tax, 0, "pair-tax collected on real PancakeSwap swaps");

        // keeper sweep (uncapped) -> FeeRouter split -> roots + holders pot grow
        uint256 rootsBefore = roots.balance(coin);
        uint256 potBefore = holderRewards.pot(coin);
        uint256 quote = router.getAmountsOut(GroveCoin(payable(coin)).accruedTax(), _path(coin, wbnb))[1];
        vm.prank(keeper);
        uint256 swept = GroveCoin(payable(coin)).sweepTax(quote * 95 / 100);
        assertGt(swept, 0);
        assertGt(roots.balance(coin), rootsBefore, "sweep fed the roots");
        assertGt(holderRewards.pot(coin), potBefore, "sweep fed the holder pot");
        console2.log("swept BNB from pair-tax", swept);

        // public sweep is capped to 1% of the pair's token reserve per block
        vm.prank(alice);
        router.swapExactETHForTokensSupportingFeeOnTransferTokens{value: 1 ether}(0, _path(wbnb, coin), alice, block.timestamp);
        vm.prank(attacker);
        GroveCoin(payable(coin)).sweepTax(0);
        vm.prank(alice); // more tax accrues in the same block
        router.swapExactETHForTokensSupportingFeeOnTransferTokens{value: 1 ether}(0, _path(wbnb, coin), alice, block.timestamp);
        vm.prank(attacker);
        vm.expectRevert(bytes("one per block"));
        GroveCoin(payable(coin)).sweepTax(0);

        // harvest public: ratio never drops
        uint256 perTokenBefore = roots.valuePerToken(coin);
        uint256 burn = IERC20(coin).balanceOf(bob) / 2;
        vm.startPrank(bob);
        IERC20(coin).approve(address(roots), type(uint256).max);
        uint256 bobBnb = bob.balance;
        uint256 got = roots.harvest(coin, burn, 0);
        vm.stopPrank();
        assertGt(got, 0);
        assertEq(bob.balance - bobBnb, got);
        assertGe(roots.valuePerToken(coin), perTokenBefore, "roots per token never drops on harvest");

        // harvest shielded: lands in the pool as a note
        uint256 poolBefore = address(pool).balance;
        uint256 toShield = IERC20(coin).balanceOf(bob) / 2;
        uint256 bobKey = json.readUint(".bobPubkey");
        vm.prank(bob);
        (uint256 shieldedBnb,) = roots.harvestShielded(coin, toShield, 0, bobKey, 777);
        assertEq(address(pool).balance - poolBefore, shieldedBnb);

        // rootstock buyback by the keeper burns $ZKBNB (still on its curve)
        uint256 pot = feeRouter.rootstockPot();
        assertGt(pot, 0);
        uint256 supplyBefore = IERC20(d.grove).totalSupply();
        vm.prank(keeper);
        feeRouter.buybackAndBurn(0);
        assertLt(IERC20(d.grove).totalSupply(), supplyBefore, "ZKBNB burned");
    }

    /// The high-severity finding, on the real PancakeSwap factory: an attacker pre-creates and seeds
    /// the pair before graduation. Graduation must still succeed and keep the raised BNB in the pool.
    function test_fork_graduation_survivesPreSeededRealPair() public onlyFork {
        address coin = _plant(PayoutMode.Creator, 0, "SEED");
        uint256 got = _buy(attacker, coin, 0.1 ether);

        vm.startPrank(attacker);
        address pair = factory.createPair(coin, wbnb);
        IERC20(coin).transfer(pair, got / 2);
        IWETH(wbnb).deposit{value: 1}();
        IWETH(wbnb).transfer(pair, 1);
        IPancakePair(pair).mint(attacker); // attacker holds LP at an absurd price
        vm.stopPrank();
        uint256 attackerLp = IERC20(pair).balanceOf(attacker);
        assertGt(attackerLp, 0);

        (,,, uint256 realBefore,,,,,,,) = launchpad.info(coin);
        uint256 gross = _grossToClear(coin);
        (, uint256 used, uint256 fee) = launchpad.quoteBuy(coin, gross);
        _buy(whale, coin, gross);

        assertEq(launchpad.pairOf(coin), pair, "graduated into the attacker's pre-created pair");
        (, uint256 rBnb) = _reserves(coin, pair);
        assertGe(rBnb, realBefore + used - fee, "all raised BNB is in the pool");
        uint256 share = attackerLp * 1e18 / IERC20(pair).totalSupply();
        assertLt(share * rBnb / 1e18, 1e13, "attacker's LP is worth dust");
    }

    /// Real proofs on the fork: the JS-generated fixture sequence verifies against the deployed verifier.
    function test_fork_shieldedPool_realProofs() public onlyFork {
        address recipient = json.readAddress(".recipient");
        address relayer = json.readAddress(".relayer");
        uint256 r0 = recipient.balance;
        uint256 l0 = relayer.balance;
        _step(".deposit");
        _step(".transfer");
        _step(".withdraw");
        assertEq(recipient.balance - r0, json.readUint(".withdraw.recipientGets"));
        assertEq(relayer.balance - l0, json.readUint(".withdraw.relayerGets"));
        vm.deal(address(this), 1 ether);
        pool.depositFor{value: json.readUint(".depositFor.value")}(json.readUint(".depositFor.pubKey"), json.readUint(".depositFor.blinding"));
        assertEq(pool.getLastRoot(), json.readUint(".depositFor.rootAfter"));
        _step(".spendDepositFor");
        assertEq(pool.nextIndex(), 9);
    }

    function _step(string memory key) internal {
        uint256[] memory a = json.readUintArray(string.concat(key, ".proof.a"));
        uint256[] memory b0 = json.readUintArray(string.concat(key, ".proof.b[0]"));
        uint256[] memory b1 = json.readUintArray(string.concat(key, ".proof.b[1]"));
        uint256[] memory c = json.readUintArray(string.concat(key, ".proof.c"));
        uint256[] memory n = json.readUintArray(string.concat(key, ".proof.inputNullifiers"));
        uint256[] memory o = json.readUintArray(string.concat(key, ".proof.outputCommitments"));
        ShieldedPool.Proof memory p;
        p.a = [a[0], a[1]];
        p.b = [[b0[0], b0[1]], [b1[0], b1[1]]];
        p.c = [c[0], c[1]];
        p.root = json.readUint(string.concat(key, ".proof.root"));
        p.publicAmount = json.readUint(string.concat(key, ".proof.publicAmount"));
        p.extDataHash = json.readBytes32(string.concat(key, ".proof.extDataHash"));
        p.inputNullifiers = [n[0], n[1]];
        p.outputCommitments = [o[0], o[1]];
        ShieldedPool.ExtData memory e;
        e.recipient = json.readAddress(string.concat(key, ".extData.recipient"));
        e.extAmount = json.readInt(string.concat(key, ".extData.extAmount"));
        e.relayer = json.readAddress(string.concat(key, ".extData.relayer"));
        e.fee = json.readUint(string.concat(key, ".extData.fee"));
        e.encryptedOutput1 = json.readBytes(string.concat(key, ".extData.encryptedOutput1"));
        e.encryptedOutput2 = json.readBytes(string.concat(key, ".extData.encryptedOutput2"));
        uint256 value = json.readUint(string.concat(key, ".value"));
        vm.deal(address(this), address(this).balance + value);
        pool.transact{value: value}(p, e);
        assertEq(pool.getLastRoot(), json.readUint(string.concat(key, ".rootAfter")), key);
    }

    /// Donation ring: Donate-mode coin funds the ring, settle pays the cause as a shielded note.
    function test_fork_donationRing_settlesShielded() public onlyFork {
        uint256[] memory ids = new uint256[](1);
        uint256 fee = rotator.registerFee();
        vm.prank(causeOwner);
        ids[0] = rotator.registerCause{value: fee}("Fork cause", "https://example.org", json.readUint(".alicePubkey"), bytes32(uint256(1)), causeOwner);
        uint256 ringId = rotator.createRing("fork ring", ids, 1 days);

        address coin = _plant(PayoutMode.Donate, ringId, "GIVE");
        _buy(alice, coin, 3 ether);
        uint256 pot = rotator.pot(ringId);
        assertApproxEqAbs(pot, 3 ether * FEE_BPS / BPS * 4000 / BPS, 1e9, "0.80% of the trade");

        vm.warp(block.timestamp + 1 days + 1);
        uint256 poolBefore = address(pool).balance;
        (uint256 causeId, uint256 amount) = rotator.settle(ringId);
        assertEq(causeId, ids[0]);
        assertEq(amount, pot);
        assertEq(address(pool).balance - poolBefore, pot, "paid into the shielded pool");
        assertEq(rotator.pot(ringId), 0);
    }

    receive() external payable {}
}
