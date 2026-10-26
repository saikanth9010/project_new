#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_BUNDLE="$SCRIPT_DIR/northstar-webgui.tar.gz"
STAGE_DIR=""
cleanup() {
  if [[ -n "$STAGE_DIR" && -d "$STAGE_DIR" ]]; then rm -rf -- "$STAGE_DIR"; fi
}
trap cleanup EXIT

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
ask() {
  local __name="$1" __label="$2" __default="$3" __value=""
  read -r -p "$__label [$__default]: " __value
  printf -v "$__name" '%s' "${__value:-$__default}"
}
shell_escape() { printf '%q' "$1"; }

[[ "$EUID" -eq 0 ]] || die 'Run this script as root on a Proxmox VE host.'
command -v pct >/dev/null || die 'The pct command is missing. Run this on a Proxmox VE node.'
command -v pvesm >/dev/null || die 'The pvesm command is missing.'
command -v pveam >/dev/null || die 'The pveam command is missing.'
command -v pveversion >/dev/null || die 'This host does not appear to be Proxmox VE.'
[[ -s "$APP_BUNDLE" ]] || die "Copy northstar-webgui.tar.gz beside this script first: $APP_BUNDLE"

printf '\nNorthstar Security Web GUI · Proxmox LXC installer\n'
printf 'Creates an unprivileged Debian LXC with PostgreSQL, Node.js, and Caddy. No Docker daemon runs inside the LXC.\n\n'

mapfile -t ROOT_STORAGES < <(pvesm status --content rootdir | awk 'NR > 1 && $3 == "active" { print $1 }')
[[ "${#ROOT_STORAGES[@]}" -gt 0 ]] || die 'No active Proxmox storage supports container root disks (rootdir).'
printf 'Select the storage that will hold the LXC root disk:\n'
pvesm status --content rootdir | awk 'NR == 1 || ($3 == "active") { print "  " $0 }'
read -r -p 'Storage ID: ' ROOT_STORAGE
[[ " ${ROOT_STORAGES[*]} " == *" $ROOT_STORAGE "* ]] || die 'That storage is not an active rootdir storage.'

mapfile -t TEMPLATE_STORAGES < <(pvesm status --content vztmpl | awk 'NR > 1 && $3 == "active" { print $1 }')
[[ "${#TEMPLATE_STORAGES[@]}" -gt 0 ]] || die 'No active storage can hold a container template (vztmpl).'
TEMPLATE_STORAGE="${TEMPLATE_STORAGES[0]}"
for candidate in "${TEMPLATE_STORAGES[@]}"; do
  if [[ "$candidate" == 'local' ]]; then TEMPLATE_STORAGE='local'; break; fi
done

pveam update >/dev/null
TEMPLATE="$(pveam available --section system | awk '$1 == "system" && $2 ~ /^debian-13-standard_.*_amd64\.tar\.(zst|xz|gz)$/ { print $2 }' | sort -V | tail -n 1)"
[[ -n "$TEMPLATE" ]] || die 'Could not find a Debian 13 standard container template in the Proxmox catalog.'
if ! pveam list "$TEMPLATE_STORAGE" | grep -Fq "$TEMPLATE"; then
  printf '\nDownloading %s to template cache %s...\n' "$TEMPLATE" "$TEMPLATE_STORAGE"
  pveam download "$TEMPLATE_STORAGE" "$TEMPLATE"
fi

NEXT_ID="$(pvesh get /cluster/nextid 2>/dev/null | tr -cd '0-9')"
[[ "$NEXT_ID" =~ ^[0-9]{3,5}$ ]] || NEXT_ID='240'
ask CTID 'New LXC ID' "$NEXT_ID"
[[ "$CTID" =~ ^[0-9]{3,5}$ ]] || die 'LXC ID must be a 3–5 digit number.'
pct status "$CTID" >/dev/null 2>&1 && die "LXC $CTID already exists; choose a free ID."

ask ROOTFS_GIB 'LXC disk size in GiB' '24'
ask CORES 'CPU cores' '2'
ask MEMORY_MIB 'Memory in MiB' '4096'
ask SWAP_MIB 'Swap in MiB' '1024'
for number in "$ROOTFS_GIB" "$CORES" "$MEMORY_MIB" "$SWAP_MIB"; do [[ "$number" =~ ^[0-9]+$ ]] || die 'Disk, CPU, memory, and swap values must be whole numbers.'; done
(( ROOTFS_GIB >= 12 && CORES >= 1 && MEMORY_MIB >= 2048 )) || die 'Use at least a 12 GiB disk, one CPU core, and 2048 MiB of memory.'

mapfile -t BRIDGES < <(ip -o link show | awk -F': ' '{print $2}' | grep -E '^vmbr[0-9]+' || true)
[[ "${#BRIDGES[@]}" -gt 0 ]] || die 'No vmbr bridge was found. Create and verify a Proxmox bridge before installing.'
DEFAULT_BRIDGE="${BRIDGES[0]}"
for bridge in "${BRIDGES[@]}"; do if [[ "$bridge" == 'vmbr0' ]]; then DEFAULT_BRIDGE='vmbr0'; break; fi; done
ask BRIDGE 'Proxmox network bridge' "$DEFAULT_BRIDGE"
[[ " ${BRIDGES[*]} " == *" $BRIDGE "* ]] || die 'Choose an existing vmbr bridge.'
ask NETWORK_MODE 'Container network (dhcp or static)' 'dhcp'
if [[ "$NETWORK_MODE" == 'static' ]]; then
  read -r -p 'Static IPv4 address with CIDR, e.g. 192.168.1.40/24: ' STATIC_IP
  read -r -p 'IPv4 gateway, e.g. 192.168.1.1: ' STATIC_GATEWAY
  [[ "$STATIC_IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2}$ && "$STATIC_GATEWAY" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || die 'Use an IPv4 address/CIDR and an IPv4 gateway.'
  IP_CONFIG="ip=$STATIC_IP,gw=$STATIC_GATEWAY"
elif [[ "$NETWORK_MODE" == 'dhcp' ]]; then
  IP_CONFIG='ip=dhcp'
else
  die 'Network mode must be dhcp or static.'
fi

ask APP_DOMAIN 'Public DNS name for the web GUI' 'ops.example.com'
APP_DOMAIN="${APP_DOMAIN,,}"
[[ "$APP_DOMAIN" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ && "$APP_DOMAIN" == *.* ]] || die 'Enter a valid fully qualified DNS name.'
[[ "$APP_DOMAIN" != *.local && "$APP_DOMAIN" != *.internal && "$APP_DOMAIN" != *.home.arpa ]] || die 'Use a public DNS domain for a trusted browser certificate.'
[[ "$APP_DOMAIN" != *.example.com ]] || die 'Replace the example.com placeholder with your own DNS name.'
read -r -p 'Admin account email: ' ADMIN_EMAIL
ADMIN_EMAIL="${ADMIN_EMAIL,,}"
[[ "$ADMIN_EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ && "${#ADMIN_EMAIL}" -le 254 ]] || die 'Enter a valid admin email address.'
read -r -p 'Admin display name [Security Administrator]: ' ADMIN_NAME
ADMIN_NAME="${ADMIN_NAME:-Security Administrator}"
read -r -s -p 'Choose initial admin password (at least 16 characters): ' ADMIN_PASSWORD
printf '\n'
[[ "${#ADMIN_PASSWORD}" -ge 16 && "$ADMIN_PASSWORD" != *$'\n'* && "$ADMIN_PASSWORD" != *$'\r'* ]] || die 'The initial admin password must be at least 16 characters and on one line.'
read -r -s -p 'Confirm initial admin password: ' ADMIN_PASSWORD_CONFIRM
printf '\n'
[[ "$ADMIN_PASSWORD" == "$ADMIN_PASSWORD_CONFIRM" ]] || die 'The admin passwords did not match.'
unset ADMIN_PASSWORD_CONFIRM

CASDOOR_ISSUER=''
CASDOOR_DISCOVERY_URL=''
CASDOOR_CLIENT_ID=''
CASDOOR_CLIENT_SECRET=''
read -r -p 'Configure Casdoor sign-in now? [y/N]: ' CONFIGURE_CASDOOR
if [[ "${CONFIGURE_CASDOOR,,}" == 'y' || "${CONFIGURE_CASDOOR,,}" == 'yes' ]]; then
  read -r -p 'Exact Casdoor OIDC issuer URL (https://...): ' CASDOOR_ISSUER
  [[ "$CASDOOR_ISSUER" =~ ^https://[^[:space:]]+$ && "$CASDOOR_ISSUER" != *\?* && "$CASDOOR_ISSUER" != *\#* ]] || die 'Use the exact HTTPS issuer URL from the Casdoor discovery document.'
  read -r -p 'Casdoor client ID: ' CASDOOR_CLIENT_ID
  [[ -n "$CASDOOR_CLIENT_ID" && "$CASDOOR_CLIENT_ID" != *$'\n'* ]] || die 'Casdoor client ID cannot be empty.'
  read -r -s -p 'Casdoor client secret: ' CASDOOR_CLIENT_SECRET
  printf '\n'
  [[ -n "$CASDOOR_CLIENT_SECRET" && "$CASDOOR_CLIENT_SECRET" != *$'\n'* ]] || die 'Casdoor client secret cannot be empty.'
  read -r -p 'Optional Casdoor discovery URL (press Enter for automatic discovery): ' CASDOOR_DISCOVERY_URL
fi

DB_RUNTIME_PASSWORD="$(openssl rand -hex 32)"
DB_MIGRATION_PASSWORD="$(openssl rand -hex 32)"
STAGE_DIR="$(mktemp -d /root/northstar-lxc-install.XXXXXX)"
chmod 700 "$STAGE_DIR"
{
  printf 'APP_DOMAIN=%s\n' "$(shell_escape "$APP_DOMAIN")"
  printf 'ADMIN_EMAIL=%s\n' "$(shell_escape "$ADMIN_EMAIL")"
  printf 'ADMIN_NAME=%s\n' "$(shell_escape "$ADMIN_NAME")"
  printf 'ADMIN_PASSWORD=%s\n' "$(shell_escape "$ADMIN_PASSWORD")"
  printf 'DB_RUNTIME_PASSWORD=%s\n' "$(shell_escape "$DB_RUNTIME_PASSWORD")"
  printf 'DB_MIGRATION_PASSWORD=%s\n' "$(shell_escape "$DB_MIGRATION_PASSWORD")"
  printf 'CASDOOR_ISSUER=%s\n' "$(shell_escape "$CASDOOR_ISSUER")"
  printf 'CASDOOR_DISCOVERY_URL=%s\n' "$(shell_escape "$CASDOOR_DISCOVERY_URL")"
  printf 'CASDOOR_CLIENT_ID=%s\n' "$(shell_escape "$CASDOOR_CLIENT_ID")"
  printf 'CASDOOR_CLIENT_SECRET=%s\n' "$(shell_escape "$CASDOOR_CLIENT_SECRET")"
} > "$STAGE_DIR/installer.env"
unset ADMIN_PASSWORD CASDOOR_CLIENT_SECRET DB_RUNTIME_PASSWORD DB_MIGRATION_PASSWORD
chmod 600 "$STAGE_DIR/installer.env"

cat > "$STAGE_DIR/database-setup.sql" <<SQL
CREATE ROLE northstar_migrator LOGIN PASSWORD '$(sed -n 's/^DB_MIGRATION_PASSWORD=//p' "$STAGE_DIR/installer.env" | tr -d "'\"")';
CREATE ROLE northstar_app LOGIN PASSWORD '$(sed -n 's/^DB_RUNTIME_PASSWORD=//p' "$STAGE_DIR/installer.env" | tr -d "'\"")';
CREATE DATABASE northstar OWNER northstar_migrator;
SQL
chmod 600 "$STAGE_DIR/database-setup.sql"

cat > "$STAGE_DIR/bootstrap-in-lxc.sh" <<'BOOTSTRAP'
#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
source /root/northstar-installer.env
cleanup_secrets() {
  rm -f /root/northstar-installer.env /root/northstar-database-setup.sql /root/northstar-webgui.tar.gz /root/northstar-bootstrap.sh /run/northstar-bootstrap.env
}
trap cleanup_secrets EXIT

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get upgrade -y
apt-get install -y ca-certificates curl gnupg nano openssl postgresql postgresql-contrib python3 tar xz-utils util-linux ssl-cert

# Install Caddy from its official Debian repository.
install -m 0755 -d /etc/apt/keyrings
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /etc/apt/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt -o /etc/apt/sources.list.d/caddy-stable.list
chmod 0644 /etc/apt/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
apt-get update
apt-get install -y caddy

case "$(dpkg --print-architecture)" in
  amd64) NODE_ARCH='linux-x64' ;;
  arm64) NODE_ARCH='linux-arm64' ;;
  *) echo 'Unsupported CPU architecture for the official Node.js binary.' >&2; exit 1 ;;
esac
NODE_VERSION="$(curl -fsSL https://nodejs.org/dist/index.json | python3 -c 'import json,sys; print(next(x["version"] for x in json.load(sys.stdin) if x["version"].startswith("v24.") and x["lts"] is not False))')"
NODE_ARCHIVE="node-${NODE_VERSION}-${NODE_ARCH}.tar.xz"
curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/${NODE_ARCHIVE}" -o "/tmp/${NODE_ARCHIVE}"
curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt" -o /tmp/node-SHASUMS256.txt
(cd /tmp && grep -F "  ${NODE_ARCHIVE}" node-SHASUMS256.txt | sha256sum --check --status)
install -d -m 0755 /opt/northstar-node
tar -xJf "/tmp/${NODE_ARCHIVE}" -C /opt/northstar-node --strip-components=1
ln -sfn /opt/northstar-node/bin/node /usr/local/bin/node
ln -sfn /opt/northstar-node/bin/npm /usr/local/bin/npm
ln -sfn /opt/northstar-node/bin/npx /usr/local/bin/npx
node --version
npm --version

# PostgreSQL uses TLS even on loopback so the application can run in production mode with verified certificates.
openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 825 \
  -keyout /etc/ssl/private/northstar-postgres.key \
  -out /etc/ssl/certs/northstar-postgres.crt \
  -subj '/CN=localhost' -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1'
chown root:ssl-cert /etc/ssl/private/northstar-postgres.key
chmod 0640 /etc/ssl/private/northstar-postgres.key
chmod 0644 /etc/ssl/certs/northstar-postgres.crt
usermod -a -G ssl-cert postgres
PG_VERSION="$(pg_lsclusters --no-header | awk 'NR == 1 {print $1}')"
[[ -n "$PG_VERSION" ]] || { echo 'PostgreSQL cluster was not created.' >&2; exit 1; }
cat >> "/etc/postgresql/${PG_VERSION}/main/postgresql.conf" <<'PGCONF'
ssl = on
ssl_cert_file = '/etc/ssl/certs/northstar-postgres.crt'
ssl_key_file = '/etc/ssl/private/northstar-postgres.key'
PGCONF
systemctl enable --now postgresql
systemctl restart postgresql
pg_isready -h 127.0.0.1 -p 5432
runuser -u postgres -- psql -v ON_ERROR_STOP=1 -f /root/northstar-database-setup.sql
rm -f /root/northstar-database-setup.sql

useradd --system --home /opt/northstar --create-home --shell /usr/sbin/nologin northstar
install -d -o root -g northstar -m 0750 /etc/northstar /opt/northstar/webGUI
install -d -o root -g northstar -m 0750 /opt/northstar
tar -xzf /root/northstar-webgui.tar.gz -C /opt/northstar/webGUI
npm --prefix /opt/northstar/webGUI ci --omit=dev --no-audit --no-fund

dotenv_quote() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '"%s"' "$value"
}

cat > /etc/northstar/webgui.env <<ENVFILE
NODE_ENV=production
HOST=127.0.0.1
PORT=4173
APP_ORIGIN=$(dotenv_quote "https://${APP_DOMAIN}")
DATABASE_URL=$(dotenv_quote "postgresql://northstar_app:${DB_RUNTIME_PASSWORD}@127.0.0.1:5432/northstar")
DATABASE_SSL=verify-full
DATABASE_CA_CERT=/etc/ssl/certs/northstar-postgres.crt
DB_POOL_MAX=10
CASDOOR_ISSUER=$(dotenv_quote "$CASDOOR_ISSUER")
CASDOOR_DISCOVERY_URL=$(dotenv_quote "$CASDOOR_DISCOVERY_URL")
CASDOOR_CLIENT_ID=$(dotenv_quote "$CASDOOR_CLIENT_ID")
CASDOOR_CLIENT_SECRET=$(dotenv_quote "$CASDOOR_CLIENT_SECRET")
ENVFILE
chown root:northstar /etc/northstar/webgui.env
chmod 0640 /etc/northstar/webgui.env

cat > /run/northstar-bootstrap.env <<BOOTENV
NODE_ENV=production
DATABASE_SSL=verify-full
DATABASE_CA_CERT=/etc/ssl/certs/northstar-postgres.crt
MIGRATION_DATABASE_URL=$(dotenv_quote "postgresql://northstar_migrator:${DB_MIGRATION_PASSWORD}@127.0.0.1:5432/northstar")
ADMIN_DATABASE_URL=$(dotenv_quote "postgresql://northstar_migrator:${DB_MIGRATION_PASSWORD}@127.0.0.1:5432/northstar")
BOOTSTRAP_ADMIN_EMAIL=$(dotenv_quote "$ADMIN_EMAIL")
BOOTSTRAP_ADMIN_NAME=$(dotenv_quote "$ADMIN_NAME")
BOOTSTRAP_ADMIN_PASSWORD=$(dotenv_quote "$ADMIN_PASSWORD")
BOOTSTRAP_TENANT_NAME="Northstar Security"
BOOTSTRAP_TENANT_SLUG=northstar
BOOTENV
chown root:northstar /run/northstar-bootstrap.env
chmod 0640 /run/northstar-bootstrap.env
chown -R root:northstar /opt/northstar/webGUI
find /opt/northstar/webGUI -type d -exec chmod 0750 {} +
find /opt/northstar/webGUI -type f -exec chmod 0640 {} +
runuser -u northstar -- node --env-file=/etc/northstar/webgui.env --env-file=/run/northstar-bootstrap.env /opt/northstar/webGUI/scripts/migrate.mjs
runuser -u northstar -- node --env-file=/etc/northstar/webgui.env --env-file=/run/northstar-bootstrap.env /opt/northstar/webGUI/scripts/bootstrap-admin.mjs
rm -f /run/northstar-bootstrap.env

runuser -u postgres -- psql -v ON_ERROR_STOP=1 -d northstar -f /opt/northstar/webGUI/db/production-runtime-grants.sql

cat > /etc/systemd/system/northstar-webgui.service <<'UNIT'
[Unit]
Description=Northstar Security Operations Web GUI
After=network-online.target postgresql.service
Wants=network-online.target
Requires=postgresql.service

[Service]
Type=simple
User=northstar
Group=northstar
WorkingDirectory=/opt/northstar/webGUI
EnvironmentFile=/etc/northstar/webgui.env
ExecStart=/usr/local/bin/node /opt/northstar/webGUI/server.mjs
Restart=on-failure
RestartSec=3
TimeoutStopSec=20
KillSignal=SIGTERM
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
RestrictSUIDSGID=true
LockPersonality=true
ProtectProc=invisible
ProcSubset=pid
CapabilityBoundingSet=
AmbientCapabilities=
UMask=0077

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/caddy/Caddyfile <<CADDYFILE
${APP_DOMAIN} {
	encode zstd gzip
	@health path /api/health
	header @health Cache-Control "no-store"
	reverse_proxy 127.0.0.1:4173
}
CADDYFILE
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl daemon-reload
systemctl enable --now northstar-webgui.service caddy
systemctl restart northstar-webgui.service caddy
sleep 2
curl --fail --silent --show-error http://127.0.0.1:4173/api/health
printf '\nNorthstar app, PostgreSQL, and Caddy are enabled for automatic startup.\n'
printf 'Casdoor callback: https://%s/api/auth/casdoor/callback\n' "$APP_DOMAIN"
printf 'Initial administrator: %s\n' "$ADMIN_EMAIL"
printf 'Remove bootstrap credentials from your notes after you confirm sign-in.\n'
BOOTSTRAP
chmod 700 "$STAGE_DIR/bootstrap-in-lxc.sh"

printf '\nCreating unprivileged LXC %s on root storage %s...\n' "$CTID" "$ROOT_STORAGE"
pct create "$CTID" "${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE}" \
  --ostype debian --hostname northstar-ops --unprivileged 1 --onboot 1 \
  --cores "$CORES" --memory "$MEMORY_MIB" --swap "$SWAP_MIB" \
  --rootfs "${ROOT_STORAGE}:${ROOTFS_GIB}" \
  --net0 "name=eth0,bridge=${BRIDGE},${IP_CONFIG},type=veth,firewall=1" \
  --features nesting=0
pct start "$CTID"
for attempt in $(seq 1 30); do
  if pct exec "$CTID" -- true >/dev/null 2>&1; then break; fi
  sleep 2
done
pct exec "$CTID" -- true >/dev/null 2>&1 || die 'The LXC did not become ready. Inspect it with pct status and pct console.'

pct push "$CTID" "$STAGE_DIR/installer.env" /root/northstar-installer.env
pct push "$CTID" "$STAGE_DIR/database-setup.sql" /root/northstar-database-setup.sql
pct push "$CTID" "$APP_BUNDLE" /root/northstar-webgui.tar.gz
pct push "$CTID" "$STAGE_DIR/bootstrap-in-lxc.sh" /root/northstar-bootstrap.sh
pct exec "$CTID" -- chmod 0600 /root/northstar-installer.env /root/northstar-database-setup.sql /root/northstar-webgui.tar.gz /root/northstar-bootstrap.sh
pct exec "$CTID" -- bash /root/northstar-bootstrap.sh

CONTAINER_IP="$(pct exec "$CTID" -- hostname -I | awk '{print $1}')"
printf '\nInstallation completed.\n'
printf 'LXC ID: %s\nRoot storage: %s\nContainer IP: %s\n' "$CTID" "$ROOT_STORAGE" "$CONTAINER_IP"
printf 'Web GUI: https://%s\n' "$APP_DOMAIN"
printf 'Casdoor callback URL: https://%s/api/auth/casdoor/callback\n' "$APP_DOMAIN"
printf 'Ensure DNS points to this service and network/firewall rules allow inbound TCP 80 and 443.\n'
printf 'The LXC starts automatically with Proxmox. Service logs: pct exec %s -- journalctl -u northstar-webgui -f\n' "$CTID"
