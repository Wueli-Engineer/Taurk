// Postgres access. Production uses `pg` against DATABASE_URL (Neon via Vercel works).
// Local development and tests can use DATABASE_URL=pglite:memory or pglite:./.data
import { RULES } from "./config.js";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  pw_hash TEXT NOT NULL,
  balance NUMERIC(14,2) NOT NULL CHECK (balance >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mode TEXT NOT NULL CHECK (mode IN ('owner', 'crowd')),
  current_version INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS edits (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  base_version INTEGER NOT NULL,
  code TEXT NOT NULL,
  hunks JSONB NOT NULL,
  added INTEGER NOT NULL,
  deleted INTEGER NOT NULL,
  cost INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'withdrawn', 'conflict')),
  refund NUMERIC(14,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closes_at TIMESTAMPTZ,
  decided_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS edits_status ON edits (status);
CREATE TABLE IF NOT EXISTS versions (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL,
  edit_id INTEGER REFERENCES edits(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS votes (
  edit_id INTEGER NOT NULL REFERENCES edits(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  yes BOOLEAN NOT NULL,
  weight NUMERIC(14,2) NOT NULL,
  PRIMARY KEY (edit_id, user_id)
);
INSERT INTO state (id, mode, current_version) VALUES (1, 'owner', 0) ON CONFLICT (id) DO NOTHING;
`;

// Upgrades databases created before balances could hold fractions (e.g. 62.5).
// Runs once: converts the columns, then credits every account what rounding down withheld.
const exactRefund = `CASE WHEN status = 'approved' THEN cost * ${1 + RULES.approvedBonus} ELSE cost * ${RULES.deniedRefund} END`;
export const MIGRATIONS = `
DO $$
BEGIN
  PERFORM pg_advisory_xact_lock(7151);
  IF (SELECT data_type FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'users' AND column_name = 'balance') = 'integer' THEN
    ALTER TABLE users ALTER COLUMN balance TYPE NUMERIC(14,2);
    ALTER TABLE edits ALTER COLUMN refund TYPE NUMERIC(14,2);
    ALTER TABLE votes ALTER COLUMN weight TYPE NUMERIC(14,2);
    UPDATE users u SET balance = u.balance + x.owed
      FROM (SELECT user_id, SUM(${exactRefund} - refund) AS owed FROM edits WHERE status <> 'pending' GROUP BY user_id) x
     WHERE x.user_id = u.id AND x.owed > 0;
    UPDATE edits SET refund = ${exactRefund} WHERE status <> 'pending';
  END IF;
END $$;
`;

let backend; // { query(text, params), tx(fn) }

async function connect() {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) throw new Error("DATABASE_URL is not set. See README.md.");
  if (url.startsWith("pglite:")) {
    const { PGlite } = await import("@electric-sql/pglite");
    const where = url.slice("pglite:".length);
    const opts = { parsers: { 1700: (v) => (v == null ? null : Number(v)) } }; // NUMERIC as numbers
    const db = where === "memory" ? new PGlite(opts) : new PGlite(where, opts);
    await db.exec(SCHEMA + MIGRATIONS);
    return {
      query: (t, p) => db.query(t, p),
      tx: (fn) => db.transaction((t) => fn({ query: (q, p) => t.query(q, p) })),
      close: () => db.close(),
    };
  }
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: url, max: 3, idleTimeoutMillis: 10_000 });
  // Two cold starts can race on CREATE ... IF NOT EXISTS; one retry settles it.
  // NUMERIC arrives as a string by default; balances are small, so plain numbers are exact enough.
  pg.types.setTypeParser(1700, (v) => (v == null ? null : Number(v)));
  try { await pool.query(SCHEMA + MIGRATIONS); } catch { await pool.query(SCHEMA + MIGRATIONS); }
  return {
    query: (t, p) => pool.query(t, p),
    async tx(fn) {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        const out = await fn({ query: (q, p) => c.query(q, p) });
        await c.query("COMMIT");
        return out;
      } catch (e) {
        await c.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        c.release();
      }
    },
    close: () => pool.end(),
  };
}

export function db() {
  if (!backend) backend = connect().catch((e) => { backend = undefined; throw e; });
  return backend;
}

/** For tests: drop the cached connection. */
export async function resetDb() {
  if (backend) { const b = await backend.catch(() => null); backend = undefined; await b?.close?.(); }
}
