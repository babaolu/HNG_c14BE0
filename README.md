# Insighta Labs+ Backend (Stage 3)

Secure Profile Intelligence backend with OAuth login, RBAC, token rotation, API versioning, CSV export, and preserved Stage 2 profile intelligence features (filtering, sorting, pagination, natural-language search).

## System architecture

- **Runtime**: Node.js + Express (ESM).
- **Data layer**: PostgreSQL via `postgres` driver.
- **Core domain**: `profiles` table (Stage 2).
- **Auth domain**:
  - `app_users` (GitHub-linked users + role).
  - `oauth_states` (PKCE verifier + temporary state store).
  - `refresh_tokens` (hashed rotating refresh tokens).
- **Security middleware**:
  - global request logging.
  - in-memory rate limit (100 requests / 15 minutes / IP).
  - CSRF protection for cookie-based session flows.
  - RBAC guards (`admin`, `analyst`) on v1 endpoints.

## Authentication flow (GitHub OAuth + PKCE)

1. Client calls `GET /api/v1/auth/github/start?interface=web|cli&redirect_uri=<uri>`.
2. Backend generates PKCE verifier/challenge + `state`, stores verifier server-side in `oauth_states`, returns GitHub authorize URL.
3. User authenticates at GitHub; callback hits `GET /api/v1/auth/github/callback?code=...&state=...`.
4. Backend exchanges code at GitHub with stored `code_verifier`.
5. Backend upserts `app_users` row and assigns role:
   - `admin` if GitHub login is in `ADMIN_GITHUB_LOGINS`.
   - otherwise `analyst`.
6. Backend issues:
   - short-lived access token (JWT, default 15m).
   - short-lived refresh token (opaque, hashed in DB, default 24h).
7. Interface-specific delivery:
   - **CLI**: JSON response with bearer tokens.
   - **Web**: HTTP-only cookies (`access_token`, `refresh_token`) + CSRF cookie.

## Token handling approach

- Access tokens are HMAC-signed JWTs with role claims (`sub`, `role`, `login`).
- Refresh tokens are random opaque strings, persisted only as SHA-256 hashes.
- Refresh endpoint rotates refresh tokens and revokes old token rows.
- Logout revokes current refresh token and clears auth cookies.
- Expired/invalid tokens return `401`.

## Role enforcement logic

- `requireAuth`: validates bearer token or access cookie.
- `requireRole('admin'|'analyst')`: applied per route.
- Route policy:
  - `GET /api/v1/profiles*`: authenticated users.
  - `POST /api/v1/profiles`: `admin` or `analyst`.
  - `DELETE /api/v1/profiles/:id`: `admin` only.
  - `GET /api/v1/profiles/export.csv`: `admin` only.

## Natural language parsing approach

The Stage 2 parser is retained and used by both v0 and v1 search endpoints:
- regex extraction for gender phrases and age phrases.
- semantic mapping of words like `young` to age range filters.
- dynamic country matching from known profile country names in DB.
- parser output is fed into shared SQL query builder with pagination.

## API versioning and pagination

- Existing Stage 2 endpoints remain under `/api/*` for backward compatibility.
- New secure versioned endpoints are under `/api/v1/*`.
- V1 list/search responses use:

```json
{
  "status": "success",
  "data": [],
  "pagination": {
    "page": 1,
    "per_page": 10,
    "total_items": 100,
    "total_pages": 10,
    "has_next": true,
    "has_prev": false
  }
}
```

## CLI usage

The CLI should:
1. Start OAuth via `/api/v1/auth/github/start?interface=cli`.
2. Open returned authorize URL.
3. Complete callback and receive token pair.
4. Save credentials to `~/.insighta/credentials.json`.
5. Send `Authorization: Bearer <access_token>` to v1 endpoints.
6. Use `/api/v1/auth/refresh` to rotate when access token expires.

## Setup

```bash
npm install
export DATABASE_URL=postgres://user:password@localhost:5432/profiles
export JWT_SECRET=replace-me
export GITHUB_CLIENT_ID=...
export GITHUB_CLIENT_SECRET=...
export GITHUB_REDIRECT_URI=http://localhost:3000/api/v1/auth/github/callback
export ADMIN_GITHUB_LOGINS=yourgithublogin
node seed.js
node index.js
```

## Key Stage 3 endpoints

- `GET /api/v1/auth/github/start`
- `GET /api/v1/auth/github/callback`
- `POST /api/v1/auth/refresh`
- `POST /api/v1/auth/logout`
- `GET /api/v1/me`
- `GET /api/v1/profiles`
- `GET /api/v1/profiles/search`
- `POST /api/v1/profiles`
- `DELETE /api/v1/profiles/:id`
- `GET /api/v1/profiles/export.csv`

## Notes

- CSRF enforcement is required on all state-changing routes.
- Web sessions are cookie-based; CLI sessions are token-response based.
- Stage 2 endpoints and behavior are intentionally preserved.
