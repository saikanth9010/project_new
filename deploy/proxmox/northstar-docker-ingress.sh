#!/usr/bin/env bash
set -Eeuo pipefail

# Docker-published ports bypass UFW's normal INPUT rules. This filter restricts
# one published TCP port to one source IPv4 address through DOCKER-USER.
ALLOW_SOURCE="${1:-}"
PUBLISHED_PORT="${2:-}"
[[ "$ALLOW_SOURCE" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || {
  echo 'Usage: northstar-docker-ingress.sh ALLOW_SOURCE_IPV4 PUBLISHED_PORT' >&2
  exit 2
}
[[ "$PUBLISHED_PORT" =~ ^[0-9]{1,5}$ ]] && (( PUBLISHED_PORT > 0 && PUBLISHED_PORT <= 65535 )) || {
  echo 'The published port must be between 1 and 65535.' >&2
  exit 2
}
[[ "$EUID" -eq 0 ]] || { echo 'Run this script as root.' >&2; exit 1; }

iptables -S DOCKER-USER >/dev/null 2>&1 || {
  echo 'Docker must be running and have created the DOCKER-USER chain first.' >&2
  exit 1
}

iptables -N NORTHSTAR-INGRESS 2>/dev/null || true
iptables -F NORTHSTAR-INGRESS
iptables -A NORTHSTAR-INGRESS -i eth0 -p tcp -s "$ALLOW_SOURCE" --dport "$PUBLISHED_PORT" -j ACCEPT
iptables -A NORTHSTAR-INGRESS -i eth0 -p tcp --dport "$PUBLISHED_PORT" -j DROP
iptables -A NORTHSTAR-INGRESS -j RETURN
iptables -C DOCKER-USER -j NORTHSTAR-INGRESS 2>/dev/null || iptables -I DOCKER-USER 1 -j NORTHSTAR-INGRESS
