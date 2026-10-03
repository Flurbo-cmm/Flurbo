// Converts a small, explicitly reviewed release selection into the exact supported rule template.
// No network access, wallet access, deployment or inferred reviewer consent.
import { z } from 'zod';
import { releaseEvent, releaseTargetSchema } from '../src/github-release';
import { VOID_POLICY, disputePolicy, preparePilot } from '../src/pilot-config';

const inputSchema=z.object({
  creator:z.string(),clusterId:z.string(),title:z.string(),closesAt:z.number().int(),
  reviewers:z.array(z.object({name:z.string(),address:z.string()}).strict()),
  reviewerControl:z.enum(['independent-panel','single-operator']).default('independent-panel'),
  independentReviewersConfirmed:z.boolean(),rulesReviewed:z.literal(true),
  bondAtoms:z.string(),assertionPeriod:z.number().int(),challengePeriod:z.number().int(),votingPeriod:z.number().int(),
  events:z.array(z.object({id:z.string(),target:releaseTargetSchema,observationStartsAt:z.number().int(),observationEndsAt:z.number().int()}).strict()).min(2).max(4),
}).strict();
if(process.argv.length!==3)throw new Error('Usage: bun scripts/create-pilot-publication.ts <reviewed-selection.json>');
const input=inputSchema.parse(await Bun.file(process.argv[2]).json());
const {clusterId,title,closesAt,events,...policy}=input;
const publication={schema:'flurbo.pilot-publication.v1',...policy,
  draft:{schema:'flurbo.event-draft.v1',status:'draft',chainId:10143,clusterId,title,closesAt,
    events:events.map(e=>releaseEvent(e.target,e.id,e.observationStartsAt,e.observationEndsAt)),
    exceptionPolicy:VOID_POLICY,disputeModel:'reviewer-panel',disputePolicy:disputePolicy(input)}};
preparePilot(publication,Math.floor(Date.now()/1000));
console.log(JSON.stringify(publication,null,2));
