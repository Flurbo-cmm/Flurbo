import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readCheckout,saveCheckout,clearCheckout,restorableCheckout,markCheckoutVisited,type CheckoutDraft} from '../src/checkout.ts';

test('checkout drafts restore inputs after approval, isolate login and pool, and contain no transaction authorization',()=>{
  const db=new Map<string,string>();
  const previous=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(k:string)=>db.get(k)??null,setItem:(k:string,v:string)=>db.set(k,v),removeItem:(k:string)=>db.delete(k)}});
  const draft={event:1,yes:false,legs:[1],answers:{1:false},quantity:'5',side:'buy' as const,walletKind:'browser' as const};
  try{
    saveCheckout('rehearsal','0xABC',draft);assert.deepEqual(readCheckout('rehearsal','0xabc'),draft);
    assert.equal(readCheckout('pilot','0xabc'),null);assert.equal(readCheckout('rehearsal','0xdef'),null);
    const combined={...draft,legs:[0,1],rule:'OR' as const};
    saveCheckout('rehearsal','0xabc',combined);assert.deepEqual(readCheckout('rehearsal','0xabc'),combined);
    assert.throws(()=>saveCheckout('rehearsal','0xabc',{...combined,rule:'XOR' as any}));
    assert.throws(()=>saveCheckout('rehearsal','0xabc',{...draft,rule:'AT_LEAST_TWO'}));
    assert.throws(()=>saveCheckout('rehearsal','0xabc',{...draft,legs:[0,1,2,3]}));
    clearCheckout('rehearsal','0xabc');assert.equal(readCheckout('rehearsal','0xabc'),null);
    db.set('flurbo.checkout.v1:rehearsal:0xabc',JSON.stringify({...draft,event:99}));assert.throws(()=>readCheckout('rehearsal','0xabc'));
  }finally{if(previous)Object.defineProperty(globalThis,'localStorage',previous);else delete (globalThis as any).localStorage;}
});

const LOGIN='0x'+'4'.repeat(40);
const single: CheckoutDraft = { event: 1, yes: true, legs: [1], answers: { 1: true }, rule: 'AND', quantity: '2', side: 'buy' };
const combined: CheckoutDraft = { event: 1, yes: true, legs: [0, 1], answers: { 0: true, 1: true }, rule: 'AND', quantity: '1', side: 'buy' };

test('a single-answer draft is always restored',()=>{
  assert.equal(restorableCheckout('pilot',LOGIN,single,false),single);
  assert.equal(restorableCheckout('pilot',LOGIN,null,false),null);
});

test('a combined draft survives a reload but a return from elsewhere in the app starts from the single answer',()=>{
  const login='0x'+'5'.repeat(40);
  assert.equal(restorableCheckout('pilot',login,combined,false),combined,'first open in this page load: reload recovery');
  markCheckoutVisited('pilot',login);
  assert.equal(restorableCheckout('pilot',login,combined,false),null,'returning within the app');
  assert.equal(restorableCheckout('pilot',login,combined,true),combined,'a pending transaction keeps its combination');
  const bound={...combined,binding:{pool:'0x'+'1'.repeat(40),rulesHash:'0x'+'2'.repeat(64)}};
  assert.equal(restorableCheckout('pilot',login,bound,false),bound,'thesis explorer handoff');
});
