// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DeployBase} from "../../script/Deploy.s.sol";
import {Launchpad} from "../../src/Launchpad.sol";
import {FeeRouter} from "../../src/FeeRouter.sol";
import {FlapBuyback} from "../../src/FlapBuyback.sol";
import {IFlapPortal} from "../../src/interfaces/IFlap.sol";
import {PayoutMode} from "../../src/interfaces/IGrove.sol";
import {IPancakeRouter02, IPancakeFactory} from "../../src/interfaces/IPancake.sol";

/// @dev The launch side of Flap's Portal (docs.flap.sh, IPortal.sol). Enums are uint8 on the ABI.
interface IFlapLauncher {
    struct NewTokenV6Params {
        string name;
        string symbol;
        string meta;
        uint8 dexThresh;
        bytes32 salt;
        uint8 migratorType;
        address quoteToken;
        uint256 quoteAmt;
        address beneficiary;
        bytes permitData;
        bytes32 extensionID;
        bytes extensionData;
        uint8 dexId;
        uint8 lpFeeProfile;
        uint16 buyTaxRate;
        uint16 sellTaxRate;
        uint64 taxDuration;
        uint64 antiFarmerDuration;
        uint16 mktBps;
        uint16 deflationBps;
        uint16 dividendBps;
        uint16 lpBps;
        uint256 minimumShareBalance;
        address dividendToken;
        address commissionReceiver;
        uint8 tokenVersion;
    }

    struct TokenStateV8Safe {
        uint8 status;
        uint256 reserve;
        uint256 circulatingSupply;
        uint256 price;
        uint8 tokenVersion;
        uint256 r;
        uint256 h;
        uint256 k;
        uint256 dexSupplyThresh;
        address quoteTokenAddress;
        bool nativeToQuoteSwapEnabled;
        bytes32 extensionID;
        uint256 buyTaxRate;
        uint256 sellTaxRate;
        address pool;
        uint256 progress;
        uint8 lpFeeProfile;
        uint8 dexId;
    }

    function newTokenV6(NewTokenV6Params calldata params) external payable returns (address token);
    function getTokenV8Safe(address token) external view returns (TokenStateV8Safe memory state);
    function swapExactInput(IFlapPortal.ExactInputParams calldata params) external payable returns (uint256 outputAmount);
}

interface IFlapTaxTokenV3 {
    function taxProcessor() external view returns (address);
    function dividendContract() external view returns (address);
    function buyTaxRate() external view returns (uint16);
    function sellTaxRate() external view returns (uint16);
    function liquidationThreshold() external view returns (uint256);
}

interface ITaxProcessor {
    function commissionReceiver() external view returns (address);
    function commissionBps() external view returns (uint16);
    function dispatch() external;
}

interface IPancakeRouterTokens {
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external;
}

/// @title $ZKBNB on Flap, against the real Portal on a BNB mainnet fork
/// @notice Launches the rootstock exactly as decided (Tax Token V3, quote Binance-Peg ZEC, 2%/2% tax,
///         50% beneficiary / 50% ZEC dividends, vanity 7777), deploys the zkBNB stack with the real
///         deploy code path (FLAP_TOKEN branch), and runs the rootstock buyback on the curve, through
///         migration and on PancakeSwap. Skipped unless BSC_FORK_URL is set.
contract FlapRootstockForkTest is Test, DeployBase {
    address constant TAX_V3_IMPL = 0x024f18294970B5c76c0691b87f138A0317156422;
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;
    IFlapLauncher constant PORTAL = IFlapLauncher(FLAP_PORTAL_BSC);
    IERC20 constant ZEC = IERC20(ZEC_BSC);

    // decided launch parameters
    uint8 constant DEX_THRESH_FOUR_FIFTHS = 1;
    uint8 constant MIGRATOR_V2 = 1;
    uint8 constant DEX0 = 0;
    uint8 constant TOKEN_TAXED_V3 = 6;
    uint16 constant TAX_BPS = 200;
    uint256 constant MIN_SHARE = 100_000e18;
    /// @dev Longest tax duration the Portal accepts (100 years, see test_fork_flap_taxDurationLimit).
    uint64 constant TAX_FOREVER = 100 * 365 days;

    bool forked;
    Deployment d;
    FeeRouter feeRouter;
    FlapBuyback buyback;
    Launchpad launchpad;
    address token;
    uint256 launchFee;

    address deployer = _actor("deployer");
    address treasury = _actor("treasury");
    address recovery = _actor("recovery");
    address keeper = _actor("keeper");
    address creatorWallet = _actor("creatorWallet"); // beneficiary + commissionReceiver
    address whale = _actor("whale");
    address alice = _actor("alice");
    address bob = _actor("bob");

    function _actor(string memory name) internal returns (address a) {
        a = makeAddr(string.concat("zkbnb-flap-fork-v1-", name));
        vm.etch(a, "");
    }

    function setUp() public {
        string memory url = vm.envOr("BSC_FORK_URL", string(""));
        if (bytes(url).length == 0) {
            vm.skip(true, "set BSC_FORK_URL to run the Flap fork tests");
            return;
        }
        vm.createSelectFork(url);
        require(block.chainid == 56, "fork is not BNB mainnet");
        forked = true;
        address[8] memory all = [deployer, treasury, recovery, keeper, creatorWallet, whale, alice, bob];
        for (uint256 i; i < all.length; i++) {
            vm.etch(all[i], "");
            vm.deal(all[i], 100 ether);
        }

        (token, launchFee) = _launch("", creatorWallet);

        vm.startPrank(deployer);
        d = _deployStack(_routerFor(56), treasury, recovery, keeper, deployer, deployer, token);
        vm.stopPrank();
        feeRouter = FeeRouter(payable(d.feeRouter));
        buyback = FlapBuyback(payable(d.rootstockBuyback));
        launchpad = Launchpad(payable(d.launchpad));
    }

    // ------------------------------------------------------------------ launch helpers

    function _initCodeHash() internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(hex"3d602d80600a3d3981f3363d3d373d3d3d363d73", TAX_V3_IMPL, hex"5af43d82803e903d91602b57fd5bf3"));
    }

    /// @dev Docs' salt search: keccak chain from a seed until the CREATE2 clone address ends in 7777.
    ///      Hashes in scratch memory so ~65k iterations do not grow memory.
    function _mineSalt(bytes32 seed) internal pure returns (bytes32 salt, address predicted) {
        bytes32 h = _initCodeHash();
        address portal = address(PORTAL);
        assembly {
            let ptr := mload(0x40)
            mstore(0, seed)
            salt := keccak256(0, 32)
            for {} 1 {} {
                mstore8(ptr, 0xff)
                mstore(add(ptr, 1), shl(96, portal))
                mstore(add(ptr, 21), salt)
                mstore(add(ptr, 53), h)
                predicted := and(keccak256(ptr, 85), 0xffffffffffffffffffffffffffffffffffffffff)
                if eq(and(predicted, 0xffff), 0x7777) { break }
                mstore(0, salt)
                salt := keccak256(0, 32)
            }
        }
    }

    function _params(string memory meta, bytes32 salt, address creator) internal pure returns (IFlapLauncher.NewTokenV6Params memory p) {
        p.name = "zkBNB";
        p.symbol = "ZKBNB";
        p.meta = meta;
        p.dexThresh = DEX_THRESH_FOUR_FIFTHS;
        p.salt = salt;
        p.migratorType = MIGRATOR_V2;
        p.quoteToken = ZEC_BSC;
        p.quoteAmt = 0;
        p.beneficiary = creator;
        p.dexId = DEX0;
        p.lpFeeProfile = 0;
        p.buyTaxRate = TAX_BPS;
        p.sellTaxRate = TAX_BPS;
        p.taxDuration = TAX_FOREVER;
        p.antiFarmerDuration = 0;
        p.mktBps = 5000;
        p.deflationBps = 0;
        p.dividendBps = 5000;
        p.lpBps = 0;
        p.minimumShareBalance = MIN_SHARE;
        p.dividendToken = ZEC_BSC;
        p.commissionReceiver = creator;
        p.tokenVersion = TOKEN_TAXED_V3;
    }

    /// @dev Launches with the smallest msg.value the Portal accepts (0, else 1 gwei, else the
    ///      required fee the revert reports) and returns that value.
    function _launch(string memory meta, address creator) internal returns (address t, uint256 value) {
        (bytes32 salt, address predicted) = _mineSalt(keccak256(abi.encode(meta, creator)));
        IFlapLauncher.NewTokenV6Params memory p = _params(meta, salt, creator);
        uint256[3] memory tries = [uint256(0), 1 gwei, 0.01 ether];
        bytes memory lastErr;
        for (uint256 i; i < tries.length; i++) {
            vm.prank(creator);
            try PORTAL.newTokenV6{value: tries[i]}(p) returns (address created) {
                assertEq(created, predicted, "CREATE2 prediction");
                return (created, tries[i]);
            } catch (bytes memory err) {
                lastErr = err;
                console2.log("newTokenV6 reverted with msg.value", tries[i]);
                console2.logBytes(err);
            }
        }
        revert(string(abi.encodePacked("launch failed: ", lastErr)));
    }

    function _status() internal view returns (uint8) {
        return PORTAL.getTokenV8Safe(token).status;
    }

    function _buyWithZec(address who, uint256 amount) internal returns (uint256 out) {
        deal(ZEC_BSC, who, ZEC.balanceOf(who) + amount);
        vm.startPrank(who);
        ZEC.approve(address(PORTAL), amount);
        out = PORTAL.swapExactInput(
            IFlapPortal.ExactInputParams({inputToken: ZEC_BSC, outputToken: token, inputAmount: amount, minOutputAmount: 0, permitData: ""})
        );
        vm.stopPrank();
    }

    /// @dev Real fee collection: trades on a zkBNB Launchpad coin put 0.50% into the rootstock pot.
    function _fundPot(uint256 tradeBnb) internal {
        Launchpad.PlantParams memory pp = Launchpad.PlantParams({
            name: "Fee Source",
            symbol: "FEES",
            metadata: Launchpad.Metadata({description: "", image: "", website: "", twitter: "", telegram: ""}),
            payoutMode: PayoutMode.Creator,
            payoutWallet: address(0),
            ringId: 0,
            minFirstBuyTokens: 0
        });
        uint256 fee = launchpad.plantFee();
        vm.prank(alice);
        address coin = launchpad.plant{value: fee}(pp);
        vm.prank(bob);
        launchpad.buy{value: tradeBnb}(coin, 0);
    }

    function _pathZec(address a, address b) internal pure returns (address[] memory p) {
        p = new address[](2);
        p[0] = a;
        p[1] = b;
    }

    // ------------------------------------------------------------------ tests

    function test_fork_flap_launchMatchesDecision() public view {
        if (!forked) return;
        IFlapLauncher.TokenStateV8Safe memory st = PORTAL.getTokenV8Safe(token);
        assertEq(uint160(token) & 0xffff, 0x7777, "vanity 7777");
        assertEq(st.status, 1, "Tradable on the curve");
        assertEq(st.quoteTokenAddress, ZEC_BSC, "quote token ZEC");
        assertEq(st.tokenVersion, TOKEN_TAXED_V3);
        assertEq(st.buyTaxRate, TAX_BPS);
        assertEq(st.sellTaxRate, TAX_BPS);
        assertEq(st.dexId, DEX0);
        assertTrue(st.nativeToQuoteSwapEnabled, "BNB in is swapped to ZEC by the Portal");
        assertEq(IERC20(token).totalSupply(), 1_000_000_000e18);
        assertEq(IFlapTaxTokenV3(token).buyTaxRate(), TAX_BPS);
        assertEq(IFlapTaxTokenV3(token).sellTaxRate(), TAX_BPS);
        ITaxProcessor tp = ITaxProcessor(IFlapTaxTokenV3(token).taxProcessor());
        assertEq(tp.commissionReceiver(), creatorWallet);
        console2.log("token", token);
        console2.log("launch msg.value (wei)", launchFee);
        console2.log("dexSupplyThresh", st.dexSupplyThresh);
        console2.log("commissionBps", tp.commissionBps());
        console2.log("dividend contract", IFlapTaxTokenV3(token).dividendContract());
    }

    function test_fork_flap_deployWiring() public view {
        if (!forked) return;
        assertEq(d.grove, token, "deployments grove = the Flap token");
        assertEq(feeRouter.rootstockCoin(), token);
        assertEq(address(feeRouter.rootstockBuyback()), address(buyback));
        assertEq(buyback.token(), token);
        assertEq(buyback.quoteToken(), ZEC_BSC);
        assertEq(buyback.feeRouter(), address(feeRouter));
        assertEq(buyback.wbnb(), WBNB_BSC);
        assertEq(buyback.bnbToQuotePath(), abi.encodePacked(WBNB_BSC, uint24(2500), ZEC_BSC));
        assertEq(buyback.owner(), deployer);
        assertEq(buyback.status(), 1);
    }

    /// Empty meta (no image, no description): newTokenV6 accepts it.
    function test_fork_flap_emptyMetaAccepted() public view {
        if (!forked) return;
        // setUp launched with meta = "" already; it would have reverted otherwise
        assertTrue(token.code.length > 0);
    }

    /// A second launch with meta "" from another creator: is the empty meta "already used"?
    function test_fork_flap_emptyMetaTwice() public onlyFork {
        (address t2,) = _launch("", alice);
        assertTrue(t2 != token);
    }

    function test_fork_flap_taxDurationLimit() public onlyFork {
        (bytes32 salt,) = _mineSalt(keccak256("dur"));
        IFlapLauncher.NewTokenV6Params memory p = _params("", salt, bob);
        p.taxDuration = TAX_FOREVER + 1;
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSignature("TaxDurationTooLong()"));
        PORTAL.newTokenV6{value: launchFee}(p);
    }

    function test_fork_flap_buybackOnCurveThenDex() public onlyFork {
        // ---- curve: real fees fund the pot, the keeper buys through the Portal (BNB -> ZEC -> token)
        _fundPot(4 ether);
        uint256 pot = feeRouter.rootstockPot();
        assertEq(pot, 4 ether * 200 / 10_000 * 2500 / 10_000, "0.50% of the trade");
        uint256 deadBefore = IERC20(token).balanceOf(DEAD);
        uint256 benZecBefore = ZEC.balanceOf(creatorWallet);
        vm.prank(keeper);
        uint256 burned = feeRouter.buybackAndBurn(1);
        assertGt(burned, 0);
        assertEq(IERC20(token).balanceOf(DEAD) - deadBefore, burned, "every bought token is at 0xdEaD");
        assertEq(feeRouter.rootstockPot(), 0, "pot spent");
        assertEq(address(buyback).balance, 0);
        assertEq(IERC20(token).balanceOf(address(buyback)), 0);
        assertEq(ZEC.balanceOf(address(buyback)), 0);
        console2.log("curve buyback: BNB", pot, "tokens burned", burned);

        // the curve tax is paid in ZEC; dispatch pushes the beneficiary + commission share
        ITaxProcessor tp = ITaxProcessor(IFlapTaxTokenV3(token).taxProcessor());
        _buyWithZec(alice, 1e18);
        try tp.dispatch() {} catch {}
        uint256 benGot = ZEC.balanceOf(creatorWallet) - benZecBefore;
        console2.log("beneficiary ZEC after curve trades", benGot);
        assertGt(benGot, 0, "curve tax reached the creator wallet in ZEC");

        // public buyback: capped, once per block
        _fundPot(8 ether);
        _fundPot(8 ether);
        pot = feeRouter.rootstockPot();
        assertGt(pot, feeRouter.publicBuybackCap());
        vm.roll(block.number + 1);
        vm.prank(alice);
        feeRouter.buybackAndBurn(0);
        assertEq(feeRouter.rootstockPot(), pot - feeRouter.publicBuybackCap(), "public spend capped");
        vm.prank(bob);
        vm.expectRevert(bytes("one per block"));
        feeRouter.buybackAndBurn(0);

        // ---- drive to migration: whales buy with ZEC until the token is on PancakeSwap
        uint256 rounds;
        while (_status() == 1 && rounds < 200) {
            _buyWithZec(whale, 5e18);
            rounds++;
        }
        IFlapLauncher.TokenStateV8Safe memory st = PORTAL.getTokenV8Safe(token);
        assertEq(st.status, 4, "migrated to DEX");
        address pair = IPancakeFactory(IPancakeRouter02(d.router).factory()).getPair(token, ZEC_BSC);
        assertTrue(pair != address(0), "V2 pair token/ZEC");
        console2.log("migrated after ZEC buys of 5 ZEC:", rounds);
        console2.log("pool", st.pool, "pair", pair);
        assertEq(buyback.status(), 4);

        // ---- DEX: keeper buyback goes BNB -(V3)-> ZEC -(V2)-> token, burns, pot debited
        uint256 pot2 = feeRouter.rootstockPot();
        deadBefore = IERC20(token).balanceOf(DEAD);
        vm.prank(keeper);
        uint256 burned2 = feeRouter.buybackAndBurn(1);
        assertGt(burned2, 0);
        assertEq(IERC20(token).balanceOf(DEAD) - deadBefore, burned2, "DEX buyback burned at 0xdEaD");
        assertEq(feeRouter.rootstockPot(), 0);
        assertEq(ZEC.balanceOf(address(buyback)), 0, "no ZEC left behind");
        assertEq(address(buyback).balance, 0);
        console2.log("DEX buyback: BNB", pot2, "tokens burned", burned2);

        // slippage: an impossible minOut reverts and leaves the pot alone
        _fundPot(4 ether);
        uint256 pot3 = feeRouter.rootstockPot();
        vm.prank(keeper);
        vm.expectRevert();
        feeRouter.buybackAndBurn(type(uint128).max);
        assertEq(feeRouter.rootstockPot(), pot3);

        // ---- DEX tax: trades through the V2 pair accrue tax tokens in the token; once past the
        //      liquidation threshold a pair trade swaps them to ZEC for the beneficiary + dividends
        uint256 benBefore = ZEC.balanceOf(creatorWallet);
        address div = IFlapTaxTokenV3(token).dividendContract();
        uint256 divBefore = ZEC.balanceOf(div);
        console2.log("liquidation threshold", IFlapTaxTokenV3(token).liquidationThreshold());
        address v2 = d.router;
        for (uint256 i; i < 30; i++) {
            deal(ZEC_BSC, bob, 2e18);
            vm.startPrank(bob);
            ZEC.approve(v2, 2e18);
            IPancakeRouterTokens(v2).swapExactTokensForTokensSupportingFeeOnTransferTokens(2e18, 0, _pathZec(ZEC_BSC, token), bob, block.timestamp);
            uint256 bal = IERC20(token).balanceOf(bob);
            IERC20(token).approve(v2, bal);
            IPancakeRouterTokens(v2).swapExactTokensForTokensSupportingFeeOnTransferTokens(bal, 0, _pathZec(token, ZEC_BSC), bob, block.timestamp);
            vm.stopPrank();
        }
        try tp.dispatch() {} catch {}
        uint256 benDex = ZEC.balanceOf(creatorWallet) - benBefore;
        console2.log("token-held tax after DEX trades", IERC20(token).balanceOf(token));
        console2.log("beneficiary ZEC from DEX trades", benDex);
        console2.log("dividend contract ZEC gained", ZEC.balanceOf(div) - divBefore);
        assertGt(benDex, 0, "DEX tax liquidated to ZEC for the creator wallet");
        assertGt(ZEC.balanceOf(div), divBefore, "holders' ZEC dividends funded");
    }

    /// One keeper buyback big enough to finish the curve: the Portal may refund the excess (BNB or
    /// ZEC); nothing may be left stuck in the buyback contract and the next buyback goes via DEX.
    function test_fork_flap_buybackAcrossMigration() public onlyFork {
        // bring the curve close to its end
        while (PORTAL.getTokenV8Safe(token).progress < 0.9e18) _buyWithZec(whale, 0.25e18);
        assertEq(_status(), 1);
        console2.log("progress before the crossing buyback", PORTAL.getTokenV8Safe(token).progress);
        // a pot far larger than the rest of the curve: real fees first, then 40 BNB more written
        // into rootstockPot (backed by 40 BNB dealt to the FeeRouter)
        _fundPot(8 ether);
        uint256 potBefore = feeRouter.rootstockPot();
        vm.deal(address(feeRouter), address(feeRouter).balance + 40 ether);
        vm.store(address(feeRouter), bytes32(_potSlot()), bytes32(potBefore + 40 ether));
        uint256 pot = feeRouter.rootstockPot();
        assertEq(pot, potBefore + 40 ether);
        vm.prank(keeper);
        uint256 burned = feeRouter.buybackAndBurn(1);
        assertGt(burned, 0);
        assertEq(_status(), 4, "the buyback finished the curve");
        uint256 refunded = feeRouter.rootstockPot();
        console2.log("crossing buyback: BNB spent", pot - refunded, "tokens burned", burned);
        assertGt(refunded, 0, "the Portal refunded the excess BNB, back in the pot");
        assertEq(address(buyback).balance, 0);
        assertEq(IERC20(token).balanceOf(address(buyback)), 0);
        assertEq(ZEC.balanceOf(address(buyback)), 0, "no ZEC stuck in the buyback");
        assertEq(address(feeRouter).balance, refunded, "FeeRouter holds exactly the pot");

        // next buyback takes the DEX route with what came back
        uint256 deadBefore = IERC20(token).balanceOf(DEAD);
        vm.prank(keeper);
        uint256 burned2 = feeRouter.buybackAndBurn(1);
        assertEq(IERC20(token).balanceOf(DEAD) - deadBefore, burned2);
        assertEq(feeRouter.rootstockPot(), 0);
        assertEq(ZEC.balanceOf(address(buyback)), 0);

        // for the record: does the Portal still route BNB buys once the token is on DEX?
        vm.prank(alice);
        try PORTAL.swapExactInput{value: 0.01 ether}(
            IFlapPortal.ExactInputParams({inputToken: address(0), outputToken: token, inputAmount: 0.01 ether, minOutputAmount: 0, permitData: ""})
        ) returns (uint256 out) {
            console2.log("Portal.swapExactInput after migration: works, tokens out", out);
        } catch {
            console2.log("Portal.swapExactInput after migration: reverts");
        }
    }

    /// Where rootstockPot lives in FeeRouter storage (found by probing, so layout changes are caught).
    function _potSlot() internal view returns (uint256) {
        uint256 pot = feeRouter.rootstockPot();
        for (uint256 i; i < 40; i++) {
            if (uint256(vm.load(address(feeRouter), bytes32(i))) == pot && pot != 0) return i;
        }
        revert("pot slot");
    }

    modifier onlyFork() {
        if (!forked) return;
        _;
    }

    receive() external payable {}
}
