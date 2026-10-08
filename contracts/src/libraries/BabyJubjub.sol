// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {GroveConstants as C} from "./GroveConstants.sol";

/// @title Baby Jubjub twisted-Edwards arithmetic (spec section 2.7)
/// @notice Extended coordinates (X, Y, T, Z) with X/Z = x, Y/Z = y, T/Z = x*y. Addition is the
///         unified "add-2008-hwcd" formula (complete for Baby Jubjub: a is a square, d is not), so
///         it also doubles and handles the identity. No inversion per add; `toAffine` does one
///         `modexp`. Internal library: inlined, no address of its own.
library BabyJubjub {
    uint256 private constant P = C.FIELD_SIZE;

    struct Point {
        uint256 x;
        uint256 y;
        uint256 t;
        uint256 z;
    }

    error NotOnCurve();

    /// @notice The neutral element (0, 1).
    function identity() internal pure returns (Point memory) {
        return Point(0, 1, 0, 1);
    }

    function isIdentity(Point memory p) internal pure returns (bool) {
        return p.x == 0 && p.z != 0 && p.y == p.z;
    }

    /// @notice `a*x^2 + y^2 == 1 + d*x^2*y^2` over the field, coordinates reduced.
    function isOnCurve(uint256 x, uint256 y) internal pure returns (bool) {
        if (x >= P || y >= P) return false;
        uint256 x2 = mulmod(x, x, P);
        uint256 y2 = mulmod(y, y, P);
        uint256 lhs = addmod(mulmod(C.BJJ_A, x2, P), y2, P);
        uint256 rhs = addmod(1, mulmod(C.BJJ_D, mulmod(x2, y2, P), P), P);
        return lhs == rhs;
    }

    /// @notice Lift an affine point. Reverts `NotOnCurve` for anything off the curve.
    function fromAffine(uint256 x, uint256 y) internal pure returns (Point memory) {
        if (!isOnCurve(x, y)) revert NotOnCurve();
        return Point(x, y, mulmod(x, y, P), 1);
    }

    /// @notice Generator `Base8` of the prime-order subgroup.
    function base8() internal pure returns (Point memory) {
        return Point(C.B8_X, C.B8_Y, mulmod(C.B8_X, C.B8_Y, P), 1);
    }

    /// @notice P + Q (unified: works for P == Q and for the identity).
    function add(Point memory p, Point memory q) internal pure returns (Point memory r) {
        uint256 a = mulmod(p.x, q.x, P);
        uint256 b = mulmod(p.y, q.y, P);
        uint256 c = mulmod(C.BJJ_D, mulmod(p.t, q.t, P), P);
        uint256 d = mulmod(p.z, q.z, P);
        uint256 e = addmod(mulmod(addmod(p.x, p.y, P), addmod(q.x, q.y, P), P), P - addmod(a, b, P), P);
        uint256 f = addmod(d, P - c, P);
        uint256 g = addmod(d, c, P);
        uint256 h = addmod(b, P - mulmod(C.BJJ_A, a, P), P);
        r.x = mulmod(e, f, P);
        r.y = mulmod(g, h, P);
        r.t = mulmod(e, h, P);
        r.z = mulmod(f, g, P);
    }

    /// @notice -P = (-x, y).
    function neg(Point memory p) internal pure returns (Point memory) {
        return Point(p.x == 0 ? 0 : P - p.x, p.y, p.t == 0 ? 0 : P - p.t, p.z);
    }

    /// @notice Double-and-add scalar multiplication (test / verification helper; on-chain only
    ///         sums are needed, the circuits do the multiplications).
    function mul(Point memory p, uint256 k) internal pure returns (Point memory r) {
        r = identity();
        Point memory acc = p;
        while (k != 0) {
            if (k & 1 == 1) r = add(r, acc);
            acc = add(acc, acc);
            k >>= 1;
        }
    }

    /// @notice Normalise to affine with one modular inverse (modexp precompile).
    function toAffine(Point memory p) internal view returns (uint256 x, uint256 y) {
        uint256 zInv = _inv(p.z);
        x = mulmod(p.x, zInv, P);
        y = mulmod(p.y, zInv, P);
    }

    /// @notice Equal iff the affine forms agree: X1*Z2 == X2*Z1 and Y1*Z2 == Y2*Z1.
    function eq(Point memory p, Point memory q) internal pure returns (bool) {
        return mulmod(p.x, q.z, P) == mulmod(q.x, p.z, P) && mulmod(p.y, q.z, P) == mulmod(q.y, p.z, P);
    }

    function _inv(uint256 a) private view returns (uint256 result) {
        require(a != 0, "BabyJubjub: inv(0)");
        bool ok;
        uint256 p = P;
        uint256 pm2 = P - 2;
        assembly ("memory-safe") {
            let m := mload(0x40)
            mstore(m, 0x20)
            mstore(add(m, 0x20), 0x20)
            mstore(add(m, 0x40), 0x20)
            mstore(add(m, 0x60), a)
            mstore(add(m, 0x80), pm2)
            mstore(add(m, 0xa0), p)
            ok := staticcall(gas(), 0x05, m, 0xc0, m, 0x20)
            result := mload(m)
        }
        require(ok, "BabyJubjub: modexp");
    }
}
