import { decodeFunctionData, encodeFunctionResult, keccak256, type Hex } from 'viem';
import { pilotService } from '../server/pilot.mjs';
import { resolverAbi,pilotPoolAbi,pilotCashAbi } from '../shared/pilot.mjs';

export const owner=('0x'+'11'.repeat(20)) as Hex, pool=('0x'+'22'.repeat(20)) as Hex, resolver=('0x'+'33'.repeat(20)) as Hex;
export const hash=('0x'+'44'.repeat(32)) as Hex, rules=('0x'+'55'.repeat(32)) as Hex, code='0x6000' as Hex;
export function pilotFixture(now=Math.floor(Date.now()/1000),count=2) {
  const manifest:any={schema:'flurbo.pilot-manifest.v1',status:'verified_pilot_snapshot',chainId:10143,pool,resolver,rulesHash:rules,draftHash:rules,
    verifiedBlock:'90',verifiedBlockHash:hash,codeHashes:{[pool]:keccak256(code),[resolver]:keccak256(code)},
    publication:{creator:owner,bondAtoms:'1000000',assertionPeriod:3600,challengePeriod:3600,votingPeriod:3600,
      reviewers:[{name:'Test Alice',address:'0x'+'66'.repeat(20)},{name:'Test Bob',address:'0x'+'77'.repeat(20)},{name:'Test Carol',address:'0x'+'88'.repeat(20)}],
      draft:{title:'Explicit test fixtures',closesAt:now+86400,exceptionPolicy:'Test void policy',disputePolicy:'Test panel policy',events:Array.from({length:count},(_,i)=>i).map(i=>({id:`event-${i}`,question:`Test event ${i+1}`,yesRule:'Test YES rule',noRule:'Test NO rule',observationStartsAt:now+86401,observationEndsAt:now+90000,source:{referenceUrl:'https://github.com/ethereum/go-ethereum/releases',recordId:'fixture'}}))}}};
  const options={allowance:0n,chain:10143n,changed:false,failSimulation:false,liquidity:10_000_000n,factors:[] as {scope:number;values:bigint[]}[]};
  const rpc=async(method:string,params:any[]=[])=>{
    if(method==='eth_chainId')return '0x'+options.chain.toString(16);
    if(method==='eth_getBlockByNumber')return {number:'0x64',hash:options.changed?'0x'+'99'.repeat(32):hash,timestamp:'0x'+now.toString(16)};
    if(method==='eth_getCode')return code;
    if(method==='eth_estimateGas')return '0x186a0';
    if(method==='eth_gasPrice')return '0x3b9aca00';
    if(method==='eth_call'){
      const tx=params[0],abi=tx.to===pool?pilotPoolAbi:tx.to===resolver?resolverAbi:pilotCashAbi;
      const {functionName:name}=decodeFunctionData({abi,data:tx.data});
      if(tx.from){if(options.failSimulation)throw new Error('Simulation rejected');return name==='approve'?encodeFunctionResult({abi,functionName:name,result:true}):'0x';}
      const values:Record<string,any>={settlementRulesHash:rules,pool,caseState:{phase:0,proposal:0,counter:0,result:0,asserter:owner,disputer:owner,evidenceHash:'0x'+'00'.repeat(32),counterEvidenceHash:'0x'+'00'.repeat(32),challengeUntil:0n,voteUntil:0n,votes:[0,0,0]},assertionDeadline:BigInt(now+93600),
        liquidity:options.liquidity,voted:false,delivered:false,requiredCollateral:0n,balanceOf:100_000_000n,resolved:false,voidMask:0,credits:0n,isReviewer:false,allowance:options.allowance,quoteBuy:250_000n,quoteSell:249_000n,holdings:1_000_000n,factors:options.factors,eliminationOrder:Array.from({length:count},(_,i)=>i)};
      if(!(name in values))throw new Error('Unexpected read '+name);
      return encodeFunctionResult({abi,functionName:name,result:values[name]});
    }
    throw new Error('Unexpected RPC '+method);
  };
  return {manifest,options,rpc,service:pilotService({manifest,rpc,now:()=>now})};
}

