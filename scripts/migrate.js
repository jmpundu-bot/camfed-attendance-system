const fs = require('fs');
const path = require('path');
require('../load-env');
const { pool } = require('../database');

async function main() {
  if (!pool) throw new Error('Set DATABASE_URL or POSTGRES_URL before running the database migration.');
  const schema = fs.readFileSync(path.join(__dirname, '..', 'migrations', '001_initial_schema.sql'), 'utf8');
  await pool.query(schema);
  console.log('PostgreSQL schema is ready.');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => { if (pool) await pool.end(); });
