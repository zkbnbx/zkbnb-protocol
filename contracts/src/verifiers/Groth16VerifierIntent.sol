// SPDX-License-Identifier: GPL-3.0
// DEV KEY, never deploy to chain 56. Exported by circuits/scripts/setup-v2.sh from build/intent.zkey
// (intent.circom, circom2 0.2.23, --O2). The phase-2 ceremony (circuits/CEREMONY-v2.md) replaces this file.
/*
    Copyright 2021 0KIMS association.

    This file is generated with [snarkJS](https://github.com/iden3/snarkjs).

    snarkJS is a free software: you can redistribute it and/or modify it
    under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    snarkJS is distributed in the hope that it will be useful, but WITHOUT
    ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
    or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public
    License for more details.

    You should have received a copy of the GNU General Public License
    along with snarkJS. If not, see <https://www.gnu.org/licenses/>.
*/

pragma solidity >=0.7.0 <0.9.0;

contract Groth16VerifierIntent {
    // Scalar field size
    uint256 constant r    = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    // Base field size
    uint256 constant q   = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    // Verification Key data
    uint256 constant alphax  = 20491192805390485299153009773594534940189261866228447918068658471970481763042;
    uint256 constant alphay  = 9383485363053290200918347156157836566562967994039712273449902621266178545958;
    uint256 constant betax1  = 4252822878758300859123897981450591353533073413197771768651442665752259397132;
    uint256 constant betax2  = 6375614351688725206403948262868962793625744043794305715222011528459656738731;
    uint256 constant betay1  = 21847035105528745403288232691147584728191162732299865338377159692350059136679;
    uint256 constant betay2  = 10505242626370262277552901082094356697409835680220590971873171140371331206856;
    uint256 constant gammax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant gammax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant gammay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant gammay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;
    uint256 constant deltax1 = 17013947686072848676402475699999309241809167487001355091802231944835067387905;
    uint256 constant deltax2 = 7284690202598325409418865662440699472124202928274880462929716877824020992052;
    uint256 constant deltay1 = 3404555161190855701036767532568784547946550341808672431568764082454214791736;
    uint256 constant deltay2 = 4788126388147228783014624272037440623453840232438237379166438495791662576727;

    
    uint256 constant IC0x = 2822341017925715699026912586486625854484774610347832336045556422928955965918;
    uint256 constant IC0y = 21827285439048260011691695714087469908909246760484090402158311288087861319943;
    
    uint256 constant IC1x = 18257888383031459360113067760850025867282880255104879725786223970127931725507;
    uint256 constant IC1y = 7066181285910342448654263866265783936680448641704099205772185026691461302297;
    
    uint256 constant IC2x = 12163420429318212251532151519594816114293238876051886602074210230759920033865;
    uint256 constant IC2y = 17140146341181806134980717786881416377913791071082327439439429802599861148365;
    
    uint256 constant IC3x = 5916219191700906515697846731536659708075363730446540406381939210728573104275;
    uint256 constant IC3y = 6630576608710781042702871119935846401807611553446035556529673782206369088557;
    
    uint256 constant IC4x = 3984171185280763220952009903885436769459035192623786244187963219556855185801;
    uint256 constant IC4y = 12416818621711852964083396910526656902558667051716355700147977732056087516981;
    
    uint256 constant IC5x = 460164627055156247109667289994892435044466998757240421916855788543173724623;
    uint256 constant IC5y = 14153640790912018304928558122508286409716819906109702949092827406536170329627;
    
    uint256 constant IC6x = 16553721576561262819405438582736976168091303369861711140160226187728581701875;
    uint256 constant IC6y = 10404425926560802534210414693625578487607681018852730450392444843929724767505;
    
    uint256 constant IC7x = 11673877387352980502827155500984252840441871373132304561844332333271857910451;
    uint256 constant IC7y = 17185159769215845820979592603295672108307244774320185205366750372073433576507;
    
    uint256 constant IC8x = 6177702687736346892010527625651638826028601885368809667237971974643341343860;
    uint256 constant IC8y = 16215175712462186315951033892804642326522470449894481430995217378368527243025;
    
    uint256 constant IC9x = 15237017544475469132189786598546149501939419628812902550717347378482626101873;
    uint256 constant IC9y = 16549598056567801993507192364382169586003677745722498602042282425488241032602;
    
    uint256 constant IC10x = 2119744261412421152476687390692550114684525818558352045096817440836685889798;
    uint256 constant IC10y = 283383001644295249215316392063793053198559620624015451837533895859683544813;
    
    uint256 constant IC11x = 15230284418802306316773513543757232038786611184638050765417483714762272091753;
    uint256 constant IC11y = 2492320298051468053669554146606551421784427791322584342309746033997779426616;
    
    uint256 constant IC12x = 14180411755089991615587129068146443793562249162071502993515916558870900991795;
    uint256 constant IC12y = 2859345195945264407079477816847876292525750731009632394327552890456452419821;
    
    uint256 constant IC13x = 13769747897520285148556548608207835820346666636869248778331782231795666684454;
    uint256 constant IC13y = 13234015463742749140352067470015840910311312237191120436229140090230088765685;
    
    uint256 constant IC14x = 11327379987507875160755564846201742420031665906042297638343076779259777234230;
    uint256 constant IC14y = 6378774366023678483309089132298846630658003319721356220155712889212472640510;
    
    uint256 constant IC15x = 3189444052062498777235309874049554056491915711398931877073047221869542332;
    uint256 constant IC15y = 8969270051964731365868975507749334547057396137982954003624876154803568294884;
    
    uint256 constant IC16x = 11768386162624736702849860815318592183463647157428610221018895923664374380432;
    uint256 constant IC16y = 2059660622060460784309843218384026016534530944547848648448955674865828416000;
    
    uint256 constant IC17x = 11437954359256306615103880965315568006720831771868704579156311661189211166229;
    uint256 constant IC17y = 4560652451012273698863257886332113044779556279395672999506888387137029270730;
    
 
    // Memory data
    uint16 constant pVk = 0;
    uint16 constant pPairing = 128;

    uint16 constant pLastMem = 896;

    function verifyProof(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[17] calldata _pubSignals) public view returns (bool) {
        assembly {
            function checkField(v) {
                if iszero(lt(v, r)) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }
            
            // G1 function to multiply a G1 value(x,y) to value in an address
            function g1_mulAccC(pR, x, y, s) {
                let success
                let mIn := mload(0x40)
                mstore(mIn, x)
                mstore(add(mIn, 32), y)
                mstore(add(mIn, 64), s)

                success := staticcall(sub(gas(), 2000), 7, mIn, 96, mIn, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }

                mstore(add(mIn, 64), mload(pR))
                mstore(add(mIn, 96), mload(add(pR, 32)))

                success := staticcall(sub(gas(), 2000), 6, mIn, 128, pR, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }

            function checkPairing(pA, pB, pC, pubSignals, pMem) -> isOk {
                let _pPairing := add(pMem, pPairing)
                let _pVk := add(pMem, pVk)

                mstore(_pVk, IC0x)
                mstore(add(_pVk, 32), IC0y)

                // Compute the linear combination vk_x
                
                g1_mulAccC(_pVk, IC1x, IC1y, calldataload(add(pubSignals, 0)))
                
                g1_mulAccC(_pVk, IC2x, IC2y, calldataload(add(pubSignals, 32)))
                
                g1_mulAccC(_pVk, IC3x, IC3y, calldataload(add(pubSignals, 64)))
                
                g1_mulAccC(_pVk, IC4x, IC4y, calldataload(add(pubSignals, 96)))
                
                g1_mulAccC(_pVk, IC5x, IC5y, calldataload(add(pubSignals, 128)))
                
                g1_mulAccC(_pVk, IC6x, IC6y, calldataload(add(pubSignals, 160)))
                
                g1_mulAccC(_pVk, IC7x, IC7y, calldataload(add(pubSignals, 192)))
                
                g1_mulAccC(_pVk, IC8x, IC8y, calldataload(add(pubSignals, 224)))
                
                g1_mulAccC(_pVk, IC9x, IC9y, calldataload(add(pubSignals, 256)))
                
                g1_mulAccC(_pVk, IC10x, IC10y, calldataload(add(pubSignals, 288)))
                
                g1_mulAccC(_pVk, IC11x, IC11y, calldataload(add(pubSignals, 320)))
                
                g1_mulAccC(_pVk, IC12x, IC12y, calldataload(add(pubSignals, 352)))
                
                g1_mulAccC(_pVk, IC13x, IC13y, calldataload(add(pubSignals, 384)))
                
                g1_mulAccC(_pVk, IC14x, IC14y, calldataload(add(pubSignals, 416)))
                
                g1_mulAccC(_pVk, IC15x, IC15y, calldataload(add(pubSignals, 448)))
                
                g1_mulAccC(_pVk, IC16x, IC16y, calldataload(add(pubSignals, 480)))
                
                g1_mulAccC(_pVk, IC17x, IC17y, calldataload(add(pubSignals, 512)))
                

                // -A
                mstore(_pPairing, calldataload(pA))
                mstore(add(_pPairing, 32), mod(sub(q, calldataload(add(pA, 32))), q))

                // B
                mstore(add(_pPairing, 64), calldataload(pB))
                mstore(add(_pPairing, 96), calldataload(add(pB, 32)))
                mstore(add(_pPairing, 128), calldataload(add(pB, 64)))
                mstore(add(_pPairing, 160), calldataload(add(pB, 96)))

                // alpha1
                mstore(add(_pPairing, 192), alphax)
                mstore(add(_pPairing, 224), alphay)

                // beta2
                mstore(add(_pPairing, 256), betax1)
                mstore(add(_pPairing, 288), betax2)
                mstore(add(_pPairing, 320), betay1)
                mstore(add(_pPairing, 352), betay2)

                // vk_x
                mstore(add(_pPairing, 384), mload(add(pMem, pVk)))
                mstore(add(_pPairing, 416), mload(add(pMem, add(pVk, 32))))


                // gamma2
                mstore(add(_pPairing, 448), gammax1)
                mstore(add(_pPairing, 480), gammax2)
                mstore(add(_pPairing, 512), gammay1)
                mstore(add(_pPairing, 544), gammay2)

                // C
                mstore(add(_pPairing, 576), calldataload(pC))
                mstore(add(_pPairing, 608), calldataload(add(pC, 32)))

                // delta2
                mstore(add(_pPairing, 640), deltax1)
                mstore(add(_pPairing, 672), deltax2)
                mstore(add(_pPairing, 704), deltay1)
                mstore(add(_pPairing, 736), deltay2)


                let success := staticcall(sub(gas(), 2000), 8, _pPairing, 768, _pPairing, 0x20)

                isOk := and(success, mload(_pPairing))
            }

            let pMem := mload(0x40)
            mstore(0x40, add(pMem, pLastMem))

            // Validate that all evaluations ∈ F
            
            checkField(calldataload(add(_pubSignals, 0)))
            
            checkField(calldataload(add(_pubSignals, 32)))
            
            checkField(calldataload(add(_pubSignals, 64)))
            
            checkField(calldataload(add(_pubSignals, 96)))
            
            checkField(calldataload(add(_pubSignals, 128)))
            
            checkField(calldataload(add(_pubSignals, 160)))
            
            checkField(calldataload(add(_pubSignals, 192)))
            
            checkField(calldataload(add(_pubSignals, 224)))
            
            checkField(calldataload(add(_pubSignals, 256)))
            
            checkField(calldataload(add(_pubSignals, 288)))
            
            checkField(calldataload(add(_pubSignals, 320)))
            
            checkField(calldataload(add(_pubSignals, 352)))
            
            checkField(calldataload(add(_pubSignals, 384)))
            
            checkField(calldataload(add(_pubSignals, 416)))
            
            checkField(calldataload(add(_pubSignals, 448)))
            
            checkField(calldataload(add(_pubSignals, 480)))
            
            checkField(calldataload(add(_pubSignals, 512)))
            

            // Validate all evaluations
            let isValid := checkPairing(_pA, _pB, _pC, _pubSignals, pMem)

            mstore(0, isValid)
             return(0, 0x20)
         }
     }
 }
