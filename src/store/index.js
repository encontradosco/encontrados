const env = require('../env');

// Pick the storage backend: Postgres in production (Vercel sets POSTGRES_URL /
// DATABASE_URL), SQLite locally.
// Accept the connection string under any of the names the Vercel/Neon
// integration may inject, including custom prefixes like STORAGE_URL.
function findPostgresUrl() {
  const known = [
    'DATABASE_URL',
    'POSTGRES_URL',
    'STORAGE_URL',
    'STORAGE_POSTGRES_URL',
    'NEON_DATABASE_URL',
    'POSTGRES_PRISMA_URL'
  ];
  for (const k of known) {
    if (process.env[k]) return process.env[k];
  }
  const dynamic = Object.keys(process.env).find(
    (k) => /(_|^)(DATABASE|POSTGRES)_URL$/.test(k) && process.env[k].startsWith('postgres')
  );
  return dynamic ? process.env[dynamic] : null;
}

async function createAdapter() {
  const pgUrl = findPostgresUrl();
  if (pgUrl) {
    const { createPostgresAdapter } = require('./postgres');
    return createPostgresAdapter(pgUrl);
  }
  const { createSqliteAdapter } = require('./sqlite');
  if (process.env.VERCEL) {
    // Serverless filesystem is read-only except /tmp. This keeps the app usable
    // before Postgres is attached, but data does NOT survive between invocations.
    console.warn('[store] No DATABASE_URL/POSTGRES_URL set on Vercel — using EPHEMERAL SQLite in /tmp. Attach Postgres for real persistence.');
    return createSqliteAdapter('/tmp/encontrados.db');
  }
  return createSqliteAdapter(env.DB_PATH);
}

module.exports = { createAdapter };
