import assert from 'node:assert/strict';
import {test} from 'node:test';
import {accountActivity,realizedPerformance,type TradeActivity} from '../src/portfolio-performance.ts';
const owner='0x'+'11'.repeat(20),other='0x'+'22'.repeat(20),pool='0x'+'33'.repeat(20),hash='0x'+'44'.repeat(32);
const trade=(action:TradeActivity['action'],quantity:bigint,cash:bigint,block:number,overrides:Partial<TradeActivity>={}):TradeActivity=>({namespace:'pilot',pool,owner,scope:1,mask:'2',action,quantity,cash,block,hash,index:0,...overrides});
test('realized PnL allocates average cost on partial sales, retains rounding dust and includes redemptions',()=>{
  const p=realizedPerformance([trade('Buy',3n,10n,1),trade('Sell',1n,5n,2),trade('Payout',2n,12n,3)]);
  assert.equal(p.valid,true);assert.deepEqual(p.points.map(p=>p.value),[2n,7n]);assert.equal(p.realized,7n);assert.equal([...p.inventory.values()][0].cost,0n);
});
test('cost basis never crosses wallets, pools or opposite outcomes; uncollected positions are not profit',()=>{
  const p=realizedPerformance([trade('Buy',10n,8n,1),trade('Buy',10n,2n,2,{owner:other}),trade('Sell',5n,3n,3),trade('Buy',10n,9n,4,{pool:other}),trade('Buy',10n,1n,5,{mask:'1'})]);
  assert.equal(p.realized,-1n);assert.equal(p.inventory.size,4);assert.equal(p.valid,true);
  assert.equal(realizedPerformance([trade('Payout',10n,10n,2)]).valid,false);
});
test('activity excludes approvals, other accounts and duplicate logs, and keeps buys, sales and payouts',()=>{
  const log={name:'Traded',hash,index:0,block:1,args:{trader:owner,scope:1,mask:'2',quantity:'1000000',collateralAmount:'500000',isBuy:true}};
  const rows=accountActivity('pilot',pool,[log,log,{...log,index:1,args:{...log.args,trader:other}},{...log,index:2,name:'Approved'},{...log,index:3,name:'Redeemed',args:{owner,scope:1,mask:'2',quantity:'1000000',collateralAmount:'1000000'}}],[owner]);
  assert.equal(rows.length,2);assert.deepEqual(rows.map(r=>r.action),['Buy','Payout']);assert.equal(realizedPerformance(rows).realized,500000n);
});
