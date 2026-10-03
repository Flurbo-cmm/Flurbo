import crypto from 'node:crypto';

// In-memory ring buffer of recent Alchemy-streamed events for real-time reactivity
const recentActivities = [];
const MAX_ACTIVITIES = 50;
let lastVerifiedDeliveryAt = null;

export function validateAlchemySignature(rawBody, signature, signingKey) {
  if (!signingKey) return false;
  if (!signature || typeof signature !== 'string') return false;
  const hmac = crypto.createHmac('sha256', signingKey);
  hmac.update(rawBody, 'utf8');
  const digest = hmac.digest('hex');
  const sigBuffer = Buffer.from(signature, 'utf8');
  const digestBuffer = Buffer.from(digest, 'utf8');
  if (sigBuffer.length !== digestBuffer.length) return false;
  return crypto.timingSafeEqual(sigBuffer, digestBuffer);
}

export function parseAlchemyPayload(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('Invalid JSON payload');
  if ((payload.event?.network || payload.network) !== 'MONAD_TESTNET') throw new Error('Unexpected Alchemy network');
  const activityList = payload.event?.activity || payload.activity || [];
  if (!Array.isArray(activityList)) throw new Error('Invalid activity list');

  const parsed = [];
  for (const item of activityList) {
    const to = (item.toAddress || item.to || '').toLowerCase();
    const from = (item.fromAddress || item.from || '').toLowerCase();
    const hash = item.hash || '';
    const blockNum = typeof item.blockNum === 'string' ? parseInt(item.blockNum, 16) : Number(item.blockNum || 0);

    let category = 'transfer';
    if (item.category === 'token' || item.asset === 'AUSD') {
      category = 'pool-activity';
    } else if (item.category === 'external') {
      category = 'contract-call';
    }

    parsed.push({
      hash,
      from,
      to,
      blockNum,
      category,
      asset: item.asset || 'MON',
      value: item.value ?? 0,
      timestamp: Date.now()
    });
  }

  return parsed;
}

export function recordAlchemyActivities(activities) {
  for (const act of activities) {
    recentActivities.unshift(act);
    if (recentActivities.length > MAX_ACTIVITIES) {
      recentActivities.pop();
    }
  }
}

export function getAlchemyActivities(signingKey = process.env.FLURBO_ALCHEMY_WEBHOOK_SIGNING_KEY) {
  return {
    network: 'monad-testnet',
    chainId: 10143,
    provider: 'Alchemy',
    configured: Boolean(signingKey),
    active: Boolean(signingKey && lastVerifiedDeliveryAt && Date.now() - lastVerifiedDeliveryAt < 24 * 60 * 60 * 1000),
    lastVerifiedDeliveryAt,
    totalTracked: recentActivities.length,
    events: [...recentActivities]
  };
}

export async function handleAlchemyWebhook({ rawBody, signature, signingKey }) {
  if (signingKey) {
    const valid = validateAlchemySignature(rawBody, signature, signingKey);
    if (!valid) {
      return { status: 401, body: { error: 'Invalid Alchemy webhook signature' } };
    }
  } else {
    return { status: 503, body: { error: 'Alchemy webhook signing key is not configured' } };
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: 'Malformed JSON payload' } };
  }

  try {
    const activities = parseAlchemyPayload(payload);
    recordAlchemyActivities(activities);
    lastVerifiedDeliveryAt = Date.now();
    return {
      status: 200,
      body: {
        ok: true,
        processed: activities.length,
        timestamp: Date.now()
      }
    };
  } catch (err) {
    return { status: 400, body: { error: err.message || 'Processing failed' } };
  }
}
