import pg from 'pg';

const { Pool } = pg;

// Return DATE columns as plain 'YYYY-MM-DD' strings. By default node-pg turns them
// into Date objects at local midnight, which shifts the day by one once serialized
// to UTC JSON on any host running ahead of UTC.
pg.types.setTypeParser(1082, (value) => value);

// NUMERIC comes back as a string by default, which would ship coordinates to the
// browser as "36.160000". Everything numeric here is small enough for a float.
pg.types.setTypeParser(1700, (value) => (value === null ? null : Number(value)));

const connectionString = process.env.DATABASE_URL || '';

if (!connectionString) {
  console.error('[fatal] DATABASE_URL is not set. Add a Postgres service in Railway (or set DATABASE_URL locally).');
}

// Railway's private network connection does not use TLS. A public/proxy URL does.
const needsSsl = /sslmode=require/.test(connectionString) || process.env.PGSSL === 'true';

export const pool = new Pool({
  connectionString,
  ssl: needsSsl ? { rejectUnauthorized: false } : false,
  max: 5,
  idleTimeoutMillis: 30_000
});

export function query(text, params) {
  return pool.query(text, params);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS places (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  category      TEXT NOT NULL DEFAULT 'restaurant',
  neighborhood  TEXT,
  address       TEXT,
  status        TEXT NOT NULL DEFAULT 'visited',
  rating        SMALLINT,
  price         SMALLINT,
  would_return  BOOLEAN,
  visit_date    DATE,
  notes         TEXT,
  tags          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Added after the first release; ADD COLUMN IF NOT EXISTS keeps boot idempotent.
ALTER TABLE places ADD COLUMN IF NOT EXISTS lat            NUMERIC(9, 6);
ALTER TABLE places ADD COLUMN IF NOT EXISTS lng            NUMERIC(9, 6);
ALTER TABLE places ADD COLUMN IF NOT EXISTS place_provider TEXT;
ALTER TABLE places ADD COLUMN IF NOT EXISTS place_id       TEXT;
ALTER TABLE places ADD COLUMN IF NOT EXISTS source         TEXT;

CREATE INDEX IF NOT EXISTS places_status_idx   ON places (status);
CREATE INDEX IF NOT EXISTS places_category_idx ON places (category);
CREATE INDEX IF NOT EXISTS places_created_idx  ON places (created_at DESC);

-- One row per real-world place, so tapping the same search result twice cannot
-- create a duplicate. Rows typed by hand (no provider id) are exempt.
CREATE UNIQUE INDEX IF NOT EXISTS places_provider_id_idx
  ON places (place_provider, place_id)
  WHERE place_id IS NOT NULL;
`;

export async function initDb() {
  await query(SCHEMA);
  console.log('[db] schema ready');
}
