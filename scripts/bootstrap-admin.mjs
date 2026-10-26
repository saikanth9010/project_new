import { createDbPool } from '../lib/db.mjs';
import { hashPassword } from '../lib/security.mjs';

const pool = createDbPool(process.env.ADMIN_DATABASE_URL || process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL);

try {
  const email = String(process.env.BOOTSTRAP_ADMIN_EMAIL || '').trim().toLowerCase();
  const name = String(process.env.BOOTSTRAP_ADMIN_NAME || 'Security Administrator').trim();
  const password = String(process.env.BOOTSTRAP_ADMIN_PASSWORD || '');
  const tenantName = String(process.env.BOOTSTRAP_TENANT_NAME || 'Northstar Security').trim();
  const tenantSlug = String(process.env.BOOTSTRAP_TENANT_SLUG || 'northstar').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw new Error('Set a valid BOOTSTRAP_ADMIN_EMAIL in the private environment file.');
  }
  if (password.length < 16 || password.length > 256 || password === 'replace-this-with-a-long-unique-password') {
    throw new Error('Set a unique BOOTSTRAP_ADMIN_PASSWORD with at least 16 characters.');
  }
  if (!name || name.length > 100 || !tenantName || tenantName.length > 120 || !/^[a-z0-9-]{2,64}$/.test(tenantSlug)) {
    throw new Error('Check BOOTSTRAP_ADMIN_NAME, BOOTSTRAP_TENANT_NAME, and BOOTSTRAP_TENANT_SLUG.');
  }

  const tenant = await pool.query(
    'INSERT INTO tenants(name, slug) VALUES ($1, $2) ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id',
    [tenantName, tenantSlug],
  );
  const passwordHash = await hashPassword(password);
  const inserted = await pool.query(
    "INSERT INTO users(tenant_id, email, full_name, password_hash, role) VALUES ($1, $2, $3, $4, 'admin') ON CONFLICT (email) DO NOTHING RETURNING id",
    [tenant.rows[0].id, email, name, passwordHash],
  );
  if (!inserted.rowCount) {
    const existing = await pool.query('SELECT tenant_id FROM users WHERE email = $1', [email]);
    if (!existing.rowCount || existing.rows[0].tenant_id !== tenant.rows[0].id) {
      throw new Error('That email already belongs to a different tenant. No account was changed.');
    }
    process.stdout.write('Admin already exists; its password and role were left unchanged.\n');
  } else {
    process.stdout.write('Created the initial admin account. Remove bootstrap credentials from the environment after sign-in is verified.\n');
  }
} finally {
  await pool.end();
}
