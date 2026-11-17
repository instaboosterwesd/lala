#!/bin/sh
# ARTEX "full stack" supervisor, enabled with ARTEX_STACK=1 (see start.sh).
#
#   Xvfb :99          virtual display for the headed browser the bridge drives
#   artex :8787       the Go server (supervised in turn by start.sh)
#   bridge :9223      browser bridge — tabs + live screenshots over CDP :9222
#   gateway :8790     front door: /api → artex, /browser-bridge → bridge,
#                     /oc-api → Open Connector (when it runs), everything else → artex
#
# Point the deployment's public port at the GATEWAY (8790), not at 8787: the chat's
# "Open Browser" panel and the Connections page talk to /browser-bridge and /oc-api, which
# only the gateway serves. Without this stack those paths hit ARTEX's SPA fallback and return
# index.html, which the UI reports as "runtime is not available on this server".
set -u

cd "$(dirname "$0")" || exit 1

DISPLAY_NUM="${ARTEX_BROWSER_DISPLAY:-99}"
export DISPLAY=":${DISPLAY_NUM}"
export CHROME_PATH="${CHROME_PATH:-/usr/bin/google-chrome-stable}"
export BROWSER_BRIDGE_PORT="${BROWSER_BRIDGE_PORT:-9223}"
export CHROME_CDP_PORT="${CHROME_CDP_PORT:-9222}"
export ARTEX_GATEWAY_PORT="${ARTEX_GATEWAY_PORT:-8790}"
export ARTEX_UPSTREAM="${ARTEX_UPSTREAM:-http://127.0.0.1:8787}"
export BROWSER_BRIDGE_UPSTREAM="${BROWSER_BRIDGE_UPSTREAM:-http://127.0.0.1:${BROWSER_BRIDGE_PORT}}"
export OPEN_CONNECTOR_UPSTREAM="${OPEN_CONNECTOR_UPSTREAM:-http://127.0.0.1:3000}"
# No web/out in the image: the gateway then forwards everything to ARTEX, whose UI is embedded.
export ARTEX_STATIC_ROOT="${ARTEX_STATIC_ROOT:-/app/web-out}"

xvfb_pid=0
artex_pid=0
bridge_pid=0
gateway_pid=0

cleanup() {
	trap - INT TERM
	for pid in "$gateway_pid" "$bridge_pid" "$artex_pid" "$xvfb_pid"; do
		[ "$pid" -gt 0 ] 2>/dev/null && kill -TERM "$pid" 2>/dev/null
	done
	wait
	exit 0
}
trap cleanup INT TERM

# Logs go to stdout/stderr so the platform's log viewer shows them.
echo "[stack] Xvfb ${DISPLAY}"
Xvfb "$DISPLAY" -screen 0 1280x800x24 -ac +extension GLX +render -noreset &
xvfb_pid=$!
sleep 1

echo "[stack] artex on :8787 (data=${ARTEX_DATA_DIR:-./data})"
ARTEX_STACK=0 ./start.sh "$@" &
artex_pid=$!

# The bridge spawns Chrome itself (headed, on $DISPLAY) and connects over CDP.
echo "[stack] browser bridge on :${BROWSER_BRIDGE_PORT} (chrome=${CHROME_PATH})"
( cd scripts && node browser-bridge.js ) &
bridge_pid=$!
sleep 2

echo "[stack] gateway on :${ARTEX_GATEWAY_PORT} → artex=${ARTEX_UPSTREAM} bridge=${BROWSER_BRIDGE_UPSTREAM}"
( cd scripts && node artex-gateway.js ) &
gateway_pid=$!

# If the gateway exits, the public port is dead: stop everything instead of half-running.
wait "$gateway_pid"
status=$?
echo "[stack] gateway exited (${status}), shutting the stack down" >&2
cleanup
