import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import postgres from 'postgres';

import { createAuthRouter }     from './routes/auth.js';
import { createProfilesRouter } from './routes/profiles.js';
import { requestLogger }        from './middleware/logger.js';

const app  = express();
const port = process.env.PORT || 3000;

// Database
import { sql } from './sql.js';

//  Country map (built from DB, refreshed on POST) 
let countryMap        = {};
let sortedCountryKeys = [];

async function refreshCountryMap() {
  const rows = await sql`SELECT DISTINCT country_id, country_name FROM profiles`;
  countryMap = {};
  for (const { country_id, country_name } of rows) {
    countryMap[country_name.toLowerCase()] = country_id;
  }
  sortedCountryKeys = Object.keys(countryMap).sort((a, b) => b.length - a.length);
}

await refreshCountryMap();

function getCountryMap() {
  return { countryMap, sortedCountryKeys };
}

//  Middleware
app.use(cors({
  origin:      process.env.WEB_PORTAL_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());
app.use(requestLogger(sql));

// Rate limiting - stricter on auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max:      20,
  standardHeaders: true,
  message: { status: 'error', message: 'Too many requests, please try again later' },
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      200,
  standardHeaders: true,
  message: { status: 'error', message: 'Too many requests, please try again later' },
});

// Routes
app.get('/api/v1', (_req, res) => {
  res.json({ status: 'success', message: 'Insighta Labs+ API v1', version: '1.0.0' });
});

app.use('/api/v1/auth',     authLimiter, createAuthRouter(sql));
app.use('/api/v1/profiles', apiLimiter,  createProfilesRouter(sql, getCountryMap));

// Admin: view logs
app.get('/api/v1/admin/logs', async (req, res) => {
  const { authenticate } = await import('./middleware/auth.js');
  const { requireRole }  = await import('./middleware/auth.js');
  // inline — normally you'd put this in its own router
  res.status(200).json({ status: 'success', message: 'use /api/v1/admin router' });
});

// 404
app.use((_req, res) => res.status(404).json({ status: 'error', message: 'Route not found' }));

app.listen(port, () => console.log(`Insighta Labs+ API listening on port ${port}`));

export { refreshCountryMap };
