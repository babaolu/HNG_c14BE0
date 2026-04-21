import express from 'express';
import cors from 'cors';
import { uuidv7 } from "uuidv7";
import postgres from 'postgres';

const app = express();
const port = process.env.PORT || 3000;

const sql = postgres(process.env.DATABASE_URL || 'postgres://localhost:5432/profiles');

await sql`
  CREATE TABLE IF NOT EXISTS profiles (
    id                  TEXT        PRIMARY KEY,
    name                VARCHAR     NOT NULL UNIQUE,
    gender              VARCHAR     NOT NULL,
    gender_probability  FLOAT       NOT NULL,
    age                 INT         NOT NULL,
    age_group           VARCHAR     NOT NULL,
    country_id          VARCHAR(2)  NOT NULL,
    country_name        VARCHAR     NOT NULL,
    country_probability FLOAT       NOT NULL,
    created_at          TIMESTAMP   NOT NULL DEFAULT now()
  )
`;

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });

app.use(cors())
app.use(express.json())

function getAgeGroup(age) {
  if (age >= 0  && age <= 12) return 'child';
  if (age >= 13 && age <= 19) return 'teenager';
  if (age >= 20 && age <= 59) return 'adult';
  return 'senior'; // 60+
}

app.get('/api', (req, res) => {
  res.status(200).json({
    message: "HNG14 Stage 1",
    track: "DevOps",
    username: "ItunZ"
  });
});

app.post('/api/profiles', async (req, res) => {
  let { name } = req.body ?? {};
  if (!name || (typeof name === 'string' && name.trim() === '')) {
    return res.status(400).json({status: 'error', message: "name is required"});
  }
  if (typeof name !== 'string') {
    return res.status(422).json({status: 'error', message: "name must be a string"});
  }

  name = name.trim().toLowerCase();

  // -- Return existing profile ----------------------------------------------
  const [existing] = await sql`SELECT * FROM profiles WHERE name = ${name}`;
  if (existing) {
    return res.status(200).json({status: 'success', message: 'Profile already exists', data: existing});
  }

  // -- Call external APIs --------------------------------------------------
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
 
    [gender, age, nationality] = await Promise.all([
      gRes.json(), aRes.json(), nRes.json(),
    ]);
  } catch (err) {
    const api = err.message || 'upstream';
    return res.status(502).json({
      status: 'error',
      message: `${api} returned an invalid response`,
    });
  }

  // -- Validate external API payloads -----------------------------------------
  if (!gender.gender || gender.count === 0) {
    return res.status(502).json({
      status: 'error',
      message: 'Genderize returned an invalid response',
    });
  }
  if (age.age === null || age.age === undefined) {
    return res.status(502).json({
      status: 'error',
      message: 'Agify returned an invalid response',
    });
  }
  if (!nationality.country || nationality.country.length === 0) {
    return res.status(502).json({
      status: 'error',
      message: 'Nationalize returned an invalid response',
    });
  }

  const country = nationality.country.reduce((highest, current) => 
    highest.probability > current.probability ? highest : current);

  
  let data = {
    id : uuidv7(),
    name, 
    gender : gender.gender,
    gender_probability : gender.probability,
    age : age.age,
    age_group : getAgeGroup(age.age),
    country_id : country.country_id,
    country_name : regionNames.of(country.country_id) ?? country.country_id,
    country_probability : country.probability,
    created_at : new Date().toISOString(),
  };

  await sql`
    INSERT INTO profiles ${sql(data, 'id','name','gender','gender_probability','age','age_group','country_id','country_name','country_probability','created_at')}
  `;

  res.status(201).json({status: "success", data});
});

app.get('/api/profiles/:id', async (req, res) => {
  const { id } = req.params;
 
  // Basic UUID format guard (prevents Redis noise from garbage input)
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRe.test(id)) {
    return res.status(404).json({ status: 'error', message: 'Profile not found' });
  }
 
  const raw = await sql`SELECT * FROM profiles WHERE id = ${id}`;
  if (!raw.length) {
    return res.status(404).json({ status: 'error', message: 'Profile not found' });
  }
  const profile = raw[0];
 
  return res.status(200).json({ status: 'success', data: profile });
});

app.get('/api/profiles', async (req, res) => {
  const { gender, country_id, age_group } = req.query;
 
  const profiles = await sql`
    SELECT id, name, age, gender, age_group, country_id, country_name
    FROM profiles
    WHERE (${gender  ?? null}::text IS NULL OR gender     = ${gender  ?? null})
      AND (${country_id ?? null}::text IS NULL OR country_id = ${country_id ?? null})
      AND (${age_group ?? null}::text IS NULL OR age_group  = ${age_group ?? null})
  `;

  return res.status(200).json({ status: 'success', count: profiles.length, data: profiles });
});

app.delete('/api/profiles/:id', async (req, res) => {
  const { id } = req.params;
 
  // Basic UUID format guard (prevents Redis noise from garbage input)
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRe.test(id)) return res.status(404).json({ status: 'error', message: 'Profile not found' });

  const result = await sql`DELETE FROM profiles WHERE id = ${id} RETURNING id`;
  if (!result.length) return res.status(404).json({ status: 'error', message: 'Profile not found' });

  return res.status(204).end();
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
});

