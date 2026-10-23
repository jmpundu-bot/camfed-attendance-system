const { Pool } = require('pg');

// Marketplace providers can expose more than one connection variable. Prefer
// the pooled URL where available for serverless function instances.
const connectionString = process.env.POSTGRES_URL
  || process.env.DATABASE_URL
  || process.env.POSTGRES_PRISMA_URL
  || '';

const pool = connectionString
  ? new Pool({ connectionString, max: Number(process.env.PG_POOL_MAX || 3) })
  : null;

if (pool) {
  pool.on('error', error => console.error('Unexpected idle PostgreSQL client error:', error));
}

module.exports = { pool, enabled: Boolean(pool) };
