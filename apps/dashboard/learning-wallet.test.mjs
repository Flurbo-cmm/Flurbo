import test from 'node:test';
import assert from 'node:assert/strict';
import { submit, validatePlan } from './learning-wallet.mjs';
const owner = '0x' + '11'.repeat(20), pool = '0x' + '22'.repeat(20), token = '0x' + '33'.repeat(20);
const word = n => BigInt(n).toString(16).padStart(64, '0');
function fixture() {
  const now = Math.floor(Date.now() / 1000);
  const snapshot = {chainId:'31339', pool, blockNumber:'7', blockHash:'0x'+'44'.repeat(32), revision:'1', timestamp:String(now)};
  const deadline = String(now + 120);
  return {kind:'buy', action:'buy', owner, pool, token, to:pool, chainId:31339, value:'0x0', snapshot,
    deadline, quantityAtoms:'1000000', limitAtoms:'300000', data:'0x3e6b6cde' + [3,8,1000000,300000,deadline].map(word).join('')};
}
function harness(plan, overrides={}) {
  const sent = [];
  const state = {owner,pool,token,checkpoint:{number:'0x0',hash:'0x'+'55'.repeat(32)}};
  const provider = { request: async ({method,params}) => {
    if (method === 'eth_sendTransaction') { sent.push(params[0]); if (overrides.reject) throw Object.assign(Error('User rejected'), {code:4001}); return '0x'+'66'.repeat(32); }
    if (method === 'eth_accounts') return [overrides.owner || owner];
    if (method === 'eth_chainId') return overrides.chain || '0x7a6b';
    if (method === 'eth_getBlockByNumber') return {hash: params[0] === '0x0' ? state.checkpoint.hash : plan.snapshot.blockHash};
    if (method === 'eth_call') {
      const data = params[0].data;
      if (data === '0x7cc96380') return '0x'+word(overrides.revision ?? 1);
      if (data === '0xdf034cd0') return '0x'+word(owner);
      if (data === '0xd8dfeb45') return '0x'+word(token);
      if (overrides.simulation) throw Error('Simulation reverted');
      return '0x';
    }
    throw Error('Unexpected RPC '+method);
  }};
  return {provider,state,sent};
}
test('wrong chain, switched account, revision and failed simulation cannot send', async () => {
  for (const overrides of [{chain:'0x279f'}, {owner:token}, {revision:2}, {simulation:true}]) {
    const plan=fixture(), h=harness(plan,overrides);
    await assert.rejects(submit(h.provider,plan,h.state)); assert.equal(h.sent.length,0);
  }
});
test('wallet rejection is propagated once without resubmission', async () => {
  const plan=fixture(), h=harness(plan,{reject:true});
  await assert.rejects(submit(h.provider,plan,h.state), {code:4001}); assert.equal(h.sent.length,1);
});
test('calldata destination and amounts cannot differ from the bounded review', () => {
  const plan=fixture(); validatePlan(plan);
  for (const patch of [{to:token},{value:'0x1'},{quantityAtoms:'2000000'},{limitAtoms:'1000001'},{data:plan.data+'00'},
    {deadline:'0'}, {snapshot:{...plan.snapshot, timestamp:'0'}}]) assert.throws(() => validatePlan({...plan,...patch}));
});
test('matching plan submits exactly the locally encoded transaction', async () => {
  const plan=fixture(), h=harness(plan);
  await submit(h.provider,plan,h.state);
  assert.deepEqual(h.sent,[{from:owner,to:pool,data:plan.data,value:'0x0'}]);
});
