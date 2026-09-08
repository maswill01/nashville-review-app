import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDb, query, pool } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const AUTH_ENABLED = APP_PASSWORD.length > 0;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const COOKIE_NAME = 'nra_auth';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 60; // 60 days — stay logged in on your phone

const CATEGORIES = ['restaurant', 'bar', 'coffee', 'music', 'activity', 'shop', 'other'];
const STATUSES = ['visited', 'wishlist'];

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '256kb' }));

/* ------------------------------ auth helpers ------------------------------ */

function sessionToken() {
  return crypto.createHmac('sha256', SESSION_SECRET).update('authenticated:v1').digest('hex');
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function readCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out[trimmed.slice(0, eq)] = decodeURIComponent(trimmed.slice(eq + 1));
  }
  return out;
}

function isAuthed(req) {
  if (!AUTH_ENABLED) return true;
  const token = readCookies(req)[COOKIE_NAME];
  return Boolean(token) && safeEqual(token, sessionToken());
}

function setAuthCookie(req, res, value, maxAge) {
  const secure = req.headers['x-forwarded-proto'] === 'https' || req.secure;
  const bits = [
    `${COOKIE_NAME}=${value}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${maxAge}`
  ];
  if (secure) bits.push('Secure');
  res.setHeader('Set-Cookie', bits.join('; '));
}

/* -------------------------------- validation ------------------------------ */

function clean(value, max = 500) {
  if (value === undefined || value === null) return null;
  const str = String(value).trim();
  if (!str) return null;
  return str.slice(0, max);
}

function toRating(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 5) return null;
  return n;
}

function toPrice(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 4) return null;
  return n;
}

function toBool(value) {
  if (value === undefined || value === null || value === '') return null;
  return value === true || value === 'true' || value === 1 || value === '1';
}

function toDate(value) {
  const str = clean(value, 10);
  if (!str) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(str) ? str : null;
}

function normalizePlace(body) {
  const name = clean(body.name, 200);
  if (!name) return { error: 'Name is required.' };

  const category = CATEGORIES.includes(body.category) ? body.category : 'other';
  const status = STATUSES.includes(body.status) ? body.status : 'visited';

  return {
    value: {
      name,
      category,
      status,
      neighborhood: clean(body.neighborhood, 120),
      address: clean(body.address, 300),
      rating: status === 'wishlist' ? null : toRating(body.rating),
      price: toPrice(body.price),
      would_return: status === 'wishlist' ? null : toBool(body.would_return),
      visit_date: status === 'wishlist' ? null : toDate(body.visit_date),
      notes: clean(body.notes, 4000),
      tags: clean(body.tags, 300)
    }
  };
}

/* ---------------------------------- routes -------------------------------- */

app.get('/api/health', async (_req, res) => {
  try {
    await query('SELECT 1');
    res.json({ ok: true, db: 'up', auth: AUTH_ENABLED });
  } catch (err) {
    res.status(503).json({ ok: false, db: 'down', error: err.message });
  }
});

app.post('/api/login', (req, res) => {
  if (!AUTH_ENABLED) return res.json({ ok: true });
  const password = String(req.body?.password ?? '');
  if (!safeEqual(password, APP_PASSWORD)) {
    return res.status(401).json({ error: 'Incorrect password.' });
  }
  setAuthCookie(req, res, sessionToken(), COOKIE_MAX_AGE);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  setAuthCookie(req, res, '', 0);
  res.json({ ok: true });
});

// Everything below /api requires a session.
app.use('/api', (req, res, next) => {
  if (isAuthed(req)) return next();
  res.status(401).json({ error: 'unauthorized' });
});

app.get('/api/places', async (req, res, next) => {
  try {
    const where = [];
    const params = [];

    if (STATUSES.includes(req.query.status)) {
      params.push(req.query.status);
      where.push(`status = $${params.length}`);
    }
    if (CATEGORIES.includes(req.query.category)) {
      params.push(req.query.category);
      where.push(`category = $${params.length}`);
    }
    const search = clean(req.query.q, 100);
    if (search) {
      params.push(`%${search}%`);
      const i = params.length;
      where.push(`(name ILIKE $${i} OR neighborhood ILIKE $${i} OR notes ILIKE $${i} OR tags ILIKE $${i})`);
    }

    const sorts = {
      recent: 'created_at DESC',
      rating: 'rating DESC NULLS LAST, created_at DESC',
      name: 'LOWER(name) ASC',
      visited: 'visit_date DESC NULLS LAST, created_at DESC'
    };
    const orderBy = sorts[req.query.sort] || sorts.recent;

    const sql = `SELECT * FROM places ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${orderBy} LIMIT 500`;
    const { rows } = await query(sql, params);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

app.get('/api/stats', async (_req, res, next) => {
  try {
    const { rows } = await query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'visited')  AS visited,
        COUNT(*) FILTER (WHERE status = 'wishlist') AS wishlist,
        ROUND(AVG(rating) FILTER (WHERE status = 'visited'), 1) AS avg_rating
      FROM places
    `);
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

app.post('/api/places', async (req, res, next) => {
  try {
    const { value, error } = normalizePlace(req.body || {});
    if (error) return res.status(400).json({ error });

    const { rows } = await query(
      `INSERT INTO places (name, category, status, neighborhood, address, rating, price, would_return, visit_date, notes, tags)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [value.name, value.category, value.status, value.neighborhood, value.address,
       value.rating, value.price, value.would_return, value.visit_date, value.notes, value.tags]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

app.put('/api/places/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id.' });

    const { value, error } = normalizePlace(req.body || {});
    if (error) return res.status(400).json({ error });

    const { rows } = await query(
      `UPDATE places SET
         name = $1, category = $2, status = $3, neighborhood = $4, address = $5,
         rating = $6, price = $7, would_return = $8, visit_date = $9, notes = $10,
         tags = $11, updated_at = NOW()
       WHERE id = $12
       RETURNING *`,
      [value.name, value.category, value.status, value.neighborhood, value.address,
       value.rating, value.price, value.would_return, value.visit_date, value.notes, value.tags, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found.' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

app.delete('/api/places/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id.' });
    const { rowCount } = await query('DELETE FROM places WHERE id = $1', [id]);
    if (!rowCount) return res.status(404).json({ error: 'Not found.' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* --------------------------------- pages ---------------------------------- */

app.get('/', (req, res) => {
  const file = isAuthed(req) ? 'index.html' : 'login.html';
  res.sendFile(path.join(__dirname, 'public', file));
});

app.get('/login', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.use((err, _req, res, _next) => {
  console.error('[error]', err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

/* --------------------------------- startup -------------------------------- */

if (!AUTH_ENABLED) {
  console.warn('[warn] APP_PASSWORD is not set — anyone with the URL can read and edit your data.');
}
if (AUTH_ENABLED && !process.env.SESSION_SECRET) {
  console.warn('[warn] SESSION_SECRET is not set — a random one is generated, so you are logged out on every restart.');
}

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`[server] listening on :${PORT}`));
  })
  .catch((err) => {
    console.error('[fatal] could not initialize the database:', err.message);
    process.exit(1);
  });

process.on('SIGTERM', async () => {
  await pool.end().catch(() => {});
  process.exit(0);
});
