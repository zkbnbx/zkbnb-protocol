// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {GrovePool} from "./GrovePool.sol";
import {IPoseidonT3, IPoseidonT4} from "./interfaces/IGrove.sol";
import {IPancakeRouter02, IPancakePair} from "./interfaces/IPancake.sol";
import {IVerifier17, IVerifier5, IVerifier7, ILaunchpadPrivacy, IRootsHarvestV2 as IRootsHarvest} from "./interfaces/IGroveV2.sol";
import {GroveConstants as C} from "./libraries/GroveConstants.sol";
import {BabyJubjub as B} from "./libraries/BabyJubjub.sol";

/// @title Dark Curve: private batched trading against the live Launchpad (spec section 2.6 / 4.3)
/// @notice Intents are join-split proofs that escrow `u * UNIT` in an intent note and publish only an
///         ElGamal ciphertext of `u` to the Coordinator key. The contract sums ciphertexts per
///         (coin, direction, epoch) in extended Baby Jubjub coordinates; the Coordinator opens an
///         epoch with a proof of the plaintext sum and the contract executes SELL -> HARVEST -> BUY
///         on the live venue as one account, writing a result leaf each participant later claims
///         pro rata. Anyone can void a stuck epoch; nothing here can take or freeze escrow.
contract DarkCurve is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Dir {
        BUY,
        SELL,
        HARVEST
    }

    struct Params {
        uint32 tMin;
        uint32 tMax;
        uint32 k;
        uint32 grace;
        uint16 bandBps;
        uint16 maxIntents;
        uint128 bandFloorWei;
        uint32 claimGas;
    }

    struct Epoch {
        uint64 startedAt;
        uint8 status; // 0 none, 1 collecting, 2 opened, 3 voided
        uint32 keyId; // uint32, not the spec's uint8: daily rotation would overflow a uint8 in 256 days
        uint32 count;
        uint256 refPrice;
        uint256 refVb;
        B.Point c1;
        B.Point c2;
    }

    struct IntentPublic {
        uint256 root;
        uint256 publicAmount;
        address coin;
        uint256 accRpt;
        uint8 dir;
        uint256[2] ecPk;
        uint256[2] c1;
        uint256[2] c2;
        bytes32 extDataHash;
        uint256[2] inputNullifiers;
        uint256[3] outputCommitments;
    }

    struct IntentExt {
        address relayer;
        uint256 fee;
        bytes[3] encryptedOutputs;
    }

    struct ClaimPublic {
        uint256 root;
        uint256 nullifier;
        uint256[2] outputCommitments;
        bytes32 extDataHash;
    }

    struct ClaimExt {
        address relayer;
        bytes[2] encryptedOutputs;
    }

    /// @dev Per-direction execution record of one open.
    struct Settled {
        uint256 totalIn;
        uint256 totalOut;
        uint256 refund;
    }

    GrovePool public immutable pool;
    ILaunchpadPrivacy public immutable launchpad;
    IRootsHarvest public immutable roots;
    IPancakeRouter02 public immutable router;
    address public immutable weth;
    address public immutable treasury;
    IVerifier17 public immutable intentVerifier;
    IVerifier5 public immutable claimVerifier;
    IVerifier7 public immutable openVerifier;
    IPoseidonT3 internal immutable t3;
    IPoseidonT4 internal immutable t4;

    Params public params;
    mapping(address coin => uint32[3]) public cur;
    mapping(bytes32 => Epoch) internal epochs;
    mapping(uint256 c1x => bool) public seenC1;

    /// @dev Coordinator keys by generation; `keyGen` is the current one, `keyGen + 1` the pending.
    mapping(uint256 gen => uint256[2]) public keyByGen;
    uint32 public keyGen;
    uint64 public keySwitchAt; // 0 = no pending key
    uint256 public claimBudget;
    uint256 public maxReimburseGasPrice = C.MAX_REIMBURSE_GAS_PRICE;

    event IntentSubmitted(address indexed coin, uint8 indexed dir, uint32 seq, uint32 count, uint256 intentLeaf);
    event EpochOpened(
        address indexed coin,
        uint8 indexed dir,
        uint32 seq,
        uint256 u,
        uint256 totalIn,
        uint256 totalOut,
        uint256 refund,
        uint256 spotAfter,
        uint256 rptAtSettle
    );
    event EpochVoided(address indexed coin, uint8 indexed dir, uint32 seq);
    event Claimed(address relayer, uint256 reimbursed);
    event ParamsSet(Params p);
    event CoordinatorKeySet(uint256[2] pk, uint64 switchAt);
    event ClaimBudgetFunded(uint256 amount);
    event MaxReimburseGasPriceSet(uint256 wei_);

    error NotCoin();
    error BadDir();
    error EpochFull();
    error WrongKey();
    error UnknownAccRpt();
    error InvalidProof();
    error UnknownRoot();
    error AlreadySpent();
    error BadExtDataHash();
    error BadPublicAmount();
    error ReusedRandomness();
    error NotOpenable(uint8 dir);
    error WrongSeq(uint8 dir);
    error BandExceeded(uint8 dir);
    error NotVoidable();
    error OutOfBounds();
    error EmptyMask();
    error BadValue();
    error TransferFailed();
    error PendingKey();
    error FeeTooHigh();

    constructor(
        address pool_,
        address roots_,
        address treasury_,
        address intentVerifier_,
        address claimVerifier_,
        address openVerifier_,
        uint256[2] memory coordinatorPk,
        address owner_
    ) Ownable(owner_) {
        pool = GrovePool(payable(pool_));
        launchpad = GrovePool(payable(pool_)).launchpad();
        roots = IRootsHarvest(roots_);
        router = IPancakeRouter02(GrovePool(payable(pool_)).router());
        weth = router.WETH();
        treasury = treasury_;
        intentVerifier = IVerifier17(intentVerifier_);
        claimVerifier = IVerifier5(claimVerifier_);
        openVerifier = IVerifier7(openVerifier_);
        t3 = GrovePool(payable(pool_)).hasher();
        t4 = GrovePool(payable(pool_)).t4();
        if (!_isValidKey(coordinatorPk)) revert WrongKey();
        keyByGen[0] = coordinatorPk;
        emit CoordinatorKeySet(coordinatorPk, uint64(block.timestamp));
        params = Params({
            tMin: C.T_MIN,
            tMax: C.T_MAX,
            k: C.K,
            grace: C.GRACE,
            bandBps: C.BAND_BPS,
            maxIntents: uint16(C.MAX_INTENTS),
            bandFloorWei: C.BAND_FLOOR,
            claimGas: 600_000 // placeholder inside the bounds; set from contracts/gas-v2.json at integration
        });
    }

    // ---------------------------------------------------------------- views

    function epochKey(address coin, uint32 seq, uint8 dir) public view returns (uint256) {
        return t4.poseidon([uint256(uint160(coin)), uint256(seq), uint256(dir)]);
    }

    function intentLeaf(uint256 commitment, uint256 epochKey_) public view returns (uint256) {
        return t3.poseidon([commitment, epochKey_]);
    }

    function resultLeaf(uint256 epochKey_, uint256 totalIn, uint256 totalOut, uint256 totalRefund, uint256 rptAtSettle)
        public
        view
        returns (uint256)
    {
        uint256 totalsHash = t4.poseidon([totalIn, totalOut, t3.poseidon([totalRefund, rptAtSettle])]);
        return t4.poseidon([C.RESULT_TAG, epochKey_, totalsHash]);
    }

    function epochOf(address coin, uint8 dir, uint32 seq) external view returns (Epoch memory) {
        return epochs[_key(coin, dir, seq)];
    }

    /// @notice One call for every active coin: the current epoch of each direction.
    function epochsOf(address[] calldata coins) external view returns (Epoch[3][] memory out) {
        out = new Epoch[3][](coins.length);
        for (uint256 i; i < coins.length; i++) {
            for (uint8 d; d < 3; d++) {
                out[i][d] = epochs[_key(coins[i], d, cur[coins[i]][d])];
            }
        }
    }

    function isOpenable(address coin, uint8 dir, uint32 seq) public view returns (bool) {
        Epoch storage ep = epochs[_key(coin, dir, seq)];
        if (ep.status != 1 || ep.count == 0) return false;
        uint256 age = block.timestamp - ep.startedAt;
        return (age >= params.tMin && ep.count >= params.k) || age >= params.tMax;
    }

    function isVoidable(address coin, uint8 dir, uint32 seq) public view returns (bool) {
        Epoch storage ep = epochs[_key(coin, dir, seq)];
        return ep.status == 1 && ep.count > 0 && block.timestamp > ep.startedAt + params.tMax + params.grace;
    }

    /// @notice Spot price (wei per 1e18 tokens) and the BNB reserve the band is measured on: the
    ///         curve's virtual BNB before graduation, the pair's WBNB reserve after.
    function spot(address coin) public view returns (uint256 price, uint256 vB) {
        (,,, uint256 realBnb,,,,, address pair,,) = launchpad.info(coin);
        if (pair == address(0)) {
            return (launchpad.price(coin), launchpad.VIRTUAL_BNB() + realBnb);
        }
        (uint112 r0, uint112 r1,) = IPancakePair(pair).getReserves();
        (uint256 rToken, uint256 rBnb) = IPancakePair(pair).token0() == coin ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        if (rToken == 0) return (0, rBnb);
        return (rBnb * 1e18 / rToken, rBnb);
    }

    /// @notice The key the contract accepts right now (after a pending switch has passed, that key).
    function activeCoordinatorKey() public view returns (uint256[2] memory pk, uint32 gen) {
        gen = keyGen;
        if (keySwitchAt != 0 && block.timestamp >= keySwitchAt) gen++;
        pk = keyByGen[gen];
    }

    function hashIntentExt(IntentExt calldata e) public pure returns (bytes32) {
        return bytes32(uint256(keccak256(abi.encode(e))) % C.FIELD_SIZE);
    }

    function hashClaimExt(ClaimExt calldata e) public pure returns (bytes32) {
        return bytes32(uint256(keccak256(abi.encode(e))) % C.FIELD_SIZE);
    }

    /// @notice Signals in the frozen order of WORKPLAN section 1.2 (17).
    function verifyIntent(GrovePool.Proof calldata p, IntentPublic calldata s) public view returns (bool) {
        return intentVerifier.verifyProof(
            p.a,
            p.b,
            p.c,
            [
                s.root,
                s.publicAmount,
                uint256(uint160(s.coin)),
                s.accRpt,
                uint256(s.dir),
                s.ecPk[0],
                s.ecPk[1],
                s.c1[0],
                s.c1[1],
                s.c2[0],
                s.c2[1],
                uint256(s.extDataHash),
                s.inputNullifiers[0],
                s.inputNullifiers[1],
                s.outputCommitments[0],
                s.outputCommitments[1],
                s.outputCommitments[2]
            ]
        );
    }

    /// @notice Signals in the frozen order (5).
    function verifyClaim(GrovePool.Proof calldata p, ClaimPublic calldata s) public view returns (bool) {
        return claimVerifier.verifyProof(
            p.a, p.b, p.c, [s.root, s.nullifier, s.outputCommitments[0], s.outputCommitments[1], uint256(s.extDataHash)]
        );
    }

    /// @notice Signals in the frozen order (7): ecPk, C1, C2 (affine), u.
    function verifyOpen(GrovePool.Proof calldata p, uint256[2] memory ecPk, uint256[2] memory c1, uint256[2] memory c2, uint256 u)
        public
        view
        returns (bool)
    {
        return openVerifier.verifyProof(p.a, p.b, p.c, [ecPk[0], ecPk[1], c1[0], c1[1], c2[0], c2[1], u]);
    }

    // ------------------------------------------------------------- intents

    function submitIntent(GrovePool.Proof calldata p, IntentPublic calldata s, IntentExt calldata e) external nonReentrant {
        // 1. coin, direction, key, capacity, accRpt, randomness
        if (!pool.isCoin(s.coin)) revert NotCoin();
        if (s.dir > 2) revert BadDir();
        uint32 kid = _keyIdOf(s.ecPk);
        uint32 seq = cur[s.coin][s.dir];
        Epoch storage ep = epochs[_key(s.coin, s.dir, seq)];
        if (ep.count > 0 && ep.keyId != kid) revert WrongKey();
        if (ep.count >= params.maxIntents) revert EpochFull();
        if (!pool.knownAccRpt(s.coin, s.accRpt)) revert UnknownAccRpt();
        if (seenC1[s.c1[0]]) revert ReusedRandomness();
        B.Point memory c1 = B.fromAffine(s.c1[0], s.c1[1]);
        B.Point memory c2 = B.fromAffine(s.c2[0], s.c2[1]);

        // 2. root, nullifiers, ext, public amount, proof
        if (!pool.isKnownRoot(s.root)) revert UnknownRoot();
        if (pool.isSpent(s.inputNullifiers[0]) || pool.isSpent(s.inputNullifiers[1])) revert AlreadySpent();
        if (s.inputNullifiers[0] == s.inputNullifiers[1]) revert AlreadySpent();
        if (s.extDataHash != hashIntentExt(e)) revert BadExtDataHash();
        if (e.fee > 0 && e.relayer == address(0)) revert BadValue();
        if (e.fee > C.MAX_RELAYER_FEE) revert FeeTooHigh();
        if (s.publicAmount != C.FIELD_SIZE - (e.fee + C.INTENT_FEE)) revert BadPublicAmount();
        if (!verifyIntent(p, s)) revert InvalidProof();

        // 3. first intent of the direction starts the epoch
        if (ep.count == 0) {
            (uint256 price, uint256 vB) = spot(s.coin);
            ep.startedAt = uint64(block.timestamp);
            ep.status = 1;
            ep.keyId = kid;
            ep.refPrice = price;
            ep.refVb = vB;
            ep.c1 = B.identity();
            ep.c2 = B.identity();
        }

        // 4. effects
        pool.markSpent(s.inputNullifiers[0]);
        pool.markSpent(s.inputNullifiers[1]);
        seenC1[s.c1[0]] = true;
        uint256 leaf = intentLeaf(s.outputCommitments[0], epochKey(s.coin, seq, s.dir));
        bytes[] memory enc = new bytes[](3);
        enc[0] = e.encryptedOutputs[0];
        enc[1] = e.encryptedOutputs[1];
        enc[2] = e.encryptedOutputs[2];
        pool.insertChunk([leaf, s.outputCommitments[1], s.outputCommitments[2], C.ZERO_LEAF], enc);
        ep.count += 1;
        ep.c1 = B.add(ep.c1, c1);
        ep.c2 = B.add(ep.c2, c2);
        if (e.fee > 0) pool.moveOut(address(0), e.fee, e.relayer);
        pool.moveOut(address(0), C.INTENT_FEE, treasury);

        emit IntentSubmitted(s.coin, s.dir, seq, ep.count, leaf);
    }

    // ---------------------------------------------------------------- open

    /// @notice Open every direction in `dirMask` (bit d = direction d) of `coin` at once. Sells
    ///         execute before harvests before buys. Reverts whole if any included venue call fails.
    function openEpoch(
        address coin,
        uint8 dirMask,
        uint32[3] calldata seq,
        uint256[3] calldata u,
        GrovePool.Proof[3] calldata proofs,
        uint256[3] calldata minOut
    ) external nonReentrant {
        if (dirMask == 0 || dirMask > 7) revert EmptyMask();

        // 1. verify every included direction against its stored sum, 2. band
        for (uint8 d; d < 3; d++) {
            if (dirMask & (1 << d) == 0) continue;
            if (seq[d] != cur[coin][d]) revert WrongSeq(d);
            if (!isOpenable(coin, d, seq[d])) revert NotOpenable(d);
            Epoch storage ep = epochs[_key(coin, d, seq[d])];
            (uint256 c1x, uint256 c1y) = B.toAffine(ep.c1);
            (uint256 c2x, uint256 c2y) = B.toAffine(ep.c2);
            if (!verifyOpen(proofs[d], keyByGen[ep.keyId], [c1x, c1y], [c2x, c2y], u[d])) revert InvalidProof();
            if (u[d] == 0 || u[d] >= C.MAX_U_SUM) revert OutOfBounds();
            _checkBand(coin, d, ep);
        }

        // 3. execute SELL -> HARVEST -> BUY
        Settled[3] memory res;
        if (dirMask & 2 != 0) res[1] = _sell(coin, u[1] * C.UNIT_TOKEN, minOut[1]);
        if (dirMask & 4 != 0) res[2] = _harvest(coin, u[2] * C.UNIT_TOKEN, minOut[2]);
        if (dirMask & 1 != 0) res[0] = _buy(coin, u[0] * C.UNIT_BNB, minOut[0]);

        // 4. one chunk of result leaves, 5. close the epochs
        uint256 rpt = pool.accRpt(coin);
        (uint256 spotAfter,) = spot(coin);
        uint256[4] memory leaves = [C.ZERO_LEAF, C.ZERO_LEAF, C.ZERO_LEAF, C.ZERO_LEAF];
        uint256 slot;
        for (uint8 d; d < 3; d++) {
            if (dirMask & (1 << d) == 0) continue;
            leaves[slot++] = resultLeaf(epochKey(coin, seq[d], d), res[d].totalIn, res[d].totalOut, res[d].refund, rpt);
            epochs[_key(coin, d, seq[d])].status = 2;
            cur[coin][d] = seq[d] + 1;
            emit EpochOpened(coin, d, seq[d], u[d], res[d].totalIn, res[d].totalOut, res[d].refund, spotAfter, rpt);
        }
        pool.insertChunk(leaves, new bytes[](0));
    }

    /// @notice After `T_MAX + GRACE` without an open, anyone voids a direction: every claim refunds
    ///         100 % in the escrowed asset through the result leaf (1, 0, 1, accRpt).
    function voidEpoch(address coin, uint8 dir, uint32 seq) external nonReentrant {
        if (dir > 2) revert BadDir();
        if (seq != cur[coin][dir]) revert WrongSeq(dir);
        if (!isVoidable(coin, dir, seq)) revert NotVoidable();
        uint256 rpt = pool.accRpt(coin);
        uint256 leaf = resultLeaf(epochKey(coin, seq, dir), 1, 0, 1, rpt);
        epochs[_key(coin, dir, seq)].status = 3;
        cur[coin][dir] = seq + 1;
        pool.insertChunk([leaf, C.ZERO_LEAF, C.ZERO_LEAF, C.ZERO_LEAF], new bytes[](0));
        emit EpochVoided(coin, dir, seq);
    }

    // --------------------------------------------------------------- claims

    function claim(GrovePool.Proof calldata p, ClaimPublic calldata s, ClaimExt calldata e) external nonReentrant {
        if (!pool.isKnownRoot(s.root)) revert UnknownRoot();
        if (pool.isSpent(s.nullifier)) revert AlreadySpent();
        if (s.extDataHash != hashClaimExt(e)) revert BadExtDataHash();
        if (!verifyClaim(p, s)) revert InvalidProof();

        pool.markSpent(s.nullifier);
        bytes[] memory enc = new bytes[](2);
        enc[0] = e.encryptedOutputs[0];
        enc[1] = e.encryptedOutputs[1];
        pool.insertChunk([s.outputCommitments[0], s.outputCommitments[1], C.ZERO_LEAF, C.ZERO_LEAF], enc);

        uint256 r;
        if (e.relayer != address(0)) {
            uint256 gp_ = tx.gasprice < maxReimburseGasPrice ? tx.gasprice : maxReimburseGasPrice;
            r = uint256(params.claimGas) * gp_;
            if (r > claimBudget) r = claimBudget;
            if (r > 0) {
                claimBudget -= r;
                _pay(e.relayer, r);
            }
        }
        emit Claimed(e.relayer, r);
    }

    function fundClaimBudget() external payable {
        if (msg.value == 0) revert BadValue();
        claimBudget += msg.value;
        emit ClaimBudgetFunded(msg.value);
    }

    // ---------------------------------------------------------------- admin

    function setParams(Params calldata p) external onlyOwner {
        if (
            p.tMin < C.T_MIN_LO || p.tMin > C.T_MIN_HI || p.tMax < C.T_MAX_LO || p.tMax > C.T_MAX_HI || p.tMin >= p.tMax
                || p.k == 0 || p.grace < C.GRACE_LO || p.grace > C.GRACE_HI || p.bandBps < C.BAND_BPS_LO
                || p.bandBps > C.BAND_BPS_HI || p.maxIntents == 0 || p.maxIntents > C.MAX_INTENTS
                || p.bandFloorWei < C.BAND_FLOOR_LO || p.bandFloorWei > C.BAND_FLOOR_HI || p.claimGas < C.CLAIM_GAS_LO
                || p.claimGas > C.CLAIM_GAS_HI
        ) revert OutOfBounds();
        params = p;
        emit ParamsSet(p);
    }

    /// @notice Schedule the next Coordinator key. Intents are accepted under the old key until
    ///         `switchAt` and under the new one from `switchAt - OVERLAP`. One pending key at a time.
    function setCoordinatorKey(uint256[2] calldata pk, uint64 switchAt) external onlyOwner {
        _promoteKey();
        if (keySwitchAt != 0) revert PendingKey();
        if (switchAt < block.timestamp + C.OVERLAP) revert OutOfBounds();
        if (!_isValidKey(pk)) revert WrongKey();
        keyByGen[uint256(keyGen) + 1] = pk;
        keySwitchAt = switchAt;
        emit CoordinatorKeySet(pk, switchAt);
    }

    function setMaxReimburseGasPrice(uint256 wei_) external onlyOwner {
        maxReimburseGasPrice = wei_;
        emit MaxReimburseGasPriceSet(wei_);
    }

    // ------------------------------------------------------------ internals

    function _key(address coin, uint8 dir, uint32 seq) internal pure returns (bytes32) {
        return keccak256(abi.encode(coin, dir, seq));
    }

    function _promoteKey() internal {
        if (keySwitchAt != 0 && block.timestamp >= keySwitchAt) {
            keyGen += 1;
            keySwitchAt = 0;
        }
    }

    /// @dev Current key, or the pending key inside its overlap window.
    function _keyIdOf(uint256[2] calldata pk) internal returns (uint32) {
        _promoteKey();
        uint256[2] storage curKey = keyByGen[keyGen];
        if (pk[0] == curKey[0] && pk[1] == curKey[1]) return keyGen;
        if (keySwitchAt != 0 && block.timestamp + C.OVERLAP >= keySwitchAt) {
            uint256[2] storage nxt = keyByGen[uint256(keyGen) + 1];
            if (pk[0] == nxt[0] && pk[1] == nxt[1]) return keyGen + 1;
        }
        revert WrongKey();
    }

    /// @dev A Coordinator key must be a non-identity point of the prime-order subgroup: the identity
    ///      would make every ciphertext's C2 = u*B8, i.e. publish every intent's amount, and a key
    ///      outside the subgroup can never satisfy `epochOpen` (pk == sk*B8), so every epoch voids.
    function _isValidKey(uint256[2] memory pk) internal pure returns (bool) {
        if (!B.isOnCurve(pk[0], pk[1])) return false;
        if (pk[0] == 0) return false; // (0, 1) identity, (0, -1) order 2
        B.Point memory p = B.fromAffine(pk[0], pk[1]);
        return B.isIdentity(B.mul(p, C.BJJ_ORDER)); // l*pk == identity
    }

    function _checkBand(address coin, uint8 d, Epoch storage ep) internal view {
        if (d == uint8(Dir.HARVEST)) return;
        (uint256 price, uint256 vB) = spot(coin);
        uint256 band = ep.refPrice * params.bandBps / 10_000;
        if (d == uint8(Dir.BUY)) {
            if (price > ep.refPrice + band && vB > ep.refVb && vB - ep.refVb > params.bandFloorWei) revert BandExceeded(d);
        } else {
            if (price + band < ep.refPrice && ep.refVb > vB && ep.refVb - vB > params.bandFloorWei) revert BandExceeded(d);
        }
    }

    function _sell(address coin, uint256 tokens, uint256 minOut) internal returns (Settled memory r) {
        pool.moveOut(coin, tokens, address(this));
        uint256 before = address(this).balance;
        if (!launchpad.isGraduated(coin)) {
            IERC20(coin).forceApprove(address(launchpad), tokens);
            launchpad.sell(coin, tokens, minOut);
        } else {
            IERC20(coin).forceApprove(address(router), tokens);
            address[] memory path = new address[](2);
            path[0] = coin;
            path[1] = weth;
            router.swapExactTokensForETHSupportingFeeOnTransferTokens(tokens, minOut, path, address(this), block.timestamp);
        }
        r.totalIn = tokens;
        r.totalOut = address(this).balance - before;
        _pay(address(pool), r.totalOut);
    }

    function _harvest(address coin, uint256 tokens, uint256 minOut) internal returns (Settled memory r) {
        pool.moveOut(coin, tokens, address(this));
        IERC20(coin).forceApprove(address(roots), tokens);
        uint256 before = address(this).balance;
        roots.harvest(coin, tokens, minOut);
        r.totalIn = tokens;
        r.totalOut = address(this).balance - before;
        _pay(address(pool), r.totalOut);
    }

    function _buy(address coin, uint256 bnb, uint256 minOut) internal returns (Settled memory r) {
        pool.moveOut(address(0), bnb, address(this));
        uint256 balBefore = address(this).balance; // includes `bnb`
        uint256 tokBefore = IERC20(coin).balanceOf(address(this));
        if (!launchpad.isGraduated(coin)) {
            launchpad.buy{value: bnb}(coin, minOut);
        } else {
            address[] memory path = new address[](2);
            path[0] = weth;
            path[1] = coin;
            router.swapExactETHForTokensSupportingFeeOnTransferTokens{value: bnb}(minOut, path, address(this), block.timestamp);
        }
        r.totalIn = bnb;
        r.totalOut = IERC20(coin).balanceOf(address(this)) - tokBefore;
        r.refund = address(this).balance + bnb - balBefore; // what the venue gave back
        if (r.totalOut > 0) IERC20(coin).safeTransfer(address(pool), r.totalOut);
        if (r.refund > 0) _pay(address(pool), r.refund);
    }

    function _pay(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// @dev Venue proceeds, Launchpad refunds, pool.moveOut, claim-budget top-ups via fundClaimBudget.
    receive() external payable {}
}
