import {parseAbi,keccak256,stringToHex} from 'viem';

export const eligibilityTuple='(bytes32 accountCommitment,address challenger,address holder,uint32 scope,uint256 mask,bool wrapped,uint256 nonce,uint64 deadline)';
export const holderResolverAbi=parseAbi([
  `function dispute(uint8,uint8,bytes32,string,${eligibilityTuple},bytes)`,
  'function eligibilitySigner() view returns (address)',
  'function usedEligibility(uint256) view returns (bool)',
  'function hasQualifyingShares(address,uint8,uint32,uint256,bool) view returns (bool)',
]);
export const eligibilityTypes={Eligibility:[
  {name:'accountCommitment',type:'bytes32'},{name:'challenger',type:'address'},{name:'holder',type:'address'},
  {name:'scope',type:'uint32'},{name:'mask',type:'uint256'},{name:'wrapped',type:'bool'},
  {name:'nonce',type:'uint256'},{name:'deadline',type:'uint64'},
  {name:'eventIndex',type:'uint8'},{name:'alternative',type:'uint8'},
  {name:'evidenceHash',type:'bytes32'},{name:'evidenceURIHash',type:'bytes32'},
]};
export function eligibilityTypedData(resolver,input,e){return {
  domain:{name:'Flurbo account challenges',version:'1',chainId:10143,verifyingContract:resolver},
  types:eligibilityTypes,primaryType:'Eligibility',message:{...e,mask:BigInt(e.mask),nonce:BigInt(e.nonce),deadline:BigInt(e.deadline),
    eventIndex:input.event,alternative:input.outcome,evidenceHash:input.evidenceHash,evidenceURIHash:keccak256(stringToHex(input.evidenceURI))},
};}
export function dependsOnEvent(scope,mask,event,count){
  if(!Number.isInteger(scope)||scope<=0||scope>=2**count||!Number.isInteger(event)||event<0||event>=count||!(scope&2**event))return false;
  const width=scope.toString(2).replaceAll('0','').length;
  if(width>3||typeof mask!=='bigint'||mask<=0n||mask>=(1n<<BigInt(2**width))-1n)return false;
  const local=2**((scope&(2**event-1)).toString(2).replaceAll('0','').length);
  for(let i=0;i<2**width;i++)if(((mask>>BigInt(i))&1n)!==((mask>>BigInt(i^local))&1n))return true;
  return false;
}
export function challengeCandidates(wallets,event,count,scopes){
  const claims=new Map();
  const add=(scope,mask,wrapped=false)=>{if(dependsOnEvent(scope,BigInt(mask),event,count))claims.set(`${scope}:${mask}:${wrapped}`,{scope,mask:String(mask),wrapped});};
  for(const mask of [1,2]){add(2**event,mask);add(2**event,mask,true);}
  for(const scope of scopes){const width=Number(scope).toString(2).replaceAll('0','').length;if(width>3)continue;const all=2**(2**width)-1;
    for(let i=0;i<2**width;i++){add(scope,2**i);add(scope,all^2**i);}}
  // Also include less common Boolean truth tables, rather than treating an incomplete history index as zero shares.
  for(const scope of scopes){const width=Number(scope).toString(2).replaceAll('0','').length;if(width>3)continue;for(let mask=1;mask<2**(2**width)-1;mask++)add(scope,mask);}
  return [...claims.values()].flatMap(claim=>wallets.map(holder=>({...claim,holder})));
}
