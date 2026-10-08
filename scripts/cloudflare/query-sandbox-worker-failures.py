#!/usr/bin/env python3
"""Print only allowlisted reconciliation failure fields from sandbox logs."""

import json
import os
import sys
import time
import urllib.error
import urllib.request


ACCOUNT_ID = os.environ["CF_ACCOUNT_ID"]
TOKEN = os.environ["CF_OBSERVABILITY_TOKEN"]
WORKER = os.environ.get("CF_WORKER_NAME", "trained-assist-tg-ux-sandbox")
if WORKER != "trained-assist-tg-ux-sandbox":
    raise SystemExit("This read-only probe is limited to the probability sandbox Worker")

API = (
    "https://api.cloudflare.com/client/v4/accounts/"
    f"{ACCOUNT_ID}/workers/observability/telemetry/query"
)


def failure_record(event):
    metadata = event.get("$metadata") or event.get("metadata") or {}
    source = event.get("source")
    message = metadata.get("message")
    candidates = [source, message]
    parsed = []
    for candidate in candidates:
        if isinstance(candidate, str):
            try:
                candidate = json.loads(candidate)
            except (TypeError, ValueError):
                continue
        if isinstance(candidate, dict):
            parsed.append(candidate)

    log = next((item for item in parsed if item.get("event") == "tg.reconcile.failed"), None)
    if log is None:
        return None
    record = {
        "timestamp": event.get("timestamp") or metadata.get("timestamp"),
        "event": "tg.reconcile.failed",
    }
    for key in ("profileId", "userTaskId", "boundary", "status"):
        value = log.get(key)
        if isinstance(value, (str, int)) and len(str(value)) <= 200:
            record[key] = value
    workers = event.get("$workers") or {}
    version = workers.get("scriptVersion") or {}
    if isinstance(version.get("id"), str):
        record["workerVersionId"] = version["id"]
    if isinstance(version.get("message"), str) and len(version["message"]) <= 160:
        record["workerVersionMessage"] = version["message"]
    return record


def main():
    now = int(time.time() * 1000)
    body = {
        "queryId": f"sandbox-failures-{now}",
        "timeframe": {"from": now - 24 * 60 * 60 * 1000, "to": now},
        "view": "events",
        "dry": True,
        "limit": 500,
        "parameters": {
            "datasets": ["cloudflare-workers"],
            "filters": [{
                "key": "$metadata.service",
                "operation": "eq",
                "type": "string",
                "value": WORKER,
            }],
        },
    }
    request = urllib.request.Request(
        API,
        data=json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            result = json.load(response)
    except urllib.error.HTTPError as error:
        try:
            details = json.load(error)
            messages = [item.get("message", "") for item in details.get("errors", [])]
        except Exception:
            messages = []
        print(json.dumps({"http_status": error.code, "errors": messages}), file=sys.stderr)
        raise SystemExit(1)

    if not result.get("success"):
        print(json.dumps({"errors": result.get("errors", [])}), file=sys.stderr)
        raise SystemExit(1)
    events = result.get("result", {}).get("events", {}).get("events", [])
    failures = [record for event in events if (record := failure_record(event))]
    print(json.dumps({
        "worker": WORKER,
        "windowHours": 24,
        "returnedEventCount": len(events),
        "truncated": result.get("result", {}).get("truncated", False),
        "reconciliationFailures": failures,
    }, indent=2))


if __name__ == "__main__":
    main()
