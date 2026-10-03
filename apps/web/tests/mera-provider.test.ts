import assert from 'node:assert/strict';
import {test} from 'node:test';
import {AuthController} from '../src/auth/controller.ts';
import {authPolicy} from '../src/auth/policy.ts';
import {meraProvider} from '../src/auth/mera-provider.ts';
import {pilotMera} from '../src/pilot.ts';

test('Mera login remains usable but every legacy adapter refuses signing before any RPC', async () => {
  const controller = new AuthController({policy:authPolicy('http://localhost:18767',true,true,true),client:{
    async createCredential(){throw Error('unused');},
    async getCredential(){return {credentialId:new Uint8Array([1]),prfOutput:new Uint8Array(32).fill(9)};}
  }});
  const original=globalThis.fetch; let calls=0;
  globalThis.fetch=async()=>{calls++;throw Error('No RPC expected');};
  const originalPool=meraProvider(controller),learning=meraProvider(controller,'learning');
  try {
    assert.equal(await controller.authenticate('login'),true);
    assert.equal(controller.getSnapshot().signingExpiresAt,null);
    await assert.rejects(controller.signDigest('0x'+'00'.repeat(32)),/account access only/);
    for(const provider of [originalPool,learning,pilotMera(controller),pilotMera(controller,'rehearsal')]) {
      assert.deepEqual(await provider.request({method:'eth_accounts'}),[controller.getSnapshot().address]);
      for(const method of ['eth_sendTransaction','eth_sendRawTransaction','eth_sign','personal_sign','eth_signTypedData_v4']) {
        await assert.rejects(provider.request({method,params:[]}),/account access only/);
      }
    }
    assert.equal(calls,0);
  } finally {globalThis.fetch=original;originalPool.destroy();learning.destroy();await controller.signOut();}
});
