#!/bin/bash
# health-check.sh — run after deploy or to verify VM state
# Usage: ./scripts/health-check.sh

ERRORS=0
WARNINGS=0

ok()   { echo "✅ $1"; }
fail() { echo "❌ $1"; ERRORS=$((ERRORS+1)); }
warn() { echo "⚠️  $1"; WARNINGS=$((WARNINGS+1)); }

echo "=== Alesa Health Check ==="
echo ""

# 1. Systemd services
for svc in alesa ttyd cloudflared-tunnel; do
  if systemctl is-active --quiet "$svc"; then
    ok "$svc.service running"
  else
    fail "$svc.service not running ($(systemctl is-active $svc))"
  fi
done

echo ""

# 2. Log server
HTTP=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:8080/?t=wrong" --max-time 3 2>/dev/null)
if [ "$HTTP" = "403" ]; then
  ok "Log server :8080 responding"
else
  fail "Log server :8080 not responding (got HTTP $HTTP)"
fi

# 3. Claude CLI
if claude --version >/dev/null 2>&1; then
  ok "claude CLI available"
else
  fail "claude CLI not found or broken"
fi

# 4. Auth token
CREDS="/home/vova/.claude/.credentials.json"
if [ -f "$CREDS" ]; then
  python3 -c "
import json, time, sys
d = json.load(open('$CREDS'))
oauth = d.get('claudeAiOauth', {})
if not oauth.get('accessToken'):
    print('FAIL: no accessToken')
    sys.exit(1)
now = time.time()
access_h = round((oauth.get('expiresAt',0)/1000 - now) / 3600, 1)
refresh_d = round((oauth.get('refreshTokenExpiresAt',0)/1000 - now) / 86400, 1)
if access_h < 0:
    print(f'WARN: access token EXPIRED {-access_h:.1f}h ago, refresh in {refresh_d}d')
elif access_h < 1:
    print(f'WARN: access token expires in {access_h}h, refresh token valid {refresh_d}d')
else:
    print(f'OK: access token valid {access_h}h, refresh token valid {refresh_d}d')
" 2>/dev/null | while read line; do
    case "${line:0:4}" in
      "OK: ") ok "OAuth ${line:4}" ;;
      "WARN") warn "OAuth ${line:5}" ;;
      "FAIL") fail "OAuth ${line:5}" ;;
      *) warn "OAuth parse error" ;;
    esac
  done
else
  fail "Credentials file missing: $CREDS"
fi

echo ""

# 5. tmux sessions
TMUX_COUNT=$(tmux list-sessions 2>/dev/null | wc -l | tr -d ' ')
echo "ℹ️  tmux sessions alive: $TMUX_COUNT"
tmux list-sessions 2>/dev/null | sed 's/^/   /' || true

echo ""

# 6. Sessions persist file
SESS_FILE="/home/vova/alesa-sessions/sessions.json"
if [ -f "$SESS_FILE" ]; then
  SESS_COUNT=$(python3 -c "
import json
d=json.load(open('$SESS_FILE'))
total=sum(len(v) for v in d.values())
print(total)
" 2>/dev/null)
  ok "sessions.json present — $SESS_COUNT session(s) persisted"
else
  warn "sessions.json not found (no sessions persisted yet)"
fi

# 7. Disk space
DISK=$(df -h /home/vova 2>/dev/null | awk 'NR==2{print $5}' | tr -d '%')
if [ -n "$DISK" ] && [ "$DISK" -lt 80 ]; then
  ok "Disk usage: ${DISK}%"
elif [ -n "$DISK" ]; then
  warn "Disk usage high: ${DISK}%"
fi

echo ""
echo "==========================="
if [ $ERRORS -eq 0 ] && [ $WARNINGS -eq 0 ]; then
  echo "✅ All checks passed"
elif [ $ERRORS -eq 0 ]; then
  echo "⚠️  $WARNINGS warning(s), 0 errors"
else
  echo "❌ $ERRORS error(s), $WARNINGS warning(s)"
  exit 1
fi
