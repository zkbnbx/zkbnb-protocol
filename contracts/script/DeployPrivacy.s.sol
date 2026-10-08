// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {GrovePool} from "../src/GrovePool.sol";
import {DarkCurve} from "../src/DarkCurve.sol";
import {Planter} from "../src/Planter.sol";
import {IPoseidonT3, IPoseidonT4} from "../src/interfaces/IGrove.sol";
import {ILaunchpadPrivacy} from "../src/interfaces/IGroveV2.sol";
import {Groth16VerifierTransfer} from "../src/verifiers/Groth16VerifierTransfer.sol";
import {Groth16VerifierIntent} from "../src/verifiers/Groth16VerifierIntent.sol";
import {Groth16VerifierClaim} from "../src/verifiers/Groth16VerifierClaim.sol";
import {Groth16VerifierOpen} from "../src/verifiers/Groth16VerifierOpen.sol";

/// @notice Privacy stage 2 ("Dark Curve") deployment logic, shared by `DeployPrivacy` (adds the stack to a
///         chain whose stage-1 stack is deployed) and `Deploy.s.sol._deployStack` (fresh chains 31337 / 97).
///         Order of privacy/PRIVACY-SPEC.md section 7: Poseidon, the four verifiers, GrovePool, DarkCurve,
///         Planter, `setModules`, denominations and lots (Appendix B), `params.claimGas` from
///         `contracts/gas-v2.json`, the claim budget, then ownership offered to `owner` (Ownable2Step).
///         Nothing live is touched: Launchpad, FeeRouter, Roots, HolderRewards and the v1 pool are only read.
abstract contract PrivacyDeployBase is Script {
    struct PrivacyInputs {
        address launchpad;
        address feeRouter;
        address roots;
        address holderRewards;
        address shieldedPool; // v1 pool (migrateFromV1)
        address treasury; // receives INTENT_FEE
        uint256[2] coordinatorPk;
        uint256 claimBudget; // wei sent to DarkCurve.fundClaimBudget
        address deployer; // the broadcaster: owns every module during wiring
        address owner; // offered ownership afterwards when != deployer
    }

    struct PrivacyDeployment {
        address poseidonT3v2;
        address poseidonT4v2;
        address verifierTransfer;
        address verifierIntent;
        address verifierClaim;
        address verifierOpen;
        address grovePool;
        address darkCurve;
        address planter;
        uint256 privacyStartBlock;
        uint32 claimGas;
        uint256 claimBudget;
    }

    /// @dev DEV Epoch Coordinator key for local / testnet stacks only. It is the fixture key of
    ///      `circuits/scripts/fixtures-v2.mjs` (`contracts/test/fixtures/v2/scenario.json` ".coordinator"), so
    ///      its secret is PUBLIC: anyone can decrypt every intent sent under it. Never used on chain 56
    ///      (`DeployPrivacy` requires COORDINATOR_PK_X / COORDINATOR_PK_Y and refuses this key there).
    ///      ecSk = 789720796196013502825971079891341950334297791247242114870618952306578497880
    uint256 internal constant DEV_COORDINATOR_PK_X =
        11380843620047076636614905533801391655426278998903321104676367952788880720226;
    uint256 internal constant DEV_COORDINATOR_PK_Y =
        19836921913154292301997792507734039057365739332744810348400999591851340883091;

    string internal constant GAS_V2_FILE = "gas-v2.json";
    uint256 internal constant DEFAULT_CLAIM_BUDGET = 0.1 ether;

    /// @dev Must be called inside startBroadcast/stopBroadcast.
    function _deployPrivacyStack(PrivacyInputs memory a) internal returns (PrivacyDeployment memory p) {
        p.privacyStartBlock = block.number;

        // 1. hashers (the circomlibjs bytecode the v1 pool uses; parity with the circuits is tested by
        //    PrivacyFixtures.t.sol) and the four Groth16 verifiers
        p.poseidonT3v2 = _deployPrivacyBytecode("poseidon/PoseidonT3.bin");
        p.poseidonT4v2 = _deployPrivacyBytecode("poseidon/PoseidonT4.bin");
        p.verifierTransfer = address(new Groth16VerifierTransfer());
        p.verifierIntent = address(new Groth16VerifierIntent());
        p.verifierClaim = address(new Groth16VerifierClaim());
        p.verifierOpen = address(new Groth16VerifierOpen());

        // 2.-4. modules, owned by the broadcaster while they are wired
        GrovePool pool = new GrovePool(
            p.verifierTransfer, p.poseidonT3v2, p.poseidonT4v2, a.launchpad, a.holderRewards, a.shieldedPool, a.deployer
        );
        DarkCurve curve = new DarkCurve(
            address(pool), a.roots, a.treasury, p.verifierIntent, p.verifierClaim, p.verifierOpen, a.coordinatorPk, a.deployer
        );
        Planter planter = new Planter(address(pool), a.launchpad, a.feeRouter, a.roots);
        p.grovePool = address(pool);
        p.darkCurve = address(curve);
        p.planter = address(planter);

        // 5. wiring
        pool.setModules(address(curve), address(planter));
        _addDenominations(pool);
        uint32 claimGas = _claimGasFromFile();
        if (claimGas != 0) {
            DarkCurve.Params memory prm;
            (prm.tMin, prm.tMax, prm.k, prm.grace, prm.bandBps, prm.maxIntents, prm.bandFloorWei, prm.claimGas) =
                curve.params();
            prm.claimGas = claimGas; // DarkCurve.setParams enforces [CLAIM_GAS_LO..CLAIM_GAS_HI]
            curve.setParams(prm);
        }
        (,,,,,,, p.claimGas) = curve.params();
        if (a.claimBudget > 0) curve.fundClaimBudget{value: a.claimBudget}();
        p.claimBudget = curve.claimBudget();

        if (a.owner != a.deployer) {
            pool.transferOwnership(a.owner);
            curve.transferOwnership(a.owner);
            console2.log("GrovePool / DarkCurve ownership offered to", a.owner, "- it must call acceptOwnership() on both");
        }
    }

    /// @dev privacy/PRIVACY-SPEC.md Appendix B (= web/src/lib/zk/denominations.ts). The owner can only add.
    function _addDenominations(GrovePool pool) internal {
        uint256[10] memory bnb = [
            uint256(0.01 ether),
            0.02 ether,
            0.05 ether,
            0.1 ether,
            0.2 ether,
            0.5 ether,
            1 ether,
            2 ether,
            5 ether,
            10 ether
        ];
        uint256[10] memory lots = [uint256(1e5), 2e5, 5e5, 1e6, 2e6, 5e6, 1e7, 2e7, 5e7, 1e8];
        for (uint256 i; i < 10; i++) {
            pool.addUnshieldDenomination(bnb[i]);
            pool.addTokenLot(lots[i] * 1e18);
        }
    }

    /// @dev `claim` from contracts/gas-v2.json (written by `node scripts/gas-v2.mjs`, never by hand).
    ///      Absent file: 0 (keep DarkCurve's in-bounds default) except on chain 56, which refuses.
    function _claimGasFromFile() internal view returns (uint32) {
        if (!vm.exists(GAS_V2_FILE)) {
            require(block.chainid != 56, "contracts/gas-v2.json missing: run `node scripts/gas-v2.mjs` first");
            console2.log("gas-v2.json absent: params.claimGas keeps the DarkCurve default");
            return 0;
        }
        uint256 g = vm.parseJsonUint(vm.readFile(GAS_V2_FILE), ".claim");
        require(g > 0 && g <= type(uint32).max, "gas-v2.json: bad claim");
        return uint32(g);
    }

    /// @dev COORDINATOR_PK_X / COORDINATOR_PK_Y, or (fresh dev chains only, `allowDev`) the documented dev key.
    function _coordinatorPk(bool allowDev) internal view returns (uint256[2] memory pk) {
        if (allowDev) {
            pk[0] = vm.envOr("COORDINATOR_PK_X", DEV_COORDINATOR_PK_X);
            pk[1] = vm.envOr("COORDINATOR_PK_Y", DEV_COORDINATOR_PK_Y);
            if (pk[0] == DEV_COORDINATOR_PK_X && pk[1] == DEV_COORDINATOR_PK_Y) {
                console2.log("Coordinator: DEV key (secret is public, fixtures-v2) - local/testnet only");
            }
        } else {
            pk[0] = vm.envUint("COORDINATOR_PK_X");
            pk[1] = vm.envUint("COORDINATOR_PK_Y");
        }
        if (block.chainid == 56) {
            require(!(pk[0] == DEV_COORDINATOR_PK_X && pk[1] == DEV_COORDINATOR_PK_Y), "chain 56: the dev Coordinator key is public");
        }
    }

    /// @dev CLAIM_BUDGET_BNB as a decimal BNB amount ("0.1", "1", "0.25"); default 0.1 BNB.
    function _claimBudgetWei() internal view returns (uint256) {
        string memory s = vm.envOr("CLAIM_BUDGET_BNB", string(""));
        if (bytes(s).length == 0) return DEFAULT_CLAIM_BUDGET;
        return _parseBnb(s);
    }

    function _parseBnb(string memory s) internal pure returns (uint256 wei_) {
        bytes memory b = bytes(s);
        uint256 whole;
        uint256 frac;
        uint256 fracDigits;
        bool dot;
        require(b.length > 0, "CLAIM_BUDGET_BNB: empty");
        for (uint256 i; i < b.length; i++) {
            bytes1 c = b[i];
            if (c == ".") {
                require(!dot, "CLAIM_BUDGET_BNB: two dots");
                dot = true;
            } else {
                require(c >= "0" && c <= "9", "CLAIM_BUDGET_BNB: not a decimal number");
                uint256 d = uint8(c) - 48;
                if (dot) {
                    require(fracDigits < 18, "CLAIM_BUDGET_BNB: more than 18 decimals");
                    frac = frac * 10 + d;
                    fracDigits++;
                } else {
                    whole = whole * 10 + d;
                }
            }
        }
        wei_ = whole * 1 ether + frac * 10 ** (18 - fracDigits);
    }

    /// @dev Chain 56 only: the verifiers are immutable, so dev keys on mainnet would mean a v3 migration
    ///      (spec section 3.5). `deploy.sh 56 --privacy` runs `scripts/ceremony-gate.mjs` (embedded vkeys vs
    ///      circuits/build/CEREMONY-HASHES-v2.txt) and exports PRIVACY_CEREMONY_GATE=passed only if it
    ///      passes; this script refuses without it and refuses any verifier source still marked DEV KEY.
    function _requireCeremonyVerifiersOn56() internal view {
        if (block.chainid != 56) return;
        require(
            keccak256(bytes(vm.envOr("PRIVACY_CEREMONY_GATE", string("")))) == keccak256("passed"),
            "chain 56: run through `deploy.sh 56 --privacy` (ceremony gate not passed)"
        );
        string[4] memory names = ["Transfer", "Intent", "Claim", "Open"];
        for (uint256 i; i < 4; i++) {
            string memory src = vm.readFile(string.concat("src/verifiers/Groth16Verifier", names[i], ".sol"));
            require(!vm.contains(src, "DEV KEY"), string.concat("chain 56: Groth16Verifier", names[i], " is a DEV KEY verifier"));
        }
    }

    /// @dev Adds the privacy keys to a deployment JSON object being serialised; returns the JSON so far.
    function _serializePrivacy(string memory obj, PrivacyDeployment memory p) internal returns (string memory json) {
        vm.serializeAddress(obj, "grovePool", p.grovePool);
        vm.serializeAddress(obj, "darkCurve", p.darkCurve);
        vm.serializeAddress(obj, "planter", p.planter);
        vm.serializeAddress(obj, "poseidonT3v2", p.poseidonT3v2);
        vm.serializeAddress(obj, "poseidonT4v2", p.poseidonT4v2);
        vm.serializeAddress(obj, "verifierTransfer", p.verifierTransfer);
        vm.serializeAddress(obj, "verifierIntent", p.verifierIntent);
        vm.serializeAddress(obj, "verifierClaim", p.verifierClaim);
        vm.serializeAddress(obj, "verifierOpen", p.verifierOpen);
        json = vm.serializeUint(obj, "privacyStartBlock", p.privacyStartBlock);
    }

    function _logPrivacy(PrivacyDeployment memory p) internal pure {
        console2.log("grovePool       ", p.grovePool);
        console2.log("darkCurve       ", p.darkCurve);
        console2.log("planter         ", p.planter);
        console2.log("poseidonT3v2    ", p.poseidonT3v2);
        console2.log("poseidonT4v2    ", p.poseidonT4v2);
        console2.log("verifierTransfer", p.verifierTransfer);
        console2.log("verifierIntent  ", p.verifierIntent);
        console2.log("verifierClaim   ", p.verifierClaim);
        console2.log("verifierOpen    ", p.verifierOpen);
        console2.log("privacyStartBlk ", p.privacyStartBlock);
        console2.log("claimGas        ", uint256(p.claimGas));
        console2.log("claimBudget wei ", p.claimBudget);
    }

    /// @dev Raw EVM bytecode from a hex file (no 0x prefix) with CREATE.
    function _deployPrivacyBytecode(string memory path) internal returns (address addr) {
        bytes memory code = vm.parseBytes(string.concat("0x", vm.trim(vm.readFile(path))));
        assembly {
            addr := create(0, add(code, 0x20), mload(code))
        }
        require(addr != address(0), "bytecode deploy failed");
    }
}

/// @notice Adds the privacy stage-2 stack to a chain whose stage-1 stack is deployed (97, then 56 after the
///         ceremony). Reads `launchpad, feeRouter, roots, holderRewards, shieldedPool, router, poseidonT3,
///         poseidonT4, treasury` from deployments/<chainid>.json, deploys and wires the stack and writes
///         `grovePool, darkCurve, planter, poseidonT3v2, poseidonT4v2, verifierTransfer, verifierIntent,
///         verifierClaim, verifierOpen, privacyStartBlock` back into that file, keeping every other key.
///
///         env: COORDINATOR_PK_X, COORDINATOR_PK_Y (required; the Epoch Coordinator's Baby Jubjub key),
///              OWNER (default: broadcaster; chain 56: must be the Safe), CLAIM_BUDGET_BNB (default 0.1),
///              DEPLOYMENT_FILE (default deployments/<chainid>.json; must lie under deployments/),
///              PRIVACY_CEREMONY_GATE (chain 56 only, set by deploy.sh after scripts/ceremony-gate.mjs).
///
///         forge script script/DeployPrivacy.s.sol:DeployPrivacy --rpc-url bsc_testnet --broadcast --private-key $PK
contract DeployPrivacy is PrivacyDeployBase {
    function run() external {
        _requireCeremonyVerifiersOn56();
        string memory file =
            vm.envOr("DEPLOYMENT_FILE", string.concat("deployments/", vm.toString(block.chainid), ".json"));
        string memory json = vm.readFile(file);

        PrivacyInputs memory a;
        a.launchpad = vm.parseJsonAddress(json, ".launchpad");
        a.feeRouter = vm.parseJsonAddress(json, ".feeRouter");
        a.roots = vm.parseJsonAddress(json, ".roots");
        a.holderRewards = vm.parseJsonAddress(json, ".holderRewards");
        a.shieldedPool = vm.parseJsonAddress(json, ".shieldedPool");
        a.treasury = vm.parseJsonAddress(json, ".treasury");
        address router = vm.parseJsonAddress(json, ".router");
        address t3v1 = vm.parseJsonAddress(json, ".poseidonT3");
        address t4v1 = vm.parseJsonAddress(json, ".poseidonT4");
        require(
            a.launchpad.code.length != 0 && a.feeRouter.code.length != 0 && a.roots.code.length != 0
                && a.holderRewards.code.length != 0 && a.shieldedPool.code.length != 0 && router.code.length != 0
                && t3v1.code.length != 0 && t4v1.code.length != 0,
            "stage-1 stack not deployed on this chain"
        );
        require(ILaunchpadPrivacy(a.launchpad).router() == router, "deployment file router != launchpad.router()");
        require(ILaunchpadPrivacy(a.launchpad).roots() == a.roots, "deployment file roots != launchpad.roots()");
        require(a.treasury != address(0), "treasury not set");
        if (vm.keyExistsJson(json, ".grovePool")) {
            address existing = vm.parseJsonAddress(json, ".grovePool");
            require(existing.code.length == 0, "grovePool already deployed (delete the privacy keys to redeploy)");
        }

        a.coordinatorPk = _coordinatorPk(false);
        a.claimBudget = _claimBudgetWei();
        a.deployer = msg.sender;
        a.owner = vm.envOr("OWNER", msg.sender);
        if (block.chainid == 56) require(a.owner != msg.sender, "chain 56: OWNER must be the admin Safe");

        vm.startBroadcast();
        PrivacyDeployment memory p = _deployPrivacyStack(a);
        vm.stopBroadcast();

        // the v2 hashers are the same circomlibjs bytecode as v1's: same outputs
        require(
            IPoseidonT3(p.poseidonT3v2).poseidon([uint256(1), 2]) == IPoseidonT3(t3v1).poseidon([uint256(1), 2])
                && IPoseidonT4(p.poseidonT4v2).poseidon([uint256(1), 2, 3]) == IPoseidonT4(t4v1).poseidon([uint256(1), 2, 3]),
            "poseidon v2 != v1"
        );

        _logPrivacy(p);
        string memory obj = "privacy-deployment";
        vm.serializeJson(obj, json);
        vm.writeJson(_serializePrivacy(obj, p), file);
        console2.log("wrote", file);
    }
}
