import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {loadLocalRehearsal} from './run-local-settlement-rehearsal.mjs';
import {createLocalSettlementCommand} from '../server/local-settlement-command.mjs';
import {createSettlementStores} from '../server/settlement-persistence.mjs';
import {configureCollection} from '../server/pilot-config.mjs';
import {practiceNamespace} from '../server/practice-collections.mjs';
import {pilotEvidence} from '../server/pilot.mjs';
import {localApi} from '../server/local-api.mjs';
import {TESTNET} from '../server/network.mjs';

// Rebuildable display indexes only. Auth remains in SessionStore memory and
// worker/evidence state uses its separate durable store. No production Redis.
export function rehearsalDisplayCache(){
  const entries=new Map();
  const cas="local current=redis.call('GET',KEYS[1]); if (current or '')~=ARGV[1] then return 0 end; redis.call('SET',KEYS[1],ARGV[2]); return 1";
  return async(name,...args)=>{
    if((name==='GET'&&args.length!==1)||(name==='SET'&&args.length!==2))throw Error('Unsupported display cache command');
    const [key,value]=name==='EVAL'?[args[2],args[4]]:args;
    if(typeof key!=='string'||!/^flurbo:(?:pilot:|payout:)/.test(key))throw Error('Unexpected display cache key');
    if(name==='GET')return entries.get(key)??null;
    if(name==='EVAL'){
      if(args[0]!==cas||args[1]!==1||args.length!==5)throw Error('Unsupported display cache script');
      if((entries.get(key)??'')!==args[3])return 0;
    }
    if(['SET','EVAL'].includes(name)&&typeof value==='string'&&Buffer.byteLength(value)<=1000000){
      if(!entries.has(key)&&entries.size>=100)throw Error('Display cache capacity reached');
      entries.set(key,value);return name==='EVAL'?1:'OK';
    }
    throw Error('Unsupported display cache command');
  };
}

export function localRehearsalBoundary({port,directory}){
  const hosts=new Set([`localhost:${port}`,`127.0.0.1:${port}`]);
  return async(req,res,next)=>{
    const send=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(body));};
    if(!hosts.has(req.headers.host))return send(403,{error:'Local rehearsal host required'});
    if(!req.url?.startsWith('/api/'))return next();
    const origin=`http://${req.headers.host}`;
    if(req.headers['sec-fetch-site']==='cross-site'||(req.headers.origin&&req.headers.origin!==origin))return send(403,{error:'Same-origin request required'});
    const url=new URL(req.url,origin);
    if(url.pathname==='/api/network'){
      if(req.method!=='GET'||url.search)return send(405,{error:'Read-only rehearsal network'});
      return send(200,{...TESTNET,localRehearsal:true});
    }
    if(url.pathname==='/api/local-wallet-setup')return send(404,{error:'Local minting is unavailable on public Monad testnet'});
    if(url.pathname==='/api/local-rehearsal/status'){
      if(req.method!=='GET'||url.search)return send(405,{error:'Read-only rehearsal status'});
      try{
        const text=await readFile(resolve(directory,'latest.json'),'utf8');
        if(Buffer.byteLength(text)>100000)throw Error('Status too large');
        const report=JSON.parse(text);
        if(report.schema!=='flurbo.local-rehearsal-cycle.v1')throw Error('Invalid report');
        return send(200,report);
      }catch{return send(503,{status:'not_observed',notice:'No valid local worker cycle has been recorded.'});}
    }
    return next();
  };
}

export async function serveLocalRehearsal(configPath){
  const {config,manifest,directory}=await loadLocalRehearsal(configPath);
  const command=await createLocalSettlementCommand({directory:resolve(directory,'store')});
  const stores=createSettlementStores({command,origin:config.evidenceOrigin});
  const service=await configureCollection({manifest,rpcUrl:config.rpcUrl,command:rehearsalDisplayCache()});
  const namespace=practiceNamespace(manifest.pool);
  const practiceCollections={services:new Map([[namespace,service]]),legacy:null,
    catalog:{schema:'flurbo.practice-collections.v1',active:namespace,collections:[{namespace,label:'Local settlement rehearsal',pool:manifest.pool,closesAt:manifest.publication.draft.closesAt}]}};
  const api=localApi({hosts:[`localhost:${config.port}`,`127.0.0.1:${config.port}`],rpcUrl:config.rpcUrl,
    dashboardUrl:'http://127.0.0.1:1',practiceCollections,evidence:pilotEvidence(command,config.evidenceOrigin),settlementPackets:stores.packetStore});
  const server=await createServer({configFile:false,root:fileURLToPath(new URL('../',import.meta.url)),
    server:{host:'127.0.0.1',port:config.port,strictPort:true,allowedHosts:['localhost']},
    plugins:[{name:'isolated-settlement-rehearsal',configureServer(server){
      server.middlewares.use(localRehearsalBoundary({port:config.port,directory}));
      server.middlewares.use(api);
    }}]});
  await server.listen();
  return {server,url:`http://localhost:${config.port}/markets`,namespace};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    if(process.argv.length!==3)throw Error('Provide an explicit rehearsal config path');
    const {server,url}=await serveLocalRehearsal(process.argv[2]);
    console.log(JSON.stringify({url,network:'public Monad testnet',notice:'Loopback only. Do not tunnel this app. Passkeys and linked wallets are local and require real user interaction.'}));
    for(const event of ['SIGINT','SIGTERM'])process.once(event,()=>void server.close());
  }catch{console.error('Local rehearsal website could not start. Check the selected public manifest and loopback port.');process.exitCode=1;}
}
