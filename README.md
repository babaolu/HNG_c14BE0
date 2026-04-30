# Insighta Labs+ — Backend

Secure, role-aware demographic intelligence API. Extends Stage 2 with GitHub OAuth (PKCE), JWT access + refresh tokens, RBAC, API versioning, CSV export, rate limiting, and request logging.

---

## System Architecture

```
┌─────────────────┐     ┌─────────────────┐
│   Web Portal    │     │   CLI Tool      │
│  (browser)      │     │  (terminal)     │
│                 │     │                 │
│ HTTP-only       │     │ ~/.insighta/    │
│ cookies + CSRF  │     │ credentials.json│
└────────┬────────┘     └────────┬────────┘
         │                       │
         └──────────┬────────────┘
                    │ HTTPS
          ┌─────────▼─────────┐
          │  Backend /api/v1  │
          │                   │
          │ • GitHub OAuth    │
          │ • JWT tokens      │
          │ • RBAC middleware │
          │ • Rate limiting   │
          │ • Request logging │
          └─────────┬─────────┘
                    │
          ┌─────────▼─────────┐
          │    PostgreSQL     │
          │                   │
          │ profiles          │
          │ users             │
          │ refresh_tokens    │
          │ request_logs      │
          └───────────────────┘
```

All three repos talk to one backend. The web portal uses HTTP-only cookies. The CLI uses Authorization headers. Both go through the same auth middleware.

---

## Tech Stack

- **Runtime**: Node.js (ESM)
- **Framework**: Express.js
- **Database**: PostgreSQL (v14+)
- **DB client**: `postgres` (npm)
- **Auth**: GitHub OAuth 2.0 + PKCE, JWT (jsonwebtoken)
- **ID generation**: UUIDv7

---

## Prerequisites

- Node.js v18+
- PostgreSQL v14+
- A GitHub OAuth App ([create one here](https://github.com/settings/developers))
  - Homepage URL: your backend URL
  - Callback URL: `https://your-backend.com/api/v1/auth/github/callback`

---

## Environment Variables

```env
DATABASE_URL=postgres://user:password@localhost:5432/profiles
JWT_SECRET=a-long-random-secret-string
GITHUB_CLIENT_ID=your_github_client_id
GITHUB_CLIENT_SECRET=your_github_client_secret
GITHUB_CALLBACK_URL=http://localhost:3000/api/v1/auth/github/callback
WEB_PORTAL_URL=http://localhost:5173
CLI_CALLBACK_PORT=9876
PORT=3000
NODE_ENV=development
```

---

## Setup

```bash
git clone <backend-repo-url>
cd insighta-backend
npm install

# copy and fill in your env vars
cp .env.example .env

# seed the database
node seed.js

# start the server (tables and indexes auto-created on first run)
node index.js
```

---

## Authentication Flow

### GitHub OAuth with PKCE

PKCE (Proof Key for Code Exchange) prevents auth code interception attacks. Both the CLI and the web portal use it.

```
Client                          Backend                    GitHub
  │                               │                           │
  │  1. Generate code_verifier    │                           │
  │     code_challenge =          │                           │
  │     base64url(sha256(verifier)│                           │
  │                               │                           │
  │  2. GET /api/v1/auth/github   │                           │
  │     ?client=cli|web           │                           │
  │     &code_challenge=...       │                           │
  │ ─────────────────────────── ▶ │                           │
  │                               │  3. Redirect to GitHub    │
  │ ◄─────────────────────────────│─────────────────────── ▶ │
  │                               │                           │
  │  4. User approves             │                           │
  │                               │ ◄─────────────────────── │
  │                               │  5. Auth code             │
  │                               │                           │
  │                               │  6. Exchange code +       │
  │                               │     client_secret         │
  │                               │─────────────────────── ▶ │
  │                               │ ◄─────────────────────── │
  │                               │  7. GitHub access token   │
  │                               │                           │
  │ ◄─────────────────────────── │                           │
  │  8. access_token (15min JWT)  │                           │
  │     refresh_token (7 days)    │                           │
```

### Token Delivery

| Client | Access token | Refresh token |
|--------|-------------|---------------|
| Web portal | HTTP-only cookie (`access_token`) | HTTP-only cookie scoped to `/api/v1/auth/refresh` |
| CLI | JSON response body | Saved to `~/.insighta/credentials.json` |

### Token Lifetimes

| Token | Lifetime | Storage |
|-------|----------|---------|
| Access token (JWT) | 15 minutes | Cookie (web) / memory (CLI) |
| Refresh token | 7 days | DB (hashed) + cookie/file |

Refresh tokens are stored as SHA-256 hashes — the raw token is never persisted. On every refresh, the old token is deleted and a new pair is issued (rotation).

---

## Role Enforcement

Two roles: `admin` and `analyst`. Role is stored on the `users` table and embedded in the JWT payload.

| Endpoint | Admin | Analyst |
|----------|-------|---------|
| `GET /api/v1/profiles` | ✅ | ✅ |
| `GET /api/v1/profiles/:id` | ✅ | ✅ |
| `GET /api/v1/profiles/search` | ✅ | ✅ |
| `POST /api/v1/profiles` | ✅ | ❌ 403 |
| `DELETE /api/v1/profiles/:id` | ✅ | ❌ 403 |
| `GET /api/v1/profiles/export` | ✅ | ❌ 403 |

All routes require authentication. Unauthenticated requests receive `401`. Authenticated requests without the required role receive `403`.

### How it works in code

```js
// middleware/auth.js
export function authenticate(req, res, next) {
  // accepts token from cookie (web) or Authorization header (CLI)
  const token = req.cookies?.access_token
    || req.headers.authorization?.slice(7);
  // verifies JWT, attaches payload to req.user
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role)) {
      return res.status(403).json({ status: 'error', message: 'Insufficient permissions' });
    }
    next();
  };
}

// Applied on routes:
router.post('/',    authenticate, requireRole('admin'), handler);
router.delete('/:id', authenticate, requireRole('admin'), handler);
router.get('/',    authenticate, handler); // both roles
```

---

## API Reference (v1)

All endpoints are prefixed `/api/v1`.

### Auth

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/auth/github` | Initiate OAuth (`?client=cli\|web&code_challenge=...`) |
| `GET` | `/auth/github/callback` | GitHub redirects here |
| `POST` | `/auth/refresh` | Refresh access token |
| `POST` | `/auth/logout` | Revoke refresh token + clear cookies |
| `GET` | `/auth/me` | Current user info |

### Profiles

| Method | Path | Auth | Role |
|--------|------|------|------|
| `POST` | `/profiles` | ✅ | admin |
| `GET` | `/profiles` | ✅ | any |
| `GET` | `/profiles/search` | ✅ | any |
| `GET` | `/profiles/export` | ✅ | admin |
| `GET` | `/profiles/:id` | ✅ | any |
| `DELETE` | `/profiles/:id` | ✅ | admin |

#### GET /api/v1/profiles — query parameters

| Parameter | Type | Description | Default |
|-----------|------|-------------|---------|
| `gender` | string | `male` or `female` | — |
| `age_group` | string | `child`, `teenager`, `adult`, `senior` | — |
| `country_id` | string | ISO 2-letter code | — |
| `min_age` | number | Minimum age inclusive | — |
| `max_age` | number | Maximum age inclusive | — |
| `min_gender_probability` | float | Minimum gender confidence | — |
| `min_country_probability` | float | Minimum country confidence | — |
| `sort_by` | string | `age`, `created_at`, `gender_probability` | `created_at` |
| `order` | string | `asc` or `desc` | `asc` |
| `page` | number | Page number | `1` |
| `limit` | number | Per page, max 50 | `10` |

#### Pagination shape

```json
{
  "status": "success",
  "page": 1,
  "limit": 10,
  "total": 2026,
  "data": []
}
```

---

## Natural Language Search

`GET /api/v1/profiles/search?q=...` uses a rule-based regex parser with no AI or LLMs.

### How the parser works

The query string is lowercased and matched in three sequential passes: gender → age → country. Each pass is independent. If no filter is extracted, the endpoint returns `"Unable to interpret query"`.

### Supported keywords

**Gender**

| Query contains | Resolves to |
|----------------|-------------|
| `female`, `females`, `woman`, `women` | `gender=female` |
| `male`, `males`, `man`, `men` | `gender=male` |

Female is evaluated first. Male only sets if female did not already match.

**Age groups**

| Query contains | Resolves to |
|----------------|-------------|
| `child`, `children`, `kid`, `kids` | `age_group=child` |
| `teen`, `teens`, `teenager`, `teenagers` | `age_group=teenager` |
| `adult`, `adults` | `age_group=adult` |
| `senior`, `seniors`, `elderly`, `old people` | `age_group=senior` |

**Age ranges**

| Pattern | Resolves to |
|---------|-------------|
| `young` | `min_age=16` + `max_age=24` |
| `above N` / `over N` | `min_age=N` |
| `below N` / `under N` | `max_age=N` |
| `between N and M` | `min_age=N` + `max_age=M` |

**Countries**

Country names are matched against a map built dynamically from the database at startup and refreshed after every successful POST. Multi-word names (e.g. "south africa") are matched before shorter ones to prevent partial matches.

### Example mappings

| Query | Filters |
|-------|---------|
| `young males from nigeria` | `gender=male`, `min_age=16`, `max_age=24`, `country_id=NG` |
| `females above 30` | `gender=female`, `min_age=30` |
| `adult males from kenya` | `gender=male`, `age_group=adult`, `country_id=KE` |
| `women between 20 and 40` | `gender=female`, `min_age=20`, `max_age=40` |
| `seniors below 75` | `age_group=senior`, `max_age=75` |

### Limitations

- No ISO code input — only full country names work
- No compound gender — "male and female" resolves to female only
- No negation — "not male" or "excluding seniors" are not supported
- Single country only — "from nigeria or ghana" picks the first match
- No fuzzy matching — misspellings return no results
- No relative terms beyond `young` — "middle-aged", "late 20s" are not parsed

---

## Rate Limiting

| Route group | Window | Max requests |
|-------------|--------|-------------|
| `/api/v1/auth/*` | 15 min | 20 |
| `/api/v1/profiles/*` | 15 min | 200 |

Exceeded limits return `429 Too Many Requests`.

---

## Request Logging

Every request is logged to the `request_logs` table with: user ID, method, path, status code, duration in ms, and IP address. Logging never affects response delivery.

---

## Database Schema

```sql
CREATE TABLE profiles (
  id                  TEXT          PRIMARY KEY,
  name                VARCHAR       NOT NULL UNIQUE,
  gender              VARCHAR       NOT NULL,
  gender_probability  FLOAT         NOT NULL,
  age                 INT           NOT NULL,
  age_group           VARCHAR       NOT NULL,
  country_id          VARCHAR(2)    NOT NULL,
  country_name        VARCHAR       NOT NULL,
  country_probability FLOAT         NOT NULL,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id          TEXT        PRIMARY KEY,
  github_id   VARCHAR     UNIQUE NOT NULL,
  username    VARCHAR     NOT NULL,
  email       VARCHAR,
  avatar_url  VARCHAR,
  role        VARCHAR     NOT NULL DEFAULT 'analyst',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE refresh_tokens (
  id           TEXT        PRIMARY KEY,
  user_id      TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT        UNIQUE NOT NULL,
  client_type  VARCHAR     NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE request_logs (
  id           TEXT        PRIMARY KEY,
  user_id      TEXT        REFERENCES users(id),
  method       VARCHAR     NOT NULL,
  path         TEXT        NOT NULL,
  status_code  INT,
  duration_ms  INT,
  ip           VARCHAR,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

## CORS

`Access-Control-Allow-Origin` is set to `WEB_PORTAL_URL` with `credentials: true` so HTTP-only cookies flow correctly. The wildcard `*` cannot be used with `credentials: true` — the origin must be explicit.

---

## Notes

- All IDs are UUID v7 (time-ordered)
- All timestamps are UTC ISO 8601 (`TIMESTAMPTZ`)
- Names are normalised to lowercase before storage
- `country_name` resolved via `Intl.DisplayNames` on POST; read from seed file on seeding
- First GitHub user to log in is assigned the `analyst` role — promote to `admin` manually via SQL: `UPDATE users SET role = 'admin' WHERE username = 'your-github-username';`
