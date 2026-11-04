#!/usr/bin/env bash
# Installs and updates Hamdast on a Debian or Ubuntu VM. Run it as root.
# The first run installs everything. Running it again updates the files and
# restarts the service. Watch the logs with:
#   journalctl -u hamdast.service -f
#
# Two ways to run it.
#
# 1. A VM of its own (the default). Installs Node, rsync and curl with apt if
#    they are missing, and with DOMAIN set it also puts Caddy in front:
#      sudo ./setup_service.sh
#      sudo DOMAIN=play.example.com ./setup_service.sh
#
# 2. A shared VM that already runs nginx, under a path such as /hamdast/.
#    NGINX_SNIPPET switches this on. It installs nothing and touches no firewall,
#    no Caddy, no certbot and no nginx site file. It writes exactly two files,
#    NGINX_SNIPPET and /etc/nginx/conf.d/<service>-limits.conf, checks nginx -t,
#    and removes both again if the check fails:
#      sudo SERVICE_NAME=idea-hamdast PORT=8602 BASE_PATH=/hamdast/ \
#           NGINX_SNIPPET=/etc/nginx/max.d/hamdast.conf ./setup_service.sh
#    Your nginx server block must include the snippet folder, for example
#    include /etc/nginx/max.d/*.conf; and nginx.conf must include conf.d/*.conf.
#
# Options (environment variables):
#   SERVICE_NAME=hamdast      name of the service, its timers, user and /opt folder
#   PORT=3000                 port the app listens on (always 127.0.0.1 only)
#   DOMAIN=play.example.com   own VM only: Caddy in front for automatic HTTPS
#   NGINX_SNIPPET=/path.conf  shared VM: the nginx location file to write
#   BASE_PATH=/hamdast/       shared VM: the path the app is served under
#   SKIP_TESTS=1              do not run the tests before restarting
#
# Nothing in this script contains a secret. Your settings live in
# /opt/<service>/.env on the VM and are never overwritten, only the lines this
# script owns (PORT, HOST and TRUST_PROXY) are updated.
set -euo pipefail

APP_NAME="${SERVICE_NAME:-hamdast}"
SERVICE="${APP_NAME}.service"
APP_USER="${APP_NAME}"
APP_DIR="/opt/${APP_NAME}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOMAIN="${DOMAIN:-}"
NGINX_SNIPPET="${NGINX_SNIPPET:-}"
BASE_PATH="${BASE_PATH:-/hamdast/}"
NODE_MAJOR=24

say() { printf '\n==> %s\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run this as root (sudo ./setup_service.sh)"
[[ "${APP_NAME}" =~ ^[a-z][a-z0-9-]*$ ]] || die "SERVICE_NAME may only have lowercase letters, digits and dashes"
[ -z "${PORT:-}" ] || [[ "${PORT}" =~ ^[0-9]+$ ]] || die "PORT must be a number"

node_ok() { command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge "${NODE_MAJOR}" ]; }

if [ -n "${NGINX_SNIPPET}" ]; then
  say "Shared VM mode: nginx at ${BASE_PATH}, nothing gets installed"
  [ -z "${DOMAIN}" ] || die "DOMAIN and NGINX_SNIPPET can't be used together. Leave DOMAIN out on a shared VM."
  [[ "${BASE_PATH}" == /*/ ]] || die "BASE_PATH must start and end with a slash, like /hamdast/"
  [[ "${BASE_PATH}" =~ ^[A-Za-z0-9/_-]+$ ]] || die "BASE_PATH may only have letters, digits, dashes, underscores and slashes"
  [[ "${NGINX_SNIPPET}" == /*.conf ]] || die "NGINX_SNIPPET must be an absolute path ending in .conf"
  [ -n "${PORT:-}" ] || [ -f "${APP_DIR}/.env" ] || die "set PORT, a shared VM has no safe default port"
  missing=()
  node_ok || missing+=("node ${NODE_MAJOR} or newer")
  for tool in rsync curl nginx systemctl; do command -v "${tool}" >/dev/null || missing+=("${tool}"); done
  [ ${#missing[@]} -eq 0 ] || die "missing on this VM: ${missing[*]}. Shared mode installs nothing, so add them first."
  [ -f /etc/nginx/nginx.conf ] || die "/etc/nginx/nginx.conf not found"
  grep -qE '^\s*include\s+/etc/nginx/conf\.d/\*\.conf' /etc/nginx/nginx.conf \
    || die "nginx.conf does not include /etc/nginx/conf.d/*.conf, so the rate limit zone can't be added. Nothing changed."
else
  command -v apt-get >/dev/null || die "this script expects Debian or Ubuntu (apt-get not found)"
  say "Installing system packages"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y --no-install-recommends curl ca-certificates rsync
  if ! node_ok; then
    say "Installing Node.js ${NODE_MAJOR}"
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
    apt-get install -y nodejs
  fi
fi
node_ok || die "Node.js ${NODE_MAJOR} or newer is required"
NODE_BIN="$(command -v node)"

say "Creating the service user and folders"
id -u "${APP_USER}" >/dev/null 2>&1 || useradd --system --home "${APP_DIR}" --shell /usr/sbin/nologin "${APP_USER}"
mkdir -p "${APP_DIR}" "${APP_DIR}/data" "${APP_DIR}/logs"

say "Copying the app to ${APP_DIR}"
# Anything this clone keeps out of git (its local exclude list) is not copied either.
LOCAL_EXCLUDES=()
if [ -f "${SRC_DIR}/.git/info/exclude" ]; then
  LOCAL_EXCLUDES=(--exclude-from="${SRC_DIR}/.git/info/exclude")
fi
rsync -a --delete \
  --exclude '.git' --exclude 'node_modules' --exclude '.env' \
  --exclude 'data' --exclude 'logs' --exclude '.vscode' \
  "${LOCAL_EXCLUDES[@]}" \
  "${SRC_DIR}/" "${APP_DIR}/"

ENV_FILE="${APP_DIR}/.env"
if [ ! -f "${ENV_FILE}" ]; then
  say "Creating ${ENV_FILE} from .env.example"
  cp "${APP_DIR}/.env.example" "${ENV_FILE}"
fi
# set_env KEY VALUE: replaces the line, or adds it. Everything else in .env stays.
set_env() {
  if grep -q "^$1=" "${ENV_FILE}"; then sed -i "s|^$1=.*|$1=$2|" "${ENV_FILE}"; else echo "$1=$2" >> "${ENV_FILE}"; fi
}
[ -z "${PORT:-}" ] || set_env PORT "${PORT}"
# The app only ever listens on this machine. Caddy or nginx is the public side.
set_env HOST 127.0.0.1
if [ -n "${NGINX_SNIPPET}" ]; then
  # Trust X-Forwarded-For only when it comes from nginx on this machine.
  set_env TRUST_PROXY 127.0.0.1
elif [ -n "${DOMAIN}" ]; then
  set_env TRUST_PROXY 127.0.0.1
fi
PORT="$(grep -E '^PORT=' "${ENV_FILE}" | tail -n 1 | cut -d= -f2)"
PORT="${PORT:-3000}"
chmod 640 "${ENV_FILE}"
chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"

if [ -z "${SKIP_TESTS:-}" ]; then
  say "Running the tests (set SKIP_TESTS=1 to skip)"
  (cd "${APP_DIR}" && runuser -u "${APP_USER}" -- "${NODE_BIN}" --disable-warning=ExperimentalWarning --test "test/**/*.test.js") \
    || die "tests failed, the running service was left as it was"
fi

say "Writing the systemd service"
cat > "/etc/systemd/system/${SERVICE}" <<UNIT
[Unit]
Description=Hamdast game server (${APP_NAME})
After=network.target

[Service]
Type=simple
User=${APP_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=-${APP_DIR}/.env
ExecStart=${NODE_BIN} --disable-warning=ExperimentalWarning src/server/index.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${APP_DIR}/data ${APP_DIR}/logs

[Install]
WantedBy=multi-user.target
UNIT

say "Writing the daily database backup timer"
cat > "/etc/systemd/system/${APP_NAME}-backup.service" <<UNIT
[Unit]
Description=Hamdast database backup

[Service]
Type=oneshot
User=${APP_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=-${APP_DIR}/.env
ExecStart=${NODE_BIN} --disable-warning=ExperimentalWarning scripts/backup.js
ProtectSystem=strict
ReadWritePaths=${APP_DIR}/data
UNIT
cat > "/etc/systemd/system/${APP_NAME}-backup.timer" <<UNIT
[Unit]
Description=Daily Hamdast database backup

[Timer]
OnCalendar=daily
Persistent=true

[Install]
WantedBy=timers.target
UNIT

say "Writing the minute health check timer"
cat > "/etc/systemd/system/${APP_NAME}-health.service" <<UNIT
[Unit]
Description=Hamdast health check (a failure shows in: systemctl --failed)

[Service]
Type=oneshot
User=${APP_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=-${APP_DIR}/.env
ExecStart=${NODE_BIN} scripts/healthcheck.js
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
UNIT
cat > "/etc/systemd/system/${APP_NAME}-health.timer" <<UNIT
[Unit]
Description=Check Hamdast every minute

[Timer]
OnBootSec=2min
OnUnitActiveSec=1min
AccuracySec=10s

[Install]
WantedBy=timers.target
UNIT

if [ -n "${DOMAIN}" ]; then
  say "Setting up Caddy for ${DOMAIN}"
  command -v caddy >/dev/null || apt-get install -y caddy
  cat > /etc/caddy/Caddyfile <<CADDY
${DOMAIN} {
	encode gzip
	reverse_proxy 127.0.0.1:${PORT} {
		flush_interval -1
	}
}
CADDY
  systemctl enable --now caddy
  systemctl reload caddy || systemctl restart caddy
fi

if [ -n "${NGINX_SNIPPET}" ]; then
  ZONE="${APP_NAME//-/_}"
  ZONE_FILE="/etc/nginx/conf.d/${APP_NAME}-limits.conf"
  say "nginx: ${BASE_PATH} goes to 127.0.0.1:${PORT}"
  mkdir -p "$(dirname "${NGINX_SNIPPET}")"
  had_snippet=false; had_zone=false
  if [ -f "${NGINX_SNIPPET}" ]; then cp "${NGINX_SNIPPET}" "${NGINX_SNIPPET}.bak"; had_snippet=true; fi
  if [ -f "${ZONE_FILE}" ]; then cp "${ZONE_FILE}" "${ZONE_FILE}.bak"; had_zone=true; fi
  cat > "${ZONE_FILE}" <<NGINX
# ${APP_NAME}: request rate limit zone, used by ${NGINX_SNIPPET}. Written by setup_service.sh.
limit_req_zone \$binary_remote_addr zone=${ZONE}:10m rate=10r/s;
NGINX
  cat > "${NGINX_SNIPPET}" <<NGINX
# ${APP_NAME}: written by setup_service.sh from ${SRC_DIR}. Running it again rewrites this file.
location = ${BASE_PATH%/} { return 301 ${BASE_PATH}; }
location ${BASE_PATH} {
    limit_req zone=${ZONE} burst=40 nodelay;
    limit_req_status 429;
    client_max_body_size 32k;
    # The trailing slash strips ${BASE_PATH} so the app sees plain paths.
    proxy_pass http://127.0.0.1:${PORT}/;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-For \$remote_addr;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header Connection "";
    # The live game updates are one long event stream per player.
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 1h;
    proxy_send_timeout 1h;
}
NGINX
  NGINX_LOG="$(mktemp)"
  if nginx -t >"${NGINX_LOG}" 2>&1; then
    rm -f "${NGINX_SNIPPET}.bak" "${ZONE_FILE}.bak" "${NGINX_LOG}"
    systemctl reload nginx
  else
    cat "${NGINX_LOG}" >&2
    rm -f "${NGINX_LOG}"
    if $had_snippet; then mv "${NGINX_SNIPPET}.bak" "${NGINX_SNIPPET}"; else rm -f "${NGINX_SNIPPET}"; fi
    if $had_zone; then mv "${ZONE_FILE}.bak" "${ZONE_FILE}"; else rm -f "${ZONE_FILE}"; fi
    die "nginx -t failed, so both nginx files were put back as they were. The app service was not restarted."
  fi
  grep -rqsF "$(dirname "${NGINX_SNIPPET}")" /etc/nginx/nginx.conf /etc/nginx/sites-enabled /etc/nginx/conf.d \
    || echo "Warning: no nginx file seems to include $(dirname "${NGINX_SNIPPET}"). Add include $(dirname "${NGINX_SNIPPET}")/*.conf; to your server block."
fi

say "Starting the service"
systemctl daemon-reload
systemctl enable "${SERVICE}" "${APP_NAME}-backup.timer" "${APP_NAME}-health.timer"
systemctl restart "${SERVICE}"
systemctl start "${APP_NAME}-backup.timer" "${APP_NAME}-health.timer"

for _ in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    say "Hamdast is up on port ${PORT}"
    echo "Live logs:      journalctl -u ${SERVICE} -f"
    echo "Health checks: systemctl list-timers ${APP_NAME}-health.timer, failures: systemctl --failed"
    echo "Log files:      ${APP_DIR}/logs/app.log (size limited, copy the folder to read it locally)"
    echo "Settings:       ${APP_DIR}/.env (edit, then run this script again or: systemctl restart ${SERVICE})"
    [ -z "${DOMAIN}" ] || echo "Public address: https://${DOMAIN}"
    [ -z "${NGINX_SNIPPET}" ] || echo "Public path:    ${BASE_PATH} (nginx snippet ${NGINX_SNIPPET})"
    exit 0
  fi
  sleep 1
done
journalctl -u "${SERVICE}" -n 30 --no-pager || true
die "the service did not answer on port ${PORT}"
