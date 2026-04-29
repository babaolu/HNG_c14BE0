import express from 'express';
import cors from 'cors';
import { uuidv7 } from 'uuidv7';
import { getAgeGroup, queryProfiles, parseNaturalLanguageQuery } from './helper.js';
import { sql } from './db.js';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  signJwt,
  verifyJwt,
  hashToken,
  pkcePair,
  createCsrfToken,
  randomToken,
} from './auth.js';

const app = express();
const port = process.env.PORT || 3000;
const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// Basic request logging + in-memory rate limiting (100 req / 15 min / ip)
const requestBuckets = new Map();
app.use((req, res, next) => {
  const now = Date.now();
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  const key = `${ip}:${Math.floor(now / (15 * 60 * 1000))}`;
  const count = (requestBuckets.get(key) || 0) + 1;
  requestBuckets.set(key, count);

  console.log(JSON.stringify({ at: new Date().toISOString(), method: req.method, path: req.path, ip, ua: req.headers['user-agent'] || '' }));

  if (count > 100) return res.status(429).json({ status: 'error', message: 'Rate limit exceeded' });
  return next();
});

function parseCookies(req) {
  const header = req.headers.cookie || '';
  return Object.fromEntries(
    header
      .split(';')
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => {
        const idx = x.indexOf('=');
        return [decodeURIComponent(x.slice(0, idx)), decodeURIComponent(x.slice(idx + 1))];
      })
  );
}

function setCookie(res, name, value, opts = {}) {
  const bits = [`${encodeURIComponent(name)}=${encodeURIComponent(value)}`];
  if (opts.httpOnly) bits.push('HttpOnly');
  if (opts.secure) bits.push('Secure');
  bits.push(`Path=${opts.path || '/'}`);
  if (opts.sameSite) bits.push(`SameSite=${opts.sameSite}`);
  if (opts.maxAge) bits.push(`Max-Age=${opts.maxAge}`);
  res.append('Set-Cookie', bits.join('; '));
}

function clearCookie(res, name) {
  res.append('Set-Cookie', `${encodeURIComponent(name)}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
}

function buildTokens(user) {
  const accessToken = signJwt({ sub: user.id, role: user.role, login: user.github_login }, ACCESS_TOKEN_TTL_SECONDS);
  const refreshToken = randomToken(40);
  return { accessToken, refreshToken };
}

async function persistRefreshToken(userId, refreshToken, interfaceType) {
  const id = uuidv7();
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000).toISOString();
  await sql`INSERT INTO refresh_tokens ${sql({ id, user_id: userId, token_hash: hashToken(refreshToken), interface_type: interfaceType, expires_at: expiresAt }, 'id', 'user_id', 'token_hash', 'interface_type', 'expires_at')}`;
}

function requireAuth(req, res, next) {
  const cookies = parseCookies(req);
  const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null;
  const token = bearer || cookies.access_token;
  const payload = verifyJwt(token);
  if (!payload) return res.status(401).json({ status: 'error', message: 'Unauthorized' });
  req.user = payload;
  return next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ status: 'error', message: 'Forbidden' });
    }
    return next();
  };
}

function csrfProtect(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const cookies = parseCookies(req);
  const csrfCookie = cookies.csrf_token;
  const csrfHeader = req.headers['x-csrf-token'];
  if (!csrfCookie || !csrfHeader || csrfCookie !== csrfHeader) {
    return res.status(403).json({ status: 'error', message: 'CSRF validation failed' });
  }
  return next();
}

// -------- Stage 2 routes preserved --------
app.get('/api', (_req, res) => res.status(200).json({ message: 'HNG14 Stage 2', track: 'DevOps', username: 'ItunZ' }));

app.post('/api/profiles', async (req, res) => {
  let { name } = req.body ?? {};

  if (!name || (typeof name === 'string' && name.trim() === '')) return res.status(400).json({ status: 'error', message: 'name is required' });
  if (typeof name !== 'string') return res.status(422).json({ status: 'error', message: 'name must be a string' });

  name = name.trim().toLowerCase();
  const [existing] = await sql`SELECT * FROM profiles WHERE name = ${name}`;
  if (existing) return res.status(200).json({ status: 'success', message: 'Profile already exists', data: existing });

  let gender, age, nationality;
  try {
    const [gRes, aRes, nRes] = await Promise.all([
      fetch(`https://api.genderize.io?name=${encodeURIComponent(name)}`),
      fetch(`https://api.agify.io?name=${encodeURIComponent(name)}`),
      fetch(`https://api.nationalize.io?name=${encodeURIComponent(name)}`),
    ]);

    if (!gRes.ok) throw new Error('Genderize');
    if (!aRes.ok) throw new Error('Agify');
    if (!nRes.ok) throw new Error('Nationalize');

    [gender, age, nationality] = await Promise.all([gRes.json(), aRes.json(), nRes.json()]);
  } catch (err) {
    return res.status(502).json({ status: 'error', message: `${err.message || 'upstream'} returned an invalid response` });
  }

  if (!gender.gender || gender.count === 0) return res.status(502).json({ status: 'error', message: 'Genderize returned an invalid response' });
  if (age.age === null || age.age === undefined) return res.status(502).json({ status: 'error', message: 'Agify returned an invalid response' });
  if (!nationality.country || nationality.country.length === 0) return res.status(502).json({ status: 'error', message: 'Nationalize returned an invalid response' });

  const country = nationality.country.reduce((best, cur) => (cur.probability > best.probability ? cur : best));

  const data = {
    id: uuidv7(),
    name,
    gender: gender.gender,
    gender_probability: gender.probability,
    age: age.age,
    age_group: getAgeGroup(age.age),
    country_id: country.country_id,
    country_name: regionNames.of(country.country_id) ?? country.country_id,
    country_probability: country.probability,
    created_at: new Date().toISOString(),
  };

  await sql`INSERT INTO profiles ${sql(data, 'id', 'name', 'gender', 'gender_probability', 'age', 'age_group', 'country_id', 'country_name', 'country_probability', 'created_at')}`;
  return res.status(201).json({ status: 'success', data });
});

app.get('/api/profiles/search', async (req, res) => {
  const { q, page = 1, limit = 10 } = req.query;
  if (!q || q.trim() === '') return res.status(400).json({ status: 'error', message: 'Missing or empty query' });
  const filters = await parseNaturalLanguageQuery(q);
  if (Object.keys(filters).length === 0) return res.status(200).json({ status: 'error', message: 'Unable to interpret query' });
  const result = await queryProfiles(filters, 'created_at', 'asc', page, limit);
  return res.status(200).json({ status: 'success', ...result });
});

app.get('/api/profiles/:id', async (req, res) => {
  const { id } = req.params;
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRe.test(id)) return res.status(404).json({ status: 'error', message: 'Profile not found' });
  const [profile] = await sql`SELECT * FROM profiles WHERE id = ${id}`;
  if (!profile) return res.status(404).json({ status: 'error', message: 'Profile not found' });
  return res.status(200).json({ status: 'success', data: profile });
});

app.get('/api/profiles', async (req, res) => {
  const { gender, age_group, country_id, min_age, max_age, min_gender_probability, min_country_probability, sort_by = 'created_at', order = 'asc', page = 1, limit = 10 } = req.query;
  const validSortBy = ['age', 'created_at', 'gender_probability'];
  const validOrder = ['asc', 'desc'];
  if (!validSortBy.includes(sort_by) || !validOrder.includes(order.toLowerCase())) return res.status(400).json({ status: 'error', message: 'Invalid query parameters' });
  const result = await queryProfiles({ gender, age_group, country_id, min_age, max_age, min_gender_probability, min_country_probability }, sort_by, order, page, limit);
  return res.status(200).json({ status: 'success', ...result });
});

app.delete('/api/profiles/:id', async (req, res) => {
  const { id } = req.params;
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRe.test(id)) return res.status(404).json({ status: 'error', message: 'Profile not found' });
  const result = await sql`DELETE FROM profiles WHERE id = ${id} RETURNING id`;
  if (!result.length) return res.status(404).json({ status: 'error', message: 'Profile not found' });
  return res.status(204).end();
});

// -------- Stage 3 v1 API --------
app.get('/api/v1/health', (_req, res) => res.status(200).json({ status: 'ok', service: 'insighta-labs-plus' }));

app.get('/api/v1/auth/github/start', async (req, res) => {
  const interfaceType = req.query.interface === 'cli' ? 'cli' : 'web';
  const redirectUri = req.query.redirect_uri || process.env.GITHUB_REDIRECT_URI;
  if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET || !redirectUri) {
    return res.status(500).json({ status: 'error', message: 'GitHub OAuth is not configured' });
  }

  const { verifier, challenge, method } = pkcePair();
  const state = randomToken(18);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  await sql`INSERT INTO oauth_states ${sql({ state, code_verifier: verifier, interface_type: interfaceType, redirect_uri: redirectUri, expires_at: expiresAt }, 'state', 'code_verifier', 'interface_type', 'redirect_uri', 'expires_at')}`;

  const authorizeUrl = new URL('https://github.com/login/oauth/authorize');
  authorizeUrl.searchParams.set('client_id', GITHUB_CLIENT_ID);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('scope', 'read:user user:email');
  authorizeUrl.searchParams.set('code_challenge', challenge);
  authorizeUrl.searchParams.set('code_challenge_method', method);

  return res.status(200).json({ status: 'success', data: { authorize_url: authorizeUrl.toString(), state } });
});

app.get('/api/v1/auth/github/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) return res.status(400).json({ status: 'error', message: 'Missing code/state' });

  const [oauthState] = await sql`SELECT * FROM oauth_states WHERE state = ${state}`;
  if (!oauthState || new Date(oauthState.expires_at).getTime() < Date.now()) {
    return res.status(400).json({ status: 'error', message: 'State expired or invalid' });
  }

  const tokenResp = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      client_secret: GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: oauthState.redirect_uri,
      state,
      code_verifier: oauthState.code_verifier,
    }),
  });

  const tokenJson = await tokenResp.json();
  if (!tokenJson.access_token) return res.status(502).json({ status: 'error', message: 'GitHub token exchange failed', details: tokenJson });

  const userResp = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${tokenJson.access_token}`, 'User-Agent': 'insighta-labs-plus' },
  });
  const gh = await userResp.json();
  if (!gh.id || !gh.login) return res.status(502).json({ status: 'error', message: 'Unable to read GitHub profile' });

  const adminLogins = (process.env.ADMIN_GITHUB_LOGINS || '').split(',').map((v) => v.trim()).filter(Boolean);
  const role = adminLogins.includes(gh.login) ? 'admin' : 'analyst';

  const userId = uuidv7();
  const rows = await sql`
    INSERT INTO app_users (id, github_id, github_login, role)
    VALUES (${userId}, ${gh.id}, ${gh.login}, ${role})
    ON CONFLICT (github_id) DO UPDATE SET github_login = EXCLUDED.github_login, updated_at = now()
    RETURNING *
  `;
  const user = rows[0];

  const { accessToken, refreshToken } = buildTokens(user);
  await persistRefreshToken(user.id, refreshToken, oauthState.interface_type);
  await sql`DELETE FROM oauth_states WHERE state = ${state}`;

  if (oauthState.interface_type === 'web') {
    const secure = process.env.NODE_ENV === 'production';
    const csrf = createCsrfToken();
    setCookie(res, 'access_token', accessToken, { httpOnly: true, secure, sameSite: 'Lax', path: '/', maxAge: ACCESS_TOKEN_TTL_SECONDS });
    setCookie(res, 'refresh_token', refreshToken, { httpOnly: true, secure, sameSite: 'Lax', path: '/', maxAge: REFRESH_TOKEN_TTL_SECONDS });
    setCookie(res, 'csrf_token', csrf, { secure, sameSite: 'Lax', path: '/', maxAge: REFRESH_TOKEN_TTL_SECONDS });
    return res.status(200).json({ status: 'success', data: { user: { id: user.id, login: user.github_login, role: user.role }, csrf_token: csrf } });
  }

  return res.status(200).json({
    status: 'success',
    data: {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      user: { id: user.id, login: user.github_login, role: user.role },
    },
  });
});

app.post('/api/v1/auth/refresh', csrfProtect, async (req, res) => {
  const cookies = parseCookies(req);
  const incomingRefresh = req.body?.refresh_token || cookies.refresh_token;
  if (!incomingRefresh) return res.status(401).json({ status: 'error', message: 'Missing refresh token' });

  const [existing] = await sql`SELECT * FROM refresh_tokens WHERE token_hash = ${hashToken(incomingRefresh)} AND revoked_at IS NULL`;
  if (!existing || new Date(existing.expires_at).getTime() < Date.now()) {
    return res.status(401).json({ status: 'error', message: 'Invalid refresh token' });
  }

  const [user] = await sql`SELECT * FROM app_users WHERE id = ${existing.user_id}`;
  if (!user) return res.status(401).json({ status: 'error', message: 'User not found' });

  const { accessToken, refreshToken } = buildTokens(user);
  await sql`UPDATE refresh_tokens SET revoked_at = now() WHERE id = ${existing.id}`;
  await persistRefreshToken(user.id, refreshToken, existing.interface_type);

  if (existing.interface_type === 'web') {
    const secure = process.env.NODE_ENV === 'production';
    setCookie(res, 'access_token', accessToken, { httpOnly: true, secure, sameSite: 'Lax', path: '/', maxAge: ACCESS_TOKEN_TTL_SECONDS });
    setCookie(res, 'refresh_token', refreshToken, { httpOnly: true, secure, sameSite: 'Lax', path: '/', maxAge: REFRESH_TOKEN_TTL_SECONDS });
    return res.status(200).json({ status: 'success', data: { expires_in: ACCESS_TOKEN_TTL_SECONDS } });
  }

  return res.status(200).json({ status: 'success', data: { access_token: accessToken, refresh_token: refreshToken, token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL_SECONDS } });
});

app.post('/api/v1/auth/logout', requireAuth, csrfProtect, async (req, res) => {
  const cookies = parseCookies(req);
  const refresh = req.body?.refresh_token || cookies.refresh_token;
  if (refresh) await sql`UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = ${hashToken(refresh)} AND revoked_at IS NULL`;
  clearCookie(res, 'access_token');
  clearCookie(res, 'refresh_token');
  clearCookie(res, 'csrf_token');
  return res.status(200).json({ status: 'success' });
});

app.get('/api/v1/me', requireAuth, async (req, res) => {
  return res.status(200).json({ status: 'success', data: req.user });
});

app.get('/api/v1/profiles', requireAuth, async (req, res) => {
  const { gender, age_group, country_id, min_age, max_age, min_gender_probability, min_country_probability, sort_by = 'created_at', order = 'asc', page = 1, per_page = 10 } = req.query;
  const validSortBy = ['age', 'created_at', 'gender_probability'];
  const validOrder = ['asc', 'desc'];
  if (!validSortBy.includes(sort_by) || !validOrder.includes(order.toLowerCase())) return res.status(400).json({ status: 'error', message: 'Invalid query parameters' });

  const result = await queryProfiles({ gender, age_group, country_id, min_age, max_age, min_gender_probability, min_country_probability }, sort_by, order, page, per_page);
  const totalPages = Math.max(Math.ceil(result.total / result.limit), 1);

  return res.status(200).json({
    status: 'success',
    data: result.data,
    pagination: {
      page: result.page,
      per_page: result.limit,
      total_items: result.total,
      total_pages: totalPages,
      has_next: result.page < totalPages,
      has_prev: result.page > 1,
    },
  });
});

app.get('/api/v1/profiles/search', requireAuth, async (req, res) => {
  const { q, page = 1, per_page = 10 } = req.query;
  if (!q || q.trim() === '') return res.status(400).json({ status: 'error', message: 'Missing or empty query' });
  const filters = await parseNaturalLanguageQuery(q);
  if (Object.keys(filters).length === 0) return res.status(200).json({ status: 'error', message: 'Unable to interpret query' });
  const result = await queryProfiles(filters, 'created_at', 'asc', page, per_page);
  return res.status(200).json({
    status: 'success',
    data: result.data,
    pagination: {
      page: result.page,
      per_page: result.limit,
      total_items: result.total,
      total_pages: Math.max(Math.ceil(result.total / result.limit), 1),
    },
  });
});

app.post('/api/v1/profiles', requireAuth, requireRole('admin', 'analyst'), csrfProtect, async (req, res) => {
  let { name } = req.body ?? {};
  if (!name || (typeof name === 'string' && name.trim() === '')) return res.status(400).json({ status: 'error', message: 'name is required' });
  if (typeof name !== 'string') return res.status(422).json({ status: 'error', message: 'name must be a string' });

  name = name.trim().toLowerCase();
  const [existing] = await sql`SELECT * FROM profiles WHERE name = ${name}`;
  if (existing) return res.status(200).json({ status: 'success', message: 'Profile already exists', data: existing });

  let gender, age, nationality;
  try {
    const [gRes, aRes, nRes] = await Promise.all([
      fetch(`https://api.genderize.io?name=${encodeURIComponent(name)}`),
      fetch(`https://api.agify.io?name=${encodeURIComponent(name)}`),
      fetch(`https://api.nationalize.io?name=${encodeURIComponent(name)}`),
    ]);
    if (!gRes.ok) throw new Error('Genderize');
    if (!aRes.ok) throw new Error('Agify');
    if (!nRes.ok) throw new Error('Nationalize');
    [gender, age, nationality] = await Promise.all([gRes.json(), aRes.json(), nRes.json()]);
  } catch (err) {
    return res.status(502).json({ status: 'error', message: `${err.message || 'upstream'} returned an invalid response` });
  }

  if (!gender.gender || gender.count === 0) return res.status(502).json({ status: 'error', message: 'Genderize returned an invalid response' });
  if (age.age === null || age.age === undefined) return res.status(502).json({ status: 'error', message: 'Agify returned an invalid response' });
  if (!nationality.country || nationality.country.length === 0) return res.status(502).json({ status: 'error', message: 'Nationalize returned an invalid response' });

  const country = nationality.country.reduce((best, cur) => (cur.probability > best.probability ? cur : best));
  const data = {
    id: uuidv7(),
    name,
    gender: gender.gender,
    gender_probability: gender.probability,
    age: age.age,
    age_group: getAgeGroup(age.age),
    country_id: country.country_id,
    country_name: regionNames.of(country.country_id) ?? country.country_id,
    country_probability: country.probability,
    created_at: new Date().toISOString(),
  };

  await sql`INSERT INTO profiles ${sql(data, 'id', 'name', 'gender', 'gender_probability', 'age', 'age_group', 'country_id', 'country_name', 'country_probability', 'created_at')}`;
  return res.status(201).json({ status: 'success', data });
});

app.delete('/api/v1/profiles/:id', requireAuth, requireRole('admin'), csrfProtect, async (req, res) => {
  const { id } = req.params;
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRe.test(id)) return res.status(404).json({ status: 'error', message: 'Profile not found' });
  const result = await sql`DELETE FROM profiles WHERE id = ${id} RETURNING id`;
  if (!result.length) return res.status(404).json({ status: 'error', message: 'Profile not found' });
  return res.status(204).end();
});

app.get('/api/v1/profiles/export.csv', requireAuth, requireRole('admin'), async (req, res) => {
  const rows = await sql`SELECT * FROM profiles ORDER BY created_at ASC`;
  const headers = ['id', 'name', 'gender', 'gender_probability', 'age', 'age_group', 'country_id', 'country_name', 'country_probability', 'created_at'];
  const escape = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [headers.join(','), ...rows.map((r) => headers.map((h) => escape(r[h])).join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="profiles.csv"');
  return res.status(200).send(csv);
});

// ----------- 404 catch-all ----------------------------------------------
app.use((_req, res) => res.status(404).json({ status: 'error', message: 'Route not found' }));

app.listen(port, () => console.log(`Server listening on port ${port}`));
