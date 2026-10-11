import {test} from 'node:test';
import assert from 'node:assert/strict';
import {settlementSources} from '../shared/settlement-sources.mjs';
import {poolFixture} from './pool-fixture.ts';

const time=1800000000;
const releaseEvent=(repository:string,tag:string)=>({id:repository.split('/')[1],question:`Will ${repository} publish stable release ${tag} during the specified observation window?`,
  yesRule:'YES requires the exact tagged release to be public, not a draft or prerelease, with published_at in [observationStartsAt, observationEndsAt).',
  noRule:'NO requires reviewed evidence that no qualifying publication occurred throughout the full window. A missing API response is not proof of NO.',
  observationStartsAt:time-100,observationEndsAt:time-1,
  source:{recordId:`${repository}@${tag}`,publisher:repository.split('/')[0],referenceUrl:`https://github.com/${repository}/releases`,
    selectionRule:'github-stable-release-publication.v1: match exact repository, tag, release ID and canonical API/HTML URLs.'}});

test('release questions publish the exact GitHub API record the settlement check reads',()=>{
  const manifest={publication:{mode:'official-releases',draft:{events:[releaseEvent('ethereum/go-ethereum','v1.17.7'),releaseEvent('paradigmxyz/reth','v2.6.1')]}}};
  assert.deepEqual(settlementSources(manifest),[
    {method:'github-stable-release-publication.v1',request:'GET',urls:['https://api.github.com/repos/ethereum/go-ethereum/releases/tags/v1.17.7']},
    {method:'github-stable-release-publication.v1',request:'GET',urls:['https://api.github.com/repos/paradigmxyz/reth/releases/tags/v2.6.1']},
  ]);
});

test('mechanical questions publish every exact address in their committed settlement rule',()=>{
  const manifest:any=poolFixture().manifest,sources=settlementSources(manifest);
  assert.equal(sources.length,manifest.publication.draft.events.length);
  sources.forEach((source,i)=>assert.deepEqual(source,{method:'json-api.v1',request:'GET',urls:manifest.publication.settlementRules[i].source.urls}));
});

test('practice questions and questions without a machine-checked source publish nothing',()=>{
  const practice={publication:{mode:'rehearsal',draft:{events:[releaseEvent('ethereum/go-ethereum','v1.17.7')]}}};
  assert.deepEqual(settlementSources(practice),[null]);
  const unknown={publication:{mode:'official-releases',draft:{events:[{id:'x',source:{recordId:'something-else',selectionRule:'manual'}}]}}};
  assert.deepEqual(settlementSources(unknown),[null]);
  assert.deepEqual(settlementSources(null),[]);
});
