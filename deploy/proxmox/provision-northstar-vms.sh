#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Creates three Ubuntu cloud-init QEMU VMs for the Jenkins deployment layout.
# Docker is installed from Ubuntu's signed archive. Application containers are
# deployed later by Jenkins; this script does not alter existing guests.

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
ask() {
  local name="$1" label="$2" default="$3" value=""
  read -r -p "$label [$default]: " value
  printf -v "$name" '%s' "${value:-$default}"
}

[[ "$EUID" -eq 0 ]] || die 'Run this script as root on a Proxmox VE node.'
for command in qm pvesm pvesh qemu-img curl sha256sum ssh-keygen python3 ip; do
  command -v "$command" >/dev/null 2>&1 || die "Missing required command: $command"
done
command -v pveversion >/dev/null 2>&1 || die 'This host does not appear to be Proxmox VE.'

printf '\nNorthstar Security · application VM provisioner\n'
printf 'Creates separate database, backend API, and frontend VMs.\n'
printf 'Existing guests are not modified. VM disks use the storage you select.\n\n'

mapfile -t IMAGE_STORAGES < <(pvesm status --content images | awk 'NR > 1 && $3 == "active" {print $1}')
(( ${#IMAGE_STORAGES[@]} > 0 )) || die 'No active storage supports VM disks.'
pvesm status --content images | awk 'NR == 1 || $3 == "active" {print "  " $0}'
DEFAULT_STORAGE='TBNASHARDDISK'
[[ " ${IMAGE_STORAGES[*]} " == *" $DEFAULT_STORAGE "* ]] || DEFAULT_STORAGE="${IMAGE_STORAGES[0]}"
ask VM_STORAGE 'Storage for the three VM disks' "$DEFAULT_STORAGE"
[[ " ${IMAGE_STORAGES[*]} " == *" $VM_STORAGE "* ]] || die 'Choose an active storage that supports VM images.'

mapfile -t BRIDGES < <(ip -o link show | awk -F': ' '{print $2}' | grep -E '^vmbr[0-9]+' || true)
(( ${#BRIDGES[@]} > 0 )) || die 'No Proxmox vmbr bridge was found.'
DEFAULT_BRIDGE='vmbr0'
[[ " ${BRIDGES[*]} " == *" $DEFAULT_BRIDGE "* ]] || DEFAULT_BRIDGE="${BRIDGES[0]}"
ask BRIDGE 'Network bridge' "$DEFAULT_BRIDGE"
[[ " ${BRIDGES[*]} " == *" $BRIDGE "* ]] || die 'Choose an existing Proxmox vmbr bridge.'

DEFAULT_KEY='/var/lib/vz/snippets/northstar-operator.pub'
ask SSH_PUBLIC_KEY 'Public SSH key file to authorize on these VMs' "$DEFAULT_KEY"
[[ -s "$SSH_PUBLIC_KEY" ]] || die 'The public SSH key file is missing or empty.'
ssh-keygen -lf "$SSH_PUBLIC_KEY" >/dev/null || die 'The SSH public key file is invalid.'
SSH_KEY_LINE="$(head -n 1 "$SSH_PUBLIC_KEY")"
[[ "$SSH_KEY_LINE" =~ ^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521))[[:space:]] ]] || die 'Use a single OpenSSH public key line.'

ask DB_MEMORY 'Database VM memory in MiB' '4096'
ask API_MEMORY 'Backend VM memory in MiB' '2048'
ask FRONTEND_MEMORY 'Frontend VM memory in MiB' '2048'
for value in "$DB_MEMORY" "$API_MEMORY" "$FRONTEND_MEMORY"; do
  [[ "$value" =~ ^[0-9]+$ ]] || die 'Memory values must be whole MiB numbers.'
done
(( DB_MEMORY >= 2048 && API_MEMORY >= 1536 && FRONTEND_MEMORY >= 1024 )) || die 'Use at least 2048 MiB for DB, 1536 MiB for backend, and 1024 MiB for frontend.'
AVAILABLE_MIB="$(awk '/MemAvailable:/ {print int($2 / 1024)}' /proc/meminfo)"
(( AVAILABLE_MIB >= DB_MEMORY + API_MEMORY + FRONTEND_MEMORY + 2048 )) || die 'Not enough available host memory for the selected VMs plus 2 GiB of host reserve.'
AVAILABLE_KIB="$(pvesm status --storage "$VM_STORAGE" | awk 'NR > 1 {print $6}')"
[[ "$AVAILABLE_KIB" =~ ^[0-9]+$ ]] || die 'Could not read free space for the selected VM storage.'
(( AVAILABLE_KIB >= 120 * 1024 * 1024 )) || die 'Selected storage needs at least 120 GiB free for the guest disks.'

IMAGE_DIR='/var/lib/vz/template/iso'
IMAGE="$IMAGE_DIR/ubuntu-24.04-server-cloudimg-amd64.img"
SUMS="$(mktemp /tmp/northstar-ubuntu-sums.XXXXXX)"
trap 'rm -f -- "$SUMS"' EXIT
mkdir -p "$IMAGE_DIR"
curl -fsSL --retry 3 https://cloud-images.ubuntu.com/releases/noble/release/SHA256SUMS -o "$SUMS"
EXPECTED_SHA="$(awk '$2 == "*ubuntu-24.04-server-cloudimg-amd64.img" {print $1}' "$SUMS")"
[[ "$EXPECTED_SHA" =~ ^[0-9a-f]{64}$ ]] || die 'Ubuntu SHA256SUMS did not contain the expected image entry.'
if [[ ! -f "$IMAGE" ]]; then
  PART="$IMAGE.part"
  rm -f -- "$PART"
  curl -fL --retry 3 https://cloud-images.ubuntu.com/releases/noble/release/ubuntu-24.04-server-cloudimg-amd64.img -o "$PART"
  printf '%s  %s\n' "$EXPECTED_SHA" "$PART" | sha256sum --check --status || die 'Ubuntu cloud image checksum verification failed.'
  mv -- "$PART" "$IMAGE"
else
  printf '%s  %s\n' "$EXPECTED_SHA" "$IMAGE" | sha256sum --check --status || die 'Cached Ubuntu image failed checksum verification.'
fi
qemu-img info "$IMAGE" >/dev/null

# Add snippet support without dropping any existing local storage content types.
LOCAL_CONTENT="$(awk '
  $0 == "dir: local" {in_local=1; next}
  in_local && $1 == "content" {print $2; exit}
  in_local && /^[^[:space:]]/ {exit}
' /etc/pve/storage.cfg)"
[[ -n "$LOCAL_CONTENT" ]] || die 'The local directory storage configuration could not be read.'
if [[ ",$LOCAL_CONTENT," != *,snippets,* ]]; then
  pvesm set local --content "$LOCAL_CONTENT,snippets"
fi
install -d -m 0755 /var/lib/vz/snippets

make_user_data() {
  local role="$1" hostname="northstar-$1" output="/var/lib/vz/snippets/northstar-$1.yaml"
  cat > "$output" <<EOF
#cloud-config
hostname: $hostname
preserve_hostname: false
ssh_pwauth: false
package_update: true
package_upgrade: true
users:
  - default
  - name: northstar-ops
    gecos: Northstar Operations Administrator
    groups: [adm, sudo]
    shell: /bin/bash
    lock_passwd: true
    sudo: ["ALL=(ALL) NOPASSWD:ALL"]
    ssh_authorized_keys:
      - '$SSH_KEY_LINE'
packages:
  - ca-certificates
  - docker.io
  - docker-compose-v2
  - qemu-guest-agent
  - ufw
runcmd:
  - [usermod, -aG, docker, northstar-ops]
  - [systemctl, enable, --now, docker, qemu-guest-agent]
  - [install, -d, -o, northstar-ops, -g, northstar-ops, -m, '0750', /opt/northstar]
  - [ufw, --force, reset]
  - [ufw, default, deny, incoming]
  - [ufw, default, allow, outgoing]
  - [ufw, allow, from, '10.10.10.0/24', to, any, port, '22', proto, tcp]
EOF
  if [[ "$role" == 'frontend' ]]; then
    cat >> "$output" <<'EOF'
  - [ufw, allow, '80/tcp']
  - [ufw, allow, '443/tcp']
  - [ufw, allow, '443/udp']
EOF
  fi
  cat >> "$output" <<'EOF'
  - [ufw, --force, enable]
EOF
  chmod 0644 "$output"
}

make_user_data database
make_user_data backend
make_user_data frontend

create_vm() {
  local role="$1" memory="$2" cores="$3" extra_disk="$4" vmid="$5"
  if qm status "$vmid" >/dev/null 2>&1 || pct status "$vmid" >/dev/null 2>&1; then
    die "Guest ID $vmid already exists. Stop and rerun after reviewing the current IDs."
  fi
  qm create "$vmid" \
    --name "northstar-$role" \
    --description "Northstar Security $role host; provisioned for the Jenkins deployment pipeline" \
    --ostype l26 --cpu host --cores "$cores" --memory "$memory" \
    --scsihw virtio-scsi-single --agent enabled=1 --onboot 1 \
    --net0 "virtio,bridge=$BRIDGE,firewall=1"
  qm disk import "$vmid" "$IMAGE" "$VM_STORAGE" --format raw --target-disk scsi0
  qm disk resize "$vmid" scsi0 "+${extra_disk}G"
  qm set "$vmid" \
    --ide2 "$VM_STORAGE:cloudinit" \
    --boot order=scsi0 --serial0 socket --vga serial0 --citype nocloud \
    --ipconfig0 ip=dhcp \
    --cicustom "user=local:snippets/northstar-$role.yaml"
  qm start "$vmid"
  printf '%s %s\n' "$role" "$vmid"
}

BASE_ID="$(pvesh get /cluster/nextid)"
[[ "$BASE_ID" =~ ^[0-9]+$ ]] || die 'Could not obtain the next Proxmox guest ID.'
(( BASE_ID + 2 < 1000000000 )) || die 'The next guest ID is outside the supported range.'

printf '\nThis will create three new VMs on %s with DHCP networking:\n' "$VM_STORAGE"
printf '  %s northstar-database · 2 vCPU · %s MiB RAM · 64 GiB disk\n' "$BASE_ID" "$DB_MEMORY"
printf '  %s northstar-backend  · 2 vCPU · %s MiB RAM · 32 GiB disk\n' "$((BASE_ID+1))" "$API_MEMORY"
printf '  %s northstar-frontend · 1 vCPU  · %s MiB RAM · 24 GiB disk\n' "$((BASE_ID+2))" "$FRONTEND_MEMORY"
read -r -p 'Type CREATE to continue: ' CONFIRM
[[ "$CONFIRM" == 'CREATE' ]] || die 'Cancelled before creating any guest.'

create_vm database "$DB_MEMORY" 2 60 "$BASE_ID"
create_vm backend "$API_MEMORY" 2 28 "$((BASE_ID+1))"
create_vm frontend "$FRONTEND_MEMORY" 1 20 "$((BASE_ID+2))"

printf '\nWaiting up to 5 minutes for QEMU Guest Agent and DHCP addresses...\n'
declare -A GUEST_IPS=()
for role in database backend frontend; do
  vmid="$BASE_ID"
  [[ "$role" == backend ]] && vmid="$((BASE_ID+1))"
  [[ "$role" == frontend ]] && vmid="$((BASE_ID+2))"
  ip_address=''
  for attempt in $(seq 1 60); do
    agent_json="$(qm agent "$vmid" network-get-interfaces 2>/dev/null || true)"
    if [[ -n "$agent_json" ]]; then
      ip_address="$(python3 -c 'import ipaddress,json,sys
for interface in json.load(sys.stdin):
  for entry in interface.get("ip-addresses", []):
    try: addr=ipaddress.ip_address(entry.get("ip-address", ""))
    except ValueError: continue
    if entry.get("ip-address-type") == "ipv4" and not addr.is_loopback and not addr.is_link_local:
      print(addr); raise SystemExit(0)' <<< "$agent_json" 2>/dev/null || true)"
      [[ -n "$ip_address" ]] && break
    fi
    sleep 5
  done
  [[ -n "$ip_address" ]] || die "VM $vmid ($role) did not receive an address from DHCP or start its guest agent."
  cloud_result="$(qm guest exec "$vmid" --timeout 360 -- /usr/bin/cloud-init status --wait)"
  cloud_exit="$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("exitcode", -1))' <<< "$cloud_result")"
  [[ "$cloud_exit" == '0' ]] || die "Cloud-init reported failure on VM $vmid ($role): $cloud_result"
  agent_json="$(qm agent "$vmid" network-get-interfaces)"
  ip_address="$(python3 -c 'import ipaddress,json,sys
for interface in json.load(sys.stdin):
  for entry in interface.get("ip-addresses", []):
    try: addr=ipaddress.ip_address(entry.get("ip-address", ""))
    except ValueError: continue
    if entry.get("ip-address-type") == "ipv4" and not addr.is_loopback and not addr.is_link_local:
      print(addr); raise SystemExit(0)' <<< "$agent_json")"
  GUEST_IPS["$role"]="$ip_address"
done

printf '\nProvisioning summary\n'
printf 'Database VM: %s · %s\n' "$BASE_ID" "${GUEST_IPS[database]:-pending DHCP}"
printf 'Backend VM:  %s · %s\n' "$((BASE_ID+1))" "${GUEST_IPS[backend]:-pending DHCP}"
printf 'Frontend VM: %s · %s\n' "$((BASE_ID+2))" "${GUEST_IPS[frontend]:-pending DHCP}"
printf '\nDocker, Docker Compose, UFW, and the QEMU Guest Agent are installed by cloud-init.\n'
printf 'SSH admin: northstar-ops · authorized key fingerprint: '
ssh-keygen -lf "$SSH_PUBLIC_KEY" | awk '{print $2, $4}'
printf 'Next: reserve these DHCP leases, set the database/backend firewall source rules, and finish Jenkins credentials and pipeline configuration.\n'
