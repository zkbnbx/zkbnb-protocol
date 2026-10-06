// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/Script.sol";
import {DeployBase} from "./Deploy.s.sol";
import {MockWBNB} from "../test/mocks/MockWBNB.sol";
import {MockPancakeFactory} from "../test/mocks/MockPancakeFactory.sol";
import {MockPancakeRouter} from "../test/mocks/MockPancakeRouter.sol";

/// @notice Local (anvil) deployment: mock WBNB / Pancake factory / router first, then the stack.
///         env (all optional): TREASURY, RECOVERY, KEEPER, OWNER default to the broadcaster.
contract DeployLocal is DeployBase {
    function run() external {
        address deployer = msg.sender;
        address treasury = vm.envOr("TREASURY", deployer);
        address recovery = vm.envOr("RECOVERY", deployer);
        address keeper = vm.envOr("KEEPER", deployer);
        address owner = vm.envOr("OWNER", deployer);

        vm.startBroadcast();
        MockWBNB wbnb = new MockWBNB();
        MockPancakeFactory factory = new MockPancakeFactory();
        MockPancakeRouter router = new MockPancakeRouter(address(factory), address(wbnb));
        Deployment memory d = _deployStack(address(router), treasury, recovery, keeper, deployer, owner);
        vm.stopBroadcast();

        _log(d);
        console2.log("wbnb            ", address(wbnb));
        console2.log("pancakeFactory  ", address(factory));
        _writeDeployment(d, string.concat("deployments/", vm.toString(block.chainid), ".json"));
    }
}
