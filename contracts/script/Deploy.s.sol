// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {Groth16Verifier} from "../src/Groth16Verifier.sol";
import {ShieldedPool} from "../src/ShieldedPool.sol";
import {FeeRouter} from "../src/FeeRouter.sol";
import {Roots} from "../src/Roots.sol";
import {HolderRewards} from "../src/HolderRewards.sol";
import {DonationRotator} from "../src/DonationRotator.sol";
import {Launchpad} from "../src/Launchpad.sol";
import {FlapBuyback} from "../src/FlapBuyback.sol";
import {DarkPool} from "../src/DarkPool.sol";
import {PrivacyDeployBase} from "./DeployPrivacy.s.sol";

/// @notice Shared deployment logic (SPEC §7 order). `Deploy` uses the real PancakeSwap router,
///         `DeployLocal` (script/DeployLocal.s.sol) deploys the mocks first.
abstract contract DeployBase is Script, PrivacyDeployBase {
    struct Deployment {
        address poseidonT3;
        address poseidonT4;
        address verifier;
        address shieldedPool;
        address feeRouter;
        address roots;
        address holderRewards;
        address donationRotator;
        address launchpad;
        address grove;
        address rootstockBuyback; // FlapBuyback when the rootstock lives on Flap, else zero
        address darkPool;
        address darkVaultImpl;
        address router;
        address treasury;
        uint256 startBlock;
        // privacy stage 2 (fresh chains other than 56 only; zero otherwise)
        PrivacyDeployment privacy;
    }

    address public constant PANCAKE_ROUTER_BSC = 0x10ED43C718714eb63d5aA57B78B54704E256024E;
    address public constant PANCAKE_ROUTER_BSC_TESTNET = 0xD99D1c33F9fC3444f8101754aBC46c52416550D1;
    // Flap rootstock (chain 56 only): Portal, its quote token Binance-Peg ZEC, and the PancakeSwap V3
    // router the buyback uses for BNB -> ZEC once the token trades on its V2 pool.
    address public constant FLAP_PORTAL_BSC = 0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0;
    address public constant ZEC_BSC = 0x1Ba42e5193dfA8B03D15dd1B86a3113bbBEF8Eeb;
    address public constant PANCAKE_V3_ROUTER_BSC = 0x1b81D678ffb9C0263b24A97847620C99d213eB14;
    address public constant WBNB_BSC = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    /// @dev Deepest BNB -> ZEC route: the PancakeSwap V3 WBNB/ZEC 0.25% pool.
    uint24 public constant ZEC_V3_FEE = 2500;

    function _routerFor(uint256 chainId) internal view returns (address) {
        if (chainId == 56) return PANCAKE_ROUTER_BSC;
        if (chainId == 97) return PANCAKE_ROUTER_BSC_TESTNET;
        return vm.envAddress("ROUTER");
    }

    /// @dev Deploys raw EVM bytecode from a hex file (no 0x prefix) with CREATE.
    function _deployBytecode(string memory path) internal returns (address addr) {
        bytes memory code = vm.parseBytes(string.concat("0x", vm.trim(vm.readFile(path))));
        assembly {
            addr := create(0, add(code, 0x20), mload(code))
        }
        require(addr != address(0), "bytecode deploy failed");
    }

    /// @dev Must be called inside startBroadcast/stopBroadcast. `deployer` is the broadcaster:
    ///      every module is owned by it during wiring, then ownership is offered to `owner`
    ///      (Ownable2Step: `owner` has to call acceptOwnership on each module).
    function _deployStack(address router, address treasury, address recovery, address keeper, address deployer, address owner)
        internal
        returns (Deployment memory d)
    {
        return _deployStack(router, treasury, recovery, keeper, deployer, owner, address(0));
    }

    /// @dev `flapToken` != 0: the rootstock is that token, already launched on Flap (chain 56 only).
    ///      No in-house $ZKBNB is planted; a FlapBuyback buys and burns `flapToken` with the pot.
    function _deployStack(
        address router,
        address treasury,
        address recovery,
        address keeper,
        address deployer,
        address owner,
        address flapToken
    ) internal returns (Deployment memory d) {
        d.router = router;
        d.treasury = treasury;
        d.startBlock = block.number;

        d.poseidonT3 = _deployBytecode("poseidon/PoseidonT3.bin");
        d.poseidonT4 = _deployBytecode("poseidon/PoseidonT4.bin");
        d.verifier = address(new Groth16Verifier());
        ShieldedPool pool = new ShieldedPool(d.verifier, d.poseidonT3, d.poseidonT4, deployer);
        d.shieldedPool = address(pool);

        FeeRouter feeRouter = new FeeRouter(treasury, recovery, router, deployer);
        Roots roots = new Roots(address(feeRouter), address(pool), deployer);
        HolderRewards holderRewards = new HolderRewards(address(pool), keeper, deployer);
        DonationRotator rotator = new DonationRotator(address(pool), treasury, deployer);
        Launchpad launchpad = new Launchpad(address(feeRouter), router, deployer);
        d.feeRouter = address(feeRouter);
        d.roots = address(roots);
        d.holderRewards = address(holderRewards);
        d.donationRotator = address(rotator);
        d.launchpad = address(launchpad);

        // wiring
        feeRouter.setModules(address(launchpad), address(roots), address(holderRewards), address(rotator));
        feeRouter.setKeeper(keeper);
        roots.setHolderRewards(address(holderRewards));
        holderRewards.setSources(address(feeRouter), address(roots));
        rotator.setFeeRouter(address(feeRouter));
        launchpad.setRoots(address(roots));

        // dark pools: the vault implementation snapshots launchpad.roots(), so only after setRoots.
        // DarkPool's constructor deploys the DarkVault implementation bound to itself.
        (d.darkPool, d.darkVaultImpl) = _deployDarkPool(address(pool), address(launchpad), router);

        // privacy stage 2 (privacy/PRIVACY-SPEC.md section 7) on fresh dev / test chains: dev verifiers and, unless
        // COORDINATOR_PK_X/Y are set, the documented dev Coordinator key. Never on chain 56 (DeployPrivacy.s.sol,
        // behind the ceremony gate). SKIP_PRIVACY=true deploys the stage-1 stack alone.
        if (block.chainid != 56 && !vm.envOr("SKIP_PRIVACY", false)) {
            d.privacy = _deployPrivacyStack(
                PrivacyInputs({
                    launchpad: address(launchpad),
                    feeRouter: address(feeRouter),
                    roots: address(roots),
                    holderRewards: address(holderRewards),
                    shieldedPool: address(pool),
                    treasury: treasury,
                    coordinatorPk: _coordinatorPk(true),
                    claimBudget: _claimBudgetWei(),
                    deployer: deployer,
                    owner: owner
                })
            );
        }

        if (flapToken != address(0)) {
            // rootstock: $ZKBNB launched on Flap (Tax Token V3 paired to ZEC)
            require(block.chainid == 56, "FLAP_TOKEN: BNB mainnet only");
            FlapBuyback buyback = new FlapBuyback(
                flapToken,
                ZEC_BSC,
                address(feeRouter),
                FLAP_PORTAL_BSC,
                router,
                PANCAKE_V3_ROUTER_BSC,
                abi.encodePacked(WBNB_BSC, ZEC_V3_FEE, ZEC_BSC),
                deployer
            );
            require(buyback.status() == 1 || buyback.status() == 4, "FLAP_TOKEN is not a tradable Flap token");
            d.grove = flapToken;
            d.rootstockBuyback = address(buyback);
            feeRouter.setExternalRootstock(flapToken, address(buyback));
        } else {
            // rootstock: $ZKBNB
            Launchpad.Metadata memory md = Launchpad.Metadata({
                description: vm.envOr("ROOTSTOCK_DESCRIPTION", string("zkBNB rootstock. 0.50% of every trade on every coin buys and burns it.")),
                image: vm.envOr("ROOTSTOCK_IMAGE", string("")),
                website: vm.envOr("ROOTSTOCK_WEBSITE", string("")),
                twitter: vm.envOr("ROOTSTOCK_TWITTER", string("")),
                telegram: vm.envOr("ROOTSTOCK_TELEGRAM", string(""))
            });
            d.grove = launchpad.plantRootstock("zkBNB", "ZKBNB", md);
            feeRouter.setRootstock(d.grove);
        }

        if (owner != deployer) {
            pool.transferOwnership(owner);
            feeRouter.transferOwnership(owner);
            roots.transferOwnership(owner);
            holderRewards.transferOwnership(owner);
            rotator.transferOwnership(owner);
            launchpad.transferOwnership(owner);
            if (d.rootstockBuyback != address(0)) FlapBuyback(payable(d.rootstockBuyback)).transferOwnership(owner);
            console2.log("Ownership offered to", owner, "- it must call acceptOwnership() on every module");
        }
    }

    /// @dev Deploys the DarkPool factory (which deploys its DarkVault implementation). Must be called
    ///      inside startBroadcast/stopBroadcast, after `launchpad.setRoots`. No owner, nothing to wire.
    function _deployDarkPool(address pool, address launchpad, address router)
        internal
        returns (address darkPool, address darkVaultImpl)
    {
        DarkPool dp = new DarkPool(pool, launchpad, router);
        darkPool = address(dp);
        darkVaultImpl = dp.vaultImpl();
    }

    function _writeDeployment(Deployment memory d, string memory file) internal {
        string memory obj = "deployment";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeAddress(obj, "poseidonT3", d.poseidonT3);
        vm.serializeAddress(obj, "poseidonT4", d.poseidonT4);
        vm.serializeAddress(obj, "verifier", d.verifier);
        vm.serializeAddress(obj, "shieldedPool", d.shieldedPool);
        vm.serializeAddress(obj, "feeRouter", d.feeRouter);
        vm.serializeAddress(obj, "roots", d.roots);
        vm.serializeAddress(obj, "holderRewards", d.holderRewards);
        vm.serializeAddress(obj, "donationRotator", d.donationRotator);
        vm.serializeAddress(obj, "launchpad", d.launchpad);
        vm.serializeAddress(obj, "grove", d.grove);
        if (d.rootstockBuyback != address(0)) {
            vm.serializeAddress(obj, "rootstockBuyback", d.rootstockBuyback);
            vm.serializeBool(obj, "rootstockExternal", true);
        }
        vm.serializeAddress(obj, "darkPool", d.darkPool);
        vm.serializeAddress(obj, "darkVaultImpl", d.darkVaultImpl);
        vm.serializeAddress(obj, "router", d.router);
        vm.serializeAddress(obj, "treasury", d.treasury);
        if (d.privacy.grovePool != address(0)) _serializePrivacy(obj, d.privacy);
        string memory json = vm.serializeUint(obj, "startBlock", d.startBlock);
        vm.createDir("deployments", true);
        vm.writeJson(json, file);
        console2.log("wrote", file);
    }

    function _log(Deployment memory d) internal pure {
        console2.log("poseidonT3      ", d.poseidonT3);
        console2.log("poseidonT4      ", d.poseidonT4);
        console2.log("verifier        ", d.verifier);
        console2.log("shieldedPool    ", d.shieldedPool);
        console2.log("feeRouter       ", d.feeRouter);
        console2.log("roots           ", d.roots);
        console2.log("holderRewards   ", d.holderRewards);
        console2.log("donationRotator ", d.donationRotator);
        console2.log("launchpad       ", d.launchpad);
        console2.log("grove           ", d.grove);
        if (d.rootstockBuyback != address(0)) console2.log("rootstockBuyback", d.rootstockBuyback);
        console2.log("darkPool        ", d.darkPool);
        console2.log("darkVaultImpl   ", d.darkVaultImpl);
        console2.log("router          ", d.router);
        console2.log("treasury        ", d.treasury);
        console2.log("startBlock      ", d.startBlock);
        if (d.privacy.grovePool != address(0)) _logPrivacy(d.privacy);
    }
}

/// @notice Mainnet / testnet deployment.
///         env: TREASURY, RECOVERY, KEEPER (required), OWNER (default: broadcaster),
///              ROUTER (only for chains other than 56 / 97),
///              FLAP_TOKEN (chain 56: the $ZKBNB token launched on Flap; unset = plant the in-house rootstock).
contract Deploy is DeployBase {
    function run() external {
        address deployer = msg.sender;
        address treasury = vm.envAddress("TREASURY");
        address recovery = vm.envAddress("RECOVERY");
        address keeper = vm.envAddress("KEEPER");
        address owner = vm.envOr("OWNER", deployer);
        address router = _routerFor(block.chainid);
        address flapToken = vm.envOr("FLAP_TOKEN", address(0));

        vm.startBroadcast();
        Deployment memory d = _deployStack(router, treasury, recovery, keeper, deployer, owner, flapToken);
        vm.stopBroadcast();

        _log(d);
        _writeDeployment(d, string.concat("deployments/", vm.toString(block.chainid), ".json"));
    }
}
