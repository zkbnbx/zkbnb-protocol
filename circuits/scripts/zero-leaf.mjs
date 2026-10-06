import { keccak256, toUtf8Bytes } from "ethers";
const p = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const z = BigInt(keccak256(toUtf8Bytes("grove"))) % p;
console.log("zeroLeaf =", z.toString());
