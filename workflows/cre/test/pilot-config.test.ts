import { describe, test, expect } from 'bun:test';
import { decodeAbiParameters } from 'viem';
import { preparePilot, disputePolicy, VOID_POLICY, resolverConfigAbi, pilotRulesHash } from '../src/pilot-config';
import { releaseEvent } from '../src/github-release';

const now = 1_800_000_000;
function fixture() {
  const policy = { reviewers: [1, 2, 3].map(i => ({name: `Test reviewer ${i}`, address: `0x${String(i).padStart(40, '0')}`})),
    bondAtoms: '1000000', assertionPeriod: 86400, challengePeriod: 86400, votingPeriod: 86400 };
  return { schema: 'flurbo.pilot-publication.v1', creator: '0x0000000000000000000000000000000000000004',
    independentReviewersConfirmed: true, rulesReviewed: true, ...policy,
    draft: {schema: 'flurbo.event-draft.v1', status: 'draft', chainId: 10143, clusterId: 'test', title: 'Test fixtures only',
      closesAt: now + 7200,
      events: [releaseEvent({repository:'ethereum/go-ethereum',tag:'v99.0.0'}, 'geth', now+7300, now+86400),
        releaseEvent({repository:'paradigmxyz/reth',tag:'v99.0.0'}, 'reth', now+7300, now+86400)],
      exceptionPolicy: VOID_POLICY, disputeModel: 'reviewer-panel', disputePolicy: disputePolicy(policy) } };
}

describe('pilot publication commitments', () => {
  test('holder-only publications bind the dedicated signer and cannot silently reuse legacy policies',()=>{
    const original=fixture(),authority='0x0000000000000000000000000000000000000009';
    const value={...original,challengePolicy:{version:'account-holders-v1' as const,authority},draft:{...original.draft}};
    expect(()=>preparePilot(value,now)).toThrow();
    value.draft.disputePolicy=disputePolicy(value);
    const prepared=preparePilot(value,now),legacy=preparePilot(original,now);
    expect(prepared.draftHash).not.toBe(legacy.draftHash);
    const [c]=decodeAbiParameters(resolverConfigAbi,prepared.resolverConfig),resolver='0x0000000000000000000000000000000000000005';
    expect(pilotRulesHash(c,resolver,prepared.creator,value.challengePolicy)).not.toBe(pilotRulesHash(c,resolver,prepared.creator));
    for(const address of [original.creator,...original.reviewers.map(r=>r.address),'0x0000000000000000000000000000000000000000']){
      const bad={...value,challengePolicy:{...value.challengePolicy,authority:address},draft:{...value.draft}};
      bad.draft.disputePolicy=disputePolicy(bad);expect(()=>preparePilot(bad,now)).toThrow();
    }
  });
  test('operator-controlled reviewers require honest disclosure bound into the rules commitment',()=>{
    const independent=fixture();
    const operator={...fixture(),reviewerControl:'single-operator' as const,independentReviewersConfirmed:false};
    expect(()=>preparePilot(operator,now)).toThrow();
    operator.draft.disputePolicy=disputePolicy(operator);
    const prepared=preparePilot(operator,now);
    expect(prepared.publication.independentReviewersConfirmed).toBe(false);
    expect(prepared.publication.draft.disputePolicy).toContain('not independent reviewers');
    expect(prepared.draftHash).not.toBe(preparePilot(independent,now).draftHash);
    expect(()=>preparePilot({...operator,independentReviewersConfirmed:true},now)).toThrow();
    expect(()=>preparePilot({...operator,reviewerControl:'independent-panel'},now)).toThrow();
    const duplicate={...operator,reviewers:[operator.reviewers[0],operator.reviewers[0],operator.reviewers[2]]};
    duplicate.draft.disputePolicy=disputePolicy(duplicate);
    expect(()=>preparePilot(duplicate,now)).toThrow();
  });
  test('round trips exact resolver configuration and binds identity', () => {
    const prepared = preparePilot(fixture(), now);
    const [c] = decodeAbiParameters(resolverConfigAbi, prepared.resolverConfig);
    expect(c.draftHash).toBe(prepared.draftHash);
    expect(c.eventHashes).toEqual(prepared.eventHashes);
    expect(c.observationEnds[0]).toBe(BigInt(now+86400));
    const a = '0x0000000000000000000000000000000000000005', b = '0x0000000000000000000000000000000000000006';
    expect(pilotRulesHash(c,a,prepared.creator)).not.toBe(pilotRulesHash(c,b,prepared.creator));
    expect(pilotRulesHash(c,a,prepared.creator)).not.toBe(pilotRulesHash(c,a,b));
  });
  test('exact policies and meaningful reviewer declarations required', () => {
    for (const change of [(x: any) => { x.draft.exceptionPolicy='refund'; }, (x:any) => { x.draft.disputePolicy='admin decides'; },
      (x:any) => { x.independentReviewersConfirmed=false; }, (x:any) => { x.reviewers[1]=x.reviewers[0]; },
      (x:any) => { x.reviewers.pop(); }, (x:any) => { x.rulesReviewed=false; }]) {
      const value=fixture(); change(value); expect(() => preparePilot(value,now)).toThrow();
    }
  });
  test('expired close, unsupported sources and duplicate release targets rejected', () => {
    expect(() => preparePilot(fixture(),now+7200)).toThrow();
    const value=fixture(); value.draft.events[1]={...value.draft.events[0],id:'duplicate'};
    expect(() => preparePilot(value,now)).toThrow();
    const modified=fixture(); modified.draft.events[0].source.referenceUrl='https://attacker.com/releases';
    expect(() => preparePilot(modified,now)).toThrow();
  });
  test('changing reviewed dates or sources changes the commitment', () => {
    const a=fixture(), b=fixture(); b.draft.events[0].observationEndsAt++;
    expect(preparePilot(a,now).draftHash).not.toBe(preparePilot(b,now).draftHash);
  });
});

test('local resolver config ABI matches the web server ABI', async () => {
  const web = await import('../../../apps/web/server/settlement-publication.mjs');
  expect(resolverConfigAbi).toEqual(web.resolverConfigAbi);
});

test('new preparations default to deeper pools and reject unsafe liquidity', () => {
  const input = fixture() as any;
  expect(preparePilot(input, now).liquidityAtoms).toBe('250000000');
  expect(preparePilot(input, now, '10000000').liquidityAtoms).toBe('10000000');
  for (const bad of ['9999999', '0', '1e9', '1000000000001', '-5']) expect(() => preparePilot(input, now, bad)).toThrow(/Liquidity/);
});
