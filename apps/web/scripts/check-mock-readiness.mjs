import { readFile,mkdir,writeFile } from 'node:fs/promises';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { pilotRpc } from '../server/pilot.mjs';
import { runPairModel } from '../server/pair-analytics.mjs';
import { checkMockReadiness } from '../server/mock-readiness.mjs';

const root=new URL('../../../',import.meta.url);
export async function runMockReadiness({args=process.argv.slice(2),env=process.env,request=fetch,output=console.log}={}){
  if(args.length>1||args.length===1&&!['--october-demo','--showcase'].includes(args[0]))throw Error('Use --october-demo, --showcase, or no flag for the real pilot');
  const name=args[0]==='--showcase'?'showcase-v0':args[0]==='--october-demo'?'october-demo':'pilot';
  const manifest=JSON.parse(await readFile(new URL(name==='pilot'?'config/pilot-testnet.json':`target/deployments/${name}-testnet.json`,root),'utf8'));
  const namespace=name==='pilot'?'pilot':`practice-${manifest.pool.slice(2)}`;
  const rpc=pilotRpc(env.FLURBO_ALCHEMY_TESTNET_RPC_URL||'https://testnet-rpc.monad.xyz',request);
  // Same example binary used by analytics tests; hosted builds have their own binary.
  const file=fileURLToPath(new URL('target/debug/examples/pair_analytics'+(process.platform==='win32'?'.exe':''),root));
  const report=await checkMockReadiness({manifest,namespace,featured:['october-demo','showcase-v0'].includes(name),request,rpc,model:input=>runPairModel(input,{file})});
  await mkdir(new URL('target/mock-testing/',root),{recursive:true});
  await writeFile(new URL(`target/mock-testing/${name}-readiness.json`,root),JSON.stringify(report,null,2)+'\n');
  output(JSON.stringify(report,null,2));return report.status==='ready_for_manual_trading_checks'?0:1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{process.exitCode=await runMockReadiness();}
  catch{console.error('Readiness setup failed. Check arguments, verified manifest and local build. No transaction or email sent.');process.exitCode=2;}
}
