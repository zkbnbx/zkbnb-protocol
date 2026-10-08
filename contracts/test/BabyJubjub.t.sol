// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {BabyJubjub as B} from "../src/libraries/BabyJubjub.sol";
import {GroveConstants as C} from "../src/libraries/GroveConstants.sol";

/// @dev Thin wrapper so the internal library can be exercised (and its gas measured) from tests.
contract BjjHarness {
    function add(B.Point memory p, B.Point memory q) external pure returns (B.Point memory) {
        return B.add(p, q);
    }

    function addGas(B.Point memory p, B.Point memory q) external view returns (uint256 gasUsed) {
        uint256 g = gasleft();
        B.Point memory r = B.add(p, q);
        gasUsed = g - gasleft();
        require(r.z != 0);
    }

    function mul(B.Point memory p, uint256 k) external pure returns (B.Point memory) {
        return B.mul(p, k);
    }

    function toAffine(B.Point memory p) external view returns (uint256, uint256) {
        return B.toAffine(p);
    }

    function fromAffine(uint256 x, uint256 y) external pure returns (B.Point memory) {
        return B.fromAffine(x, y);
    }
}

/// Vectors: circomlibjs `buildBabyjub()` (circuits/node_modules), see the WP-contracts report.
contract BabyJubjubTest is Test {
    using stdJson for string;
    BjjHarness h;

    // circomlib Generator (Base8 = 8 * Generator)
    uint256 constant GX = 995203441582195749578291179787384436505546430278305826713579947235728471134;
    uint256 constant GY = 5472060717959818805561601436314318772137091100104008585924551046643952123905;

    function setUp() public {
        h = new BjjHarness();
    }

    function _aff(B.Point memory p) internal view returns (uint256 x, uint256 y) {
        return h.toAffine(p);
    }

    function _assertAffine(B.Point memory p, uint256 x, uint256 y) internal view {
        (uint256 ax, uint256 ay) = _aff(p);
        assertEq(ax, x, "x");
        assertEq(ay, y, "y");
    }

    function test_constants_areOnCurve() public pure {
        assertTrue(B.isOnCurve(C.B8_X, C.B8_Y));
        assertTrue(B.isOnCurve(GX, GY));
        assertTrue(B.isOnCurve(0, 1));
        assertFalse(B.isOnCurve(1, 1));
        assertFalse(B.isOnCurve(C.FIELD_SIZE, 1));
    }

    function test_fromAffine_rejectsOffCurve() public {
        vm.expectRevert(B.NotOnCurve.selector);
        h.fromAffine(3, 4);
    }

    function test_identity() public view {
        B.Point memory id = B.identity();
        B.Point memory b8 = B.base8();
        assertTrue(B.eq(h.add(id, b8), b8));
        assertTrue(B.eq(h.add(b8, id), b8));
        assertTrue(B.isIdentity(h.add(id, id)));
        _assertAffine(h.add(id, id), 0, 1);
    }

    function test_base8_is_8G() public view {
        B.Point memory g = B.fromAffine(GX, GY);
        B.Point memory g2 = h.add(g, g);
        B.Point memory g4 = h.add(g2, g2);
        B.Point memory g8 = h.add(g4, g4);
        _assertAffine(g8, C.B8_X, C.B8_Y);
    }

    function test_base8_doublings() public view {
        B.Point memory b8 = B.base8();
        B.Point memory p2 = h.add(b8, b8);
        _assertAffine(
            p2,
            10031262171927540148667355526369034398030886437092045105752248699557385197826,
            633281375905621697187330766174974863687049529291089048651929454608812697683
        );
        B.Point memory p3 = h.add(p2, b8);
        _assertAffine(
            p3,
            2763488322167937039616325905516046217694264098671987087929565332380420898366,
            15305195750036305661220525648961313310481046260814497672243197092298550508693
        );
        B.Point memory p4 = h.add(p2, p2);
        _assertAffine(
            p4,
            12252886604826192316928789929706397349846234911198931249025449955069330867144,
            1286140751908834028607023759717162073146610688084909004843365841635476459484
        );
        // 2*B8 + 3*B8 == 5*B8
        _assertAffine(
            h.add(p2, p3),
            11480966271046430430613841218147196773252373073876138147006741179837832100836,
            15148236048131954717802795400425086368006776860859772698778589175317365693546
        );
        B.Point memory p16 = h.add(h.add(p4, p4), h.add(p4, p4));
        _assertAffine(
            p16,
            20535751008137662458650892643857854177364093782887716696778361156345824450120,
            21459189231378695508316163458360356529222201254620325044724979975334648070151
        );
    }

    function test_mul_vectors() public view {
        B.Point memory b8 = B.base8();
        _assertAffine(
            h.mul(b8, 7),
            20092560661213339045022877747484245238324772779820628739268223482659246842641,
            12112450042127193446189577552007703839818242727902437791835414514847797088033
        );
        _assertAffine(
            h.mul(b8, 1000),
            20366147795936572600700348767835863189204735700033902769792878907543918679364,
            17979751125406099319734770781608767238997398840154679652223692501113096137972
        );
        _assertAffine(
            h.mul(b8, 2 ** 32),
            13924641157502813998759594372437865478825281838225516826720234568502723756325,
            5909344824063165275624417723557917583356454568781175462442470854960225156713
        );
        _assertAffine(
            h.mul(b8, 2 ** 40 - 1),
            3748089374283495509753728063264604741411325491812882691617293652400752480258,
            3032498952301215585837952703045124056321905832967578116595992323817134462852
        );
    }

    function test_subgroupOrder_killsBase8() public view {
        B.Point memory r = h.mul(B.base8(), C.BJJ_ORDER);
        assertTrue(B.isIdentity(r));
        _assertAffine(r, 0, 1);
    }

    function test_add_commutative_and_neg(uint64 a, uint64 b) public view {
        B.Point memory pa = h.mul(B.base8(), a);
        B.Point memory pb = h.mul(B.base8(), b);
        assertTrue(B.eq(h.add(pa, pb), h.add(pb, pa)));
        assertTrue(B.isIdentity(h.add(pa, B.neg(pa))));
        // a*B8 + b*B8 == (a+b)*B8
        assertTrue(B.eq(h.add(pa, pb), h.mul(B.base8(), uint256(a) + b)));
    }

    /// ElGamal sample: sk = 12345, k = 777, u = 42; C2 - sk*C1 == u*B8 (what epochOpen proves).
    function test_elgamal_decrypt_identity() public view {
        B.Point memory b8 = B.base8();
        B.Point memory pk = h.mul(b8, 12345);
        _assertAffine(
            pk,
            19099552327547260981542886231210125691902505931204088720746463491300185142606,
            13276557205153692030187527501273228448057533426731746626187331221465573305487
        );
        B.Point memory c1 = h.mul(b8, 777);
        B.Point memory c2 = h.add(h.mul(b8, 42), h.mul(pk, 777));
        _assertAffine(
            c1,
            217476294010559655474040123123864250986937627406569959292555244856075336972,
            14718121333325348880045148294993430540449838867226383861510005729284703849978
        );
        _assertAffine(
            c2,
            17791953167392434656772109652901819037306204973986026532576412785907028206435,
            4423798622031997501441993334563419424434733908929702572029546239844479240216
        );
        B.Point memory m = h.add(c2, B.neg(h.mul(c1, 12345)));
        assertTrue(B.eq(m, h.mul(b8, 42)));
    }

    /// Fixture: elgamal_vectors.json (WP section 1.3) from WP-circuits. Sums are stored affine; the
    /// contract path keeps extended coordinates and normalises with toAffine before comparing.
    function test_fixture_elgamalVectors() public {
        string memory json;
        try vm.readFile("test/fixtures/v2/elgamal_vectors.json") returns (string memory j) {
            json = j;
        } catch {
            vm.skip(true);
            return;
        }
        uint256 sk = json.readUint(".coordinator.ecSk");
        uint256[] memory pk = json.readUintArray(".coordinator.ecPk");
        _assertAffine(h.mul(B.base8(), sk), pk[0], pk[1]);

        B.Point memory s1 = B.identity();
        B.Point memory s2 = B.identity();
        uint256 uSum;
        uint256 n;
        for (uint256 i;; i++) {
            string memory key = string.concat(".encryptions[", vm.toString(i), "]");
            if (!vm.keyExistsJson(json, string.concat(key, ".u"))) break;
            uint256[] memory c1 = json.readUintArray(string.concat(key, ".c1"));
            uint256[] memory c2 = json.readUintArray(string.concat(key, ".c2"));
            uint256 u = json.readUint(string.concat(key, ".u"));
            uint256 k = json.readUint(string.concat(key, ".k"));
            // each ciphertext is k*B8, u*B8 + k*pk
            _assertAffine(h.mul(B.base8(), k), c1[0], c1[1]);
            _assertAffine(h.add(h.mul(B.base8(), u), h.mul(B.fromAffine(pk[0], pk[1]), k)), c2[0], c2[1]);
            s1 = h.add(s1, B.fromAffine(c1[0], c1[1]));
            s2 = h.add(s2, B.fromAffine(c2[0], c2[1]));
            uSum += u;
            n++;
            if (n == 3) {
                uint256[] memory f1 = json.readUintArray(".sum_first3.c1");
                uint256[] memory f2 = json.readUintArray(".sum_first3.c2");
                _assertAffine(s1, f1[0], f1[1]);
                _assertAffine(s2, f2[0], f2[1]);
                assertEq(uSum, json.readUint(".sum_first3.u"));
            }
        }
        assertGt(n, 3);
        uint256[] memory a1 = json.readUintArray(".sum_all.c1");
        uint256[] memory a2 = json.readUintArray(".sum_all.c2");
        _assertAffine(s1, a1[0], a1[1]);
        _assertAffine(s2, a2[0], a2[1]);
        assertEq(uSum, json.readUint(".sum_all.u"));
        // decryption of the SUM: C2 - sk*C1 == (sum u)*B8 == decryptedPoint
        B.Point memory m = h.add(s2, B.neg(h.mul(s1, sk)));
        uint256[] memory dp = json.readUintArray(".sum_all.decryptedPoint");
        _assertAffine(m, dp[0], dp[1]);
        assertTrue(B.eq(m, h.mul(B.base8(), uSum)));
    }

    function test_gas_oneAdd() public view {
        uint256 g = h.addGas(B.base8(), h.mul(B.base8(), 3));
        console2.log("BabyJubjub.add gas", g);
        assertLt(g, 3000);
    }
}
