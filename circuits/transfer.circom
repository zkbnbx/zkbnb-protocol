pragma circom 2.1.0;
include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/comparators.circom";
include "../node_modules/circomlib/circuits/bitify.circom";
include "./keypair-v2.circom";
include "./merkleProof.circom";
include "./lib/constants.circom";
include "./lib/note.circom";

/*
 Stage-2 join-split (privacy/PRIVACY-SPEC.md section 3.1): 2 inputs, 3 outputs, BNB and at most one coin,
 dividend settlement on spent coin notes, folded handle claim.
 Public signals, in this order (frozen, WORKPLAN 1.2):
   root, publicAmount, coin, publicAmountCoin, accRpt, handle, claimAmount, extDataHash,
   inputNullifier[0], inputNullifier[1], outputCommitment[0], outputCommitment[1], outputCommitment[2]
*/
template Transfer(levels, nIns, nOuts) {
    // ---- public (declaration order = public signal order)
    signal input root;
    signal input publicAmount;
    signal input coin;
    signal input publicAmountCoin;
    signal input accRpt;
    signal input handle;
    signal input claimAmount;
    signal input extDataHash;
    signal input inputNullifier[nIns];
    signal input outputCommitment[nOuts];

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

    signal input outAsset[nOuts];
    signal input outAmount[nOuts];
    signal input outPubkey[nOuts];
    signal input outBlinding[nOuts];

    signal input handleAsk;
    signal input handleSalt;

    // ---- inputs
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

        // a zero-amount input (padding) need not exist in the tree
        inCheckRoot[i] = ForceEqualIfEnabled();
        inCheckRoot[i].in[0] <== root;
        inCheckRoot[i].in[1] <== inTree[i].root;
        inCheckRoot[i].enabled <== inAmount[i];

        // asset selector: BNB (0) or the public coin
        inAsset[i] * (inAsset[i] - coin) === 0;
        inAssetZero[i] = IsZero();
        inAssetZero[i].in <== inAsset[i];
        isCoin[i] <== 1 - inAssetZero[i].out;

        // dividends owed: floor(inAmount * (accRpt - rpt0) / 1e18)
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

    // ---- outputs
    component outNote[nOuts];
    component outAssetZero[nOuts];
    component outAmountBits[nOuts];
    signal isCoinOut[nOuts];
    signal outRpt0[nOuts];
    signal coinOut[nOuts];
    var sumBnbOut = 0;
    var sumCoinOut = 0;

    for (var j = 0; j < nOuts; j++) {
        outAsset[j] * (outAsset[j] - coin) === 0;
        outAssetZero[j] = IsZero();
        outAssetZero[j].in <== outAsset[j];
        isCoinOut[j] <== 1 - outAssetZero[j].out;
        outRpt0[j] <== isCoinOut[j] * accRpt;

        outNote[j] = NoteCommitment();
        outNote[j].amount <== outAmount[j];
        outNote[j].pubkey <== outPubkey[j];
        outNote[j].assetId <== outAsset[j];
        outNote[j].rpt0 <== outRpt0[j];
        outNote[j].blinding <== outBlinding[j];
        outNote[j].commitment === outputCommitment[j];

        outAmountBits[j] = Num2Bits(128);
        outAmountBits[j].in <== outAmount[j];

        coinOut[j] <== isCoinOut[j] * outAmount[j];
        sumBnbOut += outAmount[j] - coinOut[j];
        sumCoinOut += coinOut[j];
    }

    // ---- handle claim (handle == 0: no claim, claimAmount must be 0)
    component ovk = OwnerKey();
    ovk.privateKey <== handleAsk;
    component handleHash = Poseidon(3);
    handleHash.inputs[0] <== HANDLE_TAG();
    handleHash.inputs[1] <== ovk.ovk;
    handleHash.inputs[2] <== handleSalt;
    component handleCheck = ForceEqualIfEnabled();
    handleCheck.in[0] <== handle;
    handleCheck.in[1] <== handleHash.out;
    handleCheck.enabled <== handle;
    component handleZero = IsZero();
    handleZero.in <== handle;
    handleZero.out * claimAmount === 0;
    component claimBits = Num2Bits(128);
    claimBits.in <== claimAmount;

    // ---- balances (mod p; publicAmount already contains claimAmount, contract side)
    sumBnbIn + sumOwed + publicAmount === sumBnbOut;
    sumCoinIn + publicAmountCoin === sumCoinOut;

    // ---- no double-spend inside one transaction
    component sameNullifiers[nIns * (nIns - 1) / 2];
    var index = 0;
    for (var i = 0; i < nIns - 1; i++) {
        for (var j = i + 1; j < nIns; j++) {
            sameNullifiers[index] = IsEqual();
            sameNullifiers[index].in[0] <== inputNullifier[i];
            sameNullifiers[index].in[1] <== inputNullifier[j];
            sameNullifiers[index].out === 0;
            index++;
        }
    }

    // ---- bind extData
    signal extDataSquare;
    extDataSquare <== extDataHash * extDataHash;
}

component main { public [root, publicAmount, coin, publicAmountCoin, accRpt, handle, claimAmount, extDataHash, inputNullifier, outputCommitment] } =
    Transfer(23, 2, 3);
