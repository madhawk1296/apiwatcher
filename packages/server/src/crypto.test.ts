import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHmac, generateKeyPairSync, createPublicKey, createVerify } from 'node:crypto';

import { createAppJwt, verifyWebhookSignature } from './crypto.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

const pkcs1Pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const pkcs8Pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

function decodeSegment(segment: string): unknown {
  return JSON.parse(Buffer.from(segment.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}

/** Verify an RS256 JWT the way GitHub would. */
function jwtIsValid(token: string, spkiPem: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [header, payload, signature] = parts as [string, string, string];
  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${header}.${payload}`);
  return verifier.verify(
    createPublicKey(spkiPem),
    Buffer.from(signature.replace(/-/g, '+').replace(/_/g, '/'), 'base64'),
  );
}

test('an App JWT from a PKCS#8 key verifies against the public key', async () => {
  const token = await createAppJwt('123456', pkcs8Pem);
  assert.equal(jwtIsValid(token, publicPem), true);
});

test('an App JWT from a PKCS#1 key verifies too', async () => {
  // GitHub hands out `BEGIN RSA PRIVATE KEY` (PKCS#1) but Web Crypto only
  // imports PKCS#8, so the wrapping has to be byte-correct.
  assert.match(pkcs1Pem, /BEGIN RSA PRIVATE KEY/);
  const token = await createAppJwt('123456', pkcs1Pem);
  assert.equal(jwtIsValid(token, publicPem), true);
});

test('App JWT claims match what GitHub requires', async () => {
  const token = await createAppJwt('987', pkcs8Pem);
  const [headerSeg, payloadSeg] = token.split('.') as [string, string, string];

  assert.deepEqual(decodeSegment(headerSeg), { alg: 'RS256', typ: 'JWT' });
  const payload = decodeSegment(payloadSeg) as { iat: number; exp: number; iss: string };
  assert.equal(payload.iss, '987');

  const now = Math.floor(Date.now() / 1000);
  assert.ok(payload.iat <= now - 30, 'iat should be backdated to survive clock skew');
  assert.ok(payload.exp - payload.iat <= 600, 'GitHub rejects a lifetime over 10 minutes');
  assert.ok(payload.exp > now, 'token should not already be expired');
});

test('a malformed private key fails with a useful message', async () => {
  await assert.rejects(() => createAppJwt('1', 'not a pem'), /not a PEM block/);
});

// --- webhook signatures ----------------------------------------------------

const SECRET = 'it is a secret to everybody';
const BODY = JSON.stringify({ action: 'created', installation: { id: 1 } });

function sign(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

test('a correct webhook signature is accepted', async () => {
  assert.equal(await verifyWebhookSignature(SECRET, BODY, sign(SECRET, BODY)), true);
});

test('a signature from the wrong secret is rejected', async () => {
  assert.equal(await verifyWebhookSignature(SECRET, BODY, sign('wrong secret', BODY)), false);
});

test('a signature over different bytes is rejected', async () => {
  const forged = sign(SECRET, `${BODY} `);
  assert.equal(await verifyWebhookSignature(SECRET, BODY, forged), false);
});

test('missing or malformed signature headers are rejected', async () => {
  assert.equal(await verifyWebhookSignature(SECRET, BODY, null), false);
  assert.equal(await verifyWebhookSignature(SECRET, BODY, ''), false);
  assert.equal(await verifyWebhookSignature(SECRET, BODY, 'sha1=abc'), false);
  // Right length, wrong content — the constant-time path must still say no.
  assert.equal(await verifyWebhookSignature(SECRET, BODY, `sha256=${'0'.repeat(64)}`), false);
});
