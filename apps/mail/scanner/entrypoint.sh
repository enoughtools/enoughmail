#!/bin/sh
set -eu
# The bundled database allows startup without downloading mail or uploading it anywhere.
# Freshclam updates signatures only. A stale loaded database never certifies clean.
python3 /opt/mail-scanner/server.py &
SERVER_PID=$!
CLAMD_PID=
FRESHCLAM_PID=
trap 'kill "$SERVER_PID" ${CLAMD_PID:+"$CLAMD_PID"} ${FRESHCLAM_PID:+"$FRESHCLAM_PID"} 2>/dev/null || true' EXIT INT TERM
# Update before the initial load to avoid loading old signatures concurrently with an update.
# If the update service is unavailable, loaded-signature freshness still gates every scan.
freshclam --stdout || true
clamd --config-file=/etc/clamav/clamd.conf &
CLAMD_PID=$!
freshclam --daemon --foreground --checks=12 --stdout --notify-clamd=/etc/clamav/clamd.conf &
FRESHCLAM_PID=$!
# Exit the container if either the scanner or adapter dies; never leave a fake healthy API.
while kill -0 "$CLAMD_PID" 2>/dev/null && kill -0 "$SERVER_PID" 2>/dev/null; do sleep 2; done
exit 1
