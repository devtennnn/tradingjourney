#!/usr/bin/env bash
# Bakong relay installer for a fresh Ubuntu 22.04 / 24.04 or Debian 12 VPS that has a CAMBODIAN IP address.
#
#   sudo bash install.sh                      # HTTPS on  <your-ip>.sslip.io  (no domain needed)
#   sudo bash install.sh --domain relay.example.com   # HTTPS on your own domain (point its A record at this server first)
#   bash install.sh --dry-run [--ip 203.0.113.9] [--domain ...]    # show what it WOULD do, change nothing, needs no root
#
# What it does (safe to run again: the key is kept):
#   1. Tests from THIS server whether Bakong answers or refuses (the same empty 403 your Supabase function gets in Seoul).
#   2. Installs Node 20 (if Node 18+ is missing), creates the relay as a locked-down systemd service on 127.0.0.1:8787.
#   3. Installs Caddy and gets a free HTTPS certificate (Let's Encrypt) in front of it: the Bakong token travels in these requests.
#   4. Prints the two secrets to paste into Supabase: BAKONG_API_URL and BAKONG_RELAY_KEY.
set -euo pipefail

DOMAIN=""; IP=""; DRY=0
APP_DIR=/opt/bakong-relay; ENV_FILE=/etc/bakong-relay.env; UNIT=/etc/systemd/system/bakong-relay.service; CADDYFILE=/etc/caddy/Caddyfile
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MARK="# managed by bakong-relay install.sh"

usage() { sed -n '2,13p' "${BASH_SOURCE[0]}"; }
say()  { printf '\n==> %s\n' "$*"; }
warn() { printf '\n!! %s\n' "$*" >&2; }
die()  { warn "$*"; exit 1; }
run()  { if [ "$DRY" = 1 ]; then printf '   [dry-run] %s\n' "$*"; else "$@"; fi; }

# ---------- pure helpers (unit-tested) ----------
sslip_host() { local ip="$1"; printf '%s.sslip.io' "${ip//./-}"; }

# Bakong answers a call from a Cambodian IP with a JSON body (even "unauthorized"); from abroad it sends an empty / non-JSON 403.
# args: <http status> <body>   prints: reachable | blocked | network | unknown
classify_bakong() {
  local code="$1" body="${2:-}"
  body="${body#"${body%%[![:space:]]*}"}"            # ignore leading whitespace
  case "$code" in 000|"") echo network; return;; esac
  if [[ "$body" == "{"* ]]; then echo reachable; return; fi
  if [ "$code" = 403 ] || [ "$code" = 451 ]; then echo blocked; return; fi
  echo unknown
}

caddyfile_for() { printf '%s\n%s {\n  encode gzip\n  reverse_proxy 127.0.0.1:8787\n}\n' "$MARK" "$1"; }

unit_file() {
  cat <<'UNIT'
[Unit]
Description=Bakong relay (forwards one KHQR check to Bakong)
After=network-online.target
Wants=network-online.target

[Service]
User=bakong-relay
Group=bakong-relay
EnvironmentFile=/etc/bakong-relay.env
ExecStart=/usr/bin/env node /opt/bakong-relay/relay.mjs
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
MemoryMax=256M

[Install]
WantedBy=multi-user.target
UNIT
}

# ---------- steps ----------
preflight() {
  say "Step 1/5: can THIS server reach Bakong?"
  if [ "$DRY" = 1 ]; then echo "   [dry-run] would ask https://www.cloudflare.com/cdn-cgi/trace for this server's country and POST a probe to https://api-bakong.nbc.gov.kh"; return; fi
  local loc code body
  loc="$(curl -fsS -m 10 https://www.cloudflare.com/cdn-cgi/trace 2>/dev/null | sed -n 's/^loc=//p' || true)"
  echo "   This server's country (as the internet sees it): ${loc:-unknown}"
  if [ -n "$loc" ] && [ "$loc" != "KH" ]; then
    warn "This server is NOT in Cambodia (country=$loc). Bakong will keep refusing it. Use a VPS with a Cambodian IP address."
  fi
  body="$(mktemp)"
  code="$(curl -sS -m 15 -o "$body" -w '%{http_code}' -X POST https://api-bakong.nbc.gov.kh/v1/check_transaction_by_md5 \
          -H 'Content-Type: application/json' -H 'Authorization: Bearer invalid' -d '{"md5":"00000000000000000000000000000000"}' 2>/dev/null || echo 000)"
  case "$(classify_bakong "$code" "$(head -c 200 "$body")")" in
    reachable) echo "   OK: Bakong answered (HTTP $code). This server can talk to Bakong." ;;
    blocked)   warn "Bakong answered with an empty HTTP $code, the same refusal your Supabase function gets. This server may be blocked too (or Bakong needs your IP registered). The install continues; the admin panel's 'Check bank connection' will give the final answer." ;;
    network)   warn "Could not reach Bakong at all from this server (network problem). The install continues." ;;
    *)         warn "Bakong answered HTTP $code with an unexpected reply. The install continues." ;;
  esac
  rm -f "$body"
}

install_node() {
  say "Step 2/5: Node.js 18+"
  local major=0
  if command -v node >/dev/null 2>&1; then major="$(node -p 'process.versions.node.split(".")[0]')"; fi
  if [ "$major" -ge 18 ]; then echo "   Node $(node -v) is already installed."; return; fi
  run bash -c 'curl -fsSL https://deb.nodesource.com/setup_20.x | bash -'
  run apt-get install -y nodejs
}

install_relay() {
  say "Step 3/5: the relay service"
  if [ "$DRY" = 1 ]; then echo "   [dry-run] useradd --system --no-create-home --shell /usr/sbin/nologin bakong-relay   (only if it does not exist yet)"
  elif ! id -u bakong-relay >/dev/null 2>&1; then useradd --system --no-create-home --shell /usr/sbin/nologin bakong-relay; fi
  run install -d -m 0755 "$APP_DIR"
  run install -m 0644 "$HERE/relay.mjs" "$APP_DIR/relay.mjs"
  if [ "$DRY" = 1 ]; then
    echo "   [dry-run] would create $ENV_FILE (mode 600) with a fresh RELAY_KEY=<48 hex characters> unless it already exists"
    echo "   [dry-run] would write $UNIT:"; unit_file | sed 's/^/       | /'
  else
    if [ ! -s "$ENV_FILE" ]; then
      umask 077; printf 'RELAY_KEY=%s\nPORT=8787\nHOST=127.0.0.1\n' "$(openssl rand -hex 24)" > "$ENV_FILE"
    fi
    chmod 600 "$ENV_FILE"; unit_file > "$UNIT"
  fi
  run systemctl daemon-reload
  run systemctl enable --now bakong-relay
  run systemctl restart bakong-relay
}

install_caddy() {
  say "Step 4/5: HTTPS (Caddy + free Let's Encrypt certificate)"
  if [ "$DRY" != 1 ] && command -v caddy >/dev/null 2>&1; then echo "   Caddy is already installed."
  else
    run apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
    run bash -c "curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg"
    run bash -c "curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list"
    run apt-get update
    run apt-get install -y caddy
  fi
  if [ "$DRY" = 1 ]; then echo "   [dry-run] would write $CADDYFILE:"; caddyfile_for "$HOSTNAME_PUBLIC" | sed 's/^/       | /'
  else
    if [ -s "$CADDYFILE" ] && ! grep -qF "$MARK" "$CADDYFILE"; then cp "$CADDYFILE" "$CADDYFILE.bak-$(date +%s)"; echo "   Existing Caddyfile backed up."; fi
    caddyfile_for "$HOSTNAME_PUBLIC" > "$CADDYFILE"
  fi
  run systemctl enable --now caddy
  run systemctl reload caddy
}

verify_and_report() {
  say "Step 5/5: checking it works"
  if [ "$DRY" = 1 ]; then echo "   [dry-run] would call http://127.0.0.1:8787/health then https://$HOSTNAME_PUBLIC/health (waits up to 90 s for the certificate)"; return; fi
  local i ok=0
  for i in 1 2 3 4 5 6 7 8 9 10; do curl -fsS -m 3 http://127.0.0.1:8787/health >/dev/null 2>&1 && { ok=1; break; }; sleep 1; done
  [ "$ok" = 1 ] && echo "   The relay is running on 127.0.0.1:8787." || { journalctl -u bakong-relay -n 20 --no-pager || true; die "The relay did not start. See the log above."; }
  ok=0
  for i in $(seq 1 18); do curl -fsS -m 5 "https://$HOSTNAME_PUBLIC/health" >/dev/null 2>&1 && { ok=1; break; }; sleep 5; done
  if [ "$ok" = 1 ]; then echo "   HTTPS works: https://$HOSTNAME_PUBLIC/health"
  else warn "HTTPS is not answering yet. Check: ports 80 and 443 are open in the VPS firewall, and (if you used --domain) its DNS A record points to this server. Log: journalctl -u caddy -n 30"; fi
  local key; key="$(sed -n 's/^RELAY_KEY=//p' "$ENV_FILE")"
  cat <<EOF

================ DONE. Put these two secrets in Supabase ================
Supabase dashboard -> Project Settings -> Edge Functions -> Secrets -> Add:

   BAKONG_API_URL    = https://$HOSTNAME_PUBLIC
   BAKONG_RELAY_KEY  = $key

(BAKONG_TOKEN stays as it is.) Then open your site -> Admin -> Activations -> "Check bank connection".
It should say: "Automatic bank confirmation is working". Finish with one real test payment.
Keep BAKONG_RELAY_KEY private: it is also stored in $ENV_FILE on this server (root only).
=========================================================================
Firewall tip (Ubuntu): ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw enable
EOF
}

# tests source this file for the helpers above
if [ "${INSTALL_SOURCE_ONLY:-0}" = 1 ]; then return 0 2>/dev/null || exit 0; fi

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; [ -n "$DOMAIN" ] || die "--domain needs a value"; shift 2;;
    --ip)     IP="${2:-}"; shift 2;;
    --dry-run) DRY=1; shift;;
    -h|--help) usage; exit 0;;
    *) die "Unknown option: $1 (try --help)";;
  esac
done

if [ "$DRY" != 1 ]; then
  [ "$(id -u)" = 0 ] || die "Run as root: sudo bash install.sh"
  [ -f "$HERE/relay.mjs" ] || die "relay.mjs must be in the same folder as install.sh"
  . /etc/os-release 2>/dev/null || true
  case "${ID:-}" in ubuntu|debian) ;; *) die "This installer supports Ubuntu and Debian (found: ${ID:-unknown}).";; esac
  command -v curl >/dev/null 2>&1 || { apt-get update && apt-get install -y curl; }
  command -v openssl >/dev/null 2>&1 || apt-get install -y openssl
fi

if [ -n "$DOMAIN" ]; then HOSTNAME_PUBLIC="$DOMAIN"
else
  [ -n "$IP" ] || { if [ "$DRY" = 1 ]; then IP="203.0.113.9"; else IP="$(curl -fsS -m 10 https://api.ipify.org || true)"; fi; }
  [[ "$IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || die "Could not detect this server's public IP. Run again with:  --ip <your server IP>   (or --domain <your domain>)"
  HOSTNAME_PUBLIC="$(sslip_host "$IP")"
fi
say "Public address for the relay: https://$HOSTNAME_PUBLIC"
[ "$DRY" = 1 ] && say "DRY RUN: nothing will be changed."

preflight
install_node
install_relay
install_caddy
verify_and_report
