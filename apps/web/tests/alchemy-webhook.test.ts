import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import {
  validateAlchemySignature,
  parseAlchemyPayload,
  recordAlchemyActivities,
  getAlchemyActivities,
  handleAlchemyWebhook
} from '../server/alchemy-webhook.mjs';

const SIGNING_KEY = 'whsec_test_secret_key_12345';

function signPayload(body, key = SIGNING_KEY) {
  return crypto.createHmac('sha256', key).update(body, 'utf8').digest('hex');
}

test('validates Alchemy HMAC-SHA256 signature accurately', () => {
  const body = JSON.stringify({ test: 'alchemy-event' });
  const validSig = signPayload(body);
  assert.equal(validateAlchemySignature(body, validSig, SIGNING_KEY), true);

  // Altered body
  assert.equal(validateAlchemySignature(body + '!', validSig, SIGNING_KEY), false);

  // Wrong key
  const wrongKeySig = signPayload(body, 'whsec_different_key');
  assert.equal(validateAlchemySignature(body, wrongKeySig, SIGNING_KEY), false);

  // Missing or empty
  assert.equal(validateAlchemySignature(body, '', SIGNING_KEY), false);
  assert.equal(validateAlchemySignature(body, validSig, ''), false);
});

test('parses Alchemy address activity payload correctly', () => {
  const payload = {
    webhookId: 'wh_test_1',
    id: 'whevt_test_1',
    createdAt: '2026-10-02T12:00:00Z',
    type: 'ADDRESS_ACTIVITY',
    event: {
      network: 'MONAD_TESTNET',
      activity: [
        {
          fromAddress: '0x1111111111111111111111111111111111111111',
          toAddress: '0x2222222222222222222222222222222222222222',
          blockNum: '0x12a0',
          hash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          value: 10,
          asset: 'AUSD',
          category: 'token'
        },
        {
          fromAddress: '0x3333333333333333333333333333333333333333',
          toAddress: '0x4444444444444444444444444444444444444444',
          blockNum: '0x12a1',
          hash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          value: 0,
          asset: 'MON',
          category: 'external'
        }
      ]
    }
  };

  const parsed = parseAlchemyPayload(payload);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].category, 'pool-activity');
  assert.equal(parsed[0].blockNum, 4768);
  assert.equal(parsed[1].category, 'contract-call');
  assert.equal(parsed[1].blockNum, 4769);
  assert.throws(() => parseAlchemyPayload({ event: { network: 'ETH_MAINNET', activity: [] } }), /Unexpected Alchemy network/);
});

test('handles webhook requests with signature verification and activity storage', async () => {
  const payload = {
    event: {
      network: 'MONAD_TESTNET',
      activity: [
        {
          fromAddress: '0x1111111111111111111111111111111111111111',
          toAddress: '0x2222222222222222222222222222222222222222',
          blockNum: '0x100',
          hash: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
          value: 5,
          asset: 'AUSD',
          category: 'token'
        }
      ]
    }
  };
  const rawBody = JSON.stringify(payload);
  const signature = signPayload(rawBody);

  // Valid signature
  const resSuccess = await handleAlchemyWebhook({
    rawBody,
    signature,
    signingKey: SIGNING_KEY
  });
  assert.equal(resSuccess.status, 200);
  assert.equal(resSuccess.body.ok, true);
  assert.equal(resSuccess.body.processed, 1);

  // Check activity getter
  const store = getAlchemyActivities(SIGNING_KEY);
  assert.equal(store.network, 'monad-testnet');
  assert.equal(store.chainId, 10143);
  assert.equal(store.active, true);
  assert.ok(store.events.length > 0);

  // Invalid signature
  const resBadSig = await handleAlchemyWebhook({
    rawBody,
    signature: 'invalid_sig',
    signingKey: SIGNING_KEY
  });
  assert.equal(resBadSig.status, 401);

  // Malformed JSON
  const badBody = '{ bad json';
  const badSig = signPayload(badBody);
  const resBadJson = await handleAlchemyWebhook({
    rawBody: badBody,
    signature: badSig,
    signingKey: SIGNING_KEY
  });
  assert.equal(resBadJson.status, 400);
});
