import assert from 'node:assert/strict';
import {test} from 'node:test';
import {combineHoldings,accountOwners} from '../src/account-holdings.ts';

test('account holdings merge identical claims, preserve distinct answers and sum rounded payouts',()=>{
  const rows=combineHoldings([
    [{scope:1,mask:'2',quantity:'10000000',payoutAtoms:'5'},{scope:1,mask:'1',quantity:'4000000',payoutAtoms:null}],
    [{scope:1,mask:'2',quantity:'7000000',payoutAtoms:'3'},{scope:3,mask:'8',quantity:'2000000',payoutAtoms:null}],
  ]);
  assert.deepEqual(rows,[{scope:1,mask:'2',quantity:'17000000',payoutAtoms:'8'},{scope:1,mask:'1',quantity:'4000000',payoutAtoms:null},{scope:3,mask:'8',quantity:'2000000',payoutAtoms:null}]);
  assert.deepEqual(accountOwners('0xAB',['0xab','0xCD','0xcd']),['0xab','0xcd']);
  assert.equal(combineHoldings([[{scope:1,mask:'2',quantity:'1',payoutAtoms:'0'}],[{scope:1,mask:'2',quantity:'1',payoutAtoms:null}]])[0].payoutAtoms,null);
});
