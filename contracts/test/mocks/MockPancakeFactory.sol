// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {MockPancakePair} from "./MockPancakePair.sol";

/// @notice PancakeSwap V2 factory, trimmed: createPair / getPair / allPairs.
contract MockPancakeFactory {
    mapping(address => mapping(address => address)) public getPair;
    address[] public allPairs;

    event PairCreated(address indexed token0, address indexed token1, address pair, uint256);

    function allPairsLength() external view returns (uint256) {
        return allPairs.length;
    }

    function createPair(address tokenA, address tokenB) external returns (address pair) {
        require(tokenA != tokenB, "Pancake: IDENTICAL_ADDRESSES");
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(token0 != address(0), "Pancake: ZERO_ADDRESS");
        require(getPair[token0][token1] == address(0), "Pancake: PAIR_EXISTS");
        MockPancakePair p = new MockPancakePair();
        p.initialize(token0, token1);
        pair = address(p);
        getPair[token0][token1] = pair;
        getPair[token1][token0] = pair;
        allPairs.push(pair);
        emit PairCreated(token0, token1, pair, allPairs.length);
    }
}
