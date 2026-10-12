#!/usr/bin/env bash
set -euo pipefail

if (($# == 0)); then
  echo "usage: retry-cloudflare-command.sh command [args...]" >&2
  exit 64
fi

log_file="$(mktemp "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/ta-cloudflare-retry.XXXXXX")"
trap 'rm -f "$log_file"' EXIT

stdin_env="${WRANGLER_RETRY_STDIN_ENV:-}"
stdin_value=""
if [[ -n "$stdin_env" ]]; then
  if ! declare -p "$stdin_env" >/dev/null 2>&1; then
    echo "retry_stdin_environment_missing" >&2
    exit 64
  fi
  stdin_value="${!stdin_env}"
fi

for attempt in 1 2 3 4; do
  if [[ -n "$stdin_env" ]]; then
    if printf '%s' "$stdin_value" | "$@" >"$log_file" 2>&1; then
      cat "$log_file"
      exit 0
    else
      status=$?
    fi
  else
    if "$@" >"$log_file" 2>&1; then
      cat "$log_file"
      exit 0
    else
      status=$?
    fi
  fi

  if ! grep -Eiq '(^|[^0-9])(502|503|504|522|523|524)([^0-9]|$)|malformed response from the API' "$log_file"; then
    cat "$log_file" >&2
    exit "$status"
  fi
  if ((attempt == 4)); then
    cat "$log_file" >&2
    exit "$status"
  fi

  delay=$((2 ** (attempt - 1)))
  echo "::warning::Transient Cloudflare API failure; retrying operation (attempt $((attempt + 1))/4) after ${delay}s."
  sleep "$delay"
done
