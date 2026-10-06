// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {Launchpad} from "../src/Launchpad.sol";
import {DonationRotator} from "../src/DonationRotator.sol";
import {PayoutMode} from "../src/interfaces/IGrove.sol";

/// @notice A payee whose receive() burns every gas unit it is given, so DonationRotator's 50k-gas push to it always
///         fails and the payout is deferred into `pending[this]`. `withdraw()` pulls that pending balance with
///         `withdrawPending()` (receive() lets it through while `pulling` is set) and forwards it to the owner.
contract GasHungryPayee {
    address public immutable owner;
    DonationRotator public immutable rotator;
    bool internal pulling;

    constructor(DonationRotator rotator_, address owner_) {
        rotator = rotator_;
        owner = owner_;
    }

    receive() external payable {
        if (pulling) return;
        // spin until out of gas: a 50k-gas push can never succeed
        uint256 x;
        while (true) {
            x++;
        }
    }

    function withdraw() external {
        require(msg.sender == owner, "owner");
        pulling = true;
        rotator.withdrawPending();
        pulling = false;
        (bool ok,) = owner.call{value: address(this).balance}("");
        require(ok, "forward");
    }
}

/// @notice BNB testnet end-to-end of every donation-payout path. Testnet only (refuses any other chain).
///
///   PHASE=setup  (default)
///     1. cause A with a real shielded key (CAUSE_A_PUBKEY / CAUSE_A_ENCKEY from `node script/donation-e2e.mjs key`)
///     2. GasHungryPayee + cause B with no shielded key and that payee as fallbackWallet
///     3. donateToCause(A)  -> DirectDonation(shielded=true, leafIndex)
///     4. donateToCause(B)  -> PayoutDeferred(B, payee, amount, poolFailed=false) + DirectDonation(shielded=false)
///     5. payee.withdraw()  -> PendingWithdrawn(payee, amount), BNB back to the deployer
///     6. ring [A, B] with epoch = minEpoch, and a Donate-mode coin bound to it with a small first buy -> Funded
///     writes deployments/<chainId>.donation-e2e.json
///   PHASE=settle
///     7. settle(ring) once the epoch has passed -> Settled(ring, 0, A, pot, shielded=true, leafIndex)
///
///   env: CAUSE_A_PUBKEY, CAUSE_A_ENCKEY, DONATION (wei, default 0.002 BNB), FIRST_BUY (wei, default 0.002 BNB)
contract DonationE2E is Script {
    function run() external {
        require(block.chainid == 97, "testnet only");
        string memory depPath = string.concat("deployments/", vm.toString(block.chainid), ".json");
        string memory json = vm.readFile(depPath);
        DonationRotator rotator = DonationRotator(vm.parseJsonAddress(json, ".donationRotator"));
        Launchpad launchpad = Launchpad(payable(vm.parseJsonAddress(json, ".launchpad")));
        string memory outPath = string.concat("deployments/", vm.toString(block.chainid), ".donation-e2e.json");

        string memory phase = vm.envOr("PHASE", string("setup"));
        if (keccak256(bytes(phase)) == keccak256("settle")) {
            string memory e2e = vm.readFile(outPath);
            uint256 ring = vm.parseJsonUint(e2e, ".ringId");
            console2.log("pot", rotator.pot(ring));
            console2.log("nextSettleAt", rotator.nextSettleAt(ring), "now", block.timestamp);
            vm.startBroadcast();
            (uint256 causeId, uint256 amount) = rotator.settle(ring);
            vm.stopBroadcast();
            console2.log("settled to cause", causeId, amount);
            return;
        }

        uint256 donation = vm.envOr("DONATION", uint256(0.002 ether));
        uint256 firstBuy = vm.envOr("FIRST_BUY", uint256(0.002 ether));
        uint256 pubKeyA = vm.envUint("CAUSE_A_PUBKEY");
        bytes32 encKeyA = vm.envBytes32("CAUSE_A_ENCKEY");
        uint256 registerFee = rotator.registerFee();
        uint256 minEpoch = rotator.minEpoch();
        uint256 plantFee = launchpad.plantFee();

        vm.startBroadcast();
        address me = msg.sender;

        // 1. cause A: real shielded key, fallback = deployer (only used if the pool refused the note)
        uint256 causeA = rotator.registerCause{value: registerFee}("E2E Shielded Cause A", "https://example.org/e2e-a", pubKeyA, encKeyA, me);
        // 2. cause B: no shielded key, fallback = a payee whose receive() always runs out of gas
        GasHungryPayee payee = new GasHungryPayee(rotator, me);
        uint256 causeB = rotator.registerCause{value: registerFee}("E2E Deferred Cause B", "https://example.org/e2e-b", 0, bytes32(0), address(payee));
        // 3. direct -> shielded note
        rotator.donateToCause{value: donation}(causeA);
        // 4. direct -> push fails -> deferred into pending[payee]
        rotator.donateToCause{value: donation}(causeB);
        // 5. payee pulls its pending balance -> PendingWithdrawn
        payee.withdraw();
        // 6. ring [A, B] at the minimum epoch + a Donate-mode coin feeding it
        uint256[] memory ids = new uint256[](2);
        ids[0] = causeA;
        ids[1] = causeB;
        uint256 ringId = rotator.createRing("E2E payouts ring", ids, minEpoch);
        address coin = launchpad.plant{value: plantFee + firstBuy}(
            Launchpad.PlantParams({
                name: "Payout Test",
                symbol: "PAYT",
                metadata: Launchpad.Metadata({description: "Testnet coin feeding the E2E payouts ring.", image: "", website: "", twitter: "", telegram: ""}),
                payoutMode: PayoutMode.Donate,
                payoutWallet: address(0),
                ringId: ringId,
                minFirstBuyTokens: 0
            })
        );
        vm.stopBroadcast();

        console2.log("causeA", causeA);
        console2.log("causeB", causeB);
        console2.log("payee", address(payee));
        console2.log("ringId", ringId);
        console2.log("coin", coin);
        console2.log("minEpoch", minEpoch);

        string memory obj = "e2e";
        vm.serializeUint(obj, "causeA", causeA);
        vm.serializeUint(obj, "causeB", causeB);
        vm.serializeAddress(obj, "payee", address(payee));
        vm.serializeUint(obj, "ringId", ringId);
        vm.serializeUint(obj, "minEpoch", minEpoch);
        string memory out = vm.serializeAddress(obj, "coin", coin);
        vm.writeJson(out, outPath);
    }
}
