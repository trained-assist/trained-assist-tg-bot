#!/bin/bash
# Синхронизирует Claude OAuth токен с локального Mac на VM
# Запускать: ~/Code/alesa-pers-ai-assistant/sync-claude-auth.sh

set -euo pipefail

VM_HOST="alesa-vm"
VM_ZONE="us-central1-a"
VM_PROJECT="alesa-personal-assistent"
VM_USER="vova"
VM_CRED_PATH="/home/vova/.claude/.credentials.json"
KEYCHAIN_SERVICE="Claude Code-credentials"

echo "🔑 Читаю токен из Keychain..."
CRED_JSON=$(security find-generic-password -s "$KEYCHAIN_SERVICE" -w 2>/dev/null) || {
  echo "❌ Токен не найден в Keychain"
  exit 1
}

# Валидация: проверяем что есть claudeAiOauth.accessToken
HAS_TOKEN=$(echo "$CRED_JSON" | python3 -c "
import json, sys
d = json.load(sys.stdin)
tok = d.get('claudeAiOauth', {}).get('accessToken', '')
print('ok' if tok.startswith('sk-ant') else 'empty')
")

if [ "$HAS_TOKEN" != "ok" ]; then
  echo "❌ accessToken не найден или невалиден в Keychain"
  exit 1
fi

echo "✅ Токен найден. Отправляю на VM..."

# Убираем mcpOAuth чтобы не тащить лишнее
CLAUDE_CRED=$(echo "$CRED_JSON" | python3 -c "
import json, sys
d = json.load(sys.stdin)
# Берём только claudeAiOauth — именно это нужно Claude CLI на Linux
out = {'claudeAiOauth': d['claudeAiOauth']}
print(json.dumps(out))
")

# Создаём ~/.claude/ на VM и пишем credentials
echo "$CLAUDE_CRED" | gcloud compute ssh "$VM_HOST" \
  --zone="$VM_ZONE" --project="$VM_PROJECT" \
  --command="mkdir -p /home/$VM_USER/.claude && cat > $VM_CRED_PATH && chmod 600 $VM_CRED_PATH && echo 'Written'" \
  -- -o StrictHostKeyChecking=no

echo "✅ Токен записан на VM: $VM_CRED_PATH"
echo "🔄 Проверяю авторизацию на VM..."

gcloud compute ssh "$VM_HOST" --zone="$VM_ZONE" --project="$VM_PROJECT" \
  --command="claude auth status 2>&1 | head -5"
