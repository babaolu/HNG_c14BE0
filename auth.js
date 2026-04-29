import crypto from 'crypto';

const ACCESS_TOKEN_TTL_SECONDS = parseInt(process.env.ACCESS_TOKEN_TTL_SECONDS || '900', 10); // 15m
const REFRESH_TOKEN_TTL_SECONDS = parseInt(process.env.REFRESH_TOKEN_TTL_SECONDS || '86400', 10); // 24h
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

function signJwt(payload, ttlSeconds = ACCESS_TOKEN_TTL_SECONDS) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const body = { ...payload, iat: now, exp: now + ttlSeconds };
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(body));
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${signature}`;
}

function verifyJwt(token) {
  const [h, p, sig] = (token || '').split('.');
  if (!h || !p || !sig) return null;
  const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

function randomToken(size = 32) {
  return crypto.randomBytes(size).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function pkcePair() {
  const verifier = randomToken(48);
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge, method: 'S256' };
}

function createCsrfToken() {
  return randomToken(24);
}

export {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  signJwt,
  verifyJwt,
  randomToken,
  hashToken,
  pkcePair,
  createCsrfToken,
};
