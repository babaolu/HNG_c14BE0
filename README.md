# Name Profile API

A REST API that accepts a name and enriches it with predicted gender, age, and nationality data from three free external APIs, then stores and exposes the result through a set of CRUD endpoints.

---

## Tech Stack

- **Runtime**: Node.js (ESM)
- **Framework**: Express.js
- **Database**: Redis (plain strings + Sets — no RedisJSON module required)
- **ID generation**: UUIDv7

---

## Prerequisites

- Node.js v18+
- Redis server running locally on the default port (`6379`)

---

## Setup

```bash
# 1. Clone the repo
git clone <your-repo-url>
cd <your-repo-folder>

# 2. Install dependencies
npm install

# 3. Start Redis (if not already running)
sudo systemctl start redis

# 4. Run the server
node server.js
```

The server starts on **http://localhost:3000**.

> Make sure your `package.json` includes `"type": "module"` since the project uses ESM imports.

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

## API Reference

### `POST /api/profiles`

Creates a new profile by calling the three external APIs and storing the enriched result.

If a profile for the given name already exists, the existing record is returned without creating a duplicate.

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
    "sample_size": 1234,
    "age": 34,
    "age_group": "adult",
    "country_id": "US",
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

Returns all stored profiles. Supports optional filtering via query parameters. Filter values are **case-insensitive**.

**Query parameters** (all optional)

| Parameter | Example |
|-----------|---------|
| `gender` | `male`, `female` |
| `country_id` | `NG`, `US` |
| `age_group` | `adult`, `child`, `teenager`, `senior` |

**Example**
```
GET /api/profiles?gender=male&country_id=NG
```

**Success (200)**
```json
{
  "status": "success",
  "count": 1,
  "data": [
    {
      "id": "019d9ba8-a841-70b6-addc-f9294c1aaccd",
      "name": "emmanuel",
      "gender": "male",
      "age": 25,
      "age_group": "adult",
      "country_id": "NG"
    }
  ]
}
```

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
    "sample_size": 9821,
    "age": 25,
    "age_group": "adult",
    "country_id": "NG",
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

Deletes a profile by its UUID. Also removes its name index entry from Redis.

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

## Redis Key Structure

| Key pattern | Type | Stores |
|-------------|------|--------|
| `profiles:{uuid}` | String | Full profile JSON |
| `names:{name}` | String | UUID for that name |
| `names` | Set | All stored names (used for listing) |

---

## CORS

All responses include `Access-Control-Allow-Origin: *`.

---

## Notes

- This project uses **plain Redis** (no RedisJSON/Redis Stack module required). Profiles are stored as `JSON.stringify`'d strings and parsed on read.
- All IDs are **UUID v7** (time-ordered).
- All timestamps are **UTC ISO 8601**.
- Names are normalised to lowercase before storage, so `Ella` and `ella` resolve to the same profile.
