import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createDbPool } from '../lib/db.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const migrationDirectory = join(directory, '..', 'db', 'migrations');
const pool = createDbPool(process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL);

try {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const filenames = (await readdir(migrationDirectory))
    .filter((filename) => /^\d+_[a-z0-9_-]+\.sql$/i.test(filename))
    .sort();
  for (const filename of filenames) {
    const alreadyApplied = await pool.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [filename]);
    if (alreadyApplied.rowCount) continue;
    const sql = await readFile(join(migrationDirectory, filename), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(filename) VALUES ($1)', [filename]);
      await client.query('COMMIT');
      process.stdout.write('Applied ' + filename + '\n');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* connection is already gone */ }
      throw error;
    } finally {
      client.release();
    }
  }
  process.stdout.write('Database migrations are current.\n');
} finally {
  await pool.end();
}
