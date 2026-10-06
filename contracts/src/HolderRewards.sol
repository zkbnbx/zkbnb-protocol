// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {IShieldedPool} from "./interfaces/IGrove.sol";

/// @title HolderRewards
/// @notice When a deployer chooses "Holders", 0.80% of every trade pools here. The keeper
///         snapshots holders (random moment within the hour after the pot crosses `minPot`),
///         publishes the snapshot and posts its Merkle root. Holders claim publicly or into
///         the shielded pool. Who gets how much is computed off-chain, exactly as on Sapling;
///         every snapshot is published so anyone can check it.
contract HolderRewards is Ownable2Step, ReentrancyGuard {
    struct Run {
        bytes32 root;
        uint256 amount;
        uint256 claimed;
        uint256 holders;
        uint64 postedAt;
        string uri;
    }

    address public feeRouter;
    address public roots;
    address public keeper;
    IShieldedPool public immutable pool;

    uint256 public minPot = 0.05 ether;
    uint256 public claimWindow = 30 days;

    mapping(address => uint256) public pot;
    mapping(address => uint256) public lastRunAt;
    mapping(address => Run[]) public runs;
    mapping(bytes32 => bool) public claimed; // keccak(coin, runId, account)

    event Funded(address indexed coin, uint256 amount, address from);
    event RunPosted(address indexed coin, uint256 indexed runId, bytes32 root, uint256 amount, uint256 holders, string uri);
    event Claimed(address indexed coin, uint256 indexed runId, address indexed account, uint256 amount, bool shielded, uint256 leafIndex);
    event Swept(address indexed coin, uint256 indexed runId, uint256 amount);
    event KeeperSet(address keeper);
    event ParamsSet(uint256 minPot, uint256 claimWindow);
    event SourcesSet(address feeRouter, address roots);

    error NotAuthorized();
    error BadProof();
    error AlreadyClaimed();
    error TooSoon();
    error PotTooSmall();
    error WindowOpen();

    constructor(address pool_, address keeper_, address owner_) Ownable(owner_) {
        pool = IShieldedPool(pool_);
        keeper = keeper_;
    }

    function setSources(address feeRouter_, address roots_) external onlyOwner {
        feeRouter = feeRouter_;
        roots = roots_;
        emit SourcesSet(feeRouter_, roots_);
    }

    function setKeeper(address keeper_) external onlyOwner {
        keeper = keeper_;
        emit KeeperSet(keeper_);
    }

    function setParams(uint256 minPot_, uint256 claimWindow_) external onlyOwner {
        minPot = minPot_;
        claimWindow = claimWindow_;
        emit ParamsSet(minPot_, claimWindow_);
    }

    function runCount(address coin) external view returns (uint256) {
        return runs[coin].length;
    }

    function getRun(address coin, uint256 runId) external view returns (Run memory) {
        return runs[coin][runId];
    }

    function isClaimed(address coin, uint256 runId, address account) public view returns (bool) {
        return claimed[keccak256(abi.encode(coin, runId, account))];
    }

    function fund(address coin) external payable {
        if (msg.sender != feeRouter && msg.sender != roots) revert NotAuthorized();
        pot[coin] += msg.value;
        emit Funded(coin, msg.value, msg.sender);
    }

    /// @notice Anyone can top up a coin's holder pot (public donation to holders).
    function tip(address coin) external payable {
        pot[coin] += msg.value;
        emit Funded(coin, msg.value, msg.sender);
    }

    /// @notice Keeper posts a snapshot. `amount` is moved from the pot into the run.
    function postRun(address coin, bytes32 root, uint256 amount, uint256 holders, string calldata uri)
        external
        returns (uint256 runId)
    {
        if (msg.sender != keeper) revert NotAuthorized();
        if (block.timestamp < lastRunAt[coin] + 1 hours) revert TooSoon();
        if (amount < minPot || amount > pot[coin]) revert PotTooSmall();
        pot[coin] -= amount;
        lastRunAt[coin] = block.timestamp;
        runs[coin].push(Run({root: root, amount: amount, claimed: 0, holders: holders, postedAt: uint64(block.timestamp), uri: uri}));
        runId = runs[coin].length - 1;
        emit RunPosted(coin, runId, root, amount, holders, uri);
    }

    function leaf(address coin, uint256 runId, address account, uint256 amount) public pure returns (bytes32) {
        return keccak256(abi.encode(coin, runId, account, amount));
    }

    function claim(address coin, uint256 runId, uint256 amount, bytes32[] calldata proof) external nonReentrant {
        _claim(coin, runId, amount, proof);
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "send");
        emit Claimed(coin, runId, msg.sender, amount, false, 0);
    }

    function claimShielded(address coin, uint256 runId, uint256 amount, bytes32[] calldata proof, uint256 pubKey, uint256 blinding)
        external
        nonReentrant
    {
        _claim(coin, runId, amount, proof);
        uint256 leafIndex = pool.depositFor{value: amount}(pubKey, blinding);
        emit Claimed(coin, runId, msg.sender, amount, true, leafIndex);
    }

    function _claim(address coin, uint256 runId, uint256 amount, bytes32[] calldata proof) internal {
        Run storage r = runs[coin][runId];
        bytes32 key = keccak256(abi.encode(coin, runId, msg.sender));
        if (claimed[key]) revert AlreadyClaimed();
        if (!MerkleProof.verify(proof, r.root, leaf(coin, runId, msg.sender, amount))) revert BadProof();
        require(r.claimed + amount <= r.amount, "over");
        claimed[key] = true;
        r.claimed += amount;
    }

    /// @notice After the claim window, unclaimed rewards roll forward into the coin's pot.
    function sweepExpired(address coin, uint256 runId) external {
        Run storage r = runs[coin][runId];
        if (block.timestamp < r.postedAt + claimWindow) revert WindowOpen();
        uint256 left = r.amount - r.claimed;
        require(left > 0, "nothing");
        r.claimed = r.amount;
        pot[coin] += left;
        emit Swept(coin, runId, left);
    }
}
