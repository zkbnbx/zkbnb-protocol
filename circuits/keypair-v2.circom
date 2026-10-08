pragma circom 2.1.0;
include "./keypair.circom";
include "./lib/constants.circom";

// Stage 2 key templates (privacy/PRIVACY-SPEC.md §2.2). Kept out of keypair.circom so the deployed v1
// circuit (transaction.circom) keeps reproducing the deployed Groth16Verifier from committed source.

// nk = Poseidon(ask, 1) — nullifier key: recognises spends without the spending key
template NullifierKey() {
    signal input privateKey;
    signal output nk;
    component h = Poseidon(2);
    h.inputs[0] <== privateKey;
    h.inputs[1] <== 1;
    nk <== h.out;
}

// ovk = Poseidon(OWNER_TAG, ask) — owner key behind handles (the only definition of ovk)
template OwnerKey() {
    signal input privateKey;
    signal output ovk;
    component h = Poseidon(2);
    h.inputs[0] <== OWNER_TAG();
    h.inputs[1] <== privateKey;
    ovk <== h.out;
}
