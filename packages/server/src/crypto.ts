import type { webcrypto } from 'node:crypto';

/**
 * Signature verification and App JWT minting, using Web Crypto only.
 *
 * Ported unchanged from the Cloudflare worker: Node 22 exposes the same
 * `crypto.subtle` API, so the code that held up there holds up here.
 */

function base64UrlEncode(bytes: Uint8Array | ArrayBuffer): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Constant-time comparison.
 *
 * A webhook signature check that short-circuits on the first differing byte
 * leaks how much of a forged signature was correct.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify GitHub's `X-Hub-Signature-256` header against the raw body.
 *
 * The body must be the exact bytes GitHub sent — parse JSON only after this
 * passes, never before.
 */
export async function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  signatureHeader: string | null,
): Promise<boolean> {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const expected = `sha256=${[...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  return timingSafeEqual(expected, signatureHeader);
}

const PEM_BODY = /-----BEGIN [^-]+-----([\s\S]*?)-----END [^-]+-----/;

/**
 * ASN.1 prefix that wraps a PKCS#1 RSAPrivateKey as a PKCS#8 PrivateKeyInfo.
 *
 * GitHub hands out PKCS#1 (`BEGIN RSA PRIVATE KEY`) but Web Crypto only imports
 * PKCS#8, and the difference is a fixed header — so wrap it rather than making
 * every operator run `openssl pkcs8` before they can deploy.
 */
const PKCS8_RSA_PREFIX = new Uint8Array([
  0x30, 0x82, 0x00, 0x00, // SEQUENCE, length patched below
  0x02, 0x01, 0x00, // INTEGER 0 (version)
  0x30, 0x0d, // SEQUENCE (AlgorithmIdentifier)
  0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, // OID rsaEncryption
  0x05, 0x00, // NULL
  0x04, 0x82, 0x00, 0x00, // OCTET STRING, length patched below
]);

function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const prefix = new Uint8Array(PKCS8_RSA_PREFIX);
  const octetLen = pkcs1.length;
  const seqLen = octetLen + prefix.length - 4; // everything after the outer header

  prefix[2] = (seqLen >> 8) & 0xff;
  prefix[3] = seqLen & 0xff;
  prefix[prefix.length - 2] = (octetLen >> 8) & 0xff;
  prefix[prefix.length - 1] = octetLen & 0xff;

  const out = new Uint8Array(prefix.length + octetLen);
  out.set(prefix, 0);
  out.set(pkcs1, prefix.length);
  return out;
}

async function importPrivateKey(pem: string): Promise<webcrypto.CryptoKey> {
  const match = PEM_BODY.exec(pem.trim());
  if (!match?.[1]) {
    throw new Error('APP_PRIVATE_KEY is not a PEM block. Paste the .pem GitHub gave you, newlines included.');
  }
  const der = base64ToBytes(match[1].replace(/\s+/g, ''));
  const isPkcs1 = /BEGIN RSA PRIVATE KEY/.test(pem);
  const pkcs8 = isPkcs1 ? pkcs1ToPkcs8(der) : der;

  return crypto.subtle.importKey(
    'pkcs8',
    // A fresh ArrayBuffer keeps the typed-array view out of the call.
    pkcs8.slice().buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

/**
 * A short-lived App JWT, used only to exchange for an installation token.
 *
 * GitHub rejects anything over 10 minutes and is strict about clock skew, so
 * backdate `iat` by a minute.
 */
export async function createAppJwt(appId: string, privateKeyPem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = { iat: now - 60, exp: now + 540, iss: appId };

  const encoder = new TextEncoder();
  const signingInput = `${base64UrlEncode(encoder.encode(JSON.stringify(header)))}.${base64UrlEncode(
    encoder.encode(JSON.stringify(payload)),
  )}`;

  const key = await importPrivateKey(privateKeyPem);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(signingInput));
  return `${signingInput}.${base64UrlEncode(signature)}`;
}
