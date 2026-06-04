#!/bin/sh
# wait-healthy.sh — poll docker compose ps until all services with a
# healthcheck report "healthy", or exit 1 after TIMEOUT seconds.
#
# Usage: scripts/wait-healthy.sh [timeout_seconds] [poll_interval_seconds]
# Defaults: 180s timeout, 5s poll interval.
#
# Uses `docker compose ps --format json` (one JSON object per line).
# Services with no healthcheck (Health == "") are skipped (treated as ok).
#
# IMPORTANT: Docker may return Health="" for a newly started container that
# has a healthcheck defined but hasn't run the first probe yet.  To avoid a
# false-positive "all healthy at 0s", we require at least one service to
# report a non-empty Health field before accepting a clean result.

TIMEOUT="${1:-180}"
POLL="${2:-5}"
elapsed=0

# Python script written to a temp file to avoid heredoc-vs-pipe conflicts.
PY_SCRIPT=$(mktemp /tmp/wait-healthy-XXXXXX.py)
cat > "$PY_SCRIPT" << 'EOF'
import sys, json

not_ok = []
has_health = 0
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        s = json.loads(line)
    except Exception:
        continue
    h = s.get('Health', '')
    if h == '':
        # no healthcheck defined on this service — treat as ok
        continue
    has_health += 1
    if h != 'healthy':
        not_ok.append('{} ({})'.format(s.get('Service', '?'), h))

# First line: count of services with non-empty health field.
# Remaining lines: names of unhealthy services.
print(has_health)
print('\n'.join(not_ok))
EOF

cleanup() { rm -f "$PY_SCRIPT"; }
trap cleanup EXIT

echo "Waiting up to ${TIMEOUT}s for all services to become healthy..."

while true; do
  RESULT=$(docker compose ps --format json 2>/dev/null | python3 "$PY_SCRIPT")
  HAS_HEALTH=$(echo "$RESULT" | head -1)
  NOT_OK=$(echo "$RESULT" | tail -n +2)

  # If we found at least one service with health data AND none are unhealthy → done.
  if [ "${HAS_HEALTH:-0}" -gt 0 ] && [ -z "$NOT_OK" ]; then
    echo "All services healthy after ${elapsed}s."
    exit 0
  fi

  if [ "$elapsed" -ge "$TIMEOUT" ]; then
    echo ""
    echo "ERROR: Timed out after ${TIMEOUT}s waiting for services to become healthy."
    if [ -n "$NOT_OK" ]; then
      echo "Still unhealthy:"
      echo "$NOT_OK" | sed 's/^/  /'
    else
      echo "  (no health data yet — containers may not have started)"
    fi
    echo ""
    echo "Run 'task logs' to investigate."
    exit 1
  fi

  if [ -n "$NOT_OK" ]; then
    echo "  [${elapsed}s/${TIMEOUT}s] Not yet healthy: $(echo "$NOT_OK" | tr '\n' ' ')"
  else
    echo "  [${elapsed}s/${TIMEOUT}s] Waiting for health probes to start..."
  fi
  sleep "$POLL"
  elapsed=$((elapsed + POLL))
done
