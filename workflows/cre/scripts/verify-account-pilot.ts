import { verifyPilot } from '../src/pilot-verification';

const root=new URL('../../../',import.meta.url);
if(process.argv.length!==2)throw Error('This verifier uses account-pilot deployment files');
const prefix='account-pilot';
const prepared=await Bun.file(new URL(`target/deployments/${prefix}-prepared.json`,root)).json();
const deployment=await Bun.file(new URL(`target/deployments/${prefix}-unverified.json`,root)).json();
if(prepared.publication.challengePolicy?.version!=='account-holders-v1')throw Error('Holder-only policy required');
const artifacts:Record<string,any>={};
for(const name of ['PilotPool','AccountPilotResolver','FactoredBaseTokenFactory','FactoredBaseToken']) artifacts[name]=await Bun.file(new URL(`target/foundry/out/${name}.sol/${name}.json`,root)).json();
const endpoint=process.env.FLURBO_ALCHEMY_TESTNET_RPC_URL || 'https://testnet-rpc.monad.xyz';
if(!endpoint.startsWith('https://')) throw new Error('HTTPS RPC required');
const rpc=async(method:string,params:unknown[])=>{
  const response=await fetch(endpoint,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(20_000)});
  if(!response.ok) throw new Error('RPC request failed');
  const result=await response.json() as {error?:unknown;result?:unknown};
  if(result.error || result.result===undefined) throw new Error(`RPC rejected ${method}`);
  return result.result;
};
const manifest=await verifyPilot(prepared,deployment,rpc,artifacts,Math.floor(Date.now()/1000));
await Bun.write(new URL(`target/deployments/${prefix}-testnet.json`,root),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({status:manifest.status,mode:manifest.publication.mode,block:manifest.verifiedBlock,pool:manifest.pool}));
