import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL || 'postgres://profiles:profiles@localhost:5432/profiles');
 
await sql`
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
  )
`;

await sql`
  CREATE TABLE IF NOT EXISTS app_users (
    id                  TEXT PRIMARY KEY,
    github_id           BIGINT UNIQUE NOT NULL,
    github_login        TEXT UNIQUE NOT NULL,
    role                TEXT NOT NULL DEFAULT 'analyst' CHECK (role IN ('admin','analyst')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`;

await sql`
  CREATE TABLE IF NOT EXISTS oauth_states (
    state               TEXT PRIMARY KEY,
    code_verifier       TEXT NOT NULL,
    interface_type      TEXT NOT NULL CHECK (interface_type IN ('cli','web')),
    redirect_uri        TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at          TIMESTAMPTZ NOT NULL
  )
`;

await sql`
  CREATE TABLE IF NOT EXISTS refresh_tokens (
    id                  TEXT PRIMARY KEY,
    user_id             TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    token_hash          TEXT UNIQUE NOT NULL,
    interface_type      TEXT NOT NULL CHECK (interface_type IN ('cli','web')),
    expires_at          TIMESTAMPTZ NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at          TIMESTAMPTZ
  )
`;
 
// Indexes for every column used in filters or sorts
await sql`CREATE INDEX IF NOT EXISTS idx_gender        ON profiles(gender)`;
await sql`CREATE INDEX IF NOT EXISTS idx_age           ON profiles(age)`;
await sql`CREATE INDEX IF NOT EXISTS idx_age_group     ON profiles(age_group)`;
await sql`CREATE INDEX IF NOT EXISTS idx_country_id    ON profiles(country_id)`;
await sql`CREATE INDEX IF NOT EXISTS idx_created_at    ON profiles(created_at)`;
await sql`CREATE INDEX IF NOT EXISTS idx_gprob         ON profiles(gender_probability)`;
await sql`CREATE INDEX IF NOT EXISTS idx_cprob         ON profiles(country_probability)`;
await sql`CREATE INDEX IF NOT EXISTS idx_refresh_user  ON refresh_tokens(user_id)`;
await sql`CREATE INDEX IF NOT EXISTS idx_refresh_exp   ON refresh_tokens(expires_at)`;

export { sql };
