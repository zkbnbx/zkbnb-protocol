pragma circom 2.1.0;
include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/comparators.circom";
include "../node_modules/circomlib/circuits/bitify.circom";
include "./keypair-v2.circom";
include "./merkleProof.circom";
include "./lib/constants.circom";
include "./lib/note.circom";
include "./lib/elgamal.circom";

/*
 Private trade intent (privacy/PRIVACY-SPEC.md section 3.2): 2-in-3-out join-split whose output 0 is an
 intent note (asset = Poseidon(INTENT_TAG, coin, dir), amount = u * UNIT(dir), rpt0 = 0) and whose size u is
 published only as an exponential ElGamal ciphertext under the Coordinator key.
 Public signals, in this order (frozen, WORKPLAN 1.2):
   root, publicAmount, coin, accRpt, dir, ecPk[0], ecPk[1], C1[0], C1[1], C2[0], C2[1], extDataHash,
   inputNullifier[0], inputNullifier[1], outputCommitment[0], outputCommitment[1], outputCommitment[2]
*/
template Intent(levels) {
    var nIns = 2;
    var nChg = 2;   // change outputs = outputCommitment[1], outputCommitment[2]

    // ---- public (declaration order = public signal order)
    signal input root;
    signal input publicAmount;
    signal input coin;
    signal input accRpt;
    signal input dir;
    signal input ecPk[2];
    signal input C1[2];
    signal input C2[2];
    signal input extDataHash;
    signal input inputNullifier[nIns];
    signal input outputCommitment[3];

    // ---- private
    signal input inAsset[nIns];
    signal input inAmount[nIns];
    signal input inRpt0[nIns];
    signal input inBlinding[nIns];
    signal input inAsk[nIns];
    signal input inPathIndices[nIns];
    signal input inPathElements[nIns][levels];
    signal input inQ[nIns];
    signal input inR[nIns];

    signal input chgAsset[nChg];
    signal input chgAmount[nChg];
    signal input chgPubkey[nChg];
    signal input chgBlinding[nChg];

    signal input u;
    signal input k;
    signal input out0Pubkey;
    signal input out0Blinding;

    // ---- inputs (as transfer.circom)
    component inKey[nIns];
    component inNk[nIns];
    component inNote[nIns];
    component inNf[nIns];
    component inTree[nIns];
    component inCheckRoot[nIns];
    component inAssetZero[nIns];
    component deltaBits[nIns];
    component qBits[nIns];
    component rBits[nIns];
    component rLess[nIns];
    signal isCoin[nIns];
    signal delta[nIns];
    signal owed[nIns];
    signal coinIn[nIns];
    var sumBnbIn = 0;
    var sumOwed = 0;
    var sumCoinIn = 0;

    for (var i = 0; i < nIns; i++) {
        inKey[i] = Keypair();
        inKey[i].privateKey <== inAsk[i];
        inNk[i] = NullifierKey();
        inNk[i].privateKey <== inAsk[i];

        inNote[i] = NoteCommitment();
        inNote[i].amount <== inAmount[i];
        inNote[i].pubkey <== inKey[i].publicKey;
        inNote[i].assetId <== inAsset[i];
        inNote[i].rpt0 <== inRpt0[i];
        inNote[i].blinding <== inBlinding[i];

        inNf[i] = Nullifier();
        inNf[i].commitment <== inNote[i].commitment;
        inNf[i].pathIndices <== inPathIndices[i];
        inNf[i].nk <== inNk[i].nk;
        inNf[i].out === inputNullifier[i];

        inTree[i] = MerkleProof(levels);
        inTree[i].leaf <== inNote[i].commitment;
        inTree[i].pathIndices <== inPathIndices[i];
        for (var l = 0; l < levels; l++) inTree[i].pathElements[l] <== inPathElements[i][l];

        inCheckRoot[i] = ForceEqualIfEnabled();
        inCheckRoot[i].in[0] <== root;
        inCheckRoot[i].in[1] <== inTree[i].root;
        inCheckRoot[i].enabled <== inAmount[i];

        inAsset[i] * (inAsset[i] - coin) === 0;
        inAssetZero[i] = IsZero();
        inAssetZero[i].in <== inAsset[i];
        isCoin[i] <== 1 - inAssetZero[i].out;

        delta[i] <== accRpt - inRpt0[i];
        deltaBits[i] = Num2Bits(128);
        deltaBits[i].in <== delta[i];
        inAmount[i] * delta[i] === inQ[i] * RPT_SCALE() + inR[i];
        qBits[i] = Num2Bits(128);
        qBits[i].in <== inQ[i];
        rBits[i] = Num2Bits(64);
        rBits[i].in <== inR[i];
        rLess[i] = LessThan(64);
        rLess[i].in[0] <== inR[i];
        rLess[i].in[1] <== RPT_SCALE();
        rLess[i].out === 1;
        owed[i] <== isCoin[i] * inQ[i];

        coinIn[i] <== isCoin[i] * inAmount[i];
        sumBnbIn += inAmount[i] - coinIn[i];
        sumCoinIn += coinIn[i];
        sumOwed += owed[i];
    }

    // ---- change outputs (outputCommitment[1], outputCommitment[2])
    component chgNote[nChg];
    component chgAssetZero[nChg];
    component chgAmountBits[nChg];
    signal isCoinChg[nChg];
    signal chgRpt0[nChg];
    signal coinChg[nChg];
    var sumBnbChg = 0;
    var sumCoinChg = 0;

    for (var j = 0; j < nChg; j++) {
        chgAsset[j] * (chgAsset[j] - coin) === 0;
        chgAssetZero[j] = IsZero();
        chgAssetZero[j].in <== chgAsset[j];
        isCoinChg[j] <== 1 - chgAssetZero[j].out;
        chgRpt0[j] <== isCoinChg[j] * accRpt;

        chgNote[j] = NoteCommitment();
        chgNote[j].amount <== chgAmount[j];
        chgNote[j].pubkey <== chgPubkey[j];
        chgNote[j].assetId <== chgAsset[j];
        chgNote[j].rpt0 <== chgRpt0[j];
        chgNote[j].blinding <== chgBlinding[j];
        chgNote[j].commitment === outputCommitment[j + 1];

        chgAmountBits[j] = Num2Bits(128);
        chgAmountBits[j].in <== chgAmount[j];

        coinChg[j] <== isCoinChg[j] * chgAmount[j];
        sumBnbChg += chgAmount[j] - coinChg[j];
        sumCoinChg += coinChg[j];
    }

    // ---- direction and size
    signal dirA;
    dirA <== dir * (dir - 1);
    dirA * (dir - 2) === 0;
    component dirZero = IsZero();
    dirZero.in <== dir;
    signal isBuy;
    isBuy <== dirZero.out;

    signal unit;
    unit <== UNIT_BNB() + (1 - isBuy) * (UNIT_TOKEN() - UNIT_BNB());
    signal minU;
    minU <== MIN_U_BNB() + (1 - isBuy) * (MIN_U_TOKEN() - MIN_U_BNB());

    component uBits = Num2Bits(32);
    uBits.in <== u;
    component uMin = GreaterEqThan(33);
    uMin.in[0] <== u;
    uMin.in[1] <== minU;
    uMin.out === 1;

    signal out0Amount;
    out0Amount <== u * unit;

    component out0Asset = Poseidon(3);
    out0Asset.inputs[0] <== INTENT_TAG();
    out0Asset.inputs[1] <== coin;
    out0Asset.inputs[2] <== dir;

    component out0Note = NoteCommitment();
    out0Note.amount <== out0Amount;
    out0Note.pubkey <== out0Pubkey;
    out0Note.assetId <== out0Asset.out;
    out0Note.rpt0 <== 0;
    out0Note.blinding <== out0Blinding;
    out0Note.commitment === outputCommitment[0];

    // ---- ElGamal ciphertext of u under the Coordinator key
    component enc = ElGamalEncrypt(32);
    enc.u <== u;
    enc.k <== k;
    enc.pk[0] <== ecPk[0];
    enc.pk[1] <== ecPk[1];
    enc.c1[0] === C1[0];
    enc.c1[1] === C1[1];
    enc.c2[0] === C2[0];
    enc.c2[1] === C2[1];

    // ---- balances
    signal buyAmount;
    buyAmount <== isBuy * out0Amount;
    sumBnbIn + sumOwed + publicAmount === sumBnbChg + buyAmount;
    sumCoinIn === sumCoinChg + out0Amount - buyAmount;

    // ---- no double-spend inside one transaction
    component sameNullifiers = IsEqual();
    sameNullifiers.in[0] <== inputNullifier[0];
    sameNullifiers.in[1] <== inputNullifier[1];
    sameNullifiers.out === 0;

    // ---- bind extData
    signal extDataSquare;
    extDataSquare <== extDataHash * extDataHash;
}

component main { public [root, publicAmount, coin, accRpt, dir, ecPk, C1, C2, extDataHash, inputNullifier, outputCommitment] } =
    Intent(23);
