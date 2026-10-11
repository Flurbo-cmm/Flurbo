import { decodeFunctionData, encodeFunctionResult, keccak256, type Hex } from 'viem';
import { hybridPoolManifest, hybridPoolService } from '../server/hybrid-pool-service.mjs';
import { pilotPoolAbi, pilotCashAbi, pilotCash } from '../shared/pilot.mjs';
import { hybridRecord } from './hybrid-catalog-fixture.ts';

export const owner=('0x'+'11'.repeat(20)) as Hex, pool=('0x'+'22'.repeat(20)) as Hex, resolver=('0x'+'33'.repeat(20)) as Hex;
export const hash=('0x'+'44'.repeat(32)) as Hex, rules=('0x'+'55'.repeat(32)) as Hex, code='0x6000' as Hex;

// A hybrid agent pool over a fake chain: the pool and test AUSD reads the pool service makes, and no resolver reads.
export function poolFixture(now=Math.floor(Date.now()/1000),count=2) {
  const record:any=hybridRecord({count,pool,resolver,closesAt:now+86400});
  Object.assign(record,{pool,resolver,rulesHash:rules,deploymentBlock:90});
  const manifest:any=hybridPoolManifest(record,{verifiedBlockHash:hash,codeHashes:{[pool]:keccak256(code),[resolver]:keccak256(code)}});
  const options={allowance:0n,chain:10143n,changed:false,failSimulation:false,liquidity:10_000_000n,resolved:false,factors:[] as {scope:number;values:bigint[]}[]};
  const rpc=async(method:string,params:any[]=[])=>{
    if(method==='eth_chainId')return '0x'+options.chain.toString(16);
    if(method==='eth_getBlockByNumber')return {number:'0x64',hash:options.changed?'0x'+'99'.repeat(32):hash,timestamp:'0x'+now.toString(16)};
    if(method==='eth_getCode')return code;
    if(method==='eth_estimateGas')return '0x186a0';
    if(method==='eth_gasPrice')return '0x3b9aca00';
    if(method==='eth_call'){
      const tx=params[0],abi=tx.to===pool?pilotPoolAbi:tx.to===pilotCash?pilotCashAbi:null;
      if(!abi)throw new Error('Unexpected read target '+tx.to);
      const {functionName:name}=decodeFunctionData({abi,data:tx.data});
      if(tx.from){if(options.failSimulation)throw new Error('Simulation rejected');return name==='approve'?encodeFunctionResult({abi,functionName:name,result:true}):'0x';}
      const values:Record<string,any>={settlementRulesHash:rules,resolver,eventCount:count,funded:true,collateral:pilotCash,collateralDecimals:6,closesAt:BigInt(now+86400),
        resolvedState:0,payoutFraction:[1n,1n],liquidity:options.liquidity,requiredCollateral:0n,balanceOf:100_000_000n,resolved:options.resolved,voidMask:0,
        allowance:options.allowance,quoteBuy:250_000n,quoteSell:249_000n,holdings:1_000_000n,factors:options.factors,eliminationOrder:Array.from({length:count},(_,i)=>i)};
      if(!(name in values))throw new Error('Unexpected read '+name);
      return encodeFunctionResult({abi,functionName:name,result:values[name]});
    }
    throw new Error('Unexpected RPC '+method);
  };
  return {manifest,options,rpc,service:hybridPoolService({manifest,rpc,now:()=>now}),record,namespace:'practice-'+pool.slice(2)};
}
