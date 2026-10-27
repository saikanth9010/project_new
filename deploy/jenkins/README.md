# Jenkins and GitHub deployment

This setup builds the browser application and Node API as separate OCI images, publishes versioned images to GitHub Container Registry (GHCR), then deploys the API and frontend over SSH. PostgreSQL runs as a stateful container on its own Docker host; application releases do not recreate or erase its database volume. Schema migrations run before the API is updated.

## Recommended layout

Use one Jenkins controller in the existing Jenkins LXC. Do not install a Jenkins controller in every app VM: one controller can coordinate several deployment targets, while extra controllers add maintenance and credential copies. Keep builds off the controller and run them on a Docker-capable Jenkins agent. The existing Docker VM can be that agent. It can also be one of the deployment targets if you choose to consolidate machines.

### Northstar Proxmox deployment currently provisioned

The following guests have been provisioned on the Proxmox host using `TBNASHARDDISK`:

| Guest | VM ID | Address | Purpose |
| --- | ---: | --- | --- |
| `northstar-database` | 146 | `10.10.10.15` | PostgreSQL with TLS and persistent volume |
| `northstar-backend` | 147 | `10.10.10.16` | API container |
| `northstar-frontend` | 148 | `10.10.10.17` | Caddy and frontend container |
| Existing Docker VM | 145 | `10.10.10.11` | Jenkins Docker build agent |
| Existing Jenkins LXC | 126 | `10.10.10.10:8080` | Jenkins controller |

The database container is running and healthy. Backend and frontend runtime configuration is staged, but their application containers will not deploy until the Jenkins agent connects and the GitHub, GHCR, and target-deploy credentials below are configured. Use DHCP reservations for `.11`, `.15`, `.16`, and `.17` before relying on these addresses. The public name `project.saikanth.com` did not resolve during setup; configure DNS and router NAT to the frontend before expecting public access.

For separate machines, use:

| Role | What runs there | Network access |
| --- | --- | --- |
| Jenkins controller LXC | Jenkins UI, job configuration, credentials | HTTPS from administrators; private access to agent |
| Docker agent VM | Jenkins agent, Node.js, Docker Engine and Compose plugin | Outbound GitHub/GHCR; SSH to targets |
| Database VM | PostgreSQL 18 container and persistent volume | TCP 5432 only from backend private IP |
| Backend VM | Northstar API container | TCP 4173 only from frontend private IP; TLS to database |
| Frontend VM | Caddy/static frontend container | Public TCP 80/443; private TCP 4173 to backend |

One Docker VM can host the frontend, backend, and database containers if you prefer fewer VMs. Separate VMs give stronger machine-level isolation, but all need Docker Engine and the Compose plugin for this deployment. Prefer Docker inside VMs over nested Docker in unprivileged LXCs. Do not expose Docker's unauthenticated TCP socket (port 2375); this pipeline uses SSH for remote deployment.

Use private addressing for backend and database traffic. Limit firewall rules to the source IPs in the table. Use a DNS name for the frontend with ports 80 and 443 reaching Caddy so it can provision HTTPS certificates. If the site is internal-only, configure an internal CA and update Caddy's TLS configuration instead of publishing it.

## 1. Prepare the hosts

1. Back up the Proxmox host and any existing database before provisioning VMs. Assign stable private IPs or DNS records to each target.
2. Install Docker Engine and the Docker Compose plugin on the Docker agent VM and each deployment VM. Verify `docker version` and `docker compose version` work as the account used by Jenkins or the deployment account.
3. Create a dedicated deployment account on the backend and frontend VMs. It needs write access to `/opt/northstar` and Docker access. Docker-group access is effectively root access, so restrict this key to this pipeline, restrict SSH by source IP, and do not reuse the account for routine login.
4. Create `/opt/northstar` on each target. Set it owner-only or deployment-group-only. Never put these files in Git: runtime env files, private keys, DB passwords, TLS private keys, bootstrap credentials, and Docker credentials.
5. On the database VM, use a trusted CA to issue `server.crt` with the database DNS name in its Subject Alternative Name, and a matching `server.key`. Create `/opt/northstar/secrets/`. Put the files there as `server.crt`, `server.key`, and `postgres_superuser_password`. The key must be readable by the PostgreSQL container's postgres user; check its numeric UID with `docker run --rm postgres:18-alpine id postgres`, then set ownership and restrictive mode accordingly. Keep the password file readable only by root and the Docker service where possible.
6. Copy `deploy/docker/compose.database.yml` to the database VM as `/opt/northstar/compose.database.yml`. Copy `deploy/jenkins/examples/database-runtime.env.example` to `/opt/northstar/runtime.env`, edit `DB_BIND_IP` to that VM's private IP, then run `chmod 600 /opt/northstar/runtime.env`.
7. Start PostgreSQL once with `cd /opt/northstar && docker compose --env-file runtime.env -f compose.database.yml up -d`. Confirm `docker compose ... ps` reports it healthy. Configure automated, off-host backups and test a restore before production use.

The app requires TLS verification from the backend and migrations. Use the same database DNS hostname in the connection URLs as the certificate SAN. The CA certificate can be copied to the backend as `/opt/northstar/secrets/database-ca.pem`; it is public trust material, but keep the directory restricted to the deployment account.

If you do not already operate a private CA, you can issue a database server certificate with OpenSSL on a trusted administrator workstation. Replace the example DNS name and IP with the database address that the backend uses. Keep `northstar-db-ca.key` offline; copy only `northstar-db-ca.pem` to the backend and `server.crt`/`server.key` to the database VM.

```sh
openssl req -x509 -newkey rsa:4096 -nodes -sha256 -days 3650 \
  -keyout northstar-db-ca.key -out northstar-db-ca.pem \
  -subj "/CN=Northstar DB CA" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign"
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out server.key
openssl req -new -key server.key -out server.csr -subj "/CN=db.example.internal"
printf 'subjectAltName=DNS:db.example.internal,IP:10.20.0.10\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' > server.ext
openssl x509 -req -in server.csr -CA northstar-db-ca.pem -CAkey northstar-db-ca.key \
  -CAcreateserial -out server.crt -days 397 -sha256 -extfile server.ext
openssl verify -CAfile northstar-db-ca.pem server.crt
```

## 2. Create the application database roles

The official PostgreSQL image creates database `northstar` and owner `northstar_owner` on first initialization. Create a restricted runtime role and set its password interactively from the database VM. Do not include a password in shell history or a committed SQL file:

```sh
docker exec -it northstar-database psql -U northstar_owner -d northstar
```

At the `psql` prompt:

```sql
CREATE ROLE northstar_app LOGIN;
\password northstar_app
\q
```

Copy `db/production-runtime-grants.sql` to `/opt/northstar/production-runtime-grants.sql` and apply it as the owner:

```sh
docker exec -i northstar-database psql -v ON_ERROR_STOP=1 -U northstar_owner -d northstar < /opt/northstar/production-runtime-grants.sql
```

The runtime API uses `northstar_app`. The one-time schema migration and initial administrator bootstrap use the database owner credentials; those credentials are not included in the long-running API environment. Keep database port 5432 firewalled to the backend and administration sources only.

## 3. Configure the backend and frontend VMs

On the backend VM:

1. Copy `deploy/docker/compose.backend.yml` to `/opt/northstar/compose.backend.yml`.
2. Copy `deploy/jenkins/examples/backend-runtime-host.env.example` to `/opt/northstar/runtime.env`. Set `BACKEND_BIND_IP` to the backend private IP.
3. Copy `deploy/jenkins/examples/backend.runtime.env.example` to `/opt/northstar/backend.runtime.env`. Set the public HTTPS `APP_ORIGIN`, production mode, a TLS-verified `DATABASE_URL` using the `northstar_app` password, and the matching DB DNS hostname. Keep Casdoor settings empty until its OIDC application is configured.
4. Copy `deploy/jenkins/examples/backend.migration.env.example` to `/opt/northstar/backend.migration.env`. Set `MIGRATION_DATABASE_URL` to the owner/migration connection. It is used only by the one-shot migration container.
5. Copy `deploy/jenkins/examples/backend.bootstrap.env.example` to `/opt/northstar/backend.bootstrap.env`. Use a unique bootstrap admin email and a generated password of at least 16 characters. It is used only for first-time setup; delete it after the admin account is verified.
6. Copy the database CA to `/opt/northstar/secrets/database-ca.pem` and restrict access. The Compose files mount it read-only at `/run/secrets/database-ca.pem`.
7. Set permissions: `chmod 600 /opt/northstar/*.env` and ensure the deployment account can read them. The SSH pipeline expects `/opt/northstar/runtime.env`, `backend.runtime.env`, and `backend.migration.env` to exist.

On the frontend VM:

1. Copy `deploy/docker/compose.frontend.yml` to `/opt/northstar/compose.frontend.yml`.
2. Copy `deploy/jenkins/examples/frontend-runtime-host.env.example` to `/opt/northstar/runtime.env`. Set `PUBLIC_DOMAIN` to the public DNS name and `API_UPSTREAM` to the backend private address, for example `http://10.20.0.12:4173`.
3. Allow inbound 80/443 to this VM and permit frontend-to-backend 4173. Caddy serves the static files and forwards only `/api/*` to the backend.

Environment examples are templates only. Copy them to the indicated private host paths, then replace every example value. Do not commit the completed files.

## 4. Connect the approved VM 145 Jenkins agent

1. Jenkins already has a permanent inbound agent named `northstar-docker`, one executor, remote directory `/home/docker/jenkins-agent`, and the same label. Its usage is set to **Only build jobs with label expressions matching this node**. Keep it offline until you enter its one-time secret on VM 145.
2. Open VM 145's Proxmox console and sign in as `docker`. The agent connects outward to `http://10.10.10.10:8080/` over WebSocket, so no VM SSH key, Jenkins TCP 50000 listener, or public inbound port is needed. Give the account Docker access only if it is already approved to run trusted builds; Docker socket access is root-equivalent.
3. Install `openjdk-21-jre-headless`, `git`, `curl`, and `ca-certificates` from Ubuntu's configured signed APT repositories. The Jenkinsfile runs validation in the official Node.js 24 container, so Node.js does not need to be installed on the VM agent. Do not install a Jenkins controller on this VM.
4. Follow [`VM145-agent.md`](VM145-agent.md) to create `/home/docker/jenkins-agent`, download `agent.jar` from the controller, and install the system service. Enter the one-time secret from the `northstar-docker` node page directly into the root-only file on VM 145. Never paste it into this repository, chat, shell history, or logs.
5. Enable the service and verify the node becomes online in Jenkins and remains online after a VM restart.
6. Verify from the VM agent account that `java -version`, `git --version`, `docker version`, and `docker compose version` work. Confirm Docker can pull `node:24-bookworm-slim` and the agent can reach GitHub, GHCR, and the private deployment targets.

For the target machines, create a dedicated deployment account on backend and frontend, give it only the permissions required to update `/opt/northstar` and run the Compose deployment, then create separate Jenkins **SSH Username with private key** credentials with IDs `northstar-backend-deploy` and `northstar-frontend-deploy`. The private keys must be generated and added by the administrator; do not reuse the Proxmox administrator key. Pin verified SSH host keys in the agent account's `known_hosts` file. The pipeline uses `StrictHostKeyChecking=yes` and deliberately fails if a host key is unknown or changes.

Create the Jenkins **Username with password** credential `northstar-ghcr-writer` using the GitHub package owner username and a narrowly scoped token able to publish and read the GHCR packages. Keep repository checkout credentials read-only and separate from this package credential. Never put tokens or private keys in the Jenkinsfile, repository, or runtime environment files.

`Jenkinsfile` currently targets backend `10.10.10.16`, frontend `10.10.10.17`, and package owner `saikanth9010`. Change these only if the deployment addresses or package owner change. Keep the Jenkins built-in node executors at `0`.

The SSH deploy account can control Docker, which is root-equivalent on that target. Protect Jenkins administrators, agent access, branch protections, and credentials accordingly. Configure the GitHub Branch Source to discover `main` only and do not build pull requests, forks, or other branches on the Docker-capable agent.

## 5. Connect GitHub and Jenkins

1. Confirm the project is pushed to `saikanth9010/project_new` and that the Jenkins controller can reach GitHub.
2. Create **New Item → Multibranch Pipeline** in Jenkins. Add a GitHub Branch Source for `https://github.com/saikanth9010/project_new`. Add a narrowly scoped GitHub token credential if the repository is private.
3. Configure branch discovery to include only `main`; do not discover change requests, forks, or other branches. A Jenkinsfile from an untrusted branch could execute arbitrary code on the Docker agent. Keep repository write access restricted and protect `main` with review and branch rules.
4. Discover the root `Jenkinsfile` (script path `Jenkinsfile`) and ensure the job's agent expression is `northstar-docker`. Builds on `main` validate source, build and push immutable GHCR images, apply DB migrations, then deploy the API and frontend.
5. If GitHub can reach Jenkins through a trusted HTTPS reverse proxy, configure a `push` webhook with a random secret. Never expose Jenkins port 8080 directly to the internet. If Jenkins stays private, configure periodic multibranch scans instead of opening an inbound port. Do not add PR webhook events when PR/change-request builds are disabled.
6. Run **Scan Multibranch Pipeline Now**, then verify a reviewed change to `main` produces the expected stages. The job will remain pending or fail until the inbound agent and the three Jenkins credentials above are ready.

## 6. First release and initial admin

On the first successful `main` build the pipeline will create the schema before starting the API and then deploy the frontend. After the API is healthy, run the one-time bootstrap on the backend VM:

```sh
cd /opt/northstar
docker compose --env-file runtime.env --env-file backend.deploy.env --profile bootstrap -f compose.backend.yml run --rm bootstrap
```

Sign in and verify the administrator account. Then remove `backend.bootstrap.env` and any stored bootstrap password. The pipeline runs migrations on later releases before updating the API. Keep migrations backward compatible with the previous app image because an application image rollback cannot undo a database migration.

## Operations and recovery

- View service state with `docker compose --env-file runtime.env --env-file backend.deploy.env -f compose.backend.yml ps` on the backend VM; use `docker compose --env-file runtime.env -f compose.database.yml ps` on the DB VM and the matching frontend command on the frontend VM.
- Inspect logs with `docker compose ... logs --tail=200 api` (or `database`, `frontend`). Avoid posting logs publicly; they may include hostnames and account metadata.
- Jenkins tags images with the source commit ID and deploys that immutable tag. A failed API/frontend health check attempts to restore the prior image. Database volumes are not removed by this pipeline.
- Do not run `docker compose down -v` on the database VM unless you intend to permanently delete the database volume.
- Test backups and restore on an isolated host. Keep the database off the public network and require TLS from the app.
- If a target's address or SSH host key changes, verify the new value out of band, update the Jenkinsfile or `known_hosts`, then run the pipeline again.

## What this pipeline does not provision

It does not create Proxmox VMs/LXCs, install Docker on them, configure firewall/DNS, generate database certificates, create the database volume, install Jenkins, or create GitHub credentials/webhooks. Those depend on your Proxmox storage/network choices and credentials. Provision these once using your own infrastructure process; Jenkins then deploys application releases automatically.

## Official references

- [Jenkins Pipeline as Code](https://www.jenkins.io/doc/book/pipeline/)
- [Jenkins Multibranch Pipelines](https://www.jenkins.io/doc/book/pipeline/multibranch/)
- [Jenkins build agents](https://www.jenkins.io/doc/book/using/using-agents/)
- [Jenkins controller isolation](https://www.jenkins.io/doc/book/security/controller-isolation/)
- [Jenkins credentials](https://www.jenkins.io/doc/book/security/credentials/)
- [Docker Compose in production](https://docs.docker.com/compose/how-tos/production/)
- [Protect access to the Docker daemon](https://docs.docker.com/engine/security/protect-access/)
- [GitHub webhook setup](https://docs.github.com/en/webhooks/using-webhooks)
- [GitHub Container Registry](https://docs.github.com/en/packages/working-with-the-container-registry)
