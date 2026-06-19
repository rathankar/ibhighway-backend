require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const pool = require('./db');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Aborting.');
    process.exit(1);
  }

  const fileArgIdx = process.argv.indexOf('--file');
  const relPath = fileArgIdx !== -1 && process.argv[fileArgIdx + 1]
    ? process.argv[fileArgIdx + 1]
    : 'db/init.sql';

  const sqlPath = path.resolve(__dirname, '..', '..', relPath);
  if (!fs.existsSync(sqlPath)) {
    console.error('Could not find SQL file at', sqlPath);
    process.exit(1);
  }

  const sql = fs.readFileSync(sqlPath, 'utf8');

  console.log('Applying', relPath, 'to', process.env.DATABASE_URL.replace(/:[^:@/]+@/, ':***@'));
  try {
    await pool.query(sql);
    console.log('Migration applied successfully.');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
