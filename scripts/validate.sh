#!/bin/sh
# validate.sh — infra + curl smoke checks for the authentik-poc stack.
#
# Checks performed:
#   1. Only traefik publishes host ports
#   2. SPA reachable via app.localhost → 200
#   3. authentik reachable via auth.localhost → 200 or 302
#   4. Dex OIDC discovery reachable via idp.localhost
#   5. authentik OIDC discovery reachable via auth.localhost
#   6. GET /api/me with no token → 401
#
# Exit 0 if all checks pass, 1 if any fail.
# Called by `task validate`; Go tests and E2E are run separately by that task.

PASS=0
FAIL=0
ERRORS=""

check_pass() {
  echo "  [PASS] $1"
  PASS=$((PASS + 1))
}

check_fail() {
  echo "  [FAIL] $1"
  FAIL=$((FAIL + 1))
  ERRORS="${ERRORS}
  - $1"
}

echo ""
echo "============================================================"
echo "  validate: infra + curl smoke checks"
echo "============================================================"
echo ""

# Python script written to a temp file to avoid heredoc-vs-pipe conflicts.
PY_SCRIPT=$(mktemp /tmp/validate-ports-XXXXXX.py)
cat > "$PY_SCRIPT" << 'EOF'
import sys, json
bad = []
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        s = json.loads(line)
    except Exception:
        continue
    svc = s.get('Service', '')
    if svc == 'traefik':
        continue
    for pub in s.get('Publishers', []):
        if pub.get('PublishedPort', 0) != 0:
            bad.append('{} exposes host port {}'.format(svc, pub['PublishedPort']))
print('\n'.join(bad))
EOF

cleanup() { rm -f "$PY_SCRIPT"; }
trap cleanup EXIT

# ----------------------------------------------------------------------
# CHECK 1: Only traefik publishes host ports
# ----------------------------------------------------------------------
echo "[ CHECK 1 ] Only traefik publishes host ports"
BAD_PORTS=$(docker compose ps --format json 2>/dev/null | python3 "$PY_SCRIPT")
if [ -z "$BAD_PORTS" ]; then
  check_pass "Only traefik publishes host ports"
else
  check_fail "Non-traefik service(s) have host port bindings: $BAD_PORTS"
fi

# ----------------------------------------------------------------------
# CHECK 2: SPA reachable via Traefik on app.localhost
# ----------------------------------------------------------------------
echo "[ CHECK 2 ] SPA reachable (app.localhost -> 200)"
STATUS=$(curl -s -o /dev/null -w '%{http_code}' \
  -H 'Host: app.localhost' http://localhost:8000/ 2>/dev/null)
if [ "$STATUS" = "200" ]; then
  check_pass "app.localhost:8000/ -> HTTP $STATUS"
else
  check_fail "app.localhost:8000/ -> HTTP $STATUS (expected 200)"
fi

# ----------------------------------------------------------------------
# CHECK 3: authentik reachable via Traefik on auth.localhost
# ----------------------------------------------------------------------
echo "[ CHECK 3 ] authentik reachable (auth.localhost -> 200 or 302)"
STATUS=$(curl -s -o /dev/null -w '%{http_code}' \
  -H 'Host: auth.localhost' http://localhost:8000/ 2>/dev/null)
if [ "$STATUS" = "200" ] || [ "$STATUS" = "302" ]; then
  check_pass "auth.localhost:8000/ -> HTTP $STATUS"
else
  check_fail "auth.localhost:8000/ -> HTTP $STATUS (expected 200 or 302)"
fi

# ----------------------------------------------------------------------
# CHECK 4: Dex OIDC discovery endpoint reachable
# ----------------------------------------------------------------------
echo "[ CHECK 4 ] Dex OIDC discovery reachable"
if curl -sf -H 'Host: idp.localhost' \
    http://localhost:8000/dex/.well-known/openid-configuration \
    -o /dev/null 2>/dev/null; then
  check_pass "Dex OIDC discovery reachable (idp.localhost/dex/.well-known/openid-configuration)"
else
  check_fail "Dex OIDC discovery NOT reachable at idp.localhost:8000/dex/.well-known/openid-configuration"
fi

# ----------------------------------------------------------------------
# CHECK 5: authentik OIDC discovery endpoint reachable
# ----------------------------------------------------------------------
echo "[ CHECK 5 ] authentik OIDC discovery reachable"
if curl -sf -H 'Host: auth.localhost' \
    http://localhost:8000/application/o/app/.well-known/openid-configuration \
    -o /dev/null 2>/dev/null; then
  check_pass "authentik OIDC discovery reachable (auth.localhost/application/o/app/.well-known)"
else
  check_fail "authentik OIDC discovery NOT reachable at auth.localhost:8000/application/o/app/.well-known/openid-configuration"
fi

# ----------------------------------------------------------------------
# CHECK 6: GET /api/me with no token -> 401
# ----------------------------------------------------------------------
echo "[ CHECK 6 ] GET /api/me (no token) -> 401"
STATUS=$(curl -s -o /dev/null -w '%{http_code}' \
  -H 'Host: app.localhost' http://localhost:8000/api/me 2>/dev/null)
if [ "$STATUS" = "401" ]; then
  check_pass "GET /api/me (no token) -> HTTP $STATUS"
else
  check_fail "GET /api/me (no token) -> HTTP $STATUS (expected 401)"
fi

# ----------------------------------------------------------------------
# Summary
# ----------------------------------------------------------------------
echo ""
echo "------------------------------------------------------------"
echo "  Infra/curl checks:  PASS=${PASS}  FAIL=${FAIL}"
echo "------------------------------------------------------------"

if [ "$FAIL" -ne 0 ]; then
  echo "  Failed checks:${ERRORS}"
  exit 1
fi

exit 0
