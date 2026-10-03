import {test} from 'node:test';
import assert from 'node:assert/strict';
import {privateKeyToAccount} from 'viem/accounts';
import {resolutionSigner,resolutionFailure,runResolution} from '../scripts/run-resolution.mjs';

// Public, disposable fixture key. Never used on a deployed network.
const hex='12'.repeat(32),key=`0x${hex}` as `0x${string}`;
const owner=privateKeyToAccount(key).address;
function failure(value:unknown,address=owner){
  try{resolutionSigner(value,address);assert.fail('Expected signer rejection');}
  catch(error){return resolutionFailure(error);}
}
test('bot key accepts wallet exports with or without hex prefix and surrounding whitespace',()=>{
  for(const value of [key,hex,` \n${key}\r\n`, `0X${hex}`]){
    assert.equal(resolutionSigner(value,owner.toLowerCase()).address,owner);
  }
});
test('bot key rejects missing, malformed, out of range and different-wallet values safely',()=>{
  assert.equal(failure(undefined).code,'BOT_KEY_MISSING');
  assert.equal(failure(' \n').code,'BOT_KEY_MISSING');
  for(const value of ['secret phrase never print',JSON.stringify({privateKey:key}),`"${key}"`,'00'.repeat(32),'ff'.repeat(32),hex.slice(2)]){
    const result=failure(value);
    assert.equal(result.code,'BOT_KEY_INVALID');
    assert.ok(!JSON.stringify(result).includes(value));
  }
  const result=failure(key,'0x'+'34'.repeat(20));
  assert.equal(result.code,'BOT_KEY_MISMATCH');
  assert.ok(!JSON.stringify(result).includes(hex));
});
test('diagnostics never serialize arbitrary upstream errors or environment input',async()=>{
  const secret='sentinel-do-not-log';
  const result=resolutionFailure(Object.assign(Error(secret),{code:secret,cause:secret}));
  assert.equal(result.code,'WORKER_CHECK_FAILED');
  assert.ok(!JSON.stringify(result).includes(secret));
  await assert.rejects(runResolution({FLURBO_RESOLUTION_MANIFEST_JSON:secret}),error=>{
    const result=resolutionFailure(error);
    assert.equal(result.code,'CONFIGURATION_INVALID');
    assert.ok(!JSON.stringify(result).includes(secret));return true;
  });
});
