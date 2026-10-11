import {test} from 'node:test';
import assert from 'node:assert/strict';
import {marketQuestion,showcaseCopy} from '../src/showcase-copy.ts';

// The committed showcase questions, exactly as published.
const events=[['ethereum-fullness','Will Ethereum fill at least 75% of a block?'],['ethereum-transactions','Will Ethereum include at least 150 transactions?'],
  ['ethereum-fees','Will Ethereum’s base fee rise?'],['ethereum-blobs','Will Ethereum carry at least 3 blobs?']].map(([id,question])=>({id,question}));

test('Showcase display copy clarifies each metric without changing committed events',()=>{
  const before=JSON.stringify(events);
  for(const event of events){
    assert.match(marketQuestion(event),/selected Ethereum block/);
    assert.ok(showcaseCopy(event)?.description);
  }
  assert.match(showcaseCopy(events[0])!.description,/gas limit/);
  assert.match(showcaseCopy(events[2])!.description,/equal or lower.*No/);
  assert.match(showcaseCopy(events[3])!.description,/393,216/);
  assert.equal(JSON.stringify(events),before);
  assert.equal(marketQuestion({id:'practice-a',question:'Will the night market open?'}),'Will the night market open?');
  assert.equal(marketQuestion({...events[0],question:'A different threshold?'}),'A different threshold?');
});
