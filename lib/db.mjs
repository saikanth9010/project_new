import { readFileSync } from 'node:fs';
import pg from 'pg';

const { Pool } = pg;

export function createDbPool(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error('A PostgreSQL connection string is required.');
  const sslMode = process.env.DATABASE_SSL || 'disable';
  const production = process.env.NODE_ENV === 'production';
  let ssl = false;
  if (sslMode !== 'disable') {
    if (sslMode !== 'verify-full') throw new Error('DATABASE_SSL must be disable or verify-full.');
    if (!process.env.DATABASE_CA_CERT) throw new Error('DATABASE_CA_CERT is required for verified PostgreSQL TLS.');
    ssl = { ca: readFileSync(process.env.DATABASE_CA_CERT), rejectUnauthorized: true };
  }
  if (production && sslMode !== 'verify-full') {
    throw new Error('Production requires DATABASE_SSL=verify-full.');
  }
  const max = Number(process.env.DB_POOL_MAX || 10);
  if (!Number.isInteger(max) || max < 1 || max > 50) throw new Error('DB_POOL_MAX must be between 1 and 50.');
  return new Pool({
    connectionString,
    ssl,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: 'northstar-webgui',
  });
}

export async function inTransaction(pool, tenantId, callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (tenantId) await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const value = await callback(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* connection is already gone */ }
    throw error;
  } finally {
    client.release();
  }
}
