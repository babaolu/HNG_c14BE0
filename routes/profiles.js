import express from 'express';
import { uuidv7 } from 'uuidv7';
import { authenticate, requireRole } from '../middleware/auth.js';

export function createProfilesRouter(sql, getCountryMap) {
  const router = express.Router();

  // All profile routes require authentication
  router.use(authenticate);

  const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });

  function getAgeGroup(age) {
    if (age >= 0  && age <= 12) return 'child';
    if (age >= 13 && age <= 19) return 'teenager';
    if (age >= 20 && age <= 59) return 'adult';
    return 'senior';
  }

  // ── Shared query builder ──────────────────────────────────────────────────
  async function queryProfiles(filters = {}, sortBy = 'created_at', order = 'asc', page = 1, limit = 10) {
    const {
      gender, age_group, country_id,
      min_age, max_age,
      min_gender_probability, min_country_probability,
    } = filters;

    const conditions = [];
    const values     = [];

    if (gender)     { values.push(gender.toLowerCase());     conditions.push(`gender = $${values.length}`); }
    if (age_group)  { values.push(age_group.toLowerCase());  conditions.push(`age_group = $${values.length}`); }
    if (country_id) { values.push(country_id.toUpperCase()); conditions.push(`country_id = $${values.length}`); }
    if (min_age !== undefined) { values.push(parseInt(min_age));  conditions.push(`age >= $${values.length}`); }
    if (max_age !== undefined) { values.push(parseInt(max_age));  conditions.push(`age <= $${values.length}`); }
    if (min_gender_probability  !== undefined) { values.push(parseFloat(min_gender_probability));  conditions.push(`gender_probability >= $${values.length}`); }
    if (min_country_probability !== undefined) { values.push(parseFloat(min_country_probability)); conditions.push(`country_probability >= $${values.length}`); }

    const where    = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const orderSQL = `ORDER BY ${sortBy} ${order.toUpperCase()}`;
    const limitNum = Math.min(parseInt(limit) || 10, 50);
    const pageNum  = Math.max(parseInt(page)  || 1, 1);
    const offset   = (pageNum - 1) * limitNum;

    const [countResult, dataResult] = await Promise.all([
      sql.unsafe(`SELECT COUNT(*) FROM profiles ${where}`, values),
      sql.unsafe(
        `SELECT * FROM profiles ${where} ${orderSQL} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, limitNum, offset]
      ),
    ]);

    return {
      page:  pageNum,
      limit: limitNum,
      total: parseInt(countResult[0].count),
      data:  dataResult,
    };
  }

  // ── Natural language parser ───────────────────────────────────────────────
  function parseNaturalLanguageQuery(q) {
    const text    = q.toLowerCase().trim();
    const filters = {};

    if (/\bfemales?\b|\bwomen\b|\bwoman\b/.test(text))              filters.gender = 'female';
    if (/\bmen\b|\bman\b|\bmales?\b/.test(text) && !filters.gender) filters.gender = 'male';

    if (/\bchildren\b|\bchild\b|\bkids?\b/.test(text))              filters.age_group = 'child';
    if (/\bteen(ager)?s?\b/.test(text))                             filters.age_group = 'teenager';
    if (/\badults?\b/.test(text))                                   filters.age_group = 'adult';
    if (/\bseniors?\b|\belderly\b|\bold\s+people\b/.test(text))     filters.age_group = 'senior';

    if (/\byoung\b/.test(text)) { filters.min_age = 16; filters.max_age = 24; }

    const above   = text.match(/\b(?:above|over)\s+(\d+)\b/);
    const below   = text.match(/\b(?:below|under)\s+(\d+)\b/);
    const between = text.match(/\bbetween\s+(\d+)\s+and\s+(\d+)\b/);

    if (above)   filters.min_age = parseInt(above[1]);
    if (below)   filters.max_age = parseInt(below[1]);
    if (between) { filters.min_age = parseInt(between[1]); filters.max_age = parseInt(between[2]); }

    const { countryMap, sortedCountryKeys } = getCountryMap();
    for (const countryName of sortedCountryKeys) {
      if (text.includes(countryName)) {
        filters.country_id = countryMap[countryName];
        break;
      }
    }

    return filters;
  }

  // ── POST /api/v1/profiles — admin only ────────────────────────────────────
  router.post('/', requireRole('admin'), async (req, res) => {
    let { name } = req.body ?? {};

    if (!name || (typeof name === 'string' && name.trim() === '')) {
      return res.status(400).json({ status: 'error', message: 'name is required' });
    }
    if (typeof name !== 'string') {
      return res.status(422).json({ status: 'error', message: 'name must be a string' });
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

      [gender, age, nationality] = await Promise.all([gRes.json(), aRes.json(), nRes.json()]);
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

  // ── GET /api/v1/profiles/search — before /:id ────────────────────────────
  router.get('/search', async (req, res) => {
    const { q, page = 1, limit = 10 } = req.query;

    if (!q || q.trim() === '') {
      return res.status(400).json({ status: 'error', message: 'Missing or empty query' });
    }

    const filters = parseNaturalLanguageQuery(q);
    if (Object.keys(filters).length === 0) {
      return res.status(200).json({ status: 'error', message: 'Unable to interpret query' });
    }

    const result = await queryProfiles(filters, 'created_at', 'asc', page, limit);
    return res.status(200).json({ status: 'success', ...result });
  });

  // ── GET /api/v1/profiles/export — CSV, admin only ────────────────────────
  router.get('/export', requireRole('admin'), async (req, res) => {
    const profiles = await sql`SELECT * FROM profiles ORDER BY created_at ASC`;

    const headers = ['id','name','gender','gender_probability','age','age_group','country_id','country_name','country_probability','created_at'];
    const escape  = v => `"${String(v ?? '').replace(/"/g, '""')}"`;

    const csv = [
      headers.join(','),
      ...profiles.map(p => headers.map(h => escape(p[h])).join(',')),
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="profiles-${new Date().toISOString().slice(0,10)}.csv"`);
    return res.send(csv);
  });

  // ── GET /api/v1/profiles — both roles ────────────────────────────────────
  router.get('/', async (req, res) => {
    const {
      gender, age_group, country_id,
      min_age, max_age, min_gender_probability, min_country_probability,
      sort_by = 'created_at', order = 'asc',
      page = 1, limit = 10,
    } = req.query;

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

  // ── GET /api/v1/profiles/:id — both roles ────────────────────────────────
  router.get('/:id', async (req, res) => {
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

  // ── DELETE /api/v1/profiles/:id — admin only ─────────────────────────────
  router.delete('/:id', requireRole('admin'), async (req, res) => {
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

  return router;
}
