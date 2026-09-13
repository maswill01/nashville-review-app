import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDb, query, pool } from './db.js';
import { normalizeNeighborhood, normalizeTags } from './public/data/nashville.js';
import { searchPlaces, PROVIDER } from './place-search.js';
import {
  COOKIE_MAX_AGE, COOKIE_NAME, SESSION_SECRET_SET, burnPasswordTime, clearFailures,
  hashPassword, readCookies, readSession, recordFailure, safeEqual, setAuthCookie,
  signSession, throttled, verifyPassword
} from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;

// APP_PASSWORD used to be the login. It is the signup gate now — the code you text
// a friend so they can make an account, never asked for again once they have one.
// Reading the old name as a fallback means the Railway variable does not have to
// change on the same deploy that ships accounts.
const INVITE_CODE = process.env.INVITE_CODE || process.env.APP_PASSWORD || '';
const INVITE_REQUIRED = INVITE_CODE.length > 0;

// Existing rows predate accounts. Whoever this is gets them on the next boot.
const OWNER_USERNAME = process.env.OWNER_USERNAME || '';
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || '';

const CATEGORIES = ['restaurant', 'breakfast', 'bar', 'coffee', 'music', 'activity', 'shop', 'other'];
const STATUSES = ['visited', 'wishlist'];

// Ratings run 1-10. SMALLINT already held this, so widening the scale was a
// validation change only — old 1-5 rows stay valid and simply read low.
const RATING_MAX = 10;

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '256kb' }));

/* ------------------------------ auth helpers ------------------------------ */

const publicUser = (user) => ({ id: user.id, username: user.username });

// Enough to pick which page to serve. A valid signature means somebody logged in
// on this device; whether that account still exists is the API's problem, and the
// API answers it one query later rather than on every static page load.
function hasSession(req) {
  return readSession(readCookies(req)[COOKIE_NAME]) !== null;
}

async function currentUser(req) {
  const session = readSession(readCookies(req)[COOKIE_NAME]);
  if (!session) return null;

  const { rows } = await query(
    'SELECT id, username, token_version FROM users WHERE id = $1 LIMIT 1',
    [session.id]
  );
  const user = rows[0];
  // A bumped token_version is how a cookie on a lost phone gets cancelled: same
  // user id, stale payload, no session.
  if (!user || user.token_version !== session.tokenVersion) return null;
  return user;
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

// It shows up in other people's list picker, so a username is a name, not free
// text. The lower-cased form is what the unique index actually holds.
const USERNAME_RE = /^[a-zA-Z0-9._-]{2,30}$/;
const PASSWORD_MIN = 8;

function normalizeCredentials(body) {
  const username = clean(body.username, 30);
  if (!username || !USERNAME_RE.test(username)) {
    return { error: 'Usernames are 2-30 characters: letters, numbers, dot, dash or underscore.' };
  }
  const password = String(body.password ?? '');
  const problem = passwordProblem(password);
  if (problem) return { error: problem };
  return { value: { username, password } };
}

function passwordProblem(password) {
  if (password.length < PASSWORD_MIN) {
    return `Pick a password of at least ${PASSWORD_MIN} characters.`;
  }
  // scrypt does not care about length, but there is no reason to hash a megabyte.
  if (password.length > 200) return 'That password is too long.';
  return null;
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
    res.json({ ok: true, db: 'up', invite: INVITE_REQUIRED });
  } catch (err) {
    res.status(503).json({ ok: false, db: 'down', error: err.message });
  }
});

app.post('/api/login', async (req, res, next) => {
  try {
    const key = (clean(req.body?.username, 30) || '').toLowerCase();
    const password = String(req.body?.password ?? '');

    if (throttled(`login:${key}`)) {
      return res.status(429).json({ error: 'Too many tries. Give it a few minutes.' });
    }

    const { rows } = await query(
      'SELECT id, username, password_hash, token_version FROM users WHERE username_key = $1 LIMIT 1',
      [key]
    );
    const user = rows[0];
    // Spend the same time on a username that does not exist as on one that does,
    // so the form cannot be used to find out who has an account here.
    const ok = user ? await verifyPassword(password, user.password_hash) : await burnPasswordTime();

    if (!user || !ok) {
      recordFailure(`login:${key}`);
      return res.status(401).json({ error: 'Wrong username or password.' });
    }

    clearFailures(`login:${key}`);
    setAuthCookie(req, res, signSession(user), COOKIE_MAX_AGE);
    res.json({ ok: true, user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

app.post('/api/signup', async (req, res, next) => {
  try {
    // Keyed by address, not by username: guessing the invite code means trying
    // many codes, and each try could name a different account.
    const gate = `signup:${req.ip}`;
    if (throttled(gate)) {
      return res.status(429).json({ error: 'Too many tries. Give it a few minutes.' });
    }
    if (INVITE_REQUIRED && !safeEqual(String(req.body?.invite ?? ''), INVITE_CODE)) {
      recordFailure(gate);
      return res.status(403).json({ error: 'That invite code is not right.' });
    }

    const { value, error } = normalizeCredentials(req.body || {});
    if (error) return res.status(400).json({ error });

    const hash = await hashPassword(value.password);
    const { rows } = await query(
      `INSERT INTO users (username, username_key, password_hash)
       VALUES ($1, $2, $3)
       ON CONFLICT (username_key) DO NOTHING
       RETURNING id, username, token_version`,
      [value.username, value.username.toLowerCase(), hash]
    );
    if (!rows.length) return res.status(409).json({ error: 'That username is taken.' });

    clearFailures(gate);
    setAuthCookie(req, res, signSession(rows[0]), COOKIE_MAX_AGE);
    res.status(201).json({ ok: true, user: publicUser(rows[0]) });
  } catch (err) {
    next(err);
  }
});

app.post('/api/logout', (req, res) => {
  setAuthCookie(req, res, '', 0);
  res.json({ ok: true });
});

// Everything below /api requires a session, and knows whose it is.
app.use('/api', async (req, res, next) => {
  try {
    const user = await currentUser(req);
    if (!user) return res.status(401).json({ error: 'unauthorized' });
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
});

// Whose list this request is looking at: yours unless ?user= names someone else.
// Nothing here grants write access — every write ignores the parameter and uses
// req.user.id — so another account's list is read-only by construction rather than
// by a permission check somebody has to remember.
async function viewedUserId(req) {
  const username = clean(req.query.user, 30);
  if (!username || username.toLowerCase() === req.user.username.toLowerCase()) {
    return req.user.id;
  }
  const { rows } = await query(
    'SELECT id FROM users WHERE username_key = $1 LIMIT 1',
    [username.toLowerCase()]
  );
  return rows.length ? rows[0].id : null;
}

// Everyone with an account, so the list switcher has somebody to switch to.
app.get('/api/users', async (_req, res, next) => {
  try {
    const { rows } = await query(`
      SELECT
        u.username,
        (COUNT(p.id) FILTER (WHERE p.status = 'visited'))::int  AS visited,
        (COUNT(p.id) FILTER (WHERE p.status = 'wishlist'))::int AS wishlist,
        ROUND(AVG(p.rating) FILTER (WHERE p.status = 'visited'), 1) AS avg_rating
      FROM users u
      LEFT JOIN places p ON p.user_id = u.id
      GROUP BY u.id, u.username
      ORDER BY LOWER(u.username) ASC
    `);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

app.post('/api/password', async (req, res, next) => {
  try {
    const next_ = String(req.body?.password ?? '');
    const problem = passwordProblem(next_);
    if (problem) return res.status(400).json({ error: problem });

    const { rows } = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!rows.length || !(await verifyPassword(String(req.body?.current ?? ''), rows[0].password_hash))) {
      // 403, not the 401 this would otherwise deserve: the caller's session is
      // fine, it is the typed password that is wrong, and `api()` in app.js bounces
      // every 401 straight to the login page. Answering 401 here would throw the
      // user out of the app for a typo.
      return res.status(403).json({ error: 'That is not your current password.' });
    }

    // Bumping token_version is the point of changing a password you think leaked:
    // it cancels every cookie this account holds. Re-signing here keeps the device
    // doing the changing logged in, and signs the others out.
    const hash = await hashPassword(next_);
    const { rows: updated } = await query(
      `UPDATE users SET password_hash = $1, token_version = token_version + 1
       WHERE id = $2
       RETURNING id, username, token_version`,
      [hash, req.user.id]
    );
    setAuthCookie(req, res, signSession(updated[0]), COOKIE_MAX_AGE);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.get('/api/places', async (req, res, next) => {
  try {
    // Every read is scoped to one person's list. Nothing reaches the browser
    // without a user_id in the WHERE clause.
    const viewing = await viewedUserId(req);
    if (viewing === null) return res.status(404).json({ error: 'No such list.' });

    const where = ['user_id = $1'];
    const params = [viewing];

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

app.get('/api/stats', async (req, res, next) => {
  try {
    const viewing = await viewedUserId(req);
    if (viewing === null) return res.status(404).json({ error: 'No such list.' });

    const { rows } = await query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'visited')  AS visited,
        COUNT(*) FILTER (WHERE status = 'wishlist') AS wishlist,
        ROUND(AVG(rating) FILTER (WHERE status = 'visited'), 1) AS avg_rating
      FROM places
      WHERE user_id = $1
    `, [viewing]);
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// Everything the form needs to build its pickers in one round trip.
app.get('/api/meta', (req, res) => {
  res.json({ placeSearch: Boolean(PROVIDER), provider: PROVIDER, user: publicUser(req.user) });
});

// Tags already in use, most-used first, so the tag input can autocomplete instead
// of letting a second spelling of the same tag into the data. Deliberately always
// yours and never ?user=: this feeds the add form, which only exists on your own
// list, and a friend's vocabulary in there would be how a second spelling gets in.
app.get('/api/tags', async (req, res, next) => {
  try {
    const { rows } = await query(`
      SELECT tag, COUNT(*)::int AS count
      FROM (
        SELECT TRIM(LOWER(UNNEST(STRING_TO_ARRAY(tags, ',')))) AS tag
        FROM places
        WHERE user_id = $1 AND tags IS NOT NULL AND tags <> ''
      ) t
      WHERE tag <> ''
      GROUP BY tag
      ORDER BY count DESC, tag ASC
      LIMIT 200
    `, [req.user.id]);
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
        'SELECT * FROM places WHERE user_id = $1 AND place_provider = $2 AND place_id = $3 LIMIT 1',
        [req.user.id, value.place_provider, value.place_id]
      );
      if (dupe.rows.length) {
        return res.status(409).json({ error: 'That place is already on your list.', place: dupe.rows[0] });
      }
    }

    // user_id is deliberately outside PLACE_COLUMNS: that array also drives the
    // UPDATE, and ownership is set once at insert and never reassigned.
    const columns = [...PLACE_COLUMNS, 'user_id'];
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(',');
    const { rows } = await query(
      `INSERT INTO places (${columns.join(', ')}) VALUES (${placeholders}) RETURNING *`,
      [...placeParams(value), req.user.id]
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

    // Somebody else's row is "not found" rather than "forbidden": the reply says
    // nothing about whether that id exists on another list.
    const assignments = PLACE_COLUMNS.map((column, i) => `${column} = $${i + 1}`).join(', ');
    const { rows } = await query(
      `UPDATE places SET ${assignments}, updated_at = NOW()
       WHERE id = $${PLACE_COLUMNS.length + 1} AND user_id = $${PLACE_COLUMNS.length + 2}
       RETURNING *`,
      [...placeParams(value), id, req.user.id]
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
    const { rowCount } = await query('DELETE FROM places WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    if (!rowCount) return res.status(404).json({ error: 'Not found.' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* --------------------------------- pages ---------------------------------- */

app.get('/', (req, res) => {
  const file = hasSession(req) ? 'index.html' : 'login.html';
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
if (!INVITE_REQUIRED) {
  console.warn('[warn] No INVITE_CODE set — anyone who finds the URL can create an account and read every list.');
}
if (!SESSION_SECRET_SET) {
  console.warn('[warn] SESSION_SECRET is not set — a random one is generated, so everyone is logged out on every restart.');
}

// Rows added before accounts existed have no owner. Hand them to OWNER_USERNAME,
// creating that account if it is not there yet, so the owner's list is never
// briefly empty after the deploy that turns scoping on. Idempotent: once the rows
// are claimed the UPDATE matches nothing, and an existing password is never
// overwritten, so the env var can stay set or be removed afterwards.
async function bootstrapOwner() {
  const { rows: counted } = await query('SELECT COUNT(*)::int AS n FROM places WHERE user_id IS NULL');
  const unowned = counted[0].n;

  if (!OWNER_USERNAME) {
    // Silence here would mean a deploy where the list simply looks empty, which is
    // the single most alarming way this change could go wrong.
    if (unowned) {
      console.warn(`[warn] ${unowned} place(s) predate accounts and belong to nobody, so nobody can see them. Set OWNER_USERNAME (with OWNER_PASSWORD if that account does not exist yet) to claim them.`);
    }
    return;
  }

  const username = clean(OWNER_USERNAME, 30);
  if (!username || !USERNAME_RE.test(username)) {
    console.warn(`[warn] OWNER_USERNAME "${OWNER_USERNAME}" is not a valid username — skipping.`);
    return;
  }

  const key = username.toLowerCase();
  let { rows } = await query('SELECT id FROM users WHERE username_key = $1 LIMIT 1', [key]);

  if (!rows.length) {
    if (OWNER_PASSWORD.length < PASSWORD_MIN) {
      console.warn(`[warn] OWNER_USERNAME is set but OWNER_PASSWORD is missing or under ${PASSWORD_MIN} characters, so the account was not created and ${unowned} place(s) that predate accounts are still owned by nobody.`);
      return;
    }
    const hash = await hashPassword(OWNER_PASSWORD);
    ({ rows } = await query(
      `INSERT INTO users (username, username_key, password_hash)
       VALUES ($1, $2, $3)
       ON CONFLICT (username_key) DO NOTHING
       RETURNING id`,
      [username, key, hash]
    ));
    if (rows.length) console.log(`[db] created the owner account "${username}"`);
    else ({ rows } = await query('SELECT id FROM users WHERE username_key = $1 LIMIT 1', [key]));
  }

  const { rowCount } = await query('UPDATE places SET user_id = $1 WHERE user_id IS NULL', [rows[0].id]);
  if (rowCount) console.log(`[db] gave ${rowCount} place(s) that predate accounts to "${username}"`);
}

initDb()
  .then(bootstrapOwner)
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
