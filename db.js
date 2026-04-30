import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL || 'postgres://profiles:profiles@localhost:5432/profiles');
 
// Create tables + indexes
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
  CREATE TABLE IF NOT EXISTS users (
    id          TEXT        PRIMARY KEY,
    github_id   VARCHAR     UNIQUE NOT NULL,
    username    VARCHAR     NOT NULL,
    email       VARCHAR,
    avatar_url  VARCHAR,
    role        VARCHAR     NOT NULL DEFAULT 'analyst',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`;
await sql`
  CREATE TABLE IF NOT EXISTS refresh_tokens (
    id           TEXT        PRIMARY KEY,
    user_id      TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash   TEXT        UNIQUE NOT NULL,
    client_type  VARCHAR     NOT NULL,
    expires_at   TIMESTAMPTZ NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`;
await sql`
  CREATE TABLE IF NOT EXISTS request_logs (
    id           TEXT        PRIMARY KEY,
    user_id      TEXT        REFERENCES users(id),
    method       VARCHAR     NOT NULL,
    path         TEXT        NOT NULL,
    status_code  INT,
    duration_ms  INT,
    ip           VARCHAR,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`;

// Indexes
for (const ddl of [
  `CREATE INDEX IF NOT EXISTS idx_gender       ON profiles(gender)`,
  `CREATE INDEX IF NOT EXISTS idx_age          ON profiles(age)`,
  `CREATE INDEX IF NOT EXISTS idx_age_group    ON profiles(age_group)`,
  `CREATE INDEX IF NOT EXISTS idx_country_id   ON profiles(country_id)`,
  `CREATE INDEX IF NOT EXISTS idx_created_at   ON profiles(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_gprob        ON profiles(gender_probability)`,
  `CREATE INDEX IF NOT EXISTS idx_cprob        ON profiles(country_probability)`,
  `CREATE INDEX IF NOT EXISTS idx_rt_user      ON refresh_tokens(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_log_user     ON request_logs(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_log_created  ON request_logs(created_at)`,
]) { await sql.unsafe(ddl); }


export { sql };
