import pg from 'pg';

const { Pool } = pg;

// Return DATE columns as plain 'YYYY-MM-DD' strings. By default node-pg turns them
// into Date objects at local midnight, which shifts the day by one once serialized
// to UTC JSON on any host running ahead of UTC.
pg.types.setTypeParser(1082, (value) => value);

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

CREATE INDEX IF NOT EXISTS places_status_idx   ON places (status);
CREATE INDEX IF NOT EXISTS places_category_idx ON places (category);
CREATE INDEX IF NOT EXISTS places_created_idx  ON places (created_at DESC);
`;

export async function initDb() {
  await query(SCHEMA);
  console.log('[db] schema ready');
}
