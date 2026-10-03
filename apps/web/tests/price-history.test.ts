import {test} from 'node:test';
import assert from 'node:assert/strict';
import {priceHistory} from '../server/price-history.mjs';
import {pilotFixture} from './pilot-fixture.ts';

function archive(){
  const rows=new Map<string,string[]>();let writes=0;
  const command=async(op:string,...args:any[])=>{
    if(op==='ZRANGE')return rows.get(args[0])||[];
    if(op==='EVAL'){
      writes++;const key=args[2],bucket=Number(args[3]),list=rows.get(key)||[];
      if(!list.some(s=>Math.floor(JSON.parse(s).timestamp/300)*300===bucket))list.push(args[4]);
      list.sort((a,b)=>JSON.parse(a).timestamp-JSON.parse(b).timestamp);
      rows.set(key,list.filter(s=>JSON.parse(s).timestamp>bucket-2592000).slice(-288));return rows.get(key);
    }
    throw Error('Unexpected operation');
  };
  return {rows,command,get writes(){return writes;}};
}
test('price archive survives service reconstruction, coalesces reads and contains no trader data',async()=>{
  let now=1800000000,reads=0;const f=pilotFixture(now,4),db=archive();
  const service={manifest:f.manifest,markets:async()=>{reads++;return {...await f.service.markets(),snapshot:{...(await f.service.snapshot()),timestamp:now},owner:'PRIVATE',transaction:'PRIVATE'};}};
  const history=priceHistory({service,command:db.command,now:()=>now});
  const results=await Promise.all([history.read(),history.read(),history.read()]);
  assert.equal(reads,1);assert.equal(results[0].points.length,1);assert.equal(db.writes,1);
  assert.ok(!JSON.stringify(results).includes('PRIVATE'));
  now+=60;
  const restarted=priceHistory({service,command:db.command,now:()=>now});
  assert.equal((await restarted.read()).points.length,1);assert.equal(reads,1);
  now+=300;
  assert.equal((await restarted.read()).points.length,2);assert.equal(reads,2);
  const other=priceHistory({service:{...service,manifest:{...f.manifest,rulesHash:'0x'+'aa'.repeat(32)}},command:db.command,now:()=>now});
  const foreign=await other.read();assert.equal(foreign.points.length,0);assert.equal(foreign.sampling,'unavailable');
});
test('closed, stale and failed reads never invent price samples',async()=>{
  let now=1800000000;const f=pilotFixture(now),db=archive();let mode='open';
  const service={manifest:f.manifest,markets:async()=>{
    if(mode==='fail')throw Error('PRIVATE upstream');
    const value=await f.service.markets();
    if(mode==='closed')return {...value,open:false};
    if(mode==='invalid')return {...value,prices:[{event:0,yes:'NaN',no:'500000'},value.prices[1]]};
    return value;
  }};
  const make=()=>priceHistory({service,command:db.command,now:()=>now});
  for(mode of ['closed','fail','invalid']){
    const r=await make().read();assert.equal(r.points.length,0);assert.equal(db.writes,0);
  }
  mode='open';assert.equal((await make().read()).points.length,1);
  now+=300;
  const stale=await make().read();assert.equal(stale.sampling,'unavailable');assert.equal(stale.points.length,1);assert.equal(db.writes,1);
  now+=2592001;mode='fail';assert.equal((await make().read()).points.length,0);
});
