pragma circom 2.1.0;
include "./lib/elgamal.circom";

/*
 Coordinator proof (privacy/PRIVACY-SPEC.md section 3.4): the summed ciphertext (C1, C2) of one epoch
 direction decrypts to u under ecSk, and ecPk = ecSk * B8.   Sum of u < 2^40 (256 intents x 2^32).
 minOut is bound, not checked: the coordinator's slippage floor for this direction becomes part of the proof, so a
 copied openEpoch cannot be replayed with a lower minOut and sandwiched (review N2).
 Public signals, in this order: ecPk[0], ecPk[1], C1[0], C1[1], C2[0], C2[1], u, minOut
*/
template EpochOpen() {
    signal input ecPk[2];
    signal input C1[2];
    signal input C2[2];
    signal input u;
    signal input minOut;
    signal input ecSk;

    component d = ElGamalDecryptCheck(40);
    d.sk <== ecSk;
    d.pk[0] <== ecPk[0];
    d.pk[1] <== ecPk[1];
    d.c1[0] <== C1[0];
    d.c1[1] <== C1[1];
    d.c2[0] <== C2[0];
    d.c2[1] <== C2[1];
    d.u <== u;

    // bind minOut into the proof (a public input with no constraint can be optimised away by some toolchains)
    signal minOutSq;
    minOutSq <== minOut * minOut;
}

component main { public [ecPk, C1, C2, u, minOut] } = EpochOpen();
