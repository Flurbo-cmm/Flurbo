import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {decodeFunctionData,encodeFunctionResult,parseAbi} from 'viem';
import {resolverAbi} from '../shared/pilot.mjs';
import {ALARM_DEFAULTS,MULTICALL3,alarmConfig,alarmDecision,alarmHealth,alarmTick,githubActions,healthPing,readCalendars} from '../server/settlement-alarm.mjs';

const now=1800000000,signer='0x'+'12'.repeat(20),resolverA='0x'+'a1'.repeat(20),resolverB='0x'+'b1'.repeat(20),resolverC='0x'+'c1'.repeat(20);
const multicall=parseAbi(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)']);
const base={repository:'owner/repo',monitorWorkflow:'settlement-monitor.yml',workerWorkflow:'resolution-worker.yml',signer};
const poolA={pool:'0x'+'a0'.repeat(20),resolver:resolverA,mode:'rehearsal',evidence:false,observationEnds:[now-7200,now-7200]};
const poolB={pool:'0x'+'b0'.repeat(20),resolver:resolverB,mode:'release',evidence:true,observationEnds:[now+600,now+600]};
const poolC={pool:'0x'+'c0'.repeat(20),resolver:resolverC,mode:'ethereum-activity',evidence:false,observationEnds:[now-7200]};
const config=alarmConfig({...base,pools:[poolA,poolB]});
const iso=(t:number)=>new Date(t*1000).toISOString();
// created: start time. finished: completion time (updated_at). They are deliberately independent.
const run=(t:number,status='completed',workflow='settlement-monitor.yml',conclusion:string|null='success',finished=t+60)=>
  ({workflow,status,conclusion:status==='completed'?conclusion:null,event:'schedule',created_at:iso(t),updated_at:iso(finished)});
const blank={phase:0,proposal:0,counter:0,result:0,asserter:'0x'+'00'.repeat(20),disputer:'0x'+'00'.repeat(20),
  evidenceHash:'0x'+'00'.repeat(32),counterEvidenceHash:'0x'+'00'.repeat(32),challengeUntil:0n,voteUntil:0n,votes:[0,0,0]};

// Fake chain. Pool A: timed out, so finalization is due. Pool B: before observation. Pool C: a FOREIGN
// assertion inside its challenge window, so there is nothing for the bot but monitoring must stay fresh.
function chain({timestamp=now,fail=false,revert=[] as string[],garbage=[] as string[]}={}){
  const calls:any[]=[];
  const rpc=async(method:string,params:any[])=>{
    calls.push({method,params});if(fail)throw Error('RPC outage');
    if(method==='eth_getBlockByNumber')return {number:'0x64',hash:'0x'+'44'.repeat(32),timestamp:'0x'+timestamp.toString(16)};
    assert.equal(params[0].to,MULTICALL3);assert.equal(params[1],'0x64','reads are pinned to the fetched block');
    const inner=decodeFunctionData({abi:multicall,data:params[0].data}).args[0] as any[];
    assert.ok(inner.every(c=>c.allowFailure===true),'one resolver failure must not revert the whole read');
    return encodeFunctionResult({abi:multicall,functionName:'aggregate3',result:inner.map(c=>{
      const target=c.target.toLowerCase();
      if(revert.includes(target))return {success:false,returnData:'0x'};
      const {functionName}=decodeFunctionData({abi:resolverAbi,data:c.callData});
      const value=functionName==='delivered'?false
        :functionName==='assertionDeadline'?BigInt(target===resolverA?now-3600:target===resolverB?now+4200:now-3600)
        :target===resolverC?{...blank,phase:1,proposal:2,asserter:'0x'+'77'.repeat(20),challengeUntil:BigInt(now+1800)}
        :garbage.includes(target)?{...blank,phase:9}:blank;
      return {success:true,returnData:encodeFunctionResult({abi:resolverAbi,functionName,result:value} as any)};
    })});
  };
  return {rpc,calls};
}
function github({runs=[] as any[],listStatus=200,dispatchStatus=204}={}){
  const requests:any[]=[];
  const fetcher=async(url:string,init:any={})=>{
    requests.push({url,init});
    if(url.startsWith('https://hc.example'))return new Response('OK',{status:200});
    if(init.method==='POST')return new Response(null,{status:dispatchStatus});
    if(listStatus!==200)return new Response('{}',{status:listStatus});
    const file=url.includes('settlement-monitor.yml')?'settlement-monitor.yml':'resolution-worker.yml';
    return Response.json({workflow_runs:runs.filter(r=>r.workflow===file)});
  };
  return {requests,fetcher,client:githubActions({repository:'owner/repo',token:'test-token-value',monitorWorkflow:'settlement-monitor.yml',workerWorkflow:'resolution-worker.yml',fetcher})};
}

test('alarm reads every pool with two RPC requests at one block and schedules only automatic actions',async()=>{
  const c=chain(),{calendars,failed}=await readCalendars(config,c.rpc);
  assert.deepEqual(c.calls.map(x=>x.method),['eth_getBlockByNumber','eth_call']);
  assert.deepEqual(failed,[]);
  assert.deepEqual(calendars[0].entries.map((e:any)=>[e.action,e.event,e.readyAt]),[['finalize',0,now-3600],['finalize',1,now-3600]]);
  assert.deepEqual(calendars[1].entries.map((e:any)=>e.action),['evidence','finalize','evidence','finalize']);
  assert.deepEqual(calendars[0].watch.map((w:any)=>w.reason),['assertion-timeout','assertion-timeout']);
  assert.deepEqual(calendars[1].watch,[],'nothing to observe before the observation window ends');
});

test('regression: a failing or malformed resolver is isolated; healthy pools keep their calendars',async()=>{
  const three=alarmConfig({...base,pools:[poolA,poolB,poolC]});
  for(const broken of [{revert:[resolverB]},{garbage:[resolverB]}]){
    const {calendars,failed}=await readCalendars(three,chain(broken).rpc);
    assert.deepEqual(failed,[{pool:poolB.pool,reason:'resolver-read-failed'}]);
    assert.deepEqual(calendars.map((c:any)=>c.pool),[poolA.pool,poolC.pool]);
    assert.equal(calendars[0].entries.length,2,'pool A still schedules its overdue finalizations');
    const d=alarmDecision({now,calendars,failed,runs:[],config:three});
    assert.equal(d.action,'dispatch');assert.equal(d.reason,'due');assert.deepEqual(d.failedPools,[poolB.pool]);
    assert.ok(d.watching.includes(poolB.pool),'a pool with unknown state stays under observation');
    assert.equal(alarmHealth(d),'degraded');
  }
});

test('regression: a foreign assertion keeps monitoring fresh even when no bot action is due',async()=>{
  const only=alarmConfig({...base,pools:[poolC]}),{calendars}=await readCalendars(only,chain().rpc);
  assert.deepEqual(calendars[0].entries,[],'the bot must not finalize or act on a foreign assertion');
  assert.deepEqual(calendars[0].watch.map((w:any)=>w.reason),['foreign-assertion']);
  const d=(runs:any[])=>alarmDecision({now,calendars,runs,config:only});
  assert.equal(d([]).reason,'monitor-refresh');
  assert.equal(d([run(now-300)]).reason,'idle','monitoring that succeeded 4 minutes ago is fresh');
  assert.equal(d([run(now-ALARM_DEFAULTS.monitorIntervalSeconds-60)]).reason,'monitor-refresh');
  // No unresolved phase anywhere: no monitoring dispatch however old the last run.
  const quiet=await readCalendars(alarmConfig({...base,pools:[poolB]}),chain().rpc);
  assert.equal(alarmDecision({now,calendars:quiet.calendars,runs:[],config:alarmConfig({...base,pools:[poolB]})}).reason,'idle');
});

test('regression: freshness comes from successful completion, never from workflow start times',async()=>{
  const only=alarmConfig({...base,pools:[poolC]}),{calendars}=await readCalendars(only,chain().rpc);
  const d=(runs:any[])=>alarmDecision({now,calendars,runs,config:only});
  // Started 40 minutes ago but finished successfully 2 minutes ago: fresh.
  const late=d([run(now-2400,'completed','settlement-monitor.yml','success',now-120)]);
  assert.equal(late.reason,'idle');assert.equal(late.monitorAgeSeconds,120);
  // Started 2 minutes ago and failed: not fresh; the start only rate-limits the retry.
  const failed=d([run(now-120,'completed','settlement-monitor.yml','failure'),run(now-3000)]);
  assert.equal(failed.reason,'monitor-retry-wait');assert.equal(failed.monitorAgeSeconds,now-(now-3000+60));
  assert.equal(failed.monitorOverdue,true);
  assert.equal(d([run(now-ALARM_DEFAULTS.minRedispatchSeconds,'completed','settlement-monitor.yml','failure')]).reason,'monitor-refresh');
  // A successful WORKER run is not monitoring.
  const worker=d([run(now-120,'completed','resolution-worker.yml','success')]);
  assert.equal(worker.lastMonitorSuccess,null);assert.equal(worker.monitorOverdue,true);
  assert.equal(alarmHealth(worker,{dispatchEnabled:true}),'degraded');
  assert.equal(alarmHealth(worker,{dispatchEnabled:false}),'ok','observation mode reports, but does not alert on, stale monitoring');
});

test('decision: due work dispatches once per change; in-flight, recent and repeated attempts are deduplicated',async()=>{
  const {calendars}=await readCalendars(config,chain().rpc),d=(runs:any[],at=now)=>alarmDecision({now:at,calendars,runs,config});
  assert.equal(d([]).action,'dispatch');
  assert.equal(d([run(now-60,'queued')]).reason,'in-flight');
  // An in-progress WORKER run no longer defers the monitor dispatch (only monitor runs are in flight).
  assert.equal(d([run(now-60,'in_progress','resolution-worker.yml')]).reason,'due');
  assert.equal(d([run(now-ALARM_DEFAULTS.stuckRunSeconds-1,'in_progress')]).reason,'stuck-run');
  assert.equal(d([run(now-120)]).reason,'recently-dispatched');
  assert.equal(d([run(now-ALARM_DEFAULTS.minRedispatchSeconds)]).action,'dispatch');
  assert.equal(d([run(now-3700)]).action,'dispatch');
  // Monitoring itself is fresh (finished 100 s ago), so only the bot work is at stake: back off.
  const tried=[run(now-2400),run(now-1800),run(now-700,'completed','settlement-monitor.yml','success',now-100)];
  assert.equal(d(tried).reason,'backing-off');
  assert.equal(d(tried,now-700+ALARM_DEFAULTS.recoverySeconds).action,'dispatch');
  // Backed-off bot work must not suppress an overdue monitoring refresh.
  const stale=[run(now-2400),run(now-1800),run(now-1200,'completed','settlement-monitor.yml','failure')];
  assert.equal(d(stale).reason,'monitor-refresh');
  const earlier=await readCalendars(config,chain({timestamp:now-7300}).rpc);
  const idle=alarmDecision({now:now-7300,calendars:earlier.calendars,runs:[],config});
  assert.equal(idle.reason,'idle');assert.equal(idle.nextWake,now-3600,'finish-only pool wakes at its timeout, not observation end');
});

test('stale or unavailable calendars recover at a bounded cadence; missing run history fails closed',async()=>{
  const skewed=(await readCalendars(config,chain({timestamp:now-ALARM_DEFAULTS.maxSkewSeconds-1}).rpc)).calendars;
  assert.equal(alarmDecision({now,calendars:skewed,runs:[run(now-60)],config}).reason,'stale-calendar');
  assert.equal(alarmDecision({now,calendars:skewed,runs:[run(now-ALARM_DEFAULTS.recoverySeconds)],config}).reason,'recovery');
  const future=(await readCalendars(config,chain({timestamp:now+ALARM_DEFAULTS.maxSkewSeconds+1}).rpc)).calendars;
  assert.equal(alarmDecision({now,calendars:future,runs:[run(now-60)],config}).reason,'stale-calendar');
  assert.equal(alarmDecision({now,calendarError:'chain-read-failed',runs:[run(now-60)],config}).reason,'calendar-unavailable');
  assert.equal(alarmDecision({now,calendarError:'chain-read-failed',runs:[],config}).reason,'recovery');
  const {calendars}=await readCalendars(config,chain().rpc);
  const blind=alarmDecision({now,calendars,runsError:'github-503',config});
  assert.equal(blind.reason,'run-history-unavailable');assert.equal(alarmHealth(blind),'degraded');
});

test('tick is report-only unless dispatch is explicit; one dispatch request, never the token in output',async()=>{
  const report=github();
  const dry=await alarmTick({config,rpc:chain().rpc,github:report.client,now:()=>now,fetcher:report.fetcher});
  assert.equal(dry.action,'would-dispatch');assert.ok(!report.requests.some(r=>r.init.method==='POST'));assert.equal(dry.healthPing,'not-configured');
  const live=github();
  const sent=await alarmTick({config,rpc:chain().rpc,github:live.client,now:()=>now,dispatch:true,fetcher:live.fetcher});
  assert.equal(sent.dispatched,true);
  const posts=live.requests.filter(r=>r.init.method==='POST');
  assert.equal(posts.length,1);
  assert.equal(posts[0].url,'https://api.github.com/repos/owner/repo/actions/workflows/settlement-monitor.yml/dispatches');
  assert.deepEqual(JSON.parse(posts[0].init.body),{ref:'main'});
  assert.equal(posts[0].init.headers.authorization,'Bearer test-token-value');
  assert.ok(!JSON.stringify(sent).includes('test-token-value'));
  const next=github({runs:[run(now,'queued')]});
  assert.equal((await alarmTick({config,rpc:chain().rpc,github:next.client,now:()=>now+60,dispatch:true,fetcher:next.fetcher})).reason,'in-flight');
  assert.ok(!next.requests.some(r=>r.init.method==='POST'));
});

test('persistent failures reach Healthchecks: success pings only when healthy, immediate fail when a person is needed',async()=>{
  const url='https://hc.example/ping/abc-123';
  const healthy=github({runs:[run(now-120)]});
  const ok=await alarmTick({config,rpc:chain().rpc,github:healthy.client,now:()=>now,dispatch:true,healthUrl:url,fetcher:healthy.fetcher,
    holdings:async()=>({clear:true,positions:[],wrapped:[],blockNumber:'100',checkedClaims:2})});
  assert.equal(ok.health,'ok');assert.equal(ok.healthPing,'sent');
  assert.equal(healthy.requests.filter(r=>r.url.startsWith('https://hc.example')).map(r=>r.url)[0],url);
  const down=github({listStatus:503});
  const degraded=await alarmTick({config,rpc:chain().rpc,github:down.client,now:()=>now,dispatch:true,healthUrl:url,fetcher:down.fetcher});
  assert.equal(degraded.health,'degraded');
  const ping=down.requests.find(r=>r.url.startsWith('https://hc.example'));
  assert.equal(ping.url,url+'/log','degraded ticks log but never send a success ping');
  const revoked=github({dispatchStatus:401});
  const failed=await alarmTick({config,rpc:chain().rpc,github:revoked.client,now:()=>now,dispatch:true,healthUrl:url,fetcher:revoked.fetcher});
  assert.equal(failed.health,'fail');assert.equal(revoked.requests.find(r=>r.url.startsWith('https://hc.example')).url,url+'/fail');
  for(const result of [ok,degraded,failed])assert.ok(!JSON.stringify(result).includes('abc-123'),'the capability URL never appears in output');
  const body=JSON.parse(revoked.requests.find(r=>r.url.startsWith('https://hc.example')).init.body);
  assert.deepEqual(Object.keys(body).sort(),['action','failedPools','health','monitorAgeSeconds','proposer','reason','status']);
  assert.equal(await healthPing({url:'http://insecure.example/x',health:'ok',summary:{}}),'invalid-url');
  assert.equal(await healthPing({url,health:'ok',summary:{},fetcher:async()=>{throw Error('network');}}),'failed');
  assert.equal(alarmHealth({action:'alarm-failed'}),'fail');
});

test('outages: GitHub, RPC and rejected dispatches never loop or leak, and report retryability',async()=>{
  const down=github({listStatus:503});
  const blocked=await alarmTick({config,rpc:chain().rpc,github:down.client,now:()=>now,dispatch:true,fetcher:down.fetcher});
  assert.equal(blocked.reason,'run-history-unavailable');assert.equal(blocked.runsError,'github-503');
  assert.ok(!down.requests.some(r=>r.init.method==='POST'));
  const rpcDown=github({runs:[run(now-ALARM_DEFAULTS.recoverySeconds-5)]});
  const recovered=await alarmTick({config,rpc:chain({fail:true}).rpc,github:rpcDown.client,now:()=>now,dispatch:true,fetcher:rpcDown.fetcher});
  assert.equal(recovered.reason,'recovery');assert.equal(recovered.calendarError,'chain-read-failed');assert.equal(recovered.dispatched,true);
  assert.equal(recovered.health,'degraded');
  for(const [status,retryable,health] of [[500,true,'degraded'],[429,true,'degraded'],[401,false,'fail'],[403,false,'fail'],[404,false,'fail'],[422,false,'fail']] as const){
    const g=github({dispatchStatus:status});
    const failed=await alarmTick({config,rpc:chain().rpc,github:g.client,now:()=>now,dispatch:true,fetcher:g.fetcher});
    assert.equal(failed.action,'dispatch-failed');assert.equal(failed.status,status);assert.equal(failed.retryable,retryable);assert.equal(failed.health,health);
    assert.equal(g.requests.filter(r=>r.init.method==='POST').length,1,'one attempt per tick');
  }
  const noToken=githubActions({repository:'owner/repo',token:null,monitorWorkflow:'settlement-monitor.yml',workerWorkflow:'resolution-worker.yml',fetcher:async()=>{throw Error('no network expected');}});
  await assert.rejects(noToken.dispatch(),(e:any)=>e.status===401);
});

test('configuration rejects unsafe input; worker concurrency is job-level; chaining is opt-in',async()=>{
  for(const bad of [{...base,pools:config.pools,repository:'owner/repo/../x'},{...base,pools:config.pools,signer:'bot'},{...base,pools:[]},{...base,pools:config.pools,minRedispatchSeconds:0},
    {...base,pools:[poolA,poolA]},{...base,pools:[poolA,poolB].map(p=>({...p,evidence:true}))},{...base,pools:[{...poolA,mode:'sports'}]},{...base,pools:config.pools,monitorIntervalSeconds:-1}])
    assert.throws(()=>alarmConfig(bad),/Invalid alarm/);
  const worker=(await readFile(new URL('../../../.github/workflows/resolution-worker.yml',import.meta.url),'utf8')).replace(/\r\n/g,'\n');
  const monitor=(await readFile(new URL('../../../.github/workflows/settlement-monitor.yml',import.meta.url),'utf8')).replace(/\r\n/g,'\n');
  assert.doesNotMatch(worker,/^concurrency:/m,'no workflow-level group: skipped workflow_run runs must not cancel pending scheduled runs');
  assert.match(worker,/\n  resolve:\n(?:    #.*\n)*    concurrency:\n      group: testnet-resolution-worker\n      cancel-in-progress: false\n/);
  assert.match(monitor,/^concurrency:\n  group: settlement-monitor\n  cancel-in-progress: false/m);
  assert.match(worker,/workflow_run:\n    workflows: \['Settlement monitor'\]/);
  assert.match(worker,/github\.event_name == 'workflow_run' && vars\.FLURBO_RESOLUTION_AFTER_MONITOR == 'true' && github\.event\.workflow_run\.conclusion == 'success' && github\.event\.workflow_run\.head_branch == 'main'/);
  assert.match(worker,/github\.event_name != 'workflow_run' && github\.ref == 'refs\/heads\/main'/);
});

test('regression: repeated worker runs never postpone a monitor refresh while a foreign assertion is challengeable',async()=>{
  const only=alarmConfig({...base,pools:[poolC]}),{calendars}=await readCalendars(only,chain().rpc);
  assert.deepEqual(calendars[0].watch.map((w:any)=>w.reason),['foreign-assertion']);
  // Last successful monitoring 40 minutes ago; scheduled worker runs every 5 minutes since, one still running.
  const workers=Array.from({length:8},(_,i)=>run(now-2400+i*300,'completed','resolution-worker.yml','success',now-2400+i*300+20));
  const runs=[run(now-2460,'completed','settlement-monitor.yml','success',now-2400),...workers,run(now-30,'in_progress','resolution-worker.yml')];
  const d=alarmDecision({now,calendars,runs,config:only});
  assert.equal(d.action,'dispatch');assert.equal(d.reason,'monitor-refresh');assert.equal(d.monitorAgeSeconds,2400);
  // The same worker traffic cannot postpone recovery when the calendar is unavailable either.
  assert.equal(alarmDecision({now,calendarError:'chain-read-failed',runs,config:only}).reason,'recovery');
  // Nor can it count as attempts that trigger back-off for due bot work.
  const due=(await readCalendars(config,chain().rpc)).calendars;
  assert.equal(alarmDecision({now,calendars:due,runs:[run(now-2460,'completed','settlement-monitor.yml','success',now-2400),...workers],config}).reason,'due');
  // Only an in-flight MONITOR run defers the dispatch.
  assert.equal(alarmDecision({now,calendars,runs:[...runs,run(now-60,'in_progress')],config:only}).reason,'in-flight');
  // A stuck worker is reported as degraded health without blocking the monitor.
  const stuck=alarmDecision({now,calendars,runs:[...runs,run(now-ALARM_DEFAULTS.stuckRunSeconds-10,'in_progress','resolution-worker.yml')],config:only});
  assert.equal(stuck.reason,'monitor-refresh');assert.equal(stuck.workerStuck,true);assert.equal(alarmHealth(stuck),'degraded');
});

test('proposer preflight runs before the observation window and escalates a position immediately',async()=>{
  const url='https://hc.example/ping/pre-1';
  const holding=async()=>({clear:false,positions:[{scope:1,mask:1,quantity:'4'}],wrapped:[],blockNumber:'100'});
  const clear=async()=>({clear:true,positions:[],wrapped:[],blockNumber:'100',checkedClaims:2});
  // Pool B proposes; its observation window opens at now+600, so this is strictly before observation.
  const g=github({runs:[run(now-120)]});
  const early=await alarmTick({config,rpc:chain().rpc,github:g.client,now:()=>now,fetcher:g.fetcher,healthUrl:url,holdings:holding});
  assert.deepEqual({pool:early.proposerPreflight.pool,window:early.proposerPreflight.window,status:early.proposerPreflight.status},
    {pool:poolB.pool,window:'before-observation',status:'holds-position'});
  assert.equal(early.health,'fail');assert.equal(g.requests.find(r=>r.url.startsWith('https://hc.example')).url,url+'/fail');
  const ok=github({runs:[run(now-120)]});
  assert.equal((await alarmTick({config,rpc:chain().rpc,github:ok.client,now:()=>now,fetcher:ok.fetcher,holdings:clear})).proposerPreflight.status,'clear');
  const broken=await alarmTick({config,rpc:chain().rpc,github:github({runs:[run(now-120)]}).client,now:()=>now,holdings:async()=>{throw Error('RPC outage');}});
  assert.equal(broken.proposerPreflight.status,'guard-unavailable');assert.equal(broken.health,'degraded');
  // Sampled every preflightIntervalSeconds, not every minute.
  let calls=0;const counted=async()=>{calls++;return clear();};
  for(let m=0;m<10;m++)await alarmTick({config,rpc:chain({timestamp:now+m*60}).rpc,github:github({runs:[run(now-120)]}).client,now:()=>now+m*60,holdings:counted});
  assert.equal(calls,1);
  // No proposing pool, or no proposal still ahead: no preflight.
  const finishOnly=alarmConfig({...base,pools:[poolA,{...poolB,evidence:false}]});
  assert.equal((await alarmTick({config:finishOnly,rpc:chain().rpc,github:github().client,now:()=>now,holdings:holding})).proposerPreflight,undefined);
  const after=now+4200+600;
  assert.equal((await alarmTick({config,rpc:chain({timestamp:after}).rpc,github:github().client,now:()=>after,holdings:holding})).proposerPreflight,undefined);
});
