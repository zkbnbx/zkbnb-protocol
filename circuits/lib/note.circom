pragma circom 2.1.0;
include "../node_modules/circomlib/circuits/poseidon.circom";

/*
 Stage-2 note (spec §2.1):
   inner      = PoseidonT4(assetId, rpt0, blinding)      -> Poseidon(3) in circom
   commitment = PoseidonT4(amount, pk, inner)             (v1 shape, inner in the blinding slot)
   nullifier  = PoseidonT4(commitment, leafIndex, nk)
*/
template NoteCommitment() {
    signal input amount;
    signal input pubkey;
    signal input assetId;
    signal input rpt0;
    signal input blinding;
    signal output commitment;
    signal output inner;

    component hInner = Poseidon(3);
    hInner.inputs[0] <== assetId;
    hInner.inputs[1] <== rpt0;
    hInner.inputs[2] <== blinding;
    inner <== hInner.out;

    component hOuter = Poseidon(3);
    hOuter.inputs[0] <== amount;
    hOuter.inputs[1] <== pubkey;
    hOuter.inputs[2] <== inner;
    commitment <== hOuter.out;
}

template Nullifier() {
    signal input commitment;
    signal input pathIndices;
    signal input nk;
    signal output out;

    component h = Poseidon(3);
    h.inputs[0] <== commitment;
    h.inputs[1] <== pathIndices;
    h.inputs[2] <== nk;
    out <== h.out;
}
