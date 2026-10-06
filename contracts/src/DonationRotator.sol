// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IShieldedPool} from "./interfaces/IGrove.sol";

/// @title DonationRotator
/// @notice "Rotate fees to others with zk payments." Causes register a shielded public key.
///         A ring is an immutable ordered list of causes with an epoch length. Coins whose
///         deployer chose Donate feed their 0.80% into a ring's pot; once per epoch anyone can
///         `settle` the ring, which pays the whole pot to the next cause in rotation as a
///         shielded note (Poseidon(amount, pubKey, blinding) in the ShieldedPool). The cause
///         sees the note by scanning `DepositFor` events for its pubKey; spending it is private.
contract DonationRotator is Ownable2Step, ReentrancyGuard {
    uint256 public constant FIELD_SIZE =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;
    /// @notice Longest epoch a ring may have (an absurd epoch would strand the ring's pot forever).
    uint256 public constant MAX_EPOCH = 365 days;

    struct Cause {
        string name;
        string uri; // website / description / proof of identity
        uint256 shieldedPubKey; // 0 = pay the fallback wallet publicly
        bytes32 encryptionKey; // x25519 public key so pool users can send encrypted notes privately
        address fallbackWallet;
        address owner;
        bool active;
        uint256 received;
    }

    struct Ring {
        uint256[] causeIds;
        uint256 epochLength;
        uint256 cursor;
        uint256 lastSettled;
        uint256 epochsSettled;
        address creator;
        string name;
    }

    IShieldedPool public immutable pool;
    address public feeRouter;
    address public treasury;
    uint256 public registerFee = 0.002 ether;
    uint256 public minEpoch = 1 hours;

    Cause[] public causes;
    Ring[] internal rings;
    mapping(uint256 => uint256) public pot; // ringId => BNB waiting for the next settlement
    mapping(address => uint256) public coinRing;
    mapping(address => bool) public coinBound;
    /// @notice BNB owed to a payee whose push failed (reverting fallback wallet, full pool...).
    mapping(address => uint256) public pending;

    event CauseRegistered(uint256 indexed causeId, string name, uint256 shieldedPubKey, bytes32 encryptionKey, address fallbackWallet, address owner);
    event CauseUpdated(uint256 indexed causeId, string name, string uri, uint256 shieldedPubKey, bytes32 encryptionKey, address fallbackWallet, bool active);
    event RingCreated(uint256 indexed ringId, string name, uint256[] causeIds, uint256 epochLength, address creator);
    event CoinBound(address indexed coin, uint256 indexed ringId);
    event Funded(uint256 indexed ringId, address indexed coin, uint256 amount, address from);
    event Donated(uint256 indexed ringId, uint256 amount, address from);
    event DirectDonation(uint256 indexed causeId, uint256 amount, address from, bool shielded, uint256 leafIndex);
    event Settled(uint256 indexed ringId, uint256 indexed epoch, uint256 indexed causeId, uint256 amount, bool shielded, uint256 leafIndex);
    event PayoutDeferred(uint256 indexed causeId, address indexed to, uint256 amount, bool poolFailed);
    event PendingWithdrawn(address indexed to, uint256 amount);
    event CauseActiveSet(uint256 indexed causeId, bool active);
    event FeeRouterSet(address feeRouter);
    event ParamsSet(uint256 registerFee, uint256 minEpoch, address treasury);

    error NotAuthorized();
    error BadCause();
    error BadRing();
    error TooSoon();
    error Empty();

    constructor(address pool_, address treasury_, address owner_) Ownable(owner_) {
        pool = IShieldedPool(pool_);
        treasury = treasury_;
    }

    // ---------------------------------------------------------------- admin

    function setFeeRouter(address feeRouter_) external onlyOwner {
        feeRouter = feeRouter_;
        emit FeeRouterSet(feeRouter_);
    }

    function setParams(uint256 registerFee_, uint256 minEpoch_, address treasury_) external onlyOwner {
        registerFee = registerFee_;
        minEpoch = minEpoch_;
        treasury = treasury_;
        emit ParamsSet(registerFee_, minEpoch_, treasury_);
    }

    // --------------------------------------------------------------- causes

    function causeCount() external view returns (uint256) {
        return causes.length;
    }

    function getCause(uint256 causeId) external view returns (Cause memory) {
        return causes[causeId];
    }

    function registerCause(string calldata name, string calldata uri, uint256 shieldedPubKey, bytes32 encryptionKey, address fallbackWallet)
        external
        payable
        returns (uint256 causeId)
    {
        require(msg.value >= registerFee, "fee");
        require(bytes(name).length > 0, "name");
        require(shieldedPubKey < FIELD_SIZE, "field");
        require(shieldedPubKey != 0 || fallbackWallet != address(0), "payee");
        causes.push(
            Cause({
                name: name,
                uri: uri,
                shieldedPubKey: shieldedPubKey,
                encryptionKey: encryptionKey,
                fallbackWallet: fallbackWallet,
                owner: msg.sender,
                active: true,
                received: 0
            })
        );
        causeId = causes.length - 1;
        if (msg.value > 0) {
            (bool ok,) = treasury.call{value: msg.value}("");
            require(ok, "send");
        }
        emit CauseRegistered(causeId, name, shieldedPubKey, encryptionKey, fallbackWallet, msg.sender);
    }

    /// @notice Only the cause's owner may change where its money goes. The contract owner can only
    ///         (de)activate a cause (`setCauseActive`), never redirect it.
    function updateCause(
        uint256 causeId,
        string calldata name,
        string calldata uri,
        uint256 shieldedPubKey,
        bytes32 encryptionKey,
        address fallbackWallet,
        bool active
    ) external
    {
        if (causeId >= causes.length) revert BadCause();
        Cause storage c = causes[causeId];
        if (msg.sender != c.owner) revert NotAuthorized();
        require(shieldedPubKey < FIELD_SIZE, "field");
        require(shieldedPubKey != 0 || fallbackWallet != address(0), "payee");
        c.name = name;
        c.uri = uri;
        c.shieldedPubKey = shieldedPubKey;
        c.encryptionKey = encryptionKey;
        c.fallbackWallet = fallbackWallet;
        c.active = active;
        emit CauseUpdated(causeId, name, uri, shieldedPubKey, encryptionKey, fallbackWallet, active);
    }

    /// @notice Moderation switch: the cause owner or the contract owner can (de)activate a cause.
    function setCauseActive(uint256 causeId, bool active) external {
        if (causeId >= causes.length) revert BadCause();
        Cause storage c = causes[causeId];
        if (msg.sender != c.owner && msg.sender != owner()) revert NotAuthorized();
        c.active = active;
        emit CauseActiveSet(causeId, active);
    }

    // ---------------------------------------------------------------- rings

    function ringCount() external view returns (uint256) {
        return rings.length;
    }

    function ringExists(uint256 ringId) public view returns (bool) {
        return ringId < rings.length;
    }

    function getRing(uint256 ringId)
        external
        view
        returns (
            string memory name,
            uint256[] memory causeIds,
            uint256 epochLength,
            uint256 cursor,
            uint256 lastSettled,
            uint256 epochsSettled,
            address creator
        )
    {
        Ring storage r = rings[ringId];
        return (r.name, r.causeIds, r.epochLength, r.cursor, r.lastSettled, r.epochsSettled, r.creator);
    }

    function nextCause(uint256 ringId) public view returns (uint256 causeId) {
        Ring storage r = rings[ringId];
        return r.causeIds[r.cursor % r.causeIds.length];
    }

    function nextSettleAt(uint256 ringId) external view returns (uint256) {
        Ring storage r = rings[ringId];
        return r.lastSettled + r.epochLength;
    }

    /// @notice Rings are immutable: a coin that chose a ring has made an irrevocable choice.
    function createRing(string calldata name, uint256[] calldata causeIds, uint256 epochLength) external returns (uint256 ringId) {
        if (causeIds.length == 0 || causeIds.length > 64) revert BadRing();
        if (epochLength < minEpoch || epochLength > MAX_EPOCH) revert BadRing();
        for (uint256 i = 0; i < causeIds.length; i++) {
            if (causeIds[i] >= causes.length) revert BadCause();
        }
        rings.push();
        ringId = rings.length - 1;
        Ring storage r = rings[ringId];
        r.name = name;
        r.causeIds = causeIds;
        r.epochLength = epochLength;
        r.lastSettled = block.timestamp;
        r.creator = msg.sender;
        emit RingCreated(ringId, name, causeIds, epochLength, msg.sender);
    }

    function bindCoin(address coin, uint256 ringId) external {
        if (msg.sender != feeRouter) revert NotAuthorized();
        if (!ringExists(ringId)) revert BadRing();
        coinRing[coin] = ringId;
        coinBound[coin] = true;
        emit CoinBound(coin, ringId);
    }

    // ------------------------------------------------------------- funding

    function fund(address coin) external payable {
        if (msg.sender != feeRouter) revert NotAuthorized();
        require(coinBound[coin], "unbound");
        uint256 ringId = coinRing[coin];
        pot[ringId] += msg.value;
        emit Funded(ringId, coin, msg.value, msg.sender);
    }

    /// @notice Public donation into a ring: paid out with the next rotation.
    function donate(uint256 ringId) external payable {
        if (!ringExists(ringId)) revert BadRing();
        if (msg.value == 0) revert Empty();
        pot[ringId] += msg.value;
        emit Donated(ringId, msg.value, msg.sender);
    }

    /// @notice Direct public donation to one cause, paid immediately (shielded if it has a key).
    function donateToCause(uint256 causeId) external payable nonReentrant {
        if (causeId >= causes.length) revert BadCause();
        if (msg.value == 0) revert Empty();
        Cause storage c = causes[causeId];
        require(c.active, "inactive");
        (bool shielded, uint256 leafIndex) = _payCause(causeId, msg.value, keccak256(abi.encode("direct", causeId, msg.sender, block.number, c.received)));
        emit DirectDonation(causeId, msg.value, msg.sender, shielded, leafIndex);
    }

    // ------------------------------------------------------------ rotation

    /// @notice Pay the ring's pot to the next cause in rotation. Anyone can call once per epoch.
    function settle(uint256 ringId) external nonReentrant returns (uint256 causeId, uint256 amount) {
        if (!ringExists(ringId)) revert BadRing();
        Ring storage r = rings[ringId];
        if (block.timestamp < r.lastSettled + r.epochLength) revert TooSoon();
        amount = pot[ringId];
        if (amount == 0) revert Empty();

        // skip inactive causes; if every cause is inactive the pot waits
        uint256 n = r.causeIds.length;
        uint256 tries = 0;
        causeId = r.causeIds[r.cursor % n];
        while (!causes[causeId].active && tries < n) {
            r.cursor = (r.cursor + 1) % n;
            causeId = r.causeIds[r.cursor % n];
            tries++;
        }
        require(causes[causeId].active, "no active cause");

        pot[ringId] = 0;
        uint256 epoch = r.epochsSettled;
        r.epochsSettled = epoch + 1;
        r.lastSettled = block.timestamp;
        r.cursor = (r.cursor + 1) % n;

        (bool shielded, uint256 leafIndex) = _payCause(causeId, amount, keccak256(abi.encode("ring", ringId, epoch, causeId)));
        emit Settled(ringId, epoch, causeId, amount, shielded, leafIndex);
    }

    /// @dev Never reverts on the payee's account: a reverting fallback wallet or a pool that cannot
    ///      take the note (e.g. tree full) must not freeze a ring. Failed payments wait in `pending`
    ///      for the fallback wallet (or the cause owner if there is none).
    function _payCause(uint256 causeId, uint256 amount, bytes32 seed) internal returns (bool shielded, uint256 leafIndex) {
        Cause storage c = causes[causeId];
        c.received += amount;
        bool poolFailed;
        if (c.shieldedPubKey != 0) {
            uint256 blinding = uint256(seed) % FIELD_SIZE;
            try pool.depositFor{value: amount}(c.shieldedPubKey, blinding) returns (uint256 index) {
                return (true, index);
            } catch {
                poolFailed = true;
            }
        }
        address to = c.fallbackWallet != address(0) ? c.fallbackWallet : c.owner;
        (bool ok,) = to.call{value: amount, gas: 50_000}("");
        if (!ok) {
            pending[to] += amount;
            emit PayoutDeferred(causeId, to, amount, poolFailed);
        }
        return (false, 0);
    }

    function withdrawPending() external nonReentrant {
        uint256 amount = pending[msg.sender];
        require(amount > 0, "nothing");
        pending[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "send");
        emit PendingWithdrawn(msg.sender, amount);
    }
}
