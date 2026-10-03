import { MAX_RELEASE_BYTES, observeRelease, releaseEndpoint, releaseTargetForEvent } from '../src/github-release';

// Explicit local read. Never accepts a caller-selected network URL or credentials.
const [file, eventId, ...extra] = Bun.argv.slice(2);
if (!file || !eventId || extra.length) {
  console.error('Usage: bun scripts/observe-github-release.ts <draft.json> <event-id>');
  process.exitCode = 1;
} else {
  try {
    const draft = await Bun.file(file).json();
    const { target } = releaseTargetForEvent(draft, eventId);
    const response = await fetch(releaseEndpoint(target), {
      redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Flurbo-event-source-review', 'X-GitHub-Api-Version': '2026-03-10' },
    });
    let body = '';
    if (response.status === 200) {
      if (!response.body) throw new Error('Missing body');
      const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
      let size = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > MAX_RELEASE_BYTES) throw new Error('Response too large');
          body += decoder.decode(chunk.value, { stream: true });
        }
        body += decoder.decode();
      } finally { await reader.cancel(); }
    } else { await response.body?.cancel(); }
    const observation = observeRelease(draft, eventId, response.status, body, Math.floor(Date.now() / 1000));
    // Keep the public response with candidate evidence for local review/replay.
    // This output is not durable hosting, DON authentication or a settlement report.
    console.log(JSON.stringify({ observation, sourcePayload: observation.status === 'candidate' ? body : null }, null, 2));
    if (observation.status !== 'candidate') process.exitCode = 2;
  } catch {
    console.error('Release evidence unavailable. Check the event template and retry the source read; no outcome was produced.');
    process.exitCode = 1;
  }
}
