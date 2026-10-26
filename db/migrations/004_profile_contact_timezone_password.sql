ALTER TABLE users
  ADD COLUMN phone text NOT NULL DEFAULT '',
  ADD COLUMN timezone text NOT NULL DEFAULT 'America/Toronto';

ALTER TABLE users
  ADD CONSTRAINT users_phone_length_check CHECK (char_length(phone) <= 40),
  ADD CONSTRAINT users_timezone_length_check CHECK (char_length(timezone) BETWEEN 1 AND 64);

DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'northstar_app') THEN
    EXECUTE 'GRANT UPDATE (phone, timezone, password_hash) ON TABLE users TO northstar_app';
  END IF;
END
$grant$;
