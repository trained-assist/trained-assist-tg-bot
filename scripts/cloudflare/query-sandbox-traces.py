#!/usr/bin/env python3
"""Read a short, sanitized summary of one sandbox Worker's recent traces."""

import json
import os
import sys
import time
import urllib.error
import urllib.request


ACCOUNT_ID = os.environ["CF_ACCOUNT_ID"]
TOKEN = os.environ["CF_OBSERVABILITY_TOKEN"]
WORKER = "trained-assist-tg-ux-sandbox"
API = (
    "https://api.cloudflare.com/client/v4/accounts/"
    f"{ACCOUNT_ID}/workers/observability/telemetry/query"
)
SETTINGS_API = (
    "https://api.cloudflare.com/client/v4/accounts/"
    f"{ACCOUNT_ID}/workers/scripts/{WORKER}/script-settings"
)


def read_worker_settings() -> dict:
    request = urllib.request.Request(
        SETTINGS_API,
        headers={"Authorization": f"Bearer {TOKEN}"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        print(json.dumps({"settings_http_status": error.code}), file=sys.stderr)
        raise SystemExit(1)


def query(view: str) -> dict:
    now = int(time.time() * 1000)
    body = {
        "queryId": f"adhoc-{WORKER}-{view}",
        "timeframe": {"from": now - 24 * 60 * 60 * 1000, "to": now},
        "view": view,
        "dry": True,
        "limit": 500,
        "parameters": {
            "datasets": ["cloudflare-workers"],
            "filters": [
                {
                    "key": "$metadata.service",
                    "operation": "eq",
                    "type": "string",
                    "value": WORKER,
                }
            ],
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
            return json.load(response)
    except urllib.error.HTTPError as error:
        # Do not print request headers or token-bearing data.
        try:
            details = json.load(error)
            messages = [item.get("message", "") for item in details.get("errors", [])]
        except Exception:
            messages = []
        print(json.dumps({"http_status": error.code, "errors": messages}), file=sys.stderr)
        raise SystemExit(1)


traces_response = query("traces")
if not traces_response.get("success"):
    print(json.dumps({"errors": traces_response.get("errors", [])}), file=sys.stderr)
    raise SystemExit(1)

trace_items = traces_response.get("result", {}).get("traces", [])
trace_candidate_count = len(trace_items)
matching_traces = []
for trace in trace_items:
    services = trace.get("service", trace.get("services"))
    if services == WORKER or (isinstance(services, list) and WORKER in services):
        matching_traces.append(trace)

root_span_counts = {}
durations = []
span_counts = []
error_trace_count = 0
error_count = 0
for trace in matching_traces:
    root_span = trace.get("rootSpanName") or trace.get("rootTransactionName")
    if root_span:
        root_span_counts[root_span] = root_span_counts.get(root_span, 0) + 1
    duration = trace.get("traceDurationMs")
    if isinstance(duration, (int, float)):
        durations.append(duration)
    spans = trace.get("spans")
    if isinstance(spans, (int, float)):
        span_counts.append(spans)
    trace_errors = trace.get("errors", [])
    if trace_errors:
        error_trace_count += 1
        error_count += len(trace_errors)

print(
    json.dumps(
        {
            "worker": WORKER,
            "worker_trace_settings": (
                read_worker_settings().get("result", {}).get("observability", {}).get("traces", {})
            ),
            "window_hours": 24,
            "trace_count": len(matching_traces),
            "trace_candidate_count": trace_candidate_count,
            "traces_truncated": traces_response.get("result", {}).get("truncated", False),
            "root_span_counts": root_span_counts,
            "duration_ms": {
                "count": len(durations),
                "min": min(durations) if durations else None,
                "max": max(durations) if durations else None,
                "avg": round(sum(durations) / len(durations), 2) if durations else None,
            },
            "span_count": {
                "count": len(span_counts),
                "min": min(span_counts) if span_counts else None,
                "max": max(span_counts) if span_counts else None,
                "avg": round(sum(span_counts) / len(span_counts), 2) if span_counts else None,
            },
            "error_trace_count": error_trace_count,
            "error_count": error_count,
        },
        indent=2,
    )
)
