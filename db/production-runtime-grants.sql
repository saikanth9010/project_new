-- Run as the database owner after creating a non-superuser LOGIN role named northstar_app.
-- Keep the owner/migration credentials out of the running web process.
GRANT CONNECT ON DATABASE northstar TO northstar_app;
GRANT USAGE ON SCHEMA public TO northstar_app;

GRANT SELECT ON TABLE tenants, users TO northstar_app;
GRANT INSERT (tenant_id, email, full_name, password_hash, role, is_active, officer_id) ON TABLE users TO northstar_app;
GRANT UPDATE (full_name, role, is_active, officer_id, avatar_mime, avatar_data, phone, timezone, password_hash) ON TABLE users TO northstar_app;
GRANT SELECT, INSERT, DELETE ON TABLE sessions TO northstar_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE login_attempt_limits TO northstar_app;
GRANT SELECT, INSERT, DELETE ON TABLE oidc_auth_requests TO northstar_app;

GRANT SELECT ON TABLE sites, patrol_tours TO northstar_app;
GRANT SELECT, UPDATE ON TABLE officers TO northstar_app;
GRANT SELECT, INSERT, UPDATE ON TABLE incidents TO northstar_app;
GRANT SELECT, INSERT ON TABLE activity_events TO northstar_app;

GRANT USAGE, SELECT ON SEQUENCE incident_code_seq, activity_events_id_seq TO northstar_app;
