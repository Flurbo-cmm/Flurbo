import {readFile} from 'node:fs/promises';
import {createPublicClient,http} from 'viem';
import {pilotService,pilotRpc} from '../server/pilot.mjs';
import {pilotCash,pilotCashAbi} from '../shared/pilot.mjs';
import {redisCommand} from '../server/redis-session.mjs';
import {inspectResolutionState} from './inspect-resolution-state.mjs';
import {resolutionReadiness} from '../server/resolution-readiness.mjs';
import {proposerHoldings,proposerStatus} from '../server/proposer-guard.mjs';

// No private key is read. All chain calls are reads, and Redis permits GET/PTTL only.
try{
  if(process.argv.length!==3)throw Error('Supply the saved current complete website bundle path.');
  const env=process.env,manifest=JSON.parse(env.FLURBO_RESOLUTION_MANIFEST_JSON||'null');
  if(!manifest)throw Error('Missing public manifest');
  const registered=JSON.parse(await readFile(process.argv[2],'utf8')).map(row=>row.manifest||row);
  const monitored=JSON.parse(env.FLURBO_PRACTICE_COLLECTIONS_JSON||'[]').map(row=>row.manifest||row);
  const owner=env.FLURBO_RESOLUTION_SIGNER_ADDRESS?.toLowerCase();
  if(!/^0x[0-9a-fA-F]{40}$/.test(owner||''))throw Error('Missing public signer');
  const endpoint=env.FLURBO_ALCHEMY_TESTNET_RPC_URL||'https://testnet-rpc.monad.xyz';
  const rpc=pilotRpc(endpoint),service=pilotService({manifest,rpc}),client=createPublicClient({transport:http(endpoint,{retryCount:0,timeout:15000})});
  const state=await service.status(),now=Number(state.snapshot.timestamp);
  const inspection=await inspectResolutionState({command:redisCommand(env),rpc,manifests:[manifest],signer:owner,now});
  let holdingsClear=null;
  // The holdings reader's interface is the same one used by the execution worker.
  try{holdingsClear=(await proposerStatus(()=>proposerHoldings({manifest,owner,rpc}))).status==='clear';}catch{}
  const report=resolutionReadiness({manifest,state,env,inspection,registered,monitored,holdingsClear,now,
    pendingNonce:await client.getTransactionCount({address:owner,blockTag:'pending'}),latestNonce:await client.getTransactionCount({address:owner,blockTag:'latest'}),
    gasWei:await client.getBalance({address:owner}),cashAtoms:await client.readContract({address:pilotCash,abi:pilotCashAbi,functionName:'balanceOf',args:[owner]}),gasBudgetWei:env.FLURBO_READINESS_GAS_BUDGET_WEI});
  console.log(JSON.stringify(report,null,2));if(report.status==='blocked')process.exitCode=1;
}catch{
  console.error('Readiness inspection failed. Check the public manifest, bundle paths, RPC, signer address and Redis access. Sensitive values withheld. No transaction submitted.');process.exitCode=1;
}
