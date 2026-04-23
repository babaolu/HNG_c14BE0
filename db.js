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
 
// Indexes for every column used in filters or sorts
await sql`CREATE INDEX IF NOT EXISTS idx_gender     ON profiles(gender)`;
await sql`CREATE INDEX IF NOT EXISTS idx_age        ON profiles(age)`;
await sql`CREATE INDEX IF NOT EXISTS idx_age_group  ON profiles(age_group)`;
await sql`CREATE INDEX IF NOT EXISTS idx_country_id ON profiles(country_id)`;
await sql`CREATE INDEX IF NOT EXISTS idx_created_at ON profiles(created_at)`;
await sql`CREATE INDEX IF NOT EXISTS idx_gprob      ON profiles(gender_probability)`;
await sql`CREATE INDEX IF NOT EXISTS idx_cprob      ON profiles(country_probability)`;

// Run once at startup, after DB is ready
const countryRows = await sql`SELECT DISTINCT country_id, country_name FROM profiles`;

const countryMap = {};
for (const { country_id, country_name } of countryRows) {
  countryMap[country_name.toLowerCase()] = country_id;
}

export { sql, countryMap };
