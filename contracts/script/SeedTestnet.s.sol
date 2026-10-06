// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {Launchpad} from "../src/Launchpad.sol";
import {DonationRotator} from "../src/DonationRotator.sol";
import {PayoutMode} from "../src/interfaces/IGrove.sol";

/// @notice Seeds a fresh deployment with demo data: 3 causes, the "zkBNB global ring" (1 day
///         epoch) and two demo coins (Holders mode, Donate mode on that ring) with a small first
///         buy each. Reads deployments/<chainId>.json written by Deploy / DeployLocal.
///
///         env (optional): CAUSE{1,2,3}_NAME / _URI / _PUBKEY (uint, < field) / _ENCKEY (bytes32)
///                         / _FALLBACK (address), FIRST_BUY (wei, default 0.01 BNB),
///                         DEMO_IMAGE (image url for the demo coins).
contract SeedTestnet is Script {
    uint256 constant FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

    function run() external {
        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        string memory json = vm.readFile(path);
        Launchpad launchpad = Launchpad(payable(vm.parseJsonAddress(json, ".launchpad")));
        DonationRotator rotator = DonationRotator(vm.parseJsonAddress(json, ".donationRotator"));

        uint256 firstBuy = vm.envOr("FIRST_BUY", uint256(0.01 ether));
        string memory image = vm.envOr("DEMO_IMAGE", string(""));
        uint256 registerFee = rotator.registerFee();
        uint256 plantFee = launchpad.plantFee();

        vm.startBroadcast();

        // 1. three demo causes
        uint256[] memory causeIds = new uint256[](3);
        causeIds[0] = _registerCause(rotator, registerFee, 1, "Open Source Water Sensors", "https://example.org/water");
        causeIds[1] = _registerCause(rotator, registerFee, 2, "Reforestation Collective", "https://example.org/trees");
        causeIds[2] = _registerCause(rotator, registerFee, 3, "Privacy Research Fund", "https://example.org/privacy");

        // 2. the global ring
        uint256 ringId = rotator.createRing("zkBNB global ring", causeIds, 1 days);
        console2.log("ring", ringId);

        // 3. two demo coins
        address holdersCoin = launchpad.plant{value: plantFee + firstBuy}(
            Launchpad.PlantParams({
                name: "Holders Demo",
                symbol: "HOLD",
                metadata: Launchpad.Metadata({
                    description: "Demo coin: 0.80% of every trade is paid to holders in BNB.",
                    image: image,
                    website: "",
                    twitter: "",
                    telegram: ""
                }),
                payoutMode: PayoutMode.Holders,
                payoutWallet: address(0),
                ringId: 0,
                minFirstBuyTokens: 0
            })
        );
        address donateCoin = launchpad.plant{value: plantFee + firstBuy}(
            Launchpad.PlantParams({
                name: "Donate Demo",
                symbol: "GIVE",
                metadata: Launchpad.Metadata({
                    description: "Demo coin: 0.80% of every trade is donated to the zkBNB global ring.",
                    image: image,
                    website: "",
                    twitter: "",
                    telegram: ""
                }),
                payoutMode: PayoutMode.Donate,
                payoutWallet: address(0),
                ringId: ringId,
                minFirstBuyTokens: 0
            })
        );
        vm.stopBroadcast();

        console2.log("holdersCoin", holdersCoin);
        console2.log("donateCoin ", donateCoin);

        string memory obj = "seed";
        vm.serializeUint(obj, "ringId", ringId);
        vm.serializeUint(obj, "cause1", causeIds[0]);
        vm.serializeUint(obj, "cause2", causeIds[1]);
        vm.serializeUint(obj, "cause3", causeIds[2]);
        vm.serializeAddress(obj, "holdersCoin", holdersCoin);
        string memory out = vm.serializeAddress(obj, "donateCoin", donateCoin);
        string memory seedPath = string.concat("deployments/", vm.toString(block.chainid), ".seed.json");
        vm.writeJson(out, seedPath);
        console2.log("wrote", seedPath);
    }

    function _registerCause(DonationRotator rotator, uint256 fee, uint256 n, string memory defaultName, string memory defaultUri)
        internal
        returns (uint256 causeId)
    {
        string memory k = string.concat("CAUSE", vm.toString(n));
        string memory name = vm.envOr(string.concat(k, "_NAME"), defaultName);
        string memory uri = vm.envOr(string.concat(k, "_URI"), defaultUri);
        // demo shielded key: a deterministic field element (NOT a real key; nobody can spend these notes)
        uint256 pubKey = vm.envOr(string.concat(k, "_PUBKEY"), uint256(keccak256(abi.encodePacked("zkbnb demo cause pubkey ", n))) % FIELD_SIZE);
        bytes32 encKey = vm.envOr(string.concat(k, "_ENCKEY"), keccak256(abi.encodePacked("zkbnb demo cause enckey ", n)));
        address fallbackWallet = vm.envOr(string.concat(k, "_FALLBACK"), msg.sender);
        causeId = rotator.registerCause{value: fee}(name, uri, pubKey, encKey, fallbackWallet);
        console2.log("cause", causeId, name);
    }
}
