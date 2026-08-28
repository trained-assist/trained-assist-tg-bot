#!/bin/bash
# Запускает auth-sync-server + Cloudflare туннель к нему.
# URL туннеля сохраняется в GCP Secret Manager → VM бот читает оттуда.

set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
PORT=7755
PROJECT="alesa-personal-assistent"
SECRET_NAME="AUTH_SYNC_URL"
SYNC_SECRET="${SYNC_SECRET:-alesa-sync-2026}"
LOG_FILE="/tmp/auth-sync.log"
CF_LOG="/tmp/auth-sync-cf.log"

# Kill old instances
pkill -f "auth-sync-server.js" 2>/dev/null || true
pkill -f "cloudflared.*$PORT" 2>/dev/null || true
sleep 1

echo "🚀 Запускаю auth-sync-server на порту $PORT..."
export SYNC_SECRET
node "$DIR/auth-sync-server.js" > "$LOG_FILE" 2>&1 &
SERVER_PID=$!
echo "   PID: $SERVER_PID"
sleep 1

echo "☁️  Поднимаю Cloudflare туннель..."
cloudflared tunnel --url "http://localhost:$PORT" --no-autoupdate > "$CF_LOG" 2>&1 &
CF_PID=$!

# Ждём URL туннеля
echo "⏳ Жду URL туннеля..."
TUNNEL_URL=""
for i in $(seq 1 30); do
  TUNNEL_URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$CF_LOG" 2>/dev/null | head -1 || true)
  [ -n "$TUNNEL_URL" ] && break
  sleep 1
done

if [ -z "$TUNNEL_URL" ]; then
  echo "❌ Не удалось получить URL туннеля"
  kill $CF_PID 2>/dev/null
  exit 1
fi

echo "✅ Туннель: $TUNNEL_URL"

# Сохранить URL в GCP Secret Manager
FULL_URL="${TUNNEL_URL}/sync-auth"
echo "💾 Сохраняю $FULL_URL в Secret Manager..."

# Check if secret exists
if gcloud secrets describe "$SECRET_NAME" --project="$PROJECT" &>/dev/null; then
  echo -n "$FULL_URL" | gcloud secrets versions add "$SECRET_NAME" \
    --project="$PROJECT" --data-file=-
else
  echo -n "$FULL_URL" | gcloud secrets create "$SECRET_NAME" \
    --project="$PROJECT" --data-file=- --replication-policy=automatic
fi

echo "✅ URL сохранён в Secret Manager как '$SECRET_NAME'"
echo ""
echo "🔑 Auth sync готов:"
echo "   Endpoint: $FULL_URL"
echo "   Secret:   $SYNC_SECRET"
echo "   Логи:     $LOG_FILE"
echo "   CF логи:  $CF_LOG"
echo ""
echo "   (Ctrl+C остановит всё)"

# Ждём Ctrl+C
trap "kill $SERVER_PID $CF_PID 2>/dev/null; echo 'Stopped.'" EXIT INT TERM
wait $CF_PID
