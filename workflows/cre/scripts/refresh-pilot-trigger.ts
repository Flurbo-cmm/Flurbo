import { pilotService, pilotRpc } from '../../../apps/web/server/pilot.mjs';
const root=new URL('../../../',import.meta.url);
const manifest=await Bun.file(new URL('target/deployments/pilot-testnet.json',root)).json();
const eventId=process.argv[2];
if(process.argv.length!==3||!manifest.publication.draft.events.some((e:{id:string})=>e.id===eventId))throw new Error('Supply an event ID from the verified pilot manifest');
const rpc=pilotRpc(process.env.FLURBO_ALCHEMY_TESTNET_RPC_URL||'https://testnet-rpc.monad.xyz');
const snapshot=await pilotService({manifest,rpc}).snapshot();
await Bun.write(new URL('target/deployments/pilot-cre-trigger.json',root),JSON.stringify({eventId,blockNumber:snapshot.blockNumber,blockHash:snapshot.blockHash},null,2)+'\n');
console.log(JSON.stringify({status:'read_only_trigger_prepared',eventId,block:snapshot.blockNumber,expiresAt:snapshot.timestamp+180}));
