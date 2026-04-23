# Name Profile API

A REST API that accepts a name and enriches it with predicted gender, age, and nationality data from three free external APIs, then stores and exposes the result through a set of CRUD endpoints. Supports advanced filtering, sorting, pagination, and natural language search.

---

## Tech Stack

- **Runtime**: Node.js (ESM)
- **Framework**: Express.js
- **Database**: PostgreSQL (v14+)
- **DB client**: `postgres` (npm)
- **ID generation**: UUIDv7

---

## Prerequisites

- Node.js v18+
- PostgreSQL server (v14+) accessible via `DATABASE_URL`

---

## Setup

```bash
# 1. Clone the repo
git clone <your-repo-url>
cd <your-repo-folder>

# 2. Install dependencies
npm install

# 3. Create a PostgreSQL database
createdb profiles

# 4. Set the connection string (defaults to postgres://localhost:5432/profiles)
export DATABASE_URL=postgres://user:password@localhost:5432/profiles

# 5. Seed the database with the provided profiles
node seed.js

# 6. Run the server (the table and indexes are created automatically on first start)
node index.js
```

The server starts on **http://localhost:3000** (override with `PORT` env var).

> Make sure your `package.json` includes `"type": "module"` since the project uses ESM imports.

---

## Data Seeding

The seed script loads profiles from `seed_profiles.json` and inserts them in batches of 100. Re-running the script is safe — existing records are skipped via `ON CONFLICT (name) DO NOTHING`.

```bash
node seed.js
# or with a remote DB:
DATABASE_URL=postgres://user:pass@host/db node seed.js
```

Output example:
```
Seeding 2026 profiles...
  chunk 1: 100 inserted, 0 skipped
  chunk 2: 100 inserted, 0 skipped
  ...
Done. 2026 inserted, 0 skipped (duplicates).
```

---

## External APIs Used

| API | URL | Purpose |
|-----|-----|---------|
| Genderize | `https://api.genderize.io?name={name}` | Predicts gender |
| Agify | `https://api.agify.io?name={name}` | Predicts age |
| Nationalize | `https://api.nationalize.io?name={name}` | Predicts nationality |

All three are free and require no API key.

---

## Classification Rules

**Age group** (from Agify response):

| Age range | Group |
|-----------|-------|
| 0 – 12 | `child` |
| 13 – 19 | `teenager` |
| 20 – 59 | `adult` |
| 60+ | `senior` |

**Nationality**: the country with the highest probability from the Nationalize response is selected.

---

## Database Schema

```sql
CREATE TABLE IF NOT EXISTS profiles (
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
```

The table and the following indexes are created automatically at server startup:

```sql
CREATE INDEX IF NOT EXISTS idx_gender     ON profiles(gender);
CREATE INDEX IF NOT EXISTS idx_age        ON profiles(age);
CREATE INDEX IF NOT EXISTS idx_age_group  ON profiles(age_group);
CREATE INDEX IF NOT EXISTS idx_country_id ON profiles(country_id);
CREATE INDEX IF NOT EXISTS idx_created_at ON profiles(created_at);
CREATE INDEX IF NOT EXISTS idx_gprob      ON profiles(gender_probability);
CREATE INDEX IF NOT EXISTS idx_cprob      ON profiles(country_probability);
```

---

## API Reference

### `POST /api/profiles`

Creates a new profile by calling the three external APIs and storing the enriched result. If a profile for the given name already exists, the existing record is returned without creating a duplicate.

**Request body**
```json
{ "name": "ella" }
```

**Success – new profile (201)**
```json
{
  "status": "success",
  "data": {
    "id": "019d9ba8-a841-70b6-addc-f9294c1aaccd",
    "name": "ella",
    "gender": "female",
    "gender_probability": 0.99,
    "age": 34,
    "age_group": "adult",
    "country_id": "US",
    "country_name": "United States",
    "country_probability": 0.12,
    "created_at": "2026-04-01T12:00:00.000Z"
  }
}
```

**Success – already exists (200)**
```json
{
  "status": "success",
  "message": "Profile already exists",
  "data": { "...existing profile..." }
}
```

**Errors**

| Status | Condition |
|--------|-----------|
| `400` | Missing or empty `name` |
| `422` | `name` is not a string |
| `502` | External API returned null/empty data |

---

### `GET /api/profiles`

Returns profiles with support for filtering, sorting, and pagination. All filters are combinable and results must match every condition passed.

**Query parameters**

| Parameter | Type | Description | Default |
|-----------|------|-------------|---------|
| `gender` | string | Filter by gender (`male`, `female`) | — |
| `age_group` | string | Filter by age group (`child`, `teenager`, `adult`, `senior`) | — |
| `country_id` | string | Filter by ISO country code (`NG`, `US`, etc.) | — |
| `min_age` | number | Minimum age (inclusive) | — |
| `max_age` | number | Maximum age (inclusive) | — |
| `min_gender_probability` | float | Minimum gender confidence score | — |
| `min_country_probability` | float | Minimum country confidence score | — |
| `sort_by` | string | Sort field: `age`, `created_at`, `gender_probability` | `created_at` |
| `order` | string | Sort direction: `asc`, `desc` | `asc` |
| `page` | number | Page number | `1` |
| `limit` | number | Results per page (max 50) | `10` |

Filter values are **case-insensitive**.

**Example**
```
GET /api/profiles?gender=male&country_id=NG&min_age=25&sort_by=age&order=desc&page=1&limit=10
```

**Success (200)**
```json
{
  "status": "success",
  "page": 1,
  "limit": 10,
  "total": 2026,
  "data": [
    {
      "id": "019d9ba8-a841-70b6-addc-f9294c1aaccd",
      "name": "emmanuel",
      "gender": "male",
      "gender_probability": 0.99,
      "age": 34,
      "age_group": "adult",
      "country_id": "NG",
      "country_name": "Nigeria",
      "country_probability": 0.85,
      "created_at": "2026-04-01T12:00:00.000Z"
    }
  ]
}
```

**Errors**

| Status | Condition |
|--------|-----------|
| `400` | Invalid `sort_by` or `order` value |

---

### `GET /api/profiles/search`

Parses a plain English query string and converts it into filters, then returns matching profiles. Supports the same `page` and `limit` parameters as `GET /api/profiles`.

**Query parameters**

| Parameter | Description |
|-----------|-------------|
| `q` | Plain English search query (required) |
| `page` | Page number (default: 1) |
| `limit` | Results per page, max 50 (default: 10) |

**Example**
```
GET /api/profiles/search?q=young males from nigeria&page=1&limit=10
```

**Success (200)**
```json
{
  "status": "success",
  "page": 1,
  "limit": 10,
  "total": 12,
  "data": [ "..." ]
}
```

**Unable to interpret (200)**
```json
{ "status": "error", "message": "Unable to interpret query" }
```

**Errors**

| Status | Condition |
|--------|-----------|
| `400` | Missing or empty `q` parameter |

---

### `GET /api/profiles/:id`

Fetches a single profile by its UUID.

**Success (200)**
```json
{
  "status": "success",
  "data": {
    "id": "019d9ba8-a841-70b6-addc-f9294c1aaccd",
    "name": "emmanuel",
    "gender": "male",
    "gender_probability": 0.98,
    "age": 25,
    "age_group": "adult",
    "country_id": "NG",
    "country_name": "Nigeria",
    "country_probability": 0.34,
    "created_at": "2026-04-01T12:00:00.000Z"
  }
}
```

**Errors**

| Status | Condition |
|--------|-----------|
| `404` | No profile found for the given ID |

---

### `DELETE /api/profiles/:id`

Deletes a profile by its UUID.

**Success**: `204 No Content` (empty body)

**Errors**

| Status | Condition |
|--------|-----------|
| `404` | No profile found for the given ID |

---

## Error Response Format

All errors follow this structure:

```json
{ "status": "error", "message": "<description>" }
```

502 errors name the specific API that failed:

```json
{ "status": "error", "message": "Genderize returned an invalid response" }
```

---

## Natural Language Search

`GET /api/profiles/search` uses a rule-based parser — no AI or LLMs are involved. The query string is lowercased and matched against a fixed set of regex patterns and keyword maps.

### How it works

The parser runs in three passes over the query text: gender detection, age detection, then country detection. Each pass is independent. If none of the passes produce a filter, the endpoint returns `"Unable to interpret query"`.

### Supported keywords and mappings

**Gender**

| Query contains | Maps to |
|----------------|---------|
| `female`, `females`, `woman`, `women` | `gender=female` |
| `male`, `males`, `man`, `men` | `gender=male` |

Female is checked first. Male only sets if female was not already matched, so "women and men" correctly resolves to `female`.

**Age groups**

| Query contains | Maps to |
|----------------|---------|
| `child`, `children`, `kid`, `kids` | `age_group=child` |
| `teen`, `teens`, `teenager`, `teenagers` | `age_group=teenager` |
| `adult`, `adults` | `age_group=adult` |
| `senior`, `seniors`, `elderly`, `old people` | `age_group=senior` |

**Age ranges**

| Query pattern | Maps to |
|---------------|---------|
| `young` | `min_age=16` + `max_age=24` |
| `above N` / `over N` | `min_age=N` |
| `below N` / `under N` | `max_age=N` |
| `between N and M` | `min_age=N` + `max_age=M` |

> `young` is a parsing shorthand only — it is not a stored age group. It maps to ages 16–24 for query purposes.

**Countries**

Country names in the query are matched against a map built dynamically from the database at startup (and refreshed after every POST). Multi-word country names (e.g. "south africa") are matched before shorter ones to prevent partial matches.

| Query contains | Example mapping |
|----------------|-----------------|
| `nigeria` | `country_id=NG` |
| `south africa` | `country_id=ZA` |
| `united states` | `country_id=US` |
| *(any country name in the database)* | `country_id=<ISO code>` |

### Example mappings

| Query | Filters applied |
|-------|-----------------|
| `young males from nigeria` | `gender=male`, `min_age=16`, `max_age=24`, `country_id=NG` |
| `females above 30` | `gender=female`, `min_age=30` |
| `people from angola` | `country_id=AO` |
| `adult males from kenya` | `gender=male`, `age_group=adult`, `country_id=KE` |
| `male and female teenagers above 17` | `age_group=teenager`, `min_age=17` |
| `seniors below 75` | `age_group=senior`, `max_age=75` |
| `women between 20 and 40` | `gender=female`, `min_age=20`, `max_age=40` |

### Limitations

- **No ISO code input** — queries like `country_id=NG` in plain text won't be recognised. Only full country names work.
- **No compound gender** — "male and female" resolves to female only (female takes priority).
- **No negation** — "not male", "excluding seniors" are not supported.
- **No relative terms beyond `young`** — "middle-aged", "elderly" (except as a `senior` synonym), "late 20s" are not parsed.
- **Single country only** — "from nigeria or ghana" picks the first match; the second country is ignored.
- **Ambiguous country names** — names that could refer to multiple countries (e.g. "congo") resolve to whichever ISO code appears first in the database.
- **Abbreviations** — "US", "UK", "SA" as text in the query are not parsed; use the full country name.
- **Misspellings** — the parser does exact substring matching with no fuzzy or phonetic fallback.

---

## CORS

All responses include `Access-Control-Allow-Origin: *`.

---

## Notes

- All IDs are **UUID v7** (time-ordered).
- All timestamps are **UTC ISO 8601** (`TIMESTAMPTZ` column).
- Names are normalised to lowercase before storage, so `Ella` and `ella` resolve to the same profile.
- `country_name` is resolved from the ISO 3166-1 alpha-2 code via `Intl.DisplayNames` on POST, and stored directly from the seed file on seeding.
- The country map used by the natural language parser is built from the database at startup and refreshed after every successful POST, so newly added countries are immediately searchable without a restart.
