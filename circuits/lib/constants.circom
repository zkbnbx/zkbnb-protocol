pragma circom 2.1.0;

// Every Appendix A field constant of privacy/PRIVACY-SPEC.md as a function.
// Must stay byte-identical to circuits/lib/grove-zk-v2.mjs and contracts/src/libraries/GroveConstants.sol
// (scripts/zero-leaf-v2.mjs prints the JS side for the CI diff).

function ZERO_LEAF()   { return 1014863620666096670253896730964143634766893057150169129055179254946258934505; }  // keccak256("grove-v2") mod p
function INTENT_TAG()  { return 5485727973690184042573032548250662701561163999721995087532894922013676652701; }  // keccak256("grove-v2/intent") mod p
function HANDLE_TAG()  { return 4197082601223926234440412842350092754680596943151188710592157759256107473565; }  // keccak256("grove-v2/handle") mod p
function OWNER_TAG()   { return 4084283354661981865798945521922129247864409744154712678450526337611273152227; }  // keccak256("grove-v2/owner") mod p
function RESULT_TAG()  { return 19481998103912434576622020492478150961191355642108690953568066567392742677477; } // keccak256("grove-v2/result") mod p

function LEVELS()      { return 23; }
function CHUNK()       { return 4; }

function UNIT_BNB()    { return 10000000000000; }               // 1e13 wei = 0.00001 BNB
function UNIT_TOKEN()  { return 1000000000000000000; }          // 1e18 = one token
function U_BITS()      { return 32; }
function MIN_U_BNB()   { return 5000; }                         // 0.05 BNB
function MIN_U_TOKEN() { return 50000; }                        // 50,000 tokens
function RPT_SCALE()   { return 1000000000000000000; }          // 1e18

function DIR_BUY()     { return 0; }
function DIR_SELL()    { return 1; }
function DIR_HARVEST() { return 2; }

// Baby Jubjub (circomlib Base8); subgroup order l
function BASE8_X()     { return 5299619240641551281634865583518297030282874472190772894086521144482721001553; }
function BASE8_Y()     { return 16950150798460657717958625567821834550301663161624707787222815936182638968203; }
function SUBORDER()    { return 2736030358979909402780800718157159386076813972158567259200215660948447373041; }
