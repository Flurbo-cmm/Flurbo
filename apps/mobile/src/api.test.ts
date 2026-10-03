import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiTransport, ORIGIN } from './api.ts';
test('native requests are restricted to canonical API and use platform cookies', async () => {
  const transport = createApiTransport(async (url, init) => {
    assert.equal(url, ORIGIN + '/api/auth/challenge');
    assert.equal(new Headers(init?.headers).get('Origin'), ORIGIN);
    assert.equal(init?.credentials, 'include'); assert.equal(init?.redirect, 'error');
    return new Response('{}');
  });
  await transport('/api/auth/challenge', { method: 'POST' });
  for (const url of ['https://other.site/api/x','//other.site/api/x','/api/../../login','/api/\\other.site']) await assert.rejects(transport(url));
});
