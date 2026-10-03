import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ACTIVITY_METRICS,activityEvent,validateActivityDraft} from '../shared/ethereum-activity.mjs';
import {marketQuestion,showcaseCopy} from '../src/showcase-copy.ts';

test('Showcase display copy clarifies each metric without changing committed events',()=>{
  const closesAt=1790365560,events=ACTIVITY_METRICS.map(metric=>activityEvent(metric,closesAt+120));
  const draft={title:'Showcase v0',clusterId:`showcase-v0-${closesAt}`,closesAt,events};
  const before=JSON.stringify(draft);
  for(const event of events){
    assert.match(marketQuestion(event),/selected Ethereum block/);
    assert.ok(showcaseCopy(event)?.description);
  }
  assert.match(showcaseCopy(events[0])!.description,/gas limit/);
  assert.match(showcaseCopy(events[2])!.description,/equal or lower.*No/);
  assert.match(showcaseCopy(events[3])!.description,/393,216/);
  assert.equal(JSON.stringify(draft),before);
  assert.equal(validateActivityDraft(draft),closesAt+120);
  assert.equal(marketQuestion({id:'practice-a',question:'Will the night market open?'}),'Will the night market open?');
  assert.equal(marketQuestion({...events[0],question:'A different threshold?'}),'A different threshold?');
});
