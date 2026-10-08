// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {MerkleTreeWithHistoryV2} from "./MerkleTreeWithHistoryV2.sol";
import {ShieldedPool} from "./ShieldedPool.sol";
import {IPoseidonT4, PayoutMode} from "./interfaces/IGrove.sol";
import {IVerifier13, IHolderRewardsClaim, ILaunchpadPrivacy, IPlanter} from "./interfaces/IGroveV2.sol";
import {GroveConstants as C} from "./libraries/GroveConstants.sol";

/// @title Grove shielded pool v2 (privacy stage 2, spec section 4.2)
/// @notice Multi-asset UTXO pool: BNB and every GroveCoin share one depth-23 tree of nested
///         Poseidon notes. `transact` spends 2 notes into 3 with the 13-signal transfer proof and
///         covers shields, denomination-enforced unshields, private transfers, dividend settlement
///         (`accRpt`), handle claims (`claimAmount`), private plants and hand-overs. DarkCurve and
///         Planter are modules with narrow hooks. No event names a sender; no payout event links a
///         wallet to a leaf.
contract GrovePool is MerkleTreeWithHistoryV2, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Proof {
        uint256[2] a;
        uint256[2][2] b;
        uint256[2] c;
    }

    struct TransferPublic {
        uint256 root;
        uint256 publicAmount;
        address coin;
        uint256 publicAmountCoin;
        uint256 accRpt;
        uint256 handle;
        uint256 claimAmount;
        bytes32 extDataHash;
        uint256[2] inputNullifiers;
        uint256[3] outputCommitments;
    }

    struct ExtData {
        address recipient;
        int256 extAmountBnb;
        int256 extAmountCoin;
        address relayer;
        uint256 fee;
        bytes payload;
        bytes[3] encryptedOutputs;
    }

    IVerifier13 public immutable transferVerifier;
    IPoseidonT4 public immutable t4;
    ILaunchpadPrivacy public immutable launchpad;
    IHolderRewardsClaim public immutable holderRewards;
    ShieldedPool public immutable v1;
    address public immutable router;

    address public darkCurve;
    address public planter;
    /// @dev BNB shields only; withdrawals are never gated.
    uint256 public maxShieldPerTx = 100 ether;

    mapping(uint256 => bool) public nullifierHashes;
    mapping(uint256 handle => uint256) public claimable;
    mapping(address coin => uint256) public accRpt;
    mapping(address coin => mapping(uint256 => bool)) internal _knownAccRpt;
    /// @dev BNB unshield sizes; owner may only add.
    mapping(uint256 amount => bool) public unshieldDenom;
    /// @dev token shield / unshield sizes; owner may only add.
    mapping(uint256 amount => bool) public tokenLot;
    /// @dev True only inside `migrateFromV1`: the only window in which `receive` takes BNB from v1.
    bool private _migrating;

    event NewCommitment(uint256 indexed commitment, uint32 index, bytes encryptedOutput);
    event NewNullifier(uint256 nullifier);
    event Transact(int256 extAmountBnb, address coin, int256 extAmountCoin, address recipient, address relayer, uint256 fee);
    event Credited(uint256 indexed handle, uint256 amount);
    event HandleClaimed(uint256 indexed handle, uint256 claimAmount);
    event RewardsPulled(address indexed coin, uint256 runId, uint256 amount, uint256 accRpt);
    event MigratedFromV1(uint256 indexed handle, uint256 amount);
    event CommitmentDropped(uint256 indexed commitment);
    event ModulesSet(address darkCurve, address planter);
    event MaxShieldSet(uint256 maxShieldPerTx);
    event DenominationAdded(bool token, uint256 amount);

    error InvalidProof();
    error UnknownRoot();
    error AlreadySpent();
    error BadExtDataHash();
    error BadPublicAmount();
    error BadClaimAmount();
    error BadValue();
    error OverLimit();
    error NotDenomination();
    error BadPlantValue();
    error UnknownAccRpt();
    error NotModule();
    error NotCoin();
    error TransferFailed();
    error BadPayload();
    error ModulesAlreadySet();
    error NotPoolSender();
    error MigrationNotBound();

    modifier onlyModule() {
        if (msg.sender != darkCurve && msg.sender != planter) revert NotModule();
        _;
    }

    constructor(
        address transferVerifier_,
        address poseidonT3_,
        address poseidonT4_,
        address launchpad_,
        address holderRewards_,
        address v1_,
        address owner_
    ) MerkleTreeWithHistoryV2(C.LEVELS, poseidonT3_) Ownable(owner_) {
        transferVerifier = IVerifier13(transferVerifier_);
        t4 = IPoseidonT4(poseidonT4_);
        launchpad = ILaunchpadPrivacy(launchpad_);
        holderRewards = IHolderRewardsClaim(holderRewards_);
        v1 = ShieldedPool(payable(v1_));
        router = ILaunchpadPrivacy(launchpad_).router();
    }

    // ---------------------------------------------------------------- views

    function hashExtData(ExtData calldata e) public pure returns (bytes32) {
        return bytes32(uint256(keccak256(abi.encode(e))) % C.FIELD_SIZE);
    }

    /// @notice A Launchpad coin exists iff `info(coin).creator != 0` (no `isCoin` view on the live
    ///         Launchpad interface).
    function isCoin(address coin) public view returns (bool) {
        (address creator,,,,,,,,,,) = launchpad.info(coin);
        return creator != address(0);
    }

    function isSpent(uint256 nullifier) external view returns (bool) {
        return nullifierHashes[nullifier];
    }

    /// @notice `knownAccRpt[coin][0]` is true for every coin; every value `accRpt[coin]` ever took
    ///         stays known so a proof against an older value remains valid.
    function knownAccRpt(address coin, uint256 value) public view returns (bool) {
        return value == 0 || _knownAccRpt[coin][value];
    }

    /// @notice Signals in the frozen order of WORKPLAN section 1.2.
    function verifyTransfer(Proof calldata p, TransferPublic calldata s) public view returns (bool) {
        return transferVerifier.verifyProof(
            p.a,
            p.b,
            p.c,
            [
                s.root,
                s.publicAmount,
                uint256(uint160(s.coin)),
                s.publicAmountCoin,
                s.accRpt,
                s.handle,
                s.claimAmount,
                uint256(s.extDataHash),
                s.inputNullifiers[0],
                s.inputNullifiers[1],
                s.outputCommitments[0],
                s.outputCommitments[1],
                s.outputCommitments[2]
            ]
        );
    }

    /// @notice Field encoding of a signed amount: negatives as `p - |x|`.
    function toField(int256 x) public pure returns (uint256) {
        require(x > -(2 ** 248) && x < 2 ** 248, "range");
        return x >= 0 ? uint256(x) : C.FIELD_SIZE - uint256(-x);
    }

    // ------------------------------------------------------------- transact

    /// @notice Shield (extAmountBnb > 0, send exactly that), unshield (extAmountBnb < 0, a
    ///         denomination, or the plant fee when recipient == planter), token shield / unshield
    ///         in lots, private transfer, handle claim (claimAmount), hand-over (payload).
    function transact(Proof calldata p, TransferPublic calldata s, ExtData calldata e) external payable nonReentrant {
        bool isPlant = planter != address(0) && e.recipient == planter;

        // 1. edges
        if (e.extAmountBnb > 0) {
            if (msg.value != uint256(e.extAmountBnb)) revert BadValue();
            if (uint256(e.extAmountBnb) > maxShieldPerTx) revert OverLimit();
        } else {
            if (msg.value != 0) revert BadValue();
        }
        if (e.extAmountBnb < 0) {
            uint256 out = uint256(-e.extAmountBnb);
            if (isPlant) {
                if (out != launchpad.plantFee()) revert BadPlantValue();
            } else if (!unshieldDenom[out]) {
                revert NotDenomination();
            }
        }
        if (s.coin == address(0)) {
            if (s.publicAmountCoin != 0 || s.accRpt != 0 || e.extAmountCoin != 0) revert BadPublicAmount();
        } else {
            if (!isCoin(s.coin)) revert NotCoin();
            if (!knownAccRpt(s.coin, s.accRpt)) revert UnknownAccRpt();
        }
        if (e.extAmountCoin > 0) {
            if (!tokenLot[uint256(e.extAmountCoin)]) revert NotDenomination();
        } else if (e.extAmountCoin < 0) {
            if (!tokenLot[uint256(-e.extAmountCoin)]) revert NotDenomination();
        }

        // 2. root, nullifiers, ext data
        if (!isKnownRoot(s.root)) revert UnknownRoot();
        if (nullifierHashes[s.inputNullifiers[0]] || nullifierHashes[s.inputNullifiers[1]]) revert AlreadySpent();
        if (s.inputNullifiers[0] == s.inputNullifiers[1]) revert AlreadySpent();
        if (s.extDataHash != hashExtData(e)) revert BadExtDataHash();
        if (e.fee > 0 && e.relayer == address(0)) revert BadValue();
        if (e.fee > C.MAX_RELAYER_FEE) revert OverLimit();

        // 3. handle claim and public amounts
        uint256 h = s.handle;
        if (h == 0) {
            if (s.claimAmount != 0) revert BadClaimAmount();
        } else if (s.claimAmount > claimable[h]) {
            revert BadClaimAmount();
        }
        if (s.publicAmount != toField(e.extAmountBnb - int256(e.fee) + int256(s.claimAmount))) revert BadPublicAmount();
        if (s.publicAmountCoin != toField(e.extAmountCoin)) revert BadPublicAmount();

        // 4. verify, spend
        if (!verifyTransfer(p, s)) revert InvalidProof();
        _spend(s.inputNullifiers[0]);
        _spend(s.inputNullifiers[1]);
        if (s.claimAmount > 0) {
            claimable[h] -= s.claimAmount;
            emit HandleClaimed(h, s.claimAmount);
        }

        // 5. one chunk
        _insertOrDrop([s.outputCommitments[0], s.outputCommitments[1], s.outputCommitments[2], C.ZERO_LEAF], e.encryptedOutputs);

        // 6. edges in, payouts, payload
        if (e.extAmountCoin > 0) {
            IERC20(s.coin).safeTransferFrom(msg.sender, address(this), uint256(e.extAmountCoin));
        }
        if (e.extAmountBnb < 0) {
            uint256 out = uint256(-e.extAmountBnb);
            if (isPlant) {
                if (_action(e.payload) != C.ACTION_PLANT) revert BadPayload();
                IPlanter(planter).plantFor{value: out}(e.payload);
            } else {
                if (e.recipient == address(0)) revert BadValue();
                _pay(e.recipient, out);
            }
        }
        if (e.extAmountCoin < 0) {
            if (e.recipient == address(0)) revert BadValue();
            IERC20(s.coin).safeTransfer(e.recipient, uint256(-e.extAmountCoin));
        }
        if (e.fee > 0) _pay(e.relayer, e.fee);
        if (e.payload.length != 0 && !(isPlant && e.extAmountBnb < 0)) {
            if (_action(e.payload) != C.ACTION_HANDOVER || h == 0 || s.claimAmount != 0 || isPlant) revert BadPayload();
            (, address coin, PayoutMode mode, address wallet, uint256 ringId) =
                abi.decode(e.payload, (uint256, address, PayoutMode, address, uint256));
            IPlanter(planter).handOver(coin, h, mode, wallet, ringId);
        }

        emit Transact(e.extAmountBnb, s.coin, e.extAmountCoin, e.recipient, e.relayer, e.fee);
    }

    /// @notice Pay BNB to a handle. Anyone; the receiving key is never on-chain.
    function credit(uint256 handle) external payable {
        if (msg.value == 0) revert BadValue();
        if (handle == 0 || handle >= C.FIELD_SIZE) revert BadValue();
        claimable[handle] += msg.value;
        emit Credited(handle, msg.value);
    }

    /// @notice Pull a HolderRewards run for `coin` into the pool and raise `accRpt[coin]`.
    function pullRewards(address coin, uint256 runId, uint256 amount, bytes32[] calldata proof) external nonReentrant {
        uint256 before = address(this).balance;
        holderRewards.claim(coin, runId, amount, proof);
        require(address(this).balance == before + amount, "claim");
        uint256 supply = IERC20(coin).balanceOf(address(this));
        require(supply >= C.MIN_REWARD_SUPPLY, "supply");
        uint256 next = accRpt[coin] + amount * C.RPT_SCALE / supply;
        accRpt[coin] = next;
        _knownAccRpt[coin][next] = true;
        emit RewardsPulled(coin, runId, amount, next);
    }

    /// @notice Unshield from the v1 pool straight into a handle (recipient must be this pool).
    ///         The handle is bound into the v1 proof: `ve.encryptedOutput2 == abi.encode(handle)`
    ///         (output 2 of a migration is the zero-value dummy note, so its ciphertext slot is
    ///         free). Without the binding, anyone holding the relayed request (the relayer, or the
    ///         mempool) could replay the same v1 proof with their own handle and take the BNB.
    function migrateFromV1(ShieldedPool.Proof calldata vp, ShieldedPool.ExtData calldata ve, uint256 handle) external nonReentrant {
        if (ve.recipient != address(this) || ve.extAmount >= 0 || handle == 0 || handle >= C.FIELD_SIZE) revert BadValue();
        if (keccak256(ve.encryptedOutput2) != keccak256(abi.encode(handle))) revert MigrationNotBound();
        uint256 amount = uint256(-ve.extAmount);
        uint256 before = address(this).balance;
        _migrating = true;
        v1.transact(vp, ve);
        _migrating = false;
        require(address(this).balance == before + amount, "v1");
        claimable[handle] += amount;
        emit Credited(handle, amount);
        emit MigratedFromV1(handle, amount);
    }

    // --------------------------------------------------------- module hooks

    /// @notice Insert one chunk for a module; emits NewCommitment for every non-zero slot.
    function insertChunk(uint256[4] calldata leaves, bytes[] calldata encryptedOutputs) external onlyModule returns (uint32) {
        uint32 first = _insertChunk(leaves);
        for (uint256 i; i < 4; i++) {
            if (leaves[i] != C.ZERO_LEAF) {
                emit NewCommitment(leaves[i], first + uint32(i), i < encryptedOutputs.length ? encryptedOutputs[i] : bytes(""));
            }
        }
        return first;
    }

    function markSpent(uint256 nullifier) external onlyModule {
        if (nullifierHashes[nullifier]) revert AlreadySpent();
        _spend(nullifier);
    }

    /// @notice Move pool-held value to a module or venue. `asset == 0` is BNB.
    function moveOut(address asset, uint256 amount, address to) external onlyModule {
        if (amount == 0) return;
        if (asset == address(0)) _pay(to, amount);
        else IERC20(asset).safeTransfer(to, amount);
    }

    // ---------------------------------------------------------------- admin

    function setModules(address darkCurve_, address planter_) external onlyOwner {
        if (darkCurve != address(0) || planter != address(0)) revert ModulesAlreadySet();
        require(darkCurve_ != address(0) && planter_ != address(0), "zero");
        darkCurve = darkCurve_;
        planter = planter_;
        emit ModulesSet(darkCurve_, planter_);
    }

    function setMaxShield(uint256 v) external onlyOwner {
        maxShieldPerTx = v;
        emit MaxShieldSet(v);
    }

    function addUnshieldDenomination(uint256 wei_) external onlyOwner {
        require(wei_ > 0, "zero");
        unshieldDenom[wei_] = true;
        emit DenominationAdded(false, wei_);
    }

    function addTokenLot(uint256 units) external onlyOwner {
        require(units > 0, "zero");
        tokenLot[units] = true;
        emit DenominationAdded(true, units);
    }

    // ------------------------------------------------------------ internals

    function _spend(uint256 nullifier) internal {
        nullifierHashes[nullifier] = true;
        emit NewNullifier(nullifier);
    }

    function _insertOrDrop(uint256[4] memory leaves, bytes[3] calldata enc) internal {
        if (chunksLeft() > 0) {
            uint32 first = _insertChunk(leaves);
            for (uint256 i; i < 3; i++) {
                emit NewCommitment(leaves[i], first + uint32(i), enc[i]);
            }
        } else {
            for (uint256 i; i < 3; i++) {
                emit CommitmentDropped(leaves[i]);
            }
        }
    }

    function _action(bytes calldata payload) internal pure returns (uint256 action) {
        if (payload.length < 32) revert BadPayload();
        action = uint256(bytes32(payload[0:32]));
    }

    function _pay(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// @dev Only value the pool expects: module forwards, Launchpad refunds, router / roots /
    ///      HolderRewards payouts, and v1 payouts only inside `migrateFromV1` (a v1 withdrawal sent
    ///      here by a direct `v1.transact` would land on no handle and be stranded, so it reverts).
    ///      Everything else reverts (use `credit` or `transact`).
    receive() external payable {
        address s = msg.sender;
        if (s == address(v1)) {
            if (!_migrating) revert NotPoolSender();
            return;
        }
        if (
            s != darkCurve && s != planter && s != address(launchpad) && s != router && s != launchpad.roots()
                && s != address(holderRewards)
        ) revert NotPoolSender();
    }
}
