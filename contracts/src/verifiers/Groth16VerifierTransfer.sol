// SPDX-License-Identifier: GPL-3.0
// DEV KEY, never deploy to chain 56. Exported by circuits/scripts/setup-v2.sh from build/transfer.zkey
// (transfer.circom, circom2 0.2.23, --O2). The phase-2 ceremony (circuits/CEREMONY-v2.md) replaces this file.
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

contract Groth16VerifierTransfer {
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
    uint256 constant deltax1 = 20554491339347412852909692684018752805856969950290825834809042522901334508507;
    uint256 constant deltax2 = 9709042300293635740671664306901183060679075982614201871197722623404695924662;
    uint256 constant deltay1 = 20350483584998250811601850133322395919628060375625132204145410774020074297521;
    uint256 constant deltay2 = 7074838969799044393652036638224348879982860139921539630402709866240765594953;

    
    uint256 constant IC0x = 17566232461200276433857830673875741959873748545180929496963821909501387186265;
    uint256 constant IC0y = 13353927345004905854005230256171251282927006203663794894390347902988616386279;
    
    uint256 constant IC1x = 20263242132760114886462591218298905289656231177916135061390191736244969851006;
    uint256 constant IC1y = 3647857768486205747980703883831818335072348604224111589967044602064341701143;
    
    uint256 constant IC2x = 16352607081306339075159450053206230914396813000006834581498457469339267454030;
    uint256 constant IC2y = 16094617085252851668600798454116449223906669416508290346662979130006723979291;
    
    uint256 constant IC3x = 21332962983712457661098789033475832776783392153093171918170568589469219114393;
    uint256 constant IC3y = 21886518588460968588143398163588069689523243809640614305645249112546400026165;
    
    uint256 constant IC4x = 14338854939124114461264645829514539784203760613546497956228472732573987764367;
    uint256 constant IC4y = 6563999367273645587511297523423193510447499001801785545292454431867903543987;
    
    uint256 constant IC5x = 3354882182661288631477969376869803486680594325947329408508720064359235257099;
    uint256 constant IC5y = 2287412614930365095592890610308968345793763994514566567890519189545656044773;
    
    uint256 constant IC6x = 3715505935431488678561071884988328979556065499930923588452375455195035309530;
    uint256 constant IC6y = 2206194901522558979333798619677897638789944872904167810703034995350743561973;
    
    uint256 constant IC7x = 1647140963179606785907610964807769110631775489303638489880875475790630379370;
    uint256 constant IC7y = 20054745087140130974299324742967812528703404398566674100802202252287621261873;
    
    uint256 constant IC8x = 20375022668587270524609032762821133980535317578642394583758148822231239073296;
    uint256 constant IC8y = 5493837029027522823193439581519247506923554383658464792001356776336647237723;
    
    uint256 constant IC9x = 5084989029965894781410129411065910359067197721723823685977384508360261160801;
    uint256 constant IC9y = 972304514925341283860934545206842147471392475663390846557268254142139931908;
    
    uint256 constant IC10x = 11096634232017020170587184684284638439618165145196647780695496075872464205328;
    uint256 constant IC10y = 2940767732153539574202173945280859924491503460800837553970268823415477093248;
    
    uint256 constant IC11x = 11610711338827357787396004054525726563782990611283597050729932394742919902712;
    uint256 constant IC11y = 7087755000046560697348002621423735246214356596414526682519430768619664925184;
    
    uint256 constant IC12x = 13450294919222997297268395237509047835840138011220851008451280657337215996121;
    uint256 constant IC12y = 20499762219941002054795084490237854378200961982717468834930140179146837468574;
    
    uint256 constant IC13x = 1754890390009233806142688722978859860049034292727582810567803622999845607649;
    uint256 constant IC13y = 4921861246046554415967833305376090621442990808570001632382927000143790127440;
    
 
    // Memory data
    uint16 constant pVk = 0;
    uint16 constant pPairing = 128;

    uint16 constant pLastMem = 896;

    function verifyProof(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[13] calldata _pubSignals) public view returns (bool) {
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
            

            // Validate all evaluations
            let isValid := checkPairing(_pA, _pB, _pC, _pubSignals, pMem)

            mstore(0, isValid)
             return(0, 0x20)
         }
     }
 }
