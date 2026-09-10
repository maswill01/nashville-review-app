import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDb, query, pool } from './db.js';
import { normalizeNeighborhood, normalizeTags } from './public/data/nashville.js';
import { searchPlaces, PROVIDER } from './place-search.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const AUTH_ENABLED = APP_PASSWORD.length > 0;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const COOKIE_NAME = 'nra_auth';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 60; // 60 days — stay logged in on your phone

const CATEGORIES = ['restaurant', 'bar', 'coffee', 'music', 'activity', 'shop', 'other'];
const STATUSES = ['visited', 'wishlist'];

// Ratings run 1-10. SMALLINT already held this, so widening the scale was a
// validation change only — old 1-5 rows stay valid and simply read low.
const RATING_MAX = 10;

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
  if (!Number.isInteger(n) || n < 1 || n > RATING_MAX) return null;
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

function toCoord(value, limit) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || Math.abs(n) > limit) return null;
  return n;
}

function normalizePlace(body) {
  const name = clean(body.name, 200);
  if (!name) return { error: 'Name is required.' };

  const category = CATEGORIES.includes(body.category) ? body.category : 'other';
  const status = STATUSES.includes(body.status) ? body.status : 'visited';

  // Coordinates only mean something as a pair — half of one is worse than neither.
  const lat = toCoord(body.lat, 90);
  const lng = toCoord(body.lng, 180);
  const hasCoords = lat !== null && lng !== null;

  const placeId = clean(body.place_id, 120);
  const provider = placeId ? clean(body.place_provider, 32) : null;

  return {
    value: {
      name,
      category,
      status,
      neighborhood: normalizeNeighborhood(clean(body.neighborhood, 120)),
      address: clean(body.address, 300),
      // Rating, "would go back" and the visit date only apply once you have been.
      rating: status === 'wishlist' ? null : toRating(body.rating),
      price: toPrice(body.price),
      would_return: status === 'wishlist' ? null : toBool(body.would_return),
      visit_date: status === 'wishlist' ? null : toDate(body.visit_date),
      // Kept for both statuses so moving a place to "been" does not lose who
      // recommended it, even though the form only shows it on the wishlist.
      source: clean(body.source, 200),
      notes: clean(body.notes, 4000),
      tags: normalizeTags(body.tags).join(', ') || null,
      lat: hasCoords ? lat : null,
      lng: hasCoords ? lng : null,
      place_provider: provider,
      place_id: provider ? placeId : null
    }
  };
}

const PLACE_COLUMNS = [
  'name', 'category', 'status', 'neighborhood', 'address', 'rating', 'price',
  'would_return', 'visit_date', 'source', 'notes', 'tags', 'lat', 'lng',
  'place_provider', 'place_id'
];

const placeParams = (value) => PLACE_COLUMNS.map((column) => value[column]);

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
      where.push(
        `(name ILIKE $${i} OR neighborhood ILIKE $${i} OR notes ILIKE $${i} ` +
        `OR tags ILIKE $${i} OR address ILIKE $${i} OR source ILIKE $${i})`
      );
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

// Everything the form needs to build its pickers in one round trip.
app.get('/api/meta', (_req, res) => {
  res.json({ placeSearch: Boolean(PROVIDER), provider: PROVIDER });
});

// Tags already in use, most-used first, so the tag input can autocomplete instead
// of letting a second spelling of the same tag into the data.
app.get('/api/tags', async (_req, res, next) => {
  try {
    const { rows } = await query(`
      SELECT tag, COUNT(*)::int AS count
      FROM (
        SELECT TRIM(LOWER(UNNEST(STRING_TO_ARRAY(tags, ',')))) AS tag
        FROM places
        WHERE tags IS NOT NULL AND tags <> ''
      ) t
      WHERE tag <> ''
      GROUP BY tag
      ORDER BY count DESC, tag ASC
      LIMIT 200
    `);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Proxy to the configured place provider. Results are cached briefly because the
// input fires this on every pause in typing and each call costs quota.
const searchCache = new Map();
const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const SEARCH_CACHE_MAX = 100;

app.get('/api/place-search', async (req, res) => {
  if (!PROVIDER) return res.json({ configured: false, results: [] });

  const q = clean(req.query.q, 120);
  if (!q || q.length < 2) return res.json({ configured: true, results: [] });

  const key = q.toLowerCase();
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < SEARCH_CACHE_TTL_MS) {
    return res.json({ configured: true, results: hit.results });
  }

  try {
    const results = await searchPlaces(q);
    if (searchCache.size >= SEARCH_CACHE_MAX) searchCache.clear();
    searchCache.set(key, { at: Date.now(), results });
    res.json({ configured: true, results });
  } catch (err) {
    // A provider outage must not block adding a place — the form falls back to
    // a typed name, so report the failure and let the user carry on.
    console.error('[place-search]', err.message);
    res.status(502).json({ configured: true, results: [], error: 'Place search is unavailable right now.' });
  }
});

app.post('/api/places', async (req, res, next) => {
  try {
    const { value, error } = normalizePlace(req.body || {});
    if (error) return res.status(400).json({ error });

    // Same place tapped twice out of search: hand back the row that already exists
    // so the client can open it for editing instead of making a second copy.
    if (value.place_id) {
      const dupe = await query(
        'SELECT * FROM places WHERE place_provider = $1 AND place_id = $2 LIMIT 1',
        [value.place_provider, value.place_id]
      );
      if (dupe.rows.length) {
        return res.status(409).json({ error: 'That place is already on your list.', place: dupe.rows[0] });
      }
    }

    const columns = PLACE_COLUMNS.join(', ');
    const placeholders = PLACE_COLUMNS.map((_, i) => `$${i + 1}`).join(',');
    const { rows } = await query(
      `INSERT INTO places (${columns}) VALUES (${placeholders}) RETURNING *`,
      placeParams(value)
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

    const assignments = PLACE_COLUMNS.map((column, i) => `${column} = $${i + 1}`).join(', ');
    const { rows } = await query(
      `UPDATE places SET ${assignments}, updated_at = NOW()
       WHERE id = $${PLACE_COLUMNS.length + 1}
       RETURNING *`,
      [...placeParams(value), id]
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
  if (err?.code === '23505') {
    return res.status(409).json({ error: 'That place is already on your list.' });
  }
  console.error('[error]', err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

/* --------------------------------- startup -------------------------------- */

if (!PROVIDER) {
  console.warn('[warn] No place-search key set (GOOGLE_PLACES_API_KEY or FOURSQUARE_API_KEY) — names are typed by hand, with no address or coordinates.');
}
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
