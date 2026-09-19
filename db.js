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
  rating        NUMERIC(3, 1),
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

-- Ratings are half points now, so the column has to hold 8.5. SMALLINT -> NUMERIC
-- is lossless in both directions for whole scores, but ALTER COLUMN TYPE has no
-- IF NOT EXISTS and rewrites the table every time it runs, so it is guarded.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'places'
      AND column_name = 'rating'
      AND data_type <> 'numeric'
  ) THEN
    ALTER TABLE places ALTER COLUMN rating TYPE NUMERIC(3, 1);
  END IF;
END $$;

-- One account per person on the list. The username_key column is the lower-cased
-- name and carries the uniqueness, so "Mason" and "mason" cannot both exist
-- while the name still displays the way it was typed.
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      TEXT NOT NULL,
  username_key  TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  token_version INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Nullable so the column can land on a database full of rows that predate
-- accounts; bootstrapOwner in server.js claims those on the next boot.
ALTER TABLE places ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users (id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS places_status_idx   ON places (status);
CREATE INDEX IF NOT EXISTS places_category_idx ON places (category);
CREATE INDEX IF NOT EXISTS places_created_idx  ON places (created_at DESC);
CREATE INDEX IF NOT EXISTS places_user_idx     ON places (user_id, created_at DESC);

-- One row per real-world place *per person*, so tapping the same search result
-- twice cannot create a duplicate. Rows typed by hand (no provider id) are exempt.
--
-- This index was global before accounts existed, which would have stopped a
-- second person from ever saving a restaurant someone else already had — and,
-- worse, handed them the other person's row to edit through the 409 path.
DROP INDEX IF EXISTS places_provider_id_idx;
CREATE UNIQUE INDEX IF NOT EXISTS places_user_provider_id_idx
  ON places (user_id, place_provider, place_id)
  WHERE place_id IS NOT NULL;
`;

export async function initDb() {
  await query(SCHEMA);
  console.log('[db] schema ready');
}
