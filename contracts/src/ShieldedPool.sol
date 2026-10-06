// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MerkleTreeWithHistory} from "./MerkleTreeWithHistory.sol";
import {IVerifier, IPoseidonT4} from "./interfaces/IGrove.sol";

/// @title Grove shielded BNB pool
/// @notice A tornado-nova style UTXO pool. Notes are Poseidon(amount, pubKey, blinding) leaves;
///         spending needs a Groth16 proof over circuits/transaction.circom (2 in, 2 out).
///         `depositFor` lets other Grove contracts (Roots, HolderRewards, DonationRotator)
///         pay someone into the pool without a proof: the commitment is computed on-chain.
contract ShieldedPool is MerkleTreeWithHistory, Ownable2Step, ReentrancyGuard {
    struct Proof {
        uint256[2] a;
        uint256[2][2] b;
        uint256[2] c;
        uint256 root;
        uint256 publicAmount;
        bytes32 extDataHash;
        uint256[2] inputNullifiers;
        uint256[2] outputCommitments;
    }

    struct ExtData {
        address recipient;
        int256 extAmount;
        address relayer;
        uint256 fee;
        bytes encryptedOutput1;
        bytes encryptedOutput2;
    }

    IVerifier public immutable verifier;
    IPoseidonT4 public immutable commitmentHasher;

    uint256 public maxDeposit = 100 ether;
    /// @dev Fixed field-arithmetic bounds (not admin-settable: an owner able to lower the withdraw
    ///      limit could freeze everyone's funds, contradicting "no admin over funds"). Names kept
    ///      for ABI compatibility.
    uint256 public constant maxExtAmount = 2 ** 248;
    uint256 public constant maxFee = 2 ** 248;

    mapping(uint256 => bool) public nullifierHashes;

    event NewCommitment(uint256 indexed commitment, uint256 index, bytes encryptedOutput);
    event NewNullifier(uint256 nullifier);
    event DepositFor(uint256 indexed pubKey, uint256 amount, uint256 blinding, uint256 index, address indexed from);
    event Transact(address indexed sender, int256 extAmount, address recipient, address relayer, uint256 fee);
    event LimitsUpdated(uint256 maxDeposit, uint256 maxExtAmount, uint256 maxFee);
    /// @dev Emitted instead of NewCommitment when the tree is full: the output note is NOT inserted
    ///      and its value stays unspendable. Clients must withdraw everything (zero-value outputs)
    ///      once the tree is full; this keeps withdrawals possible instead of locking the pool.
    event CommitmentDropped(uint256 indexed commitment);

    error InvalidProof();
    error UnknownRoot();
    error AlreadySpent();
    error BadExtDataHash();
    error BadPublicAmount();
    error BadValue();
    error OverLimit();
    error TransferFailed();

    constructor(address _verifier, address _poseidonT3, address _poseidonT4, address _owner)
        MerkleTreeWithHistory(20, _poseidonT3)
        Ownable(_owner)
    {
        verifier = IVerifier(_verifier);
        commitmentHasher = IPoseidonT4(_poseidonT4);
    }

    // ---------------------------------------------------------------- views

    function calculatePublicAmount(int256 extAmount, uint256 fee) public pure returns (uint256) {
        require(fee < 2 ** 248, "fee");
        require(extAmount > -(2 ** 248) && extAmount < 2 ** 248, "ext");
        int256 publicAmount = extAmount - int256(fee);
        return publicAmount >= 0 ? uint256(publicAmount) : FIELD_SIZE - uint256(-publicAmount);
    }

    function hashExtData(ExtData calldata extData) public pure returns (bytes32) {
        return bytes32(uint256(keccak256(abi.encode(extData))) % FIELD_SIZE);
    }

    function isSpent(uint256 nullifier) external view returns (bool) {
        return nullifierHashes[nullifier];
    }

    function verifyProof(Proof calldata p) public view returns (bool) {
        return verifier.verifyProof(
            p.a,
            p.b,
            p.c,
            [
                p.root,
                p.publicAmount,
                uint256(p.extDataHash),
                p.inputNullifiers[0],
                p.inputNullifiers[1],
                p.outputCommitments[0],
                p.outputCommitments[1]
            ]
        );
    }

    // ------------------------------------------------------------- mutators

    /// @notice Deposit (extAmount > 0, send exactly that much BNB), withdraw (extAmount < 0,
    ///         paid to `recipient`) or private transfer (extAmount == 0). `fee` goes to `relayer`.
    function transact(Proof calldata p, ExtData calldata extData) external payable nonReentrant {
        if (extData.extAmount > 0) {
            if (msg.value != uint256(extData.extAmount)) revert BadValue();
            if (uint256(extData.extAmount) > maxDeposit) revert OverLimit();
        } else {
            if (msg.value != 0) revert BadValue();
        }
        if (extData.fee > maxFee) revert OverLimit();
        if (extData.extAmount < 0 && uint256(-extData.extAmount) > maxExtAmount) revert OverLimit();

        if (!isKnownRoot(p.root)) revert UnknownRoot();
        if (nullifierHashes[p.inputNullifiers[0]] || nullifierHashes[p.inputNullifiers[1]]) revert AlreadySpent();
        if (p.inputNullifiers[0] == p.inputNullifiers[1]) revert AlreadySpent();
        if (p.publicAmount != calculatePublicAmount(extData.extAmount, extData.fee)) revert BadPublicAmount();
        if (p.extDataHash != hashExtData(extData)) revert BadExtDataHash();
        if (extData.fee > 0 && extData.relayer == address(0)) revert BadValue();
        if (!verifyProof(p)) revert InvalidProof();

        nullifierHashes[p.inputNullifiers[0]] = true;
        nullifierHashes[p.inputNullifiers[1]] = true;
        emit NewNullifier(p.inputNullifiers[0]);
        emit NewNullifier(p.inputNullifiers[1]);

        if (uint256(nextIndex) + 2 <= 2 ** uint256(levels)) {
            uint32 i0 = _insert(p.outputCommitments[0]);
            uint32 i1 = _insert(p.outputCommitments[1]);
            emit NewCommitment(p.outputCommitments[0], i0, extData.encryptedOutput1);
            emit NewCommitment(p.outputCommitments[1], i1, extData.encryptedOutput2);
        } else {
            emit CommitmentDropped(p.outputCommitments[0]);
            emit CommitmentDropped(p.outputCommitments[1]);
        }

        if (extData.extAmount < 0) {
            require(extData.recipient != address(0), "recipient");
            _pay(extData.recipient, uint256(-extData.extAmount));
        }
        if (extData.fee > 0) {
            _pay(extData.relayer, extData.fee);
        }

        emit Transact(msg.sender, extData.extAmount, extData.recipient, extData.relayer, extData.fee);
    }

    /// @notice Pay `msg.value` into the pool as a note owned by `pubKey`. The amount and the
    ///         pubKey are public on this transaction; only the holder of the matching private key
    ///         can ever spend (or nullify) the note. Any address may call this.
    function depositFor(uint256 pubKey, uint256 blinding)
        external
        payable
        nonReentrant
        returns (uint256 leafIndex)
    {
        if (msg.value == 0) revert BadValue();
        // no maxDeposit here: Roots / HolderRewards / DonationRotator must never be blocked from paying out
        require(pubKey != 0 && pubKey < FIELD_SIZE && blinding < FIELD_SIZE, "field");
        uint256 commitment = commitmentHasher.poseidon([msg.value, pubKey, blinding]);
        uint32 index = _insert(commitment);
        emit NewCommitment(commitment, index, "");
        emit DepositFor(pubKey, msg.value, blinding, index, msg.sender);
        return index;
    }

    /// @notice The only admin knob: caps a single `transact` deposit. Withdrawals are never gated.
    function setMaxDeposit(uint256 _maxDeposit) external onlyOwner {
        maxDeposit = _maxDeposit;
        emit LimitsUpdated(_maxDeposit, maxExtAmount, maxFee);
    }

    function _pay(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
