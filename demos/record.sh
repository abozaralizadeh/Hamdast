#!/usr/bin/env bash
# Records the demo video. Each run starts a fresh throwaway demo server (so the room
# is new), puts its join link into the storyboard and runs the recorder.
#   demos/record.sh              record
#   demos/record.sh dry          run every step with no video, to check the storyboard
#   SEED=6 demos/record.sh       use another dealing
# The recorder is a separate demo-recorder tool. Set RECORDER to the path of its demo.mjs.
set -euo pipefail
cd "$(dirname "$0")/.."

MODE="${1:-record}"
SEED="${SEED:-1}"
STORY="${STORY:-demos/tour.json}"
RECORDER="${RECORDER:?set RECORDER to the demo-recorder demo.mjs}"
LOG="$(mktemp -t hamdast-demo-server)"

node --disable-warning=ExperimentalWarning demos/server.js "${SEED}" >"${LOG}" 2>&1 &
SERVER=$!
trap 'kill "${SERVER}" 2>/dev/null || true; rm -f "${LOG}"' EXIT

URL=""
for _ in $(seq 1 50); do
  URL="$(sed -n 's/^JOIN //p' "${LOG}" | head -1)"
  [ -n "${URL}" ] && break
  sleep 0.2
done
[ -n "${URL}" ] || { cat "${LOG}"; echo "the demo server did not start" >&2; exit 1; }

RUN="demos/.run-$(basename "${STORY}")"
sed "s|__JOIN_URL__|${URL}|" "${STORY}" > "${RUN}"
if [ "${MODE}" = "dry" ]; then
  node "${RECORDER}" record "${RUN}" --dry
else
  node "${RECORDER}" record "${RUN}"
fi
rm -f "${RUN}"
