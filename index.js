import express from 'express';
import cors from 'cors';
import { uuidv7 } from "uuidv7";
import postgres from 'postgres';
import {getAgeGroup, queryProfiles, parseNaturalLanguageQuery } from './helper.js';
import { sql } from './db.js';
 
const app = express();

const port = process.env.PORT || 3000;
  
const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
 
app.use(cors());
app.use(express.json());
 
 
// -------- Routes -----------------------------------------------------
app.get('/api', (_req, res) => {
  res.status(200).json({ message: "HNG14 Stage 2", track: "DevOps", username: "ItunZ" });
});


app.post('/api/profiles', async (req, res) => {
  let { name } = req.body ?? {};
 
  if (!name || (typeof name === 'string' && name.trim() === '')) {
    return res.status(400).json({ status: 'error', message: "name is required" });
  }
  if (typeof name !== 'string') {
    return res.status(422).json({ status: 'error', message: "name must be a string" });
  }
 
  name = name.trim().toLowerCase();
 
  const [existing] = await sql`SELECT * FROM profiles WHERE name = ${name}`;
  if (existing) {
    return res.status(200).json({ status: 'success', message: 'Profile already exists', data: existing });
  }
 
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
    return res.status(502).json({ status: 'error', message: `${err.message || 'upstream'} returned an invalid response` });
  }
 
  if (!gender.gender || gender.count === 0) {
    return res.status(502).json({ status: 'error', message: 'Genderize returned an invalid response' });
  }
  if (age.age === null || age.age === undefined) {
    return res.status(502).json({ status: 'error', message: 'Agify returned an invalid response' });
  }
  if (!nationality.country || nationality.country.length === 0) {
    return res.status(502).json({ status: 'error', message: 'Nationalize returned an invalid response' });
  }
 
  const country = nationality.country.reduce((best, cur) =>
    cur.probability > best.probability ? cur : best);
 
  const data = {
    id:                  uuidv7(),
    name,
    gender:              gender.gender,
    gender_probability:  gender.probability,
    age:                 age.age,
    age_group:           getAgeGroup(age.age),
    country_id:          country.country_id,
    country_name:        regionNames.of(country.country_id) ?? country.country_id,
    country_probability: country.probability,
    created_at:          new Date().toISOString(),
  };
 
  await sql`INSERT INTO profiles ${sql(data, 'id','name','gender','gender_probability','age','age_group','country_id','country_name','country_probability','created_at')}`;
 
  return res.status(201).json({ status: 'success', data });
});
 
// ------ GET /api/profiles/search — MUST be before /api/profiles/:id --------
app.get('/api/profiles/search', async (req, res) => {
  const { q, page = 1, limit = 10 } = req.query;
 
  if (!q || q.trim() === '') {
    return res.status(400).json({ status: 'error', message: 'Missing or empty query' });
  }
 
  const filters = await parseNaturalLanguageQuery(q);
 
  if (Object.keys(filters).length === 0) {
    return res.status(200).json({ status: 'error', message: 'Unable to interpret query' });
  }
 
  const result = await queryProfiles(filters, 'created_at', 'asc', page, limit);
  return res.status(200).json({ status: 'success', ...result });
});
 
// --------- GET /api/profiles/:id -----------------------------------------
app.get('/api/profiles/:id', async (req, res) => {
  const { id } = req.params;
 
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRe.test(id)) {
    return res.status(404).json({ status: 'error', message: 'Profile not found' });
  }
 
  const [profile] = await sql`SELECT * FROM profiles WHERE id = ${id}`;
  if (!profile) {
    return res.status(404).json({ status: 'error', message: 'Profile not found' });
  }
 
  return res.status(200).json({ status: 'success', data: profile });
});
 
// ---------- GET /api/profiles ---------------------------------------
app.get('/api/profiles', async (req, res) => {
  const {
    gender, age_group, country_id,
    min_age, max_age, min_gender_probability, min_country_probability,
    sort_by = 'created_at', order = 'asc',
    page = 1, limit = 10,
  } = req.query;
 
  // Whitelist sort columns and order to prevent SQL injection
  const validSortBy = ['age', 'created_at', 'gender_probability'];
  const validOrder  = ['asc', 'desc'];
  if (!validSortBy.includes(sort_by) || !validOrder.includes(order.toLowerCase())) {
    return res.status(400).json({ status: 'error', message: 'Invalid query parameters' });
  }
 
  const result = await queryProfiles(
    { gender, age_group, country_id, min_age, max_age, min_gender_probability, min_country_probability },
    sort_by, order, page, limit
  );
 
  return res.status(200).json({ status: 'success', ...result });
});
 
// ---------- DELETE /api/profiles/:id -----------------------------------
app.delete('/api/profiles/:id', async (req, res) => {
  const { id } = req.params;
 
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRe.test(id)) {
    return res.status(404).json({ status: 'error', message: 'Profile not found' });
  }
 
  const result = await sql`DELETE FROM profiles WHERE id = ${id} RETURNING id`;
  if (!result.length) {
    return res.status(404).json({ status: 'error', message: 'Profile not found' });
  }
 
  return res.status(204).end();
});
 
// ----------- 404 catch-all ----------------------------------------------
app.use((_req, res) => {
  res.status(404).json({ status: 'error', message: 'Route not found' });
});
 
app.listen(port, () => console.log(`Server listening on port ${port}`));
 
