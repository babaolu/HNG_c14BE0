import { sql } from './db.js'

function getAgeGroup(age) {
  if (age >= 0  && age <= 12) return 'child';
  if (age >= 13 && age <= 19) return 'teenager';
  if (age >= 20 && age <= 59) return 'adult';
  return 'senior';
}
 
// Shared dynamic query builder used by both GET /api/profiles and /api/profiles/search
async function queryProfiles(filters = {}, sortBy = 'created_at', order = 'asc', page = 1, limit = 10) {
  const {
    gender, age_group, country_id,
    min_age, max_age,
    min_gender_probability, min_country_probability,
  } = filters;
 
  const conditions = [];
  const values     = [];
 
  if (gender) {
    values.push(gender.toLowerCase());
    conditions.push(`gender = $${values.length}`);
  }
  if (age_group) {
    values.push(age_group.toLowerCase());
    conditions.push(`age_group = $${values.length}`);
  }
  if (country_id) {
    values.push(country_id.toUpperCase());
    conditions.push(`country_id = $${values.length}`);
  }
  if (min_age !== undefined) {
    values.push(parseInt(min_age));
    conditions.push(`age >= $${values.length}`);
  }
  if (max_age !== undefined) {
    values.push(parseInt(max_age));
    conditions.push(`age <= $${values.length}`);
  }
  if (min_gender_probability  !== undefined) {
    values.push(parseFloat(min_gender_probability));
    conditions.push(`gender_probability >= $${values.length}`);
  }
  if (min_country_probability !== undefined) {
    values.push(parseFloat(min_country_probability));
    conditions.push(`country_probability >= $${values.length}`);
  }
 
  const where     = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const orderSQL  = `ORDER BY ${sortBy} ${order.toUpperCase()}`;
  const limitNum  = Math.min(parseInt(limit) || 10, 50);
  const pageNum   = Math.max(parseInt(page)  || 1,  1);
  const offset    = (pageNum - 1) * limitNum;
 
  const countResult = await sql.unsafe(`SELECT COUNT(*) FROM profiles ${where}`, values);
  const dataResult  = await sql.unsafe(
    `SELECT * FROM profiles ${where} ${orderSQL} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, limitNum, offset]
  );
 
  return {
    page:  pageNum,
    limit: limitNum,
    total: parseInt(countResult[0].count),
    data:  dataResult,
  };
}
 
// ------- Natural language parser ----------------------------------------
async function parseNaturalLanguageQuery(q) {
  const text    = q.toLowerCase().trim();
  const filters = {};
 
  // Gender
  if (/\bfemales?\b|\bwomen\b|\bwoman\b/.test(text))   filters.gender = 'female';
  // "men" alone means male, but don't override "women"
  if (/\bmen\b|\bman\b|\bmales?\b/.test(text) && !filters.gender)         filters.gender = 'male';
 
  // Age groups
  if (/\bchildren\b|\bchild\b|\bkids?\b/.test(text))        filters.age_group = 'child';
  if (/\bteen(ager)?s?\b/.test(text))                        filters.age_group = 'teenager';
  if (/\badults?\b/.test(text))                              filters.age_group = 'adult';
  if (/\bseniors?\b|\belderly\b|\bold\s+people\b/.test(text)) filters.age_group = 'senior';
 
  // "young" → 16–24 (spec-defined, not a stored age_group)
  if (/\byoung\b/.test(text)) {
    filters.min_age = 16;
    filters.max_age = 24;
  }
 
  // Numeric age expressions
  const above   = text.match(/\b(?:above|over)\s+(\d+)\b/);
  const below   = text.match(/\b(?:below|under)\s+(\d+)\b/);
  const between = text.match(/\bbetween\s+(\d+)\s+and\s+(\d+)\b/);
 
  if (above)   filters.min_age = parseInt(above[1]);
  if (below)   filters.max_age = parseInt(below[1]);
  if (between) { filters.min_age = parseInt(between[1]); filters.max_age = parseInt(between[2]); }

  const countryRows = await sql`SELECT DISTINCT country_id, country_name FROM profiles`;

  const countryMap = {};
  for (const { country_id, country_name } of countryRows) {
    countryMap[country_name.toLowerCase()] = country_id;
  }

  // Sort by length descending so "south africa" matches before "africa"
  const sortedCountries = Object.keys(countryMap).sort((a, b) => b.length - a.length);
  console.log("Country Map:", countryMap);
  for (const countryName of sortedCountries) {
    if (text.includes(countryName)) {
      filters.country_id = countryMap[countryName];
      break;
    }
  }
 
  return filters;
}

export {getAgeGroup, queryProfiles, parseNaturalLanguageQuery };
