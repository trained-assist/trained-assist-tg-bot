#!/bin/bash
# setup.sh — one-shot VM setup for Alesa multi-user system
# Run on the VM: bash ~/alesa-setup/setup.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✅ $*${NC}"; }
warn() { echo -e "${YELLOW}⚠️  $*${NC}"; }
err()  { echo -e "${RED}❌ $*${NC}"; exit 1; }

echo "=== Alesa VM Setup ==="
echo ""

# ── 1. Install packages ────────────────────────────────────────────────────
echo "--- Installing packages ---"
if ! dpkg -s xvfb &>/dev/null; then
  sudo apt-get update -q
  sudo apt-get install -y xvfb
  ok "Xvfb installed"
else
  ok "Xvfb already installed"
fi

if ! command -v google-chrome &>/dev/null; then
  warn "google-chrome not found — installing..."
  curl -fsSL https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o /tmp/chrome.deb
  sudo apt-get install -y /tmp/chrome.deb
  rm /tmp/chrome.deb
  ok "google-chrome installed"
else
  ok "google-chrome already installed: $(google-chrome --version)"
fi

# ── 2. Directory structure ─────────────────────────────────────────────────
echo ""
echo "--- Creating user directories ---"
for dir in \
  /home/vova/users/vova/workspace \
  /home/vova/users/vova/chrome \
  /home/vova/users/alesa/workspace \
  /home/vova/users/alesa/chrome; do
  mkdir -p "$dir"
  ok "mkdir $dir"
done

# ── 3. CLAUDE.md skill files ───────────────────────────────────────────────
echo ""
echo "--- Deploying CLAUDE.md files ---"
cp "${SCRIPT_DIR}/users/vova/CLAUDE.md"  /home/vova/users/vova/CLAUDE.md
cp "${SCRIPT_DIR}/users/alesa/CLAUDE.md" /home/vova/users/alesa/CLAUDE.md
ok "CLAUDE.md deployed for vova and alesa"

# ── 4. Session manager code ────────────────────────────────────────────────
echo ""
echo "--- Deploying session-manager code ---"
DEST=/home/vova/alesa/session-manager
mkdir -p "$DEST/tests"
cp "${SCRIPT_DIR}/../session-manager/users.js"           "$DEST/"
cp "${SCRIPT_DIR}/../session-manager/sessions.js"        "$DEST/"
cp "${SCRIPT_DIR}/../session-manager/index.js"           "$DEST/"
cp "${SCRIPT_DIR}/../session-manager/auth.js"            "$DEST/"
cp "${SCRIPT_DIR}/../session-manager/secrets.js"         "$DEST/"
cp "${SCRIPT_DIR}/../session-manager/package.json"       "$DEST/"
cp "${SCRIPT_DIR}/../session-manager/tests/isolation.test.js" "$DEST/tests/"
cp "${SCRIPT_DIR}/../session-manager/tests/run-tests.sh" "$DEST/tests/"
chmod +x "$DEST/tests/run-tests.sh"
ok "session-manager code deployed to $DEST"

cd "$DEST"
npm install --silent
ok "npm install done"

# ── 5. Systemd services ────────────────────────────────────────────────────
echo ""
echo "--- Installing systemd services ---"
for svc in xvfb-vova xvfb-alesa chrome-vova chrome-alesa; do
  sudo cp "${SCRIPT_DIR}/systemd/${svc}.service" "/etc/systemd/system/${svc}.service"
  ok "copied ${svc}.service"
done

sudo systemctl daemon-reload

for svc in xvfb-vova xvfb-alesa; do
  sudo systemctl enable "$svc" --now
  ok "$svc enabled and started"
done

echo ""
warn "Chrome services NOT auto-started — the Claude-in-Chrome extension must be installed first."
warn "After installing the extension to /home/vova/users/{vova,alesa}/claude-in-chrome/, run:"
warn "  sudo systemctl enable --now chrome-vova chrome-alesa"

# ── 6. Restart alesa.service with new code ─────────────────────────────────
echo ""
echo "--- Restarting alesa.service ---"
sudo systemctl restart alesa
sleep 2
if systemctl is-active alesa &>/dev/null; then
  ok "alesa.service restarted successfully"
else
  err "alesa.service failed to start — check: sudo journalctl -u alesa -n 50"
fi

echo ""
echo "=== Setup complete ==="
echo "Next steps:"
echo "  1. Install Claude-in-Chrome extension packed CRX into:"
echo "       /home/vova/users/vova/claude-in-chrome/"
echo "       /home/vova/users/alesa/claude-in-chrome/"
echo "  2. sudo systemctl enable --now chrome-vova chrome-alesa"
echo "  3. Get Alesa's Telegram chat_id, update /home/vova/alesa/session-manager/users.js"
echo "  4. sudo systemctl restart alesa"
echo "  5. Run tests: bash /home/vova/alesa/session-manager/tests/run-tests.sh"
