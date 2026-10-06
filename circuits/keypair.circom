pragma circom 2.1.0;
include "../node_modules/circomlib/circuits/poseidon.circom";

// pubKey = Poseidon(privKey)
template Keypair() {
    signal input privateKey;
    signal output publicKey;
    component h = Poseidon(1);
    h.inputs[0] <== privateKey;
    publicKey <== h.out;
}

// signature = Poseidon(privKey, commitment, merklePath) ; binds the nullifier to the key
template Signature() {
    signal input privateKey;
    signal input commitment;
    signal input merklePath;
    signal output out;
    component h = Poseidon(3);
    h.inputs[0] <== privateKey;
    h.inputs[1] <== commitment;
    h.inputs[2] <== merklePath;
    out <== h.out;
}
