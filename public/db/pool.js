// db/pool.js
//
// Connects to Postgres Cloud SQL. Per instructions: the real connection
// string is supplied later, in configuration — this file just wires it up.
//
// Expected env vars (set in .env, never commit real values):
//   DATABASE_URL          e.g. postgres://user:pass@/dbname?host=/cloudsql/PROJECT:REGION:INSTANCE
//   PGSSL                 'true' if the connection requires SSL (usually not needed
//                          for the Cloud SQL Auth Proxy / unix socket connection)
//
// Cloud SQL from Cloud Run / Firebase Hosting + Functions typically connects
// via the Cloud SQL Auth Proxy using a unix socket, not a public IP — hence
// DATABASE_URL takes a ?host=/cloudsql/... form rather than a TCP host:port.
// If connecting over TCP instead, set DB_HOST/DB_PORT explicitly below.

require('dotenv').config();
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.warn(
    '[db] DATABASE_URL is not set. All queries will fail until the real ' +
    'Postgres Cloud SQL connection string is added to .env — see db/pool.js header.'
  );
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  // A background/idle client threw an error — log, don't crash the API.
  console.error('[db] unexpected error on idle client', err);
});

// Every table in this schema is Title_Case with underscores, and every
// schema is a separate Postgres schema (FMS, MSR, Master, RMS, SCS) — not
// a naming prefix. Quote both schema and table on every query.
function qi(identifier) {
  return `"${identifier.replace(/"/g, '""')}"`;
}

module.exports = { pool, qi };
