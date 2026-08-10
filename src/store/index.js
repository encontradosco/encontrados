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
  return createSqliteAdapter(env.DB_PATH);
}

module.exports = { createAdapter };
