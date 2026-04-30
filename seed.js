import { readFileSync } from 'fs';
import postgres from 'postgres';
import { uuidv7 } from 'uuidv7';

const sql = postgres(process.env.DATABASE_URL || 'postgres://localhost:5432/profiles');

const { profiles } = JSON.parse(readFileSync('./seed_profiles.json', 'utf8'));

console.log(`Seeding ${profiles.length} profiles...`);

const CHUNK = 100;
let inserted = 0;
let skipped  = 0;

for (let i = 0; i < profiles.length; i += CHUNK) {
  const chunk = profiles.slice(i, i + CHUNK);

  const rows = chunk.map(p => ({
    id:                  uuidv7(),
    name:                p.name.trim().toLowerCase(),
    gender:              p.gender,
    gender_probability:  p.gender_probability,
    age:                 p.age,
    age_group:           p.age_group,
    country_id:          p.country_id,
    country_name:        p.country_name,
    country_probability: p.country_probability,
    created_at:          new Date().toISOString(),
  }));

  const result = await sql`
    INSERT INTO profiles ${sql(rows, 'id','name','gender','gender_probability','age','age_group','country_id','country_name','country_probability','created_at')}
    ON CONFLICT (name) DO NOTHING
    RETURNING id
  `;

  inserted += result.length;
  skipped  += chunk.length - result.length;
  console.log(`  chunk ${Math.floor(i / CHUNK) + 1}: ${result.length} inserted, ${chunk.length - result.length} skipped`);
}

console.log(`\nDone. ${inserted} inserted, ${skipped} skipped (duplicates).`);
await sql.end();
