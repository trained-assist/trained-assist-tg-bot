#!/bin/bash
# run-tests.sh — smoke tests for Alesa infrastructure
set -euo pipefail

PROJECT="alesa-personal-assistent"
ZONE="us-central1-a"
VM="alesa-vm"
SSH="gcloud compute ssh ${VM} --project=${PROJECT} --zone=${ZONE} --command"

PASS=0
FAIL=0

check() {
  local desc="$1"
  local cmd="$2"
  if eval "$cmd" &>/dev/null; then
    echo "✅ $desc"
    PASS=$((PASS + 1))
  else
    echo "❌ $desc"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== Alesa Infrastructure Tests ==="
echo ""

# Local unit tests
echo "--- Unit tests ---"
check "Isolation unit tests" "node $(dirname $0)/isolation.test.js"

echo ""
echo "--- VM connectivity ---"
check "SSH to VM" "$SSH 'echo ok'"

echo ""
echo "--- Systemd services ---"
check "alesa.service running"             "$SSH 'systemctl is-active alesa'"
check "ttyd.service running"              "$SSH 'systemctl is-active ttyd'"
check "cloudflared-tunnel.service running" "$SSH 'systemctl is-active cloudflared-tunnel'"
check "xvfb-vova.service running"         "$SSH 'systemctl is-active xvfb-vova'"
check "xvfb-alesa.service running"        "$SSH 'systemctl is-active xvfb-alesa'"
check "chrome-vova.service running"       "$SSH 'systemctl is-active chrome-vova'"
check "chrome-alesa.service running"      "$SSH 'systemctl is-active chrome-alesa'"

echo ""
echo "--- Files and scripts ---"
check "alesa-login script exists"         "$SSH 'test -x /usr/local/bin/alesa-login'"
check "claude CLI installed"              "$SSH 'which claude'"
check "tmux installed"                    "$SSH 'which tmux'"
check "ffmpeg installed"                  "$SSH 'which ffmpeg'"
check "Xvfb installed"                    "$SSH 'which Xvfb'"
check "google-chrome installed"           "$SSH 'which google-chrome'"

echo ""
echo "--- User directories ---"
check "vova workspace exists"   "$SSH 'test -d /home/vova/users/vova/workspace'"
check "vova CLAUDE.md exists"   "$SSH 'test -f /home/vova/users/vova/CLAUDE.md'"
check "alesa workspace exists"  "$SSH 'test -d /home/vova/users/alesa/workspace'"
check "alesa CLAUDE.md exists"  "$SSH 'test -f /home/vova/users/alesa/CLAUDE.md'"

echo ""
echo "--- Session isolation smoke test ---"
# Create vova session, check it's namespaced correctly
$SSH 'tmux new-session -d -s vova-test-999 2>/dev/null || true' &>/dev/null || true
check "vova tmux session has vova prefix" "$SSH 'tmux ls 2>/dev/null | grep -q vova-'"
# Verify alesa sessions would not be mixed
check "no alesa sessions exist yet"      "$SSH '! tmux ls 2>/dev/null | grep -q alesa-'"
# Cleanup
$SSH 'tmux kill-session -t vova-test-999 2>/dev/null || true' &>/dev/null || true

echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
