# Northstar Web GUI

A browser dashboard served by a small Node.js API. Incident, officer, site, patrol summary, and audit event records load from PostgreSQL. Creating, assigning, and resolving an incident writes to PostgreSQL. Browser local storage holds only light/dark theme and text-size preferences.

This is a deployment foundation, not a complete live dispatch system. The iPhone app is not connected to this API. The site map is illustrative, demo seed records are fictional, and this build does not notify officer devices, send emergency alerts, track live GPS, or calculate verified shift/SLA reports.

## What is included

- PostgreSQL schema and versioned migration under db/migrations.
- Local development PostgreSQL using Docker Compose. It binds only to 127.0.0.1.
- Password hashing with Node scrypt, hashed opaque session tokens, eight-hour sessions, HttpOnly cookies, CSRF and Origin checks, login throttling, server-side role checks, tenant-scoped queries, PostgreSQL row-level policies, parameterized SQL, and restrictive response headers.
- A production runtime-role grant file at db/production-runtime-grants.sql.
- Separate commands for schema migration, optional fictional demo seed, and initial admin bootstrap.

## Local setup on Windows

### Requirements

- Node.js 22.13+ on Node 22 LTS or Node 24 LTS; use the current security patch from the [official Node.js downloads](https://nodejs.org/en/download).
- Docker Desktop with Docker Compose; install it using the [official Windows guide](https://docs.docker.com/desktop/setup/install/windows-install/).
- PowerShell.

### Install and configure

From the webGUI folder:

    Copy-Item .env.example .env

Edit .env. For local Docker, the password in DATABASE_URL must match POSTGRES_PASSWORD. Replace both with a new local-only password; use URL-safe characters or percent-encode reserved characters in DATABASE_URL. Set BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_NAME. Set BOOTSTRAP_ADMIN_PASSWORD to a unique password with at least 16 characters. Do not commit .env.

Install the Node dependency:

    npm ci

Start the local PostgreSQL container:

    docker compose up -d db

The Compose file uses PostgreSQL 18 and mounts its persistent volume at `/var/lib/postgresql`, the location expected by the official PostgreSQL 18 container image ([image documentation](https://github.com/docker-library/docs/blob/master/postgres/README.md#pgdata)).

Apply the schema:

    npm run db:migrate

For a local preview only, insert fictional Toronto sample records:

    npm run db:seed-demo

Create the first administrator:

    npm run admin:bootstrap

Start the website and API:

    npm start

Open the URL in `APP_ORIGIN` and sign in with the email and password from .env. The server is bound to loopback by default, so this development instance is reachable only on the same computer. The demo seed can be rerun without duplicating its sample incidents, tours, and audit events.

The server checks the database connection before it opens its HTTP port. If it reports that the database is unavailable, confirm that Docker Desktop is running and the `db` container is healthy. In PowerShell, `docker version` should show both a Client and Server section before you run Compose. If `docker` is not recognized, reopen PowerShell after Docker Desktop finishes installing, or add the directory containing Docker's CLI to your user `PATH`.

### If the port is already in use

`EADDRINUSE` means another process already owns the configured port. Check the exact owning process before stopping it. Set `PORT` and `APP_ORIGIN` together in `.env` if you choose another free port. The server now reports a clear error and exits if the selected port is occupied.

Check database readiness from PowerShell:

    Invoke-RestMethod http://127.0.0.1:4175/api/health

If you change `PORT` in `.env`, use that port in `APP_ORIGIN`, the browser URL, and the health check. Only one app process can bind a given host/port pair. To find a process already using a port, run `Get-NetTCPConnection -State Listen -LocalPort 4175` and inspect its PID before stopping it; do not kill an unknown process.

Stop the database when finished:

    docker compose down

The named Docker volume keeps local database data when the container stops. To remove that development database permanently, use docker compose down -v after confirming that you no longer need its contents.

## Production setup

Do not use the local Compose database or fictional demo seed for production. Use a supported managed PostgreSQL service or a privately networked PostgreSQL server, a trusted HTTPS reverse proxy, and a secrets manager.

For a Jenkins and GitHub deployment to separate frontend, backend, and database Docker hosts, see [the Jenkins deployment guide](deploy/jenkins/README.md). It covers the Docker build agent, GHCR credentials, private host networking, database bootstrap, automatic main-branch deployments, and the first administrator setup.

### 1. Create database roles

Create the database and schema with a migration owner. Create a separate non-superuser LOGIN role named northstar_app for the running website. Do not give northstar_app SUPERUSER, BYPASSRLS, or table ownership.

As the database owner, apply db/production-runtime-grants.sql after the schema migration. The grant file assumes the production database is named northstar and the runtime role is northstar_app. Adjust the database name and role in that SQL file if needed. Keep the owner credential separate from the website's runtime DATABASE_URL.

The tenant data tables use row-level security policies keyed to the transaction-local app.tenant_id setting. The API sets that value for each database transaction. PostgreSQL superusers and BYPASSRLS roles bypass row-level policies, which is why the runtime account must be a restricted non-superuser.

### 2. Configure secrets and HTTPS

Set these values in the production environment or secrets manager:

- NODE_ENV=production
- APP_ORIGIN=https://your-real-operations-host.example
- DATABASE_URL=the northstar_app connection string
- DATABASE_SSL=verify-full
- DATABASE_CA_CERT=absolute path to the database provider CA bundle
- DB_POOL_MAX=an appropriate connection limit for the deployment

Do not add sslmode, sslrootcert, sslcert, or sslkey query parameters to DATABASE_URL when DATABASE_CA_CERT is configured. Use the provider's trusted CA and a hostname matching its certificate. Never disable certificate verification in production.

Configure a trusted reverse proxy to terminate TLS, redirect HTTP to HTTPS, and forward traffic to the Node process on a private interface. Do not publish the Node port or PostgreSQL port directly to the internet. If the application is containerized, bind it only to the private container network. The production session cookie is Secure, HttpOnly, SameSite=Strict, and host-only. HSTS is enabled in production; use a hostname whose HTTPS setup is stable before enabling production mode.

The API does not trust forwarded client-IP headers. Its database-backed sign-in throttling sees the reverse proxy's network address, so also configure per-client and per-route login limits at the trusted proxy or hosting edge.

### 3. Migrate and bootstrap

Run migrations with the schema-owner credentials supplied as MIGRATION_DATABASE_URL. Run the one-time admin bootstrap with ADMIN_DATABASE_URL and the BOOTSTRAP_ADMIN_* values set in the deployment environment:

    npm run db:migrate
    npm run admin:bootstrap

The initial bootstrap creates the tenant and administrator without replacing an existing account's password. Secure or remove the bootstrap password and ADMIN_DATABASE_URL after creating the account. Do not pass migration-owner credentials to the long-running website process.

The website process uses DATABASE_URL for the restricted runtime account:

    npm start

Set a process supervisor/container restart policy, health monitoring, database connection limits, encrypted backups with point-in-time recovery, and a tested restore procedure. Apply Node and PostgreSQL security updates promptly. Restrict database network access to the application network.

### 4. Load verified operational data

The demo seed and demo-data buttons are disabled when `NODE_ENV=production`. In a development workspace, a Northstar administrator can open **Manage demo data** in the sidebar or account options to add fictional sample records or remove only records explicitly marked as demo. If a sample site or officer has been linked to an operational record, removal stops until those links are corrected. Production sites, roster members, and tours must be provisioned from verified company records using a controlled import or future admin workflow. User accounts are managed by an administrator in the account options.

## Accounts, guard workspace, and administrator tools

The web GUI uses the existing operational database for account records; it does not need a second user-management database. Use Casdoor as the identity provider when single sign-on is required, and keep the app's `users` table as the tenant-scoped account and role mapping. A verified Casdoor email maps to a pre-provisioned account; Casdoor cannot assign an app role.

Administrator-created accounts use the roles `admin`, `dispatcher`, `supervisor`, `viewer`, or `guard`. New passwords must be at least 16 characters. Link every guard account to an active officer record. The guard-facing workspace scopes incidents to that officer, patrol tours to their assignment, and sites to their post; guards can submit incident reports for their linked site. Account creation, activation, role changes, incident/report APIs, and profile-photo access are checked on the server. The last active administrator cannot be disabled or demoted.

The administrator's account menu includes a read-only record query for incidents, officers, sites, patrols, and activity. It has fixed, parameterized search fields and a 100-row cap; it does not execute arbitrary SQL or expose password/session tables. The database settings screen can test a candidate connection. It does not save credentials in browser storage or persist secrets in the application database. After a successful test, update `DATABASE_URL` in the server's secret environment and restart the service. A candidate host must match the configured host or be listed in the server-side `DATABASE_ALLOWED_HOSTS` allowlist.

Every signed-in user can adjust text size with the three A controls, open account options from either profile control, and confirm before signing out. The clock uses the browser's local timezone.

### Casdoor single sign-on

Casdoor is an optional OIDC sign-in provider. Set these server-only values together in `.env` (or the service environment):

    CASDOOR_ISSUER=https://sso.example.com
    CASDOOR_CLIENT_ID=your-casdoor-client-id
    CASDOOR_CLIENT_SECRET=your-casdoor-client-secret
    CASDOOR_DISCOVERY_URL=

In the Casdoor application's **Redirect URLs**, add the exact URL `https://your-operations-host.example/api/auth/casdoor/callback`. Use the actual `APP_ORIGIN` hostname. Configure Casdoor scopes `openid`, `profile`, and `email`. `CASDOOR_ISSUER` must exactly match the discovery document's `issuer` claim. For a standard Casdoor deployment the discovery document is `https://<casdoor-host>/.well-known/openid-configuration`; application-specific discovery is supported with `CASDOOR_DISCOVERY_URL`.

The app validates authorization state, PKCE, nonce, the signed ID token, issuer, audience, expiry, and JWKS signature. It requires Casdoor to return a verified email and maps it to one existing active GUI account. Create that account first and assign its role in the GUI; the app does not auto-provision accounts or accept roles from Casdoor. Restart the app after changing provider settings. Password sign-in remains available. Never expose the client secret in browser code.

The Proxmox host installer and complete setup instructions are in [deploy/proxmox/README.md](deploy/proxmox/README.md). The script prompts for the Proxmox storage that will hold the LXC disk and configures an unprivileged Debian LXC, Node.js, PostgreSQL with local certificate verification, Caddy HTTPS, the initial admin account, and automatic service startup.

## Before using for live security operations

The database-backed incident workflow is not a dispatch integration. It records changes and audit events in PostgreSQL but does not deliver messages to officers. Before relying on it for a live security operation, implement and validate:

- A firm-approved identity provider, account provisioning, account recovery, and role management.
- Site/officer/tour management and verified data import.
- An authenticated mobile sync API for the iPhone app, with conflict handling and audit semantics.
- Dispatch acknowledgements, escalation paths, emergency-alert delivery, and monitored failure handling.
- Verified site mapping and explicitly authorized location collection.
- Retention, privacy, access, incident evidence, backup, disaster-recovery, and breach-response policies.
- Security review and deployment-specific validation, including authorization, tenant isolation, CSRF, rate limits, backups, and incident recovery.

The current database workflow should be treated as a controlled pilot until those integrations and the firm's operational procedures are in place.

## Theme

Use the theme switch in the sign-in page or the command-center header to change between light and dark appearance. Use the three A controls to set text size. Both preferences are saved in that browser only.

## Project files

- server.mjs: HTTP server, API routes, sessions, security headers, and static-file allowlist.
- app.js and styles.css: browser UI and theme switch.
- db/migrations/001_initial_schema.sql: PostgreSQL tables, indexes, constraints, and row-level security policies.
- db/migrations/003_guard_admin_tools.sql: guard role/account links, profile photos, and their constraints.
- db/production-runtime-grants.sql: least-privilege runtime grants.
- scripts/migrate.mjs: applies numbered SQL migrations once.
- scripts/seed-demo.mjs: inserts fictional sample data for development.
- scripts/bootstrap-admin.mjs: idempotently creates the initial administrator.
- .env.example: local configuration template; copy it to .env and replace all sample passwords.
- deploy/proxmox/install-security-firm.sh: interactive Proxmox LXC host installer.
- deploy/proxmox/README.md: Proxmox deployment and Casdoor setup guide.
#   p r o j e c t _ n e w  
 #   p r o j e c t _ n e w  
 
