#!/usr/bin/env bash
# Installs and updates MafiaNight on a Debian or Ubuntu VM. Run it as root.
# The first run installs everything. Running it again updates the files and
# restarts the service. Watch the logs with:
#   journalctl -u mafianight.service -f
#
# Options (environment variables):
#   DOMAIN=play.example.com   also put Caddy in front for automatic HTTPS
#   SKIP_TESTS=1              do not run the tests before restarting
#   PORT=3000                 port the app listens on (it stays on 127.0.0.1)
#
# Nothing in this script contains a secret. Your settings live in
# /opt/mafianight/.env on the VM and are never overwritten.
set -euo pipefail

APP_NAME=mafianight
SERVICE="${APP_NAME}.service"
APP_USER="${APP_NAME}"
APP_DIR="/opt/${APP_NAME}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-3000}"
DOMAIN="${DOMAIN:-}"
NODE_MAJOR=24

say() { printf '\n==> %s\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run this as root (sudo ./setup_service.sh)"
command -v apt-get >/dev/null || die "this script expects Debian or Ubuntu (apt-get not found)"

say "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends curl ca-certificates rsync

node_ok() { command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge "${NODE_MAJOR}" ]; }
if ! node_ok; then
  say "Installing Node.js ${NODE_MAJOR}"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
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

if [ ! -f "${APP_DIR}/.env" ]; then
  say "Creating ${APP_DIR}/.env from .env.example"
  cp "${APP_DIR}/.env.example" "${APP_DIR}/.env"
  sed -i "s/^PORT=.*/PORT=${PORT}/" "${APP_DIR}/.env"
  [ -z "${DOMAIN}" ] || sed -i "s/^TRUST_PROXY=.*/TRUST_PROXY=true/" "${APP_DIR}/.env"
  chmod 640 "${APP_DIR}/.env"
fi
chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"

if [ -z "${SKIP_TESTS:-}" ]; then
  say "Running the tests (set SKIP_TESTS=1 to skip)"
  (cd "${APP_DIR}" && runuser -u "${APP_USER}" -- "${NODE_BIN}" --disable-warning=ExperimentalWarning --test "test/**/*.test.js") \
    || die "tests failed, the running service was left as it was"
fi

say "Writing the systemd service"
cat > "/etc/systemd/system/${SERVICE}" <<UNIT
[Unit]
Description=MafiaNight game server (working name)
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
Description=MafiaNight database backup

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
Description=Daily MafiaNight database backup

[Timer]
OnCalendar=daily
Persistent=true

[Install]
WantedBy=timers.target
UNIT

say "Writing the minute health check timer"
cat > "/etc/systemd/system/${APP_NAME}-health.service" <<UNIT
[Unit]
Description=MafiaNight health check (a failure shows in: systemctl --failed)

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
Description=Check MafiaNight every minute

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

say "Starting the service"
systemctl daemon-reload
systemctl enable "${SERVICE}" "${APP_NAME}-backup.timer" "${APP_NAME}-health.timer"
systemctl restart "${SERVICE}"
systemctl start "${APP_NAME}-backup.timer" "${APP_NAME}-health.timer"

for _ in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    say "MafiaNight is up on port ${PORT}"
    echo "Live logs:      journalctl -u ${SERVICE} -f"
    echo "Health checks: systemctl list-timers ${APP_NAME}-health.timer, failures: systemctl --failed"
    echo "Log files:      ${APP_DIR}/logs/app.log (size limited, copy the folder to read it locally)"
    echo "Settings:       ${APP_DIR}/.env (edit, then run this script again or: systemctl restart ${SERVICE})"
    [ -z "${DOMAIN}" ] || echo "Public address: https://${DOMAIN}"
    exit 0
  fi
  sleep 1
done
journalctl -u "${SERVICE}" -n 30 --no-pager || true
die "the service did not answer on port ${PORT}"
