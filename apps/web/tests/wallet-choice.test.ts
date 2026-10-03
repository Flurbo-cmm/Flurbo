import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isMetaMask} from '../../dashboard/metamask.mjs';
import {discoverWallets} from '../src/auth/wallet-choice.ts';

test('MetaMask discovery filters competing extensions and deduplicates announcements', () => {
  const original=globalThis.window;
  const surface=new EventTarget() as any;
  const phantom={request:async()=>[],isMetaMask:true,isPhantom:true};
  const metamask={request:async()=>[],isMetaMask:true};
  surface.ethereum=phantom;
  globalThis.window=surface;
  const found:any[]=[];
  const announce=(provider:any,rdns:string)=>surface.dispatchEvent(new CustomEvent('eip6963:announceProvider',{detail:{provider,info:{name:'Wallet',rdns}}}));
  const stop=discoverWallets(w=>found.push(w));
  try {
    announce(phantom,'app.phantom');announce({request:async()=>[]},'io.rabby');
    assert.equal(found.length,0);
    announce(metamask,'io.metamask');announce(metamask,'io.metamask');
    assert.equal(found.length,1);assert.equal(found[0].name,'MetaMask');
    assert.equal(isMetaMask({...metamask,isCoinbaseWallet:true}),false);
    assert.equal(isMetaMask({request:async()=>[]}),false);
    assert.equal(isMetaMask(metamask),true);
    stop();announce({request:async()=>[]},'io.metamask');assert.equal(found.length,1);
  } finally {stop();globalThis.window=original;}
});
