CREATE SEQUENCE IF NOT EXISTS incident_code_seq START WITH 2472;

CREATE TABLE IF NOT EXISTS tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  email text NOT NULL UNIQUE,
  full_name text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'dispatcher', 'supervisor', 'viewer')),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash char(64) PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  csrf_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS login_attempt_limits (
  key_hash char(64) PRIMARY KEY,
  window_started_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  blocked_until timestamptz
);

CREATE TABLE IF NOT EXISTS sites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  address text NOT NULL,
  city text NOT NULL,
  region text NOT NULL,
  site_type text NOT NULL DEFAULT 'Commercial',
  client_name text NOT NULL DEFAULT '',
  contact_name text NOT NULL DEFAULT '',
  contact_phone text NOT NULL DEFAULT '',
  timezone text NOT NULL DEFAULT 'America/Toronto',
  geofence_m integer NOT NULL DEFAULT 250 CHECK (geofence_m > 0),
  contract_window text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'Active',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);
CREATE INDEX IF NOT EXISTS sites_tenant_idx ON sites(tenant_id);

CREATE TABLE IF NOT EXISTS officers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  site_id uuid REFERENCES sites(id) ON DELETE SET NULL,
  officer_code text NOT NULL,
  name text NOT NULL,
  initials text NOT NULL,
  role text NOT NULL,
  status text NOT NULL CHECK (status IN ('On post', 'Available', 'On patrol', 'Responding', 'Off duty')),
  post text NOT NULL DEFAULT '',
  battery integer CHECK (battery IS NULL OR battery BETWEEN 0 AND 100),
  last_seen_at timestamptz,
  color text NOT NULL DEFAULT 'sage',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, officer_code)
);
CREATE INDEX IF NOT EXISTS officers_tenant_status_idx ON officers(tenant_id, status);

CREATE TABLE IF NOT EXISTS patrol_tours (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  site_id uuid REFERENCES sites(id) ON DELETE SET NULL,
  officer_id uuid REFERENCES officers(id) ON DELETE SET NULL,
  name text NOT NULL,
  shift_label text NOT NULL DEFAULT '',
  window_label text NOT NULL DEFAULT '',
  checkpoint_names jsonb NOT NULL DEFAULT '[]'::jsonb,
  completed_checkpoints integer NOT NULL DEFAULT 0 CHECK (completed_checkpoints >= 0),
  status text NOT NULL CHECK (status IN ('in_progress', 'exception', 'completed')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS patrol_tours_tenant_idx ON patrol_tours(tenant_id);

CREATE TABLE IF NOT EXISTS incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  incident_code text NOT NULL UNIQUE,
  site_id uuid NOT NULL REFERENCES sites(id),
  assigned_officer_id uuid REFERENCES officers(id) ON DELETE SET NULL,
  title text NOT NULL,
  incident_type text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low')),
  location text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL CHECK (status IN ('open', 'assigned', 'resolved')),
  opened_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS incidents_tenant_opened_idx ON incidents(tenant_id, opened_at DESC);
CREATE INDEX IF NOT EXISTS incidents_tenant_status_idx ON incidents(tenant_id, status);

CREATE TABLE IF NOT EXISTS activity_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  event_key text UNIQUE,
  title text NOT NULL,
  detail text NOT NULL,
  icon text NOT NULL DEFAULT '•',
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS activity_tenant_time_idx ON activity_events(tenant_id, occurred_at DESC);

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['sites', 'officers', 'patrol_tours', 'incidents', 'activity_events']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      table_name
    );
  END LOOP;
END
$$;

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
