const env = require('../env');

// Pick the storage backend: Postgres in production (Vercel sets POSTGRES_URL /
// DATABASE_URL), SQLite locally.
async function createAdapter() {
  const pgUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (pgUrl) {
    const { createPostgresAdapter } = require('./postgres');
    return createPostgresAdapter(pgUrl);
  }
  const { createSqliteAdapter } = require('./sqlite');
  if (process.env.VERCEL) {
    // Serverless filesystem is read-only except /tmp. This keeps the app usable
    // before Postgres is attached, but data does NOT survive between invocations.
    console.warn('[store] No DATABASE_URL/POSTGRES_URL set on Vercel — using EPHEMERAL SQLite in /tmp. Attach Postgres for real persistence.');
    return createSqliteAdapter('/tmp/aqui.db');
  }
  return createSqliteAdapter(env.DB_PATH);
}

module.exports = { createAdapter };
