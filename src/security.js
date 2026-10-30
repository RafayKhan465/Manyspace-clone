// HMAC helpers (Web Crypto) for webhook signatures and dashboard sessions.

const encoder = new TextEncoder();

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex) {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function hmacHex(secret, message) {
  return toHex(await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(message)));
}

// Constant-time check of `hexSig` == HMAC-SHA256(secret, message).
export async function verifyHmac(secret, message, hexSig) {
  const sig = fromHex(String(hexSig || ''));
  if (!sig) return false;
  return crypto.subtle.verify('HMAC', await hmacKey(secret), sig, encoder.encode(message));
}

// Meta signs webhook bodies: X-Hub-Signature-256: sha256=<hex hmac of raw body with app secret>.
export async function verifyWebhookSignature(appSecret, rawBody, header) {
  if (!appSecret || !header || !header.startsWith('sha256=')) return false;
  return verifyHmac(appSecret, rawBody, header.slice('sha256='.length));
}

// Compares two strings without leaking where they differ.
export async function safeEqual(a, b) {
  const key = await hmacKey('compare');
  const [ha, hb] = await Promise.all([
    crypto.subtle.sign('HMAC', key, encoder.encode(String(a))),
    crypto.subtle.sign('HMAC', key, encoder.encode(String(b))),
  ]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// ---- signed tokens: "<payload>.<expiresAt>.<hmac>" ----
export async function signToken(secret, payload, ttlMs) {
  const body = `${payload}.${Date.now() + ttlMs}`;
  return `${body}.${await hmacHex(secret, body)}`;
}

export async function verifyToken(secret, token, expectedPayload) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return false;
  const [payload, expires, sig] = parts;
  if (payload !== expectedPayload || !(Number(expires) > Date.now())) return false;
  return verifyHmac(secret, `${payload}.${expires}`, sig);
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function cookie(name, value, { maxAge, secure = true } = {}) {
  const attrs = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (secure) attrs.push('Secure');
  if (maxAge !== undefined) attrs.push(`Max-Age=${Math.floor(maxAge)}`);
  return attrs.join('; ');
}
