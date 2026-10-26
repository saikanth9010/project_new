import { createDbPool } from '../lib/db.mjs';
import { seedDemoData } from '../lib/demo-data.mjs';

if (process.env.NODE_ENV === 'production') {
  throw new Error('Demo seed data is disabled in production.');
}

const pool = createDbPool();

try {
  const tenant = await pool.query(
    "INSERT INTO tenants(name, slug) VALUES ('Northstar Security', 'northstar') ON CONFLICT (slug) DO NOTHING RETURNING id",
  );
  const tenantRow = tenant.rows[0] || (await pool.query("SELECT id FROM tenants WHERE slug = 'northstar'")).rows[0];
  const counts = await seedDemoData(pool, tenantRow.id);
  process.stdout.write('Demo records loaded or refreshed: ' + JSON.stringify(counts) + '. All records are fictional.\n');
} finally {
  await pool.end();
}
