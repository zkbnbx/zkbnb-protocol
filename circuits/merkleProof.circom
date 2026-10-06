pragma circom 2.1.0;
include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/bitify.circom";

// Recomputes the Merkle root from a leaf, path elements and a packed path-index integer.
template MerkleProof(levels) {
    signal input leaf;
    signal input pathElements[levels];
    signal input pathIndices;
    signal output root;

    component bits = Num2Bits(levels);
    bits.in <== pathIndices;

    component hashers[levels];
    signal left[levels];
    signal right[levels];
    signal cur[levels + 1];
    cur[0] <== leaf;

    for (var i = 0; i < levels; i++) {
        // bit = 0 -> cur is the left child, bit = 1 -> cur is the right child
        left[i]  <== cur[i] + bits.out[i] * (pathElements[i] - cur[i]);
        right[i] <== pathElements[i] + bits.out[i] * (cur[i] - pathElements[i]);
        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== left[i];
        hashers[i].inputs[1] <== right[i];
        cur[i + 1] <== hashers[i].out;
    }
    root <== cur[levels];
}
