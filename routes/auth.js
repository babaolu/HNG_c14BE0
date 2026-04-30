import express from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { uuidv7 } from 'uuidv7';

export function createAuthRouter(sql) {
  const router = express.Router();

  // In-memory PKCE store: state → { code_challenge, client_type }
  // In production use Redis with a short TTL
  const pkceStore = new Map();

  // ── Step 1: Initiate OAuth ──────────────────────────────────────────────
  // GET /api/v1/auth/github?client=cli|web
  router.get('/github', (req, res) => {
    const clientType = req.query.client === 'cli' ? 'cli' : 'web';
    const { code_challenge } = req.query;

    if (!code_challenge) {
      return res.status(400).json({ status: 'error', message: 'code_challenge required' });
    }

    const state = crypto.randomBytes(16).toString('hex');
    pkceStore.set(state, { code_challenge, client_type: clientType });

    // Clean up stale states after 10 minutes
    setTimeout(() => pkceStore.delete(state), 10 * 60 * 1000);

    const params = new URLSearchParams({
      client_id:    process.env.GITHUB_CLIENT_ID,
      redirect_uri: process.env.GITHUB_CALLBACK_URL,
      scope:        'read:user user:email',
      state,
    });

    res.redirect(`https://github.com/login/oauth/authorize?${params}`);
  });

  // ── Step 2: GitHub redirects back here ────────────────────────────────
  // GET /api/v1/auth/github/callback
  router.get('/github/callback', async (req, res) => {
    const { code, state } = req.query;

    const pkce = pkceStore.get(state);
    if (!pkce) {
      return res.status(400).json({ status: 'error', message: 'Invalid or expired state' });
    }
    pkceStore.delete(state);

    // Exchange code for GitHub access token
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id:     process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri:  process.env.GITHUB_CALLBACK_URL,
      }),
    });

    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      return res.status(502).json({ status: 'error', message: 'GitHub OAuth failed' });
    }

    // Fetch GitHub user profile
    const userRes = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const githubUser = await userRes.json();

    // Upsert user in DB
    const [user] = await sql`
      INSERT INTO users (id, github_id, username, email, avatar_url, role, created_at)
      VALUES (${uuidv7()}, ${String(githubUser.id)}, ${githubUser.login}, ${githubUser.email ?? null}, ${githubUser.avatar_url ?? null}, 'analyst', now())
      ON CONFLICT (github_id) DO UPDATE
        SET username   = EXCLUDED.username,
            email      = EXCLUDED.email,
            avatar_url = EXCLUDED.avatar_url
      RETURNING *
    `;

    const tokens = await issueTokens(sql, user, pkce.client_type);

    if (pkce.client_type === 'cli') {
      // CLI: redirect to localhost callback with tokens in query string
      // The CLI runs a temporary local HTTP server to receive this
      const params = new URLSearchParams({
        access_token:  tokens.access_token,
        refresh_token: tokens.refresh_token,
        role:          user.role,
        username:      user.username,
      });
      return res.redirect(`http://localhost:${process.env.CLI_CALLBACK_PORT || 9876}/callback?${params}`);
    }

    // Web: set HTTP-only cookies
    res.cookie('access_token', tokens.access_token, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge:   15 * 60 * 1000, // 15 minutes
    });
    res.cookie('refresh_token', tokens.refresh_token, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path:     '/api/v1/auth/refresh', // scoped to refresh endpoint only
      maxAge:   7 * 24 * 60 * 60 * 1000, // 7 days
    });

    res.redirect(process.env.WEB_PORTAL_URL || 'http://localhost:5173');
  });

  // ── Step 3 (PKCE verification for CLI) ───────────────────────────────
  // POST /api/v1/auth/token  { code, code_verifier, state }
  // Used by CLI to exchange the auth code directly (alternate flow)
  router.post('/token', async (req, res) => {
    const { code_verifier, state } = req.body ?? {};

    if (!code_verifier || !state) {
      return res.status(400).json({ status: 'error', message: 'code_verifier and state required' });
    }

    const pkce = pkceStore.get(state);
    if (!pkce) {
      return res.status(400).json({ status: 'error', message: 'Invalid or expired state' });
    }

    // Verify PKCE: sha256(code_verifier) must match stored code_challenge
    const hash = crypto.createHash('sha256').update(code_verifier).digest();
    const computed = hash.toString('base64url');

    if (computed !== pkce.code_challenge) {
      return res.status(400).json({ status: 'error', message: 'PKCE verification failed' });
    }

    pkceStore.delete(state);
    res.json({ status: 'success', message: 'PKCE verified' });
  });

  // ── Refresh tokens ────────────────────────────────────────────────────
  // POST /api/v1/auth/refresh
  router.post('/refresh', async (req, res) => {
    // Web sends refresh token in cookie; CLI sends in body
    const rawToken = req.cookies?.refresh_token || req.body?.refresh_token;

    if (!rawToken) {
      return res.status(401).json({ status: 'error', message: 'Refresh token required' });
    }

    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    const [stored] = await sql`
      SELECT rt.*, u.role, u.username, u.email, u.avatar_url
      FROM refresh_tokens rt
      JOIN users u ON u.id = rt.user_id
      WHERE rt.token_hash = ${tokenHash}
        AND rt.expires_at > now()
    `;

    if (!stored) {
      return res.status(401).json({ status: 'error', message: 'Invalid or expired refresh token' });
    }

    // Rotate: delete old token, issue new pair
    await sql`DELETE FROM refresh_tokens WHERE id = ${stored.id}`;

    const user = { id: stored.user_id, role: stored.role, username: stored.username };
    const tokens = await issueTokens(sql, user, stored.client_type);

    if (stored.client_type === 'web') {
      res.cookie('access_token', tokens.access_token, {
        httpOnly: true, secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict', maxAge: 15 * 60 * 1000,
      });
      res.cookie('refresh_token', tokens.refresh_token, {
        httpOnly: true, secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict', path: '/api/v1/auth/refresh', maxAge: 7 * 24 * 60 * 60 * 1000,
      });
      return res.json({ status: 'success', message: 'Tokens refreshed' });
    }

    // CLI: return tokens in body
    return res.json({ status: 'success', ...tokens });
  });

  // ── Logout ────────────────────────────────────────────────────────────
  router.post('/logout', async (req, res) => {
    const rawToken = req.cookies?.refresh_token || req.body?.refresh_token;
    if (rawToken) {
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      await sql`DELETE FROM refresh_tokens WHERE token_hash = ${tokenHash}`;
    }
    res.clearCookie('access_token');
    res.clearCookie('refresh_token', { path: '/api/v1/auth/refresh' });
    res.json({ status: 'success', message: 'Logged out' });
  });

  // ── Me ────────────────────────────────────────────────────────────────
  router.get('/me', async (req, res) => {
    const token = req.cookies?.access_token || req.headers.authorization?.slice(7);
    if (!token) return res.status(401).json({ status: 'error', message: 'Not authenticated' });

    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      const [user] = await sql`SELECT id, username, email, avatar_url, role, created_at FROM users WHERE id = ${payload.id}`;
      if (!user) return res.status(404).json({ status: 'error', message: 'User not found' });
      return res.json({ status: 'success', data: user });
    } catch {
      return res.status(401).json({ status: 'error', message: 'Invalid token' });
    }
  });

  return router;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function issueTokens(sql, user, clientType) {
  const accessToken = jwt.sign(
    { id: user.id, role: user.role, username: user.username },
    process.env.JWT_SECRET,
    { expiresIn: '15m' }
  );

  const rawRefresh = crypto.randomBytes(40).toString('hex');
  const tokenHash  = crypto.createHash('sha256').update(rawRefresh).digest('hex');
  const expiresAt  = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await sql`
    INSERT INTO refresh_tokens (id, user_id, token_hash, client_type, expires_at, created_at)
    VALUES (${uuidv7()}, ${user.id}, ${tokenHash}, ${clientType}, ${expiresAt.toISOString()}, now())
  `;

  return { access_token: accessToken, refresh_token: rawRefresh };
}
