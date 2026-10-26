ALTER TABLE sites ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;
ALTER TABLE officers ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;
ALTER TABLE patrol_tours ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;
ALTER TABLE activity_events ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;

-- Mark only the exact records created by the original fictional seed script.
UPDATE sites SET is_demo = true
WHERE (name, address, city, client_name) IN (
  ('Harbour Centre', '181 Bay Street', 'Toronto', 'Harbour Property Group'),
  ('Lakeside Distribution', '80 Unwin Avenue', 'Toronto', 'Lakeside Logistics'),
  ('Westgate Offices', '1234 Dundas Street West', 'Toronto', 'Westgate Property')
);

UPDATE officers SET is_demo = true
WHERE (officer_code, name) IN (
  ('G-1042', 'Maya Chen'), ('G-1088', 'Jordan Lee'), ('G-1116', 'Avery Brooks'),
  ('G-1173', 'Noah Patel'), ('G-1190', 'Elena Ruiz')
);

UPDATE incidents SET is_demo = true
WHERE incident_code IN ('INC-2471', 'INC-2470', 'INC-2468', 'INC-2466')
  AND description LIKE '%This is fictional seed data%';

UPDATE patrol_tours SET is_demo = true
WHERE name IN (
  'Harbour Centre · Perimeter sweep', 'Lakeside · Closing patrol', 'Westgate · Reception rounds'
);

UPDATE activity_events SET is_demo = true WHERE event_key LIKE 'seed-%';

CREATE TABLE IF NOT EXISTS oidc_auth_requests (
  state_hash char(64) PRIMARY KEY,
  nonce_hash char(64) NOT NULL,
  code_verifier text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS oidc_auth_requests_expiry_idx ON oidc_auth_requests(expires_at);
