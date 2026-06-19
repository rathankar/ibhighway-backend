const { Pool } = require('pg');
require('dotenv').config();

// Managed Postgres providers (Neon, Supabase, Render) require SSL.
// Local docker Postgres does not. Auto-detect: enable SSL unless the URL
// contains ?sslmode=disable or we're connecting to localhost.
function deriveSsl() {
  if (process.env.PGSSL === 'disable') return false;
  if (process.env.PGSSL === 'require') return { rejectUnauthorized: false };
  const url = process.env.DATABASE_URL || '';
  if (/sslmode=disable/i.test(url)) return false;
  if (/@(localhost|127\.0\.0\.1|\[::1\])/.test(url)) return false;
  // Default to SSL on (managed providers).
  return { rejectUnauthorized: false };
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: deriveSsl(),
  // Conservative sizing for free-tier Postgres (Neon free = 1 vCPU, 20 conns).
  max: Number(process.env.PG_POOL_MAX) || 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => {
  console.error('Unexpected DB error:', err);
});

module.exports = pool;
