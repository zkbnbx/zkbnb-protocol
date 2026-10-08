pragma circom 2.1.0;
include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/comparators.circom";
include "../node_modules/circomlib/circuits/bitify.circom";
include "./keypair-v2.circom";
include "./merkleProof.circom";
include "./lib/constants.circom";
include "./lib/note.circom";

/*
 Epoch claim (privacy/PRIVACY-SPEC.md section 3.3): I own an intent note (coin, dir, a, blinding) stamped into
 epoch `epoch`, and the result leaf for (coin, dir, epoch) exists under the same checkpoint root. Outputs:
   out[0] = (isBuy ? coin : 0,  floor(a * totalOut    / totalIn), rpt0 = isBuy       * rptAtSettle)
   out[1] = (isBuy ? 0 : coin,  floor(a * totalRefund / totalIn), rpt0 = (1 - isBuy) * rptAtSettle)
 Public signals, in this order (frozen): root, nullifier, outputCommitment[0], outputCommitment[1], extDataHash
*/
template Claim(levels) {
    // ---- public (declaration order = public signal order)
    signal input root;
    signal input nullifier;
    signal input outputCommitment[2];
    signal input extDataHash;

    // ---- private
    signal input ask;
    signal input coin;
    signal input dir;
    signal input epoch;
    signal input a;
    signal input blinding;
    signal input intentPathIndices;
    signal input intentPathElements[levels];
    signal input totalIn;
    signal input totalOut;
    signal input totalRefund;
    signal input rptAtSettle;
    signal input resultPathIndices;
    signal input resultPathElements[levels];
    signal input q;
    signal input r;
    signal input qr;
    signal input rr;
    signal input outPubkey[2];
    signal input outBlinding[2];

    // ---- keys
    component key = Keypair();
    key.privateKey <== ask;
    component nkC = NullifierKey();
    nkC.privateKey <== ask;

    // ---- direction
    signal dirA;
    dirA <== dir * (dir - 1);
    dirA * (dir - 2) === 0;
    component dirZero = IsZero();
    dirZero.in <== dir;
    signal isBuy;
    isBuy <== dirZero.out;

    // ---- the intent note and its stamped leaf
    component intentAsset = Poseidon(3);
    intentAsset.inputs[0] <== INTENT_TAG();
    intentAsset.inputs[1] <== coin;
    intentAsset.inputs[2] <== dir;

    component note = NoteCommitment();
    note.amount <== a;
    note.pubkey <== key.publicKey;
    note.assetId <== intentAsset.out;
    note.rpt0 <== 0;
    note.blinding <== blinding;

    component epochKey = Poseidon(3);
    epochKey.inputs[0] <== coin;
    epochKey.inputs[1] <== epoch;
    epochKey.inputs[2] <== dir;

    component intentLeaf = Poseidon(2);
    intentLeaf.inputs[0] <== note.commitment;
    intentLeaf.inputs[1] <== epochKey.out;

    component intentTree = MerkleProof(levels);
    intentTree.leaf <== intentLeaf.out;
    intentTree.pathIndices <== intentPathIndices;
    for (var l = 0; l < levels; l++) intentTree.pathElements[l] <== intentPathElements[l];
    intentTree.root === root;

    component nf = Nullifier();
    nf.commitment <== note.commitment;
    nf.pathIndices <== intentPathIndices;
    nf.nk <== nkC.nk;
    nf.out === nullifier;

    // ---- the result leaf
    component totalsInner = Poseidon(2);
    totalsInner.inputs[0] <== totalRefund;
    totalsInner.inputs[1] <== rptAtSettle;
    component totalsHash = Poseidon(3);
    totalsHash.inputs[0] <== totalIn;
    totalsHash.inputs[1] <== totalOut;
    totalsHash.inputs[2] <== totalsInner.out;
    component resultLeaf = Poseidon(3);
    resultLeaf.inputs[0] <== RESULT_TAG();
    resultLeaf.inputs[1] <== epochKey.out;
    resultLeaf.inputs[2] <== totalsHash.out;

    component resultTree = MerkleProof(levels);
    resultTree.leaf <== resultLeaf.out;
    resultTree.pathIndices <== resultPathIndices;
    for (var l = 0; l < levels; l++) resultTree.pathElements[l] <== resultPathElements[l];
    resultTree.root === root;

    // ---- pro-rata shares with floor division (field-wrap guard: a < 2^96, the rest < 2^128)
    component aBits = Num2Bits(96);
    aBits.in <== a;
    component inBits = Num2Bits(128);
    inBits.in <== totalIn;
    component outBits = Num2Bits(128);
    outBits.in <== totalOut;
    component refBits = Num2Bits(128);
    refBits.in <== totalRefund;
    component qBits = Num2Bits(128);
    qBits.in <== q;
    component qrBits = Num2Bits(128);
    qrBits.in <== qr;
    component rBits = Num2Bits(128);
    rBits.in <== r;
    component rrBits = Num2Bits(128);
    rrBits.in <== rr;

    component inNonZero = IsZero();
    inNonZero.in <== totalIn;
    inNonZero.out === 0;

    signal qt;
    qt <== q * totalIn;
    a * totalOut === qt + r;
    component rLess = LessThan(128);
    rLess.in[0] <== r;
    rLess.in[1] <== totalIn;
    rLess.out === 1;

    signal qrt;
    qrt <== qr * totalIn;
    a * totalRefund === qrt + rr;
    component rrLess = LessThan(128);
    rrLess.in[0] <== rr;
    rrLess.in[1] <== totalIn;
    rrLess.out === 1;

    // ---- outputs
    signal out0Asset;
    out0Asset <== isBuy * coin;
    signal out0Rpt0;
    out0Rpt0 <== isBuy * rptAtSettle;
    component out0 = NoteCommitment();
    out0.amount <== q;
    out0.pubkey <== outPubkey[0];
    out0.assetId <== out0Asset;
    out0.rpt0 <== out0Rpt0;
    out0.blinding <== outBlinding[0];
    out0.commitment === outputCommitment[0];

    signal out1Asset;
    out1Asset <== coin - out0Asset;
    signal out1Rpt0;
    out1Rpt0 <== rptAtSettle - out0Rpt0;
    component out1 = NoteCommitment();
    out1.amount <== qr;
    out1.pubkey <== outPubkey[1];
    out1.assetId <== out1Asset;
    out1.rpt0 <== out1Rpt0;
    out1.blinding <== outBlinding[1];
    out1.commitment === outputCommitment[1];

    // ---- bind extData
    signal extDataSquare;
    extDataSquare <== extDataHash * extDataHash;
}

component main { public [root, nullifier, outputCommitment, extDataHash] } = Claim(23);
