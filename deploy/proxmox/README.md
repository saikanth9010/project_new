# Proxmox deployment

## Separate-VM Jenkins deployment

The Jenkins deployment layout uses the existing Jenkins controller at `10.10.10.10:8080`, Docker agent VM 145 at `10.10.10.11`, and these application guests on storage `TBNASHARDDISK`:

| VM | Role | Address |
| ---: | --- | --- |
| 146 | Database | `10.10.10.15` |
| 147 | Backend API | `10.10.10.16` |
| 148 | Frontend / Caddy | `10.10.10.17` |

The three application VMs were created from the official Ubuntu 24.04 cloud image after checking its published SHA-256 checksum. Ubuntu updates, Docker Engine, Docker Compose, UFW, QEMU Guest Agent, and the `northstar-ops` administration account were configured. Jenkins is configured with the dedicated inbound node `northstar-docker`; VM 145 must still run the agent service before Jenkins reports it online. The database container is healthy; the application images wait for a successful trusted Jenkins release and credentials.

Use DHCP reservations for all four VM addresses. Public DNS for `project.saikanth.com` was not resolving during deployment; create its DNS record and configure router NAT / upstream firewall to forward TCP 80 and 443 to `10.10.10.17`. Keep Jenkins port 8080 private to the trusted LAN or an authenticated HTTPS proxy. Do not expose PostgreSQL port 5432 or the backend port 4173 publicly.

For a new installation, run `provision-northstar-vms.sh` on the Proxmox host as root. It lists storage that accepts VM disks and asks which one to use, shows the planned VM sizes, and requires typing `CREATE` before creating any guests. It downloads the Ubuntu image only from `cloud-images.ubuntu.com` and verifies the published checksum. The script uses the next available VM IDs and stops if any selected ID is already occupied. Review the script and make a host backup before running it; it does not replace the existing single-LXC installer below.

Follow [the Jenkins deployment guide](../jenkins/README.md) and [VM 145's inbound-agent instructions](../jenkins/VM145-agent.md) to finish the agent and configure Jenkins/GitHub credentials. The Jenkins node screen contains a one-time secret; enter it directly on VM 145 and do not add it to this repository or send it in chat.

This bundle installs the web GUI in one **unprivileged Debian 13 LXC**. The LXC runs the Node.js application, PostgreSQL with verified loopback TLS, and Caddy as the HTTPS reverse proxy. Proxmox starts the LXC at host boot; systemd restarts the app, database, and proxy. The container does not run Docker.

The installer asks you to select an active Proxmox storage that supports `rootdir`; that selected storage holds the LXC disk. It also asks for disk, CPU, memory, network, DNS name, and an initial administrator password. It uses an active `vztmpl` storage for the Debian template cache.

## Prepare the host

1. In Proxmox, create a current backup of the host and check that the chosen storage has enough free space. Keep the Proxmox management interface on a trusted admin network.
2. Create a DNS `A` record for the web GUI name, such as `ops.example.com`, pointing at the public address that will reach the LXC. If you use IPv6, configure the matching `AAAA` record too.
3. Allow inbound TCP 80 and 443 from the intended users to the LXC through the router, upstream firewall, Proxmox firewall, and any network ACLs. Do not forward PostgreSQL port 5432 or app port 4173.
4. Copy `northstar-proxmox-installation.tar.gz` to the Proxmox host, or copy these two files into the same directory such as `/root/northstar-proxmox/`:
   - `install-security-firm.sh`
   - `northstar-webgui.tar.gz`

The archive excludes `.env`, `node_modules`, and local database files. Do not copy your Windows `.env` to Proxmox.

## Run the installer

If you copied the bundle archive, extract it on the Proxmox node:

```sh
mkdir -p /root/northstar-proxmox
tar -xzf /root/northstar-proxmox-installation.tar.gz -C /root/northstar-proxmox
```

Then run the installer in the Proxmox node shell:

```sh
cd /root/northstar-proxmox
chmod 700 install-security-firm.sh
./install-security-firm.sh
```

The script checks for a free LXC ID and asks which storage to use for the LXC root disk. It defaults to DHCP and `vmbr0` when available; use a DHCP reservation or choose a static IPv4 address so the LXC remains reachable. It then downloads the Debian template, creates an unprivileged container, installs and configures the app stack, creates the initial admin, and enables all services at startup.

Choose a public DNS name for a browser-trusted certificate. Caddy obtains and renews HTTPS certificates automatically when DNS resolves to the service and ports 80/443 are reachable. If you use an internal-only hostname, Caddy uses its local CA; install that CA on managed client devices before relying on the connection.

The installer creates a new LXC and does not reuse or overwrite an existing one. If it stops part way through, inspect that container with `pct status <LXC_ID>` and its logs before trying again; remove an incomplete container only after confirming its ID and that it contains no needed data.

## Casdoor setup

The web GUI acts as an OpenID Connect client. Casdoor performs sign-in/consent; the GUI accepts only a verified email matching an already active account. It does not auto-create accounts or grant roles from Casdoor claims.

If you selected Casdoor during installation, add the exact callback URL shown at the end of the script to the Casdoor application's **Redirect URLs**:

```text
https://ops.example.com/api/auth/casdoor/callback
```

Use your actual web GUI hostname. In the Casdoor application settings, configure the providers and scopes needed for `openid`, `profile`, and `email`, then copy its client ID and secret into the installer prompts (or configure them later as described below). Set `CASDOOR_ISSUER` to the exact `issuer` value in Casdoor's OIDC discovery document. For a normal Casdoor deployment the discovery document is `https://<casdoor-host>/.well-known/openid-configuration`; Casdoor also supports application-specific discovery URLs. If automatic discovery cannot find your document, set `CASDOOR_DISCOVERY_URL` to its exact URL.

Before testing SSO, create or keep an active GUI account whose email exactly matches the verified email Casdoor returns. The existing GUI role stays in effect; Casdoor does not change it. The password login remains available as a fallback.

To configure or change Casdoor later, enter the LXC, edit `/etc/northstar/webgui.env`, set `CASDOOR_ISSUER`, `CASDOOR_CLIENT_ID`, and `CASDOOR_CLIENT_SECRET` together, then restart:

```sh
pct enter <LXC_ID>
nano /etc/northstar/webgui.env
systemctl restart northstar-webgui
exit
```

If your deployment needs application-specific discovery, also set `CASDOOR_DISCOVERY_URL`. Never put the client secret in frontend JavaScript or a public file. Keep the administrator email, current role, redirect URL, and Casdoor application identifiers under change control.

## Operations and updates

Useful Proxmox host commands:

```sh
pct status <LXC_ID>
pct exec <LXC_ID> -- systemctl status northstar-webgui postgresql caddy
pct exec <LXC_ID> -- journalctl -u northstar-webgui -f
pct exec <LXC_ID> -- journalctl -u caddy -f
pct exec <LXC_ID> -- curl --fail http://127.0.0.1:4173/api/health
```

The LXC has automatic on-boot enabled. Back up the LXC and the PostgreSQL data regularly, encrypt backups, and perform a restore rehearsal. To deploy an update, stage a new source archive, take a backup, replace the app files carefully, run the numbered migrations, and restart `northstar-webgui`. Do not replace the PostgreSQL data directory during an application update.

The deployment script enables HTTPS, private loopback binding, database TLS verification, least-privilege database runtime access, an unprivileged container, and service restart policies. After the initial administrator signs in, create staff accounts under **Account options → User management**. Link each `guard` account to an active officer record; that account receives the guard workspace and tenant-scoped assigned records. The administrator-only record query is read-only and bounded. Candidate database credentials can be tested in **Connection settings**, but the persistent server secret still must be changed in `/etc/northstar/webgui.env` and the service restarted.

This remains a deployment foundation, not a complete monitored dispatch system. Mobile sync, dispatch delivery/acknowledgements, live GPS, verified roster/site administration, and incident response procedures still need implementation and validation before real guard operations depend on it.

## Official references

- [Proxmox VE administration guide](https://pve.proxmox.com/pve-docs/pve-admin-guide.pdf) and [container command reference](https://pve.proxmox.com/pve-docs/pct.1.html)
- [Casdoor OIDC integration guides](https://casdoor.org/docs/category/how-to-connect-to-casdoor/)
- [Caddy installation](https://caddyserver.com/docs/install) and [automatic HTTPS requirements](https://caddyserver.com/docs/automatic-https)
