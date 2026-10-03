import { test,expect } from 'bun:test';
import { decodeAbiParameters } from 'viem';
import { prepareOctoberDemo,OCTOBER_CLOSE } from '../src/october-demo';
import { resolverConfigAbi } from '../src/pilot-config';
const selection={creator:'0x0000000000000000000000000000000000000004',reviewers:[1,2,3].map(i=>({name:`Test reviewer ${i}`,address:`0x${String(i).padStart(40,'0')}`}))};
test('October configuration commits the approved dates and existing four scripted cases',()=>{
  const now=Date.parse('2026-09-25T00:00:00Z')/1000,prepared=prepareOctoberDemo(selection,now);
  const [c]=decodeAbiParameters(resolverConfigAbi,prepared.resolverConfig);
  expect(new Date(Number(c.closesAt)*1000).toISOString()).toBe('2026-10-14T12:00:00.000Z');
  expect(c.observationEnds).toEqual(Array(4).fill(BigInt(OCTOBER_CLOSE+120)));
  expect(c.assertionPeriod).toBe(3600);expect(c.challengePeriod).toBe(3600);expect(c.votingPeriod).toBe(3600);
  expect(prepared.publication.mode).toBe('rehearsal');expect(prepared.publication.independentReviewersConfirmed).toBe(false);
  expect(prepareOctoberDemo(selection,now+86400).configHash).toBe(prepared.configHash);
  expect(()=>prepareOctoberDemo(selection,OCTOBER_CLOSE-3600)).toThrow();
});
