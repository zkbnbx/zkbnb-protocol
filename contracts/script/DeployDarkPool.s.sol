// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {DarkPool} from "../src/DarkPool.sol";
import {ILaunchpadFull} from "../src/interfaces/IGrove.sol";

/// @notice Adds dark pools to a chain whose stack is already deployed (56, 97): reads `launchpad`,
///         `shieldedPool` and `router` from deployments/<chainid>.json, deploys the DarkPool factory
///         (its constructor deploys the DarkVault implementation) and writes `darkPool` and
///         `darkVaultImpl` back into that file, keeping every other key. Nothing is owned, so there
///         is nothing to accept or wire afterwards. Env: none beyond the broadcaster.
///
///         forge script script/DeployDarkPool.s.sol:DeployDarkPool --rpc-url bsc --broadcast --private-key $PK
contract DeployDarkPool is Script {
    function run() external {
        string memory file = string.concat("deployments/", vm.toString(block.chainid), ".json");
        string memory json = vm.readFile(file);
        address launchpad = vm.parseJsonAddress(json, ".launchpad");
        address pool = vm.parseJsonAddress(json, ".shieldedPool");
        address router = vm.parseJsonAddress(json, ".router");
        require(launchpad.code.length != 0 && pool.code.length != 0 && router.code.length != 0, "stack not deployed");
        require(ILaunchpadFull(launchpad).roots() != address(0), "launchpad.roots not set");
        if (vm.keyExistsJson(json, ".darkPool")) {
            address existing = vm.parseJsonAddress(json, ".darkPool");
            require(existing.code.length == 0, "darkPool already deployed (delete the key to redeploy)");
        }

        vm.startBroadcast();
        DarkPool darkPool = new DarkPool(pool, launchpad, router);
        vm.stopBroadcast();
        address darkVaultImpl = darkPool.vaultImpl();

        console2.log("darkPool        ", address(darkPool));
        console2.log("darkVaultImpl   ", darkVaultImpl);
        _writeBack(file, json, address(darkPool), darkVaultImpl);
    }

    /// @dev Re-serialises the existing deployment JSON with the two new keys added (or replaced).
    function _writeBack(string memory file, string memory json, address darkPool, address darkVaultImpl) internal {
        string memory obj = "darkpool-deployment";
        vm.serializeJson(obj, json);
        vm.serializeAddress(obj, "darkPool", darkPool);
        string memory out = vm.serializeAddress(obj, "darkVaultImpl", darkVaultImpl);
        vm.writeJson(out, file);
        console2.log("wrote", file);
    }
}
