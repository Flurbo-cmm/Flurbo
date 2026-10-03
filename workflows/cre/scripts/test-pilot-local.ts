// End-to-end fixture only. Uses unlocked Anvil accounts on the literal loopback endpoint.
// Never reads a private key, creates a public manifest or connects to public RPC.
import { encodeDeployData, encodeFunctionData, decodeFunctionResult, type Hex } from 'viem';
import { preparePilot, disputePolicy, VOID_POLICY } from '../src/pilot-config';
import { rehearsalEvent,REHEARSAL_TITLE } from '../src/rehearsal';
import { verifyPilot } from '../src/pilot-verification';
import { pilotService, pilotEvidence } from '../../../apps/web/server/pilot.mjs';
import { resolverAbi,pilotPoolAbi,pilotCashAbi } from '../../../apps/web/shared/pilot.mjs';
import { decodeAbiParameters } from 'viem';
import { resolverConfigAbi } from '../src/pilot-config';

const root=new URL('../../../',import.meta.url);
const endpoint='http://127.0.0.1:18549';
const rpc=async(method:string,params:unknown[]=[])=>{
  const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
  const result=await response.json() as any;
  if(result.error) throw new Error(`${method}: ${JSON.stringify(result.error)}`);
  return result.result;
};
if(BigInt(await rpc('eth_chainId'))!==10143n || !(await rpc('web3_clientVersion')).toLowerCase().includes('anvil')) throw new Error('Dedicated loopback Anvil required');
const accounts=await rpc('eth_accounts') as Hex[];
const [creator,alice,bob,...reviewers]=accounts;
const artifacts:Record<string,any>={};
for(const name of ['MockCollateral','PilotPool','PilotResolver','FactoredBaseTokenFactory','FactoredBaseToken']) artifacts[name]=await Bun.file(new URL(`target/foundry/out/${name}.sol/${name}.json`,root)).json();
async function send(from:Hex,to:Hex|undefined,data:Hex) {
  const hash=await rpc('eth_sendTransaction',[{from,...(to?{to}:{}),data,gas:'0x1c9c380'}]);
  let receipt=await rpc('eth_getTransactionReceipt',[hash]);
  for(let i=0;!receipt&&i<100;i++){await Bun.sleep(50);receipt=await rpc('eth_getTransactionReceipt',[hash]);}
  if(!receipt)throw new Error('Local fixture receipt timed out');
  if(BigInt(receipt.status)!==1n)throw new Error('Fixture transaction reverted');
  return receipt;
}
async function deploy(name:string,args:any[]) { return (await send(creator,undefined,encodeDeployData({abi:artifacts[name].abi,bytecode:artifacts[name].bytecode.object,args}))).contractAddress as Hex; }
const cash='0xa9012a055bd4e0edff8ce09f960291c09d5322dc' as Hex;
const mock=await deploy('MockCollateral',[6]);
await rpc('anvil_setCode',[cash,await rpc('eth_getCode',[mock,'latest'])]);
const now=Number(BigInt((await rpc('eth_getBlockByNumber',['latest',false])).timestamp));
const policy={creator,reviewerControl:'single-operator' as const,reviewers:reviewers.slice(0,3).map((address,i)=>({name:`Fixture wallet ${i+1}`,address})),bondAtoms:'1000000',assertionPeriod:3600,challengePeriod:3600,votingPeriod:3600};
const input={schema:'flurbo.pilot-publication.v1',mode:'rehearsal',independentReviewersConfirmed:false,rulesReviewed:true,...policy,
  draft:{schema:'flurbo.event-draft.v1',status:'draft',chainId:10143,clusterId:'public-rehearsal-local-test-only',title:REHEARSAL_TITLE,closesAt:now+7200,
    events:[0,1,2,3].map(bit=>rehearsalEvent(bit,now+7300,now+8000)),
    disputeModel:'reviewer-panel',disputePolicy:disputePolicy(policy),exceptionPolicy:VOID_POLICY}};
const prepared=preparePilot(input,now);
const [config]=decodeAbiParameters(resolverConfigAbi,prepared.resolverConfig);
const resolver=await deploy('PilotResolver',[config]);
async function read(to:Hex,abi:any,name:string,args:any[]=[]) { return decodeFunctionResult({abi,functionName:name,data:await rpc('eth_call',[{to,data:encodeFunctionData({abi,functionName:name,args})},'latest'])}) as any; }
async function call(from:Hex,to:Hex,abi:any,name:string,args:any[]=[]) { return send(from,to,encodeFunctionData({abi,functionName:name,args})); }
const rulesHash=await read(resolver,resolverAbi,'rulesHash');
const pool=await deploy('PilotPool',[cash,4,BigInt(prepared.liquidityAtoms),BigInt(now+7200),[0,1,2,3],resolver,rulesHash]);
await call(creator,resolver,artifacts.PilotResolver.abi,'bindPool',[pool]);
for(const owner of [creator,alice,bob]) await call(creator,cash,artifacts.MockCollateral.abi,'mint',[owner,1_000_000_000n]);
const funding=await read(pool,pilotPoolAbi,'requiredFunding');
await call(creator,cash,pilotCashAbi,'approve',[pool,funding]);
await call(creator,pool,artifacts.PilotPool.abi,'fund');
await call(creator,cash,pilotCashAbi,'approve',[pool,0n]);
for(let i=0;i<4;i++) await call(creator,pool,artifacts.PilotPool.abi,'createBaseToken',[i,true]);
const manifest=await verifyPilot(prepared,{pool,resolver},rpc,artifacts,now);
const service=pilotService({manifest,rpc,now:()=>clock});
let clock=now;
await service.status(alice);
async function action(owner:Hex,action:string,extra:Record<string,any>={}) {
  const plan=await service.prepare({owner,action,...extra});
  await send(owner,plan.transaction.to,plan.transaction.data);
  if(plan.action==='approve') {
    const reviewed=await service.prepare({owner,action,...extra});
    if(reviewed.action==='approve') throw new Error('Repeated approval');
    await send(owner,reviewed.transaction.to,reviewed.transaction.data);
  }
}
await action(alice,'buy',{scope:7,mask:'32',quantity:'2000000',slippageBps:50});
let position=await service.position(alice,7,'32');
if(position.quantity!=='2000000')throw new Error('Buy missing from holdings');
await action(alice,'sell',{scope:7,mask:'32',quantity:'1000000',slippageBps:50});
await action(alice,'buy',{scope:8,mask:'2',quantity:'1000000',slippageBps:50});
if((await service.markets()).prices.length!==4)throw new Error('Four separate markets required');
clock=now+8000;await rpc('evm_setNextBlockTimestamp',[clock]);await rpc('evm_mine');
const memory=new Map<string,string>();
const evidence=pilotEvidence(async(...command:any[])=>{if(command[0]==='EVAL')return 1;if(command[0]==='SET'){if(!memory.has(command[1]))memory.set(command[1],command[2]);return 'OK';}return memory.get(command[1]);},'https://flurbo.singu.online');
const e=await evidence.put({eventId:'rehearsal-0',outcome:2,statement:'Scripted fixture A is YES. This is not a real result.',sourceURL:'https://flurbo.singu.online/rehearsal-rules',attachment:'fixture A'},alice,manifest.draftHash);
if(await evidence.get(e.hash)!==e.body)throw new Error('Evidence persistence mismatch');
await action(alice,'assertOutcome',{event:0,outcome:2,evidenceHash:e.hash,evidenceURI:e.uri});
const wrong=await evidence.put({eventId:'rehearsal-1',outcome:2,statement:'Intentionally incorrect YES proposal to exercise the rehearsal dispute.',sourceURL:'https://flurbo.singu.online/rehearsal-rules',attachment:'Deliberate rehearsal error'},alice,manifest.draftHash);
const correct=await evidence.put({eventId:'rehearsal-1',outcome:1,statement:'Scripted fixture B is NO; challenge the intentionally incorrect proposal.',sourceURL:'https://flurbo.singu.online/rehearsal-rules',attachment:'fixture B'},bob,manifest.draftHash);
await action(alice,'assertOutcome',{event:1,outcome:2,evidenceHash:wrong.hash,evidenceURI:wrong.uri});
await action(bob,'dispute',{event:1,outcome:1,evidenceHash:correct.hash,evidenceURI:correct.uri});
for(const reviewer of reviewers.slice(0,2))await action(reviewer,'vote',{event:1,outcome:1,evidenceHash:correct.hash,evidenceURI:correct.uri});
const fourth=await evidence.put({eventId:'rehearsal-3',outcome:2,statement:'Scripted fixture D is YES. This is not a real result.',sourceURL:'https://flurbo.singu.online/rehearsal-rules',attachment:'fixture D'},alice,manifest.draftHash);
await action(alice,'assertOutcome',{event:3,outcome:2,evidenceHash:fourth.hash,evidenceURI:fourth.uri});
// A finalizes unchallenged. C has no assertion and becomes VOID.
clock+=3601;await rpc('evm_setNextBlockTimestamp',[clock]);await rpc('evm_mine');
await action(bob,'finalize',{event:0});await action(bob,'finalize',{event:2});await action(bob,'finalize',{event:3});await action(bob,'deliver');
position=await service.position(alice,7,'32');
if(position.payoutAtoms!=='500000')throw new Error('Partial void payout mismatch');
await action(alice,'redeem',{scope:7,mask:'32',quantity:'1000000'});
await action(alice,'redeem',{scope:8,mask:'2',quantity:'1000000'});
await action(alice,'withdrawBond');
await action(bob,'withdrawBond');
const final=await service.status(alice);
if(!final.delivered||final.requiredCollateral!=='0'||final.wallet.credits!=='0')throw new Error('Settlement or bond credit incomplete');
console.log(JSON.stringify({status:'passed_local_e2e',steps:['deploy','compiled-runtime-verification','exact-approval','buy','sell','evidence','assert','dispute','quorum','void-timeout','deliver','redeem','withdraw-bond'],pool,resolver}));
