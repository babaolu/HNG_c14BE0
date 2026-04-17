import express from 'express';
import cors from 'cors';
import { uuidv7 } from "uuidv7";
import { createClient } from 'redis';

const app = express();
const port = 3000;

const client = createClient();
client.on('error', err => console.log('Redis Client Error', err));
await client.connect();

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
  const existingId = await client.get(`names:${name}`);
  if (existingId) {
    const raw = await client.get(`profiles:${existingId}`);
    const existing = raw ? JSON.parse(raw) : null;
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
    sample_size : gender.count,
    age : age.age,
    age_group : getAgeGroup(age.age),
    country_id : country.country_id,
    country_probability : country.probability,
    created_at : new Date().toISOString(),
  };

  await client.set(`profiles:${data.id}`, JSON.stringify(data));
  await client.set(`names:${data.name}`, data.id);
  await client.sAdd('names', data.name);

  res.status(201).json({status: "success", data});
});

app.get('/api/profiles/:id', async (req, res) => {
  const { id } = req.params;
 
  // Basic UUID format guard (prevents Redis noise from garbage input)
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRe.test(id)) {
    return res.status(404).json({ status: 'error', message: 'Profile not found' });
  }
 
  const raw = await client.get(`profiles:${id}`);
  console.log("Raw:", raw);
  if (!raw) {
    return res.status(404).json({ status: 'error', message: 'Profile not found' });
  }
  const profile = raw ? JSON.parse(raw) : null;
 
  return res.status(200).json({ status: 'success', data: profile });
});

app.get('/api/profiles', async (req, res) => {
  const { gender, country_id, age_group } = req.query;
 
  const names = await client.sMembers('names');
  if (!names) {
    return res.status(404).json({ status: 'error', message: 'No profiles found' });
  }

  let profiles = await Promise.all(
  names.map(async (name) => {
    const existingId = await client.get(`names:${name}`);
    if (!existingId) return null;

    const raw = await client.get(`profiles:${existingId}`); // also fix typo: profile not profiles
    const profile = raw ? JSON.parse(raw) : null;
    if (!profile) return null;
    
    if (gender && gender !== profile.gender) return null;
    if (country_id && country_id !== profile.country_id) return null;
    if (age_group && age_group !== profile.age_group) return null;

    let extract = {
      id : profile.id, name : profile.name,
      age : profile.age, gender : profile.gender,
      country_id : profile.country_id, age_group : profile.age_group,
    };

    return extract;
  })
);

  profiles = profiles.filter(Boolean);

  return res.status(200).json({ status: 'success', count: profiles.length, data: profiles });
});

app.delete('/api/profiles/:id', async (req, res) => {
  const { id } = req.params;
 
  // Basic UUID format guard (prevents Redis noise from garbage input)
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRe.test(id)) return res.status(404).json({ status: 'error', message: 'Profile not found' });

  const raw = await client.get(`profiles:${id}`);
  if (!raw) return res.status(404).json({ status: 'error', message: 'Profile not found' });

  const profile = JSON.parse(raw);

  await client.del(`profiles:${id}`);
  await client.del(`names:${profile.name}`);
  await client.sRem('names', profile.name);

  return res.status(204).end();
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
});

