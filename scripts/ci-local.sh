#!/usr/bin/env bash
# VM-side CI/CD gate for trained-assist-tg-bot — bypasses GitHub Actions
# (billing-blocked: "job was not started because ... spending limit").
#
# Runs the SAME gate the dead ci.yml would: npm run check + vitest.
# Optionally squash-merges a green+mergeable PR and/or deploys main via wrangler.
#
# Usage:
#   scripts/ci-local.sh <pr-number|branch>          # gate only (dry-run) — DEFAULT
#   scripts/ci-local.sh <pr-number> --merge         # gate, then squash-merge if green+mergeable
#   scripts/ci-local.sh main --deploy               # gate main, then wrangler deploy
#   scripts/ci-local.sh <pr-number> --merge --deploy # full pipeline for one PR
#
# Safe by default: without --merge / --deploy it only reports. Nothing touches
# prod or main unless you pass the flag. Reversible: merge=squash (revertable),
# deploy=wrangler (previous version rollback-able in CF dashboard).
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

REPO="trained-assist/trained-assist-tg-bot"
CF_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-d740a05e9442c1d0feacae2dfc673e93}"
TOKEN="$(git remote get-url origin | sed -E 's#.*x:([^@]+)@.*#\1#')"
API="https://api.github.com/repos/$REPO"

TARGET="${1:?usage: ci-local.sh <pr-number|branch> [--merge] [--deploy]}"
DO_MERGE=false; DO_DEPLOY=false
for a in "${@:2}"; do
  [ "$a" = "--merge" ] && DO_MERGE=true
  [ "$a" = "--deploy" ] && DO_DEPLOY=true
done

api() { curl -s -H "Authorization: Bearer $TOKEN" "$@"; }

# Resolve PR number → branch (and remember it for merge).
PR_NUM=""; BRANCH="$TARGET"
if [[ "$TARGET" =~ ^[0-9]+$ ]]; then
  PR_NUM="$TARGET"
  read -r BRANCH MERGEABLE <<<"$(api "$API/pulls/$PR_NUM" | python3 -c 'import sys,json;p=json.load(sys.stdin);print(p["head"]["ref"], p.get("mergeable"))')"
  echo "PR #$PR_NUM → branch '$BRANCH' (mergeable=$MERGEABLE)"
fi

echo "== fetch + checkout '$BRANCH' =="
git fetch origin "$BRANCH" --quiet || { echo "❌ fetch failed"; exit 1; }
git checkout -q "$BRANCH" && git reset -q --hard "origin/$BRANCH" || { echo "❌ checkout failed"; exit 1; }

echo "== npm ci =="
npm ci --silent || { echo "❌ npm ci failed"; exit 1; }

echo "== gate: npm run check =="
npm run check || { echo "❌ syntax check FAILED — gate red"; exit 2; }

echo "== gate: vitest =="
if npx vitest run; then
  echo "✅ GATE GREEN for '$BRANCH'"
else
  echo "❌ TESTS FAILED — gate red for '$BRANCH'"; exit 2
fi

# --- merge (only PRs, only if green+mergeable) ---
if $DO_MERGE; then
  [ -z "$PR_NUM" ] && { echo "⚠ --merge needs a PR number, got branch '$BRANCH'"; exit 3; }
  if [ "$MERGEABLE" != "True" ]; then
    echo "⚠ PR #$PR_NUM mergeable=$MERGEABLE — has conflicts, NOT merging. Rebase first."; exit 3
  fi
  echo "== squash-merging PR #$PR_NUM =="
  api -X PUT -H "Content-Type: application/json" \
    -d "{\"merge_method\":\"squash\"}" "$API/pulls/$PR_NUM/merge" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(("✅ merged: " if d.get("merged") else "❌ merge failed: ")+str(d.get("message","")))'
fi

# --- deploy (wrangler, from current main) ---
if $DO_DEPLOY; then
  echo "== deploy: checkout main + wrangler =="
  git fetch origin main --quiet && git checkout -q main && git reset -q --hard origin/main
  npm ci --silent
  CLOUDFLARE_ACCOUNT_ID="$CF_ACCOUNT_ID" npx wrangler deploy --env="" || { echo "❌ wrangler deploy failed"; exit 4; }
  echo "== smoke: /health =="
  for i in 1 2 3 4 5 6; do
    S=$(curl -s -o /dev/null -w "%{http_code}" "https://trained-assist-tg-bot.skillset-apply.workers.dev/health" || echo 000)
    echo "  attempt $i: HTTP $S"; [ "$S" = "200" ] && break; sleep 5
  done
  [ "${S:-000}" = "200" ] && echo "✅ deploy live + healthy" || { echo "❌ worker not healthy (HTTP ${S:-000})"; exit 4; }
fi
