import { prepareEventDraft } from '../src/event-draft';

// Local file validation only. No HTTP requests, signing or report submission.
const [file, ...extra] = Bun.argv.slice(2);
if (!file || extra.length) {
  console.error('Usage: bun scripts/review-event-draft.ts <draft.json>');
  process.exitCode = 1;
} else {
  try {
    const result = prepareEventDraft(await Bun.file(file).json(), Math.floor(Date.now() / 1000));
    console.log(JSON.stringify({
      status: result.status, deployable: result.deployable, clusterId: result.draft.clusterId,
      draftHash: result.draftHash, eventBits: result.eventBits, blockers: result.blockers,
    }, null, 2));
  } catch {
    console.error('Invalid event draft. Check the required fields, public source references and observation windows.');
    process.exitCode = 1;
  }
}
