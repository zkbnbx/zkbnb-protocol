pragma circom 2.1.0;
include "../node_modules/circomlib/circuits/bitify.circom";
include "../node_modules/circomlib/circuits/babyjub.circom";
include "../node_modules/circomlib/circuits/escalarmulfix.circom";
include "../node_modules/circomlib/circuits/escalarmulany.circom";
include "./constants.circom";

/*
 Exponential ElGamal on Baby Jubjub (spec §2.7):
   C1 = k·B8,  C2 = u·B8 + k·pk        k < 2^251 (subgroup scalar), u < 2^uBits
 Sums of ciphertexts encrypt sums of u; the Coordinator solves the discrete log of the SUM only.
*/
template ElGamalEncrypt(uBits) {
    signal input u;
    signal input k;
    signal input pk[2];
    signal output c1[2];
    signal output c2[2];

    var BASE8[2] = [BASE8_X(), BASE8_Y()];

    component pkCheck = BabyCheck();
    pkCheck.x <== pk[0];
    pkCheck.y <== pk[1];

    component kBits = Num2Bits(251);
    kBits.in <== k;

    component uBitsC = Num2Bits(uBits);
    uBitsC.in <== u;

    // C1 = k·B8
    component c1Mul = EscalarMulFix(251, BASE8);
    for (var i = 0; i < 251; i++) c1Mul.e[i] <== kBits.out[i];
    c1[0] <== c1Mul.out[0];
    c1[1] <== c1Mul.out[1];

    // u·B8
    component uMul = EscalarMulFix(uBits, BASE8);
    for (var i = 0; i < uBits; i++) uMul.e[i] <== uBitsC.out[i];

    // k·pk
    component kP = EscalarMulAny(251);
    for (var i = 0; i < 251; i++) kP.e[i] <== kBits.out[i];
    kP.p[0] <== pk[0];
    kP.p[1] <== pk[1];

    component add = BabyAdd();
    add.x1 <== uMul.out[0];
    add.y1 <== uMul.out[1];
    add.x2 <== kP.out[0];
    add.y2 <== kP.out[1];
    c2[0] <== add.xout;
    c2[1] <== add.yout;
}

/*
 Proves that (c1, c2) decrypts to u under sk, and that pk = sk·B8:
   D = sk·C1,  M = C2 − D,  M == u·B8
*/
template ElGamalDecryptCheck(uBits) {
    signal input sk;
    signal input pk[2];
    signal input c1[2];
    signal input c2[2];
    signal input u;

    var BASE8[2] = [BASE8_X(), BASE8_Y()];

    component skBits = Num2Bits(251);
    skBits.in <== sk;

    component pkMul = EscalarMulFix(251, BASE8);
    for (var i = 0; i < 251; i++) pkMul.e[i] <== skBits.out[i];
    pkMul.out[0] === pk[0];
    pkMul.out[1] === pk[1];

    component c1Check = BabyCheck();
    c1Check.x <== c1[0];
    c1Check.y <== c1[1];
    component c2Check = BabyCheck();
    c2Check.x <== c2[0];
    c2Check.y <== c2[1];

    component d = EscalarMulAny(251);
    for (var i = 0; i < 251; i++) d.e[i] <== skBits.out[i];
    d.p[0] <== c1[0];
    d.p[1] <== c1[1];

    // M = C2 + (−D), −(x, y) = (−x, y)
    component m = BabyAdd();
    m.x1 <== c2[0];
    m.y1 <== c2[1];
    m.x2 <== -d.out[0];
    m.y2 <== d.out[1];

    component uBitsC = Num2Bits(uBits);
    uBitsC.in <== u;
    component uMul = EscalarMulFix(uBits, BASE8);
    for (var i = 0; i < uBits; i++) uMul.e[i] <== uBitsC.out[i];

    m.xout === uMul.out[0];
    m.yout === uMul.out[1];
}
