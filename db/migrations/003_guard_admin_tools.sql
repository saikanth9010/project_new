-- Add guard identities, profile photos, and server-enforced role support.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('admin', 'dispatcher', 'supervisor', 'viewer', 'guard'));

ALTER TABLE officers ADD CONSTRAINT officers_tenant_id_id_unique UNIQUE (tenant_id, id);
ALTER TABLE users ADD COLUMN officer_id uuid;
ALTER TABLE users ADD CONSTRAINT users_officer_tenant_fk
  FOREIGN KEY (tenant_id, officer_id) REFERENCES officers(tenant_id, id);
ALTER TABLE users ADD CONSTRAINT users_guard_requires_officer
  CHECK (role <> 'guard' OR officer_id IS NOT NULL);
CREATE UNIQUE INDEX users_tenant_officer_unique ON users(tenant_id, officer_id) WHERE officer_id IS NOT NULL;

ALTER TABLE users ADD COLUMN avatar_mime text;
ALTER TABLE users ADD COLUMN avatar_data bytea;
ALTER TABLE users ADD CONSTRAINT users_avatar_pair_check
  CHECK ((avatar_mime IS NULL) = (avatar_data IS NULL));
ALTER TABLE users ADD CONSTRAINT users_avatar_type_check
  CHECK (avatar_mime IS NULL OR avatar_mime IN ('image/jpeg', 'image/png', 'image/webp'));
ALTER TABLE users ADD CONSTRAINT users_avatar_size_check
  CHECK (avatar_data IS NULL OR octet_length(avatar_data) <= 1048576);
