// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title Grove privacy stage-2 constants (privacy/PRIVACY-SPEC.md Appendix A)
/// @notice Byte-identical to `circuits/lib/grove-zk-v2.mjs`. A forge test recomputes every
///         `keccak256("grove-v2/...") mod p` tag and compares. Nothing here is admin-settable.
library GroveConstants {
    /// BN254 scalar field (the Baby Jubjub base field).
    uint256 internal constant FIELD_SIZE =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    // ---- domain tags: keccak256(label) mod p
    uint256 internal constant ZERO_LEAF =
        1014863620666096670253896730964143634766893057150169129055179254946258934505; // "grove-v2"
    uint256 internal constant INTENT_TAG =
        5485727973690184042573032548250662701561163999721995087532894922013676652701; // "grove-v2/intent"
    uint256 internal constant HANDLE_TAG =
        4197082601223926234440412842350092754680596943151188710592157759256107473565; // "grove-v2/handle"
    uint256 internal constant OWNER_TAG =
        4084283354661981865798945521922129247864409744154712678450526337611273152227; // "grove-v2/owner"
    uint256 internal constant RESULT_TAG =
        19481998103912434576622020492478150961191355642108690953568066567392742677477; // "grove-v2/result"

    // ---- tree
    uint32 internal constant LEVELS = 23;
    uint32 internal constant CHUNK = 4; // leaves per transaction; nextIndex is always a multiple of 4
    uint32 internal constant CHECKPOINT_PERIOD = 600; // seconds

    // ---- intents / ElGamal
    uint256 internal constant UNIT_BNB = 10_000_000_000_000; // 1e13 wei = 0.00001 BNB
    uint256 internal constant UNIT_TOKEN = 1_000_000_000_000_000_000; // 1e18 = one token
    uint256 internal constant U_BITS = 32;
    uint256 internal constant MIN_U_BNB = 5_000; // 0.05 BNB
    uint256 internal constant MIN_U_TOKEN = 50_000; // 50,000 tokens
    uint256 internal constant INTENT_FEE = 2_000_000_000_000_000; // 0.002 BNB, to the treasury
    uint256 internal constant MAX_INTENTS = 256; // => sum(u) < 2^40
    uint256 internal constant MAX_U_SUM = 1_099_511_627_776; // 2^40
    uint256 internal constant RPT_SCALE = 1e18;

    // ---- Baby Jubjub (twisted Edwards a x^2 + y^2 = 1 + d x^2 y^2 over FIELD_SIZE)
    uint256 internal constant BJJ_A = 168700;
    uint256 internal constant BJJ_D = 168696;
    uint256 internal constant BJJ_ORDER =
        2736030358979909402780800718157159386076813972158567259200215660948447373041; // subgroup order l
    uint256 internal constant B8_X =
        5299619240641551281634865583518297030282874472190772894086521144482721001553;
    uint256 internal constant B8_Y =
        16950150798460657717958625567821834550301663161624707787222815936182638968203;

    // ---- directions
    uint8 internal constant DIR_BUY = 0;
    uint8 internal constant DIR_SELL = 1;
    uint8 internal constant DIR_HARVEST = 2;

    // ---- transact payload actions (first word)
    uint256 internal constant ACTION_HANDOVER = 1;
    uint256 internal constant ACTION_PLANT = 2;

    // ---- epoch params: defaults and hard bounds (spec section 2.6.1)
    uint32 internal constant T_MIN = 60;
    uint32 internal constant T_MIN_LO = 30;
    uint32 internal constant T_MIN_HI = 600;
    uint32 internal constant T_MAX = 300;
    uint32 internal constant T_MAX_LO = 120;
    uint32 internal constant T_MAX_HI = 1800;
    uint32 internal constant K = 5;
    uint32 internal constant GRACE = 1800;
    uint32 internal constant GRACE_LO = 600;
    uint32 internal constant GRACE_HI = 86_400;
    uint16 internal constant BAND_BPS = 1000;
    uint16 internal constant BAND_BPS_LO = 200;
    uint16 internal constant BAND_BPS_HI = 2500;
    uint128 internal constant BAND_FLOOR = 0.5 ether;
    uint128 internal constant BAND_FLOOR_LO = 0.1 ether;
    uint128 internal constant BAND_FLOOR_HI = 5 ether;
    uint32 internal constant CLAIM_GAS_LO = 300_000;
    uint32 internal constant CLAIM_GAS_HI = 3_000_000;
    uint32 internal constant OVERLAP = 600; // coordinator key rotation overlap, seconds
    uint256 internal constant MAX_REIMBURSE_GAS_PRICE = 5 gwei;

    // ---- review hardening (privacy/STATUS.md "Review")
    /// Relayer fee cap on `transact` and `submitIntent`: the fee goes to an arbitrary address, so an
    /// uncapped fee is an unshield of any size that skips the on-chain denominations. Equal to the
    /// smallest BNB denomination (Appendix B).
    uint256 internal constant MAX_RELAYER_FEE = 0.01 ether;
    /// `pullRewards` refuses to spread a run over less than one whole token in the pool: below that,
    /// `amount * 1e18 / supply` can push `accRpt - rpt0` past the circuits' 128-bit bound and freeze
    /// coin notes. With supply >= 1e18, accRpt never exceeds the BNB ever pulled (< 2^87 wei).
    uint256 internal constant MIN_REWARD_SUPPLY = 1e18;

    // ---- labels (what the tags hash)
    string internal constant LABEL_ZERO_LEAF = "grove-v2";
    string internal constant LABEL_INTENT = "grove-v2/intent";
    string internal constant LABEL_HANDLE = "grove-v2/handle";
    string internal constant LABEL_OWNER = "grove-v2/owner";
    string internal constant LABEL_RESULT = "grove-v2/result";
}
