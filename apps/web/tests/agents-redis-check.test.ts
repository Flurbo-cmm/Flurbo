import assert from 'node:assert/strict';
import {test} from 'node:test';
import {checkAgentRedis} from '../scripts/check-agent-redis.mjs';
import {agentRedis} from './agent-fixture.ts';

// The rollout check itself: against the in-process fake by default, and against a real, local, isolated
// Redis in its own random key namespace when FLURBO_TEST_REDIS_URL is set. Either way it must pass, stay in
// the agent namespace and leave nothing behind. It does not replace running it against the hosted provider.
test('the Redis rollout check passes, stays in the agent namespace and cleans up',async()=>{
  const redis=agentRedis(),lines:string[]=[];
  await redis.set('flurbo:monitor:v1:keep','untouched');
  const results=await checkAgentRedis(redis.command,(line:string)=>lines.push(line));
  assert.deepEqual(results.filter(([,passed])=>!passed),[],lines.join('\n'));
  if(process.env.FLURBO_TEST_REDIS_LOG)console.log((redis.real?'real Redis':'fake Redis')+'\n'+lines.join('\n'));
  assert.equal(results.length,18,'every check ran, including cleanup');
  assert.deepEqual(await redis.keys(),['flurbo:monitor:v1:keep'],'only the unrelated key remains');
  const broken=await checkAgentRedis(async()=>null);
  assert.ok(broken.some(([,passed])=>!passed),'a store that ignores commands is reported as failing');
});
