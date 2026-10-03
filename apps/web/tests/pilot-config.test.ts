import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { configurePilot,configureRehearsal } from '../server/pilot-config.mjs';
import { pilotFixture } from './pilot-fixture.ts';

test('hosted pilot uses reviewed public manifest and preserves explicit overrides without fallback',async()=>{
  const command=async()=>null,rpcUrl='https://testnet-rpc.monad.xyz';
  const bundled=JSON.parse(await readFile(new URL('../../../config/pilot-testnet.json',import.meta.url),'utf8'));
  const configured=await configurePilot({env:{},rpcUrl,command});
  assert.equal(configured.manifest.pool,bundled.pool);
  assert.equal(configured.manifest.verifiedBlock,bundled.verifiedBlock);
  assert.equal(configured.manifest.publication.reviewerControl,'single-operator');
  const fixture=pilotFixture().manifest;
  const override=await configurePilot({env:{FLURBO_PILOT_MANIFEST_JSON:JSON.stringify(fixture)},rpcUrl,command,read:async()=>{throw new Error('Do not read fallback');}});
  assert.equal(override.manifest.pool,fixture.pool);
  for(const raw of ['', '{}', 'not json'])await assert.rejects(configurePilot({env:{FLURBO_PILOT_MANIFEST_JSON:raw},rpcUrl,command}));
  assert.equal(await configurePilot({env:{FLURBO_PILOT_DISABLED:'true'},rpcUrl,command,read:async()=>{throw new Error('Disabled');}}),null);
  await assert.rejects(configurePilot({env:{FLURBO_PILOT_DISABLED:'yes'},rpcUrl,command}));
  await assert.rejects(configurePilot({env:{},rpcUrl,command,read:async()=>{throw new Error('Missing manifest');}}));
});

test('rehearsal stays opt-in and cannot replace the official deployment',async()=>{
  const rpcUrl='https://testnet-rpc.monad.xyz',command=async()=>null;
  assert.equal(await configureRehearsal({env:{},rpcUrl,command}),null);
  const f=pilotFixture().manifest;
  await assert.rejects(configureRehearsal({env:{FLURBO_REHEARSAL_MANIFEST_JSON:JSON.stringify(f)},rpcUrl,command}));
  f.publication.mode='rehearsal';f.publication.draft.title='Public rehearsal: scripted settlement checks';
  const configured=await configureRehearsal({env:{FLURBO_REHEARSAL_MANIFEST_JSON:JSON.stringify(f)},rpcUrl,command});assert.equal(configured.manifest.pool,f.pool);
  await assert.rejects(configurePilot({env:{FLURBO_PILOT_MANIFEST_JSON:JSON.stringify(f)},rpcUrl,command}));
});
