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


def summarize_rows(rows: list) -> dict:
    origins = {}
    event_types = {}
    statuses = {}
    fetch_count = 0
    fetch_statuses = {}
    fetch_durations = []
    trace_ids = set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        metadata = row.get("$metadata", {})
        if not isinstance(metadata, dict):
            continue
        service = metadata.get("service") or metadata.get("scriptName")
        if service != WORKER:
            continue
        event_type = metadata.get("type")
        if event_type:
            event_types[event_type] = event_types.get(event_type, 0) + 1
        origin = metadata.get("origin")
        if origin:
            origins[origin] = origins.get(origin, 0) + 1
        trace_id = metadata.get("traceId")
        if trace_id:
            trace_ids.add(trace_id)
        status = metadata.get("statusCode")
        duration = metadata.get("duration")
        if status is not None:
            key = str(status)
            statuses[key] = statuses.get(key, 0) + 1
        if origin == "fetch":
            fetch_count += 1
            if status is not None:
                key = str(status)
                fetch_statuses[key] = fetch_statuses.get(key, 0) + 1
            if isinstance(duration, (int, float)):
                fetch_durations.append(duration)
    return {
        "row_count": len(rows),
        "unique_trace_count": len(trace_ids),
        "event_type_counts": event_types,
        "origin_counts": origins,
        "status_counts": statuses,
        "outbound_fetch_count": fetch_count,
        "outbound_fetch_status_counts": fetch_statuses,
        "outbound_fetch_duration_ms": {
            "count": len(fetch_durations),
            "min": min(fetch_durations) if fetch_durations else None,
            "max": max(fetch_durations) if fetch_durations else None,
            "avg": round(sum(fetch_durations) / len(fetch_durations), 2) if fetch_durations else None,
        },
    }
traces_response = query("traces")
if not traces_response.get("success"):
    print(json.dumps({"errors": traces_response.get("errors", [])}), file=sys.stderr)
    raise SystemExit(1)

trace_items = traces_response.get("result", {}).get("traces", [])
trace_candidate_count = len(trace_items)
trace_service_counts = {}
for trace in trace_items:
    services = trace.get("service", [])
    for service in services if isinstance(services, list) else []:
        trace_service_counts[service] = trace_service_counts.get(service, 0) + 1
trace_items = [
    trace
    for trace in trace_items
    if WORKER in trace.get("service", [])
]
summaries = [
    {
        "root_span": trace.get("rootSpanName"),
        "spans": trace.get("spans"),
        "duration_ms": trace.get("traceDurationMs"),
        "errors": len(trace.get("errors", [])),
    }
    for trace in trace_items
]

invocations_response = query("invocations")
if not invocations_response.get("success"):
    print(json.dumps({"errors": invocations_response.get("errors", [])}), file=sys.stderr)
    raise SystemExit(1)

invocations = invocations_response.get("result", {}).get("invocations", {})

events_response = query("events")
if not events_response.get("success"):
    print(json.dumps({"errors": events_response.get("errors", [])}), file=sys.stderr)
    raise SystemExit(1)
event_rows = events_response.get("result", {}).get("events", {}).get("events", [])
event_summary = summarize_rows(event_rows)
invocation_rows = [
    row
    for invocation_events in invocations.values()
    if isinstance(invocation_events, list)
    for row in invocation_events
]
invocation_summary = summarize_rows(invocation_rows)

print(
    json.dumps(
        {
            "worker": WORKER,
            "worker_trace_settings": (
                read_worker_settings().get("result", {}).get("observability", {}).get("traces", {})
            ),
            "window_hours": 24,
            "trace_count": len(summaries),
            "trace_candidate_count": trace_candidate_count,
            "trace_service_counts": trace_service_counts,
            "traces": summaries[:20],
            "event_sample": event_summary,
            "invocation_sample": invocation_summary,
            "event_sample_limit": 500,
        },
        indent=2,
    )
)
