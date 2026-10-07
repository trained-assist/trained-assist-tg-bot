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


def walk(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)


traces_response = query("traces")
if not traces_response.get("success"):
    print(json.dumps({"errors": traces_response.get("errors", [])}), file=sys.stderr)
    raise SystemExit(1)

trace_items = traces_response.get("result", {}).get("traces", [])
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
fetch_spans = []
for invocation_events in invocations.values():
    for event in invocation_events if isinstance(invocation_events, list) else []:
        for item in walk(event):
            metadata = item.get("$metadata", {})
            service = item.get("service") or metadata.get("service")
            if service != WORKER:
                continue
            span_name = item.get("spanName") or metadata.get("spanName")
            origin = item.get("origin") or metadata.get("origin")
            if origin == "fetch" or (isinstance(span_name, str) and "fetch" in span_name.lower()):
                fetch_spans.append(
                    {
                        "span": span_name or "fetch",
                        "origin": origin,
                        "status_code": item.get("statusCode", metadata.get("statusCode")),
                        "duration_ms": item.get("duration", metadata.get("duration")),
                    }
                )

events_response = query("events")
if not events_response.get("success"):
    print(json.dumps({"errors": events_response.get("errors", [])}), file=sys.stderr)
    raise SystemExit(1)
event_rows = events_response.get("result", {}).get("events", {}).get("events", [])
event_summaries = []
for row in event_rows:
    metadata = row.get("$metadata", {}) if isinstance(row, dict) else {}
    source = row.get("source", {}) if isinstance(row, dict) else {}
    if not isinstance(source, dict):
        source = {}
    service = metadata.get("service") or source.get("service")
    if service != WORKER:
        continue
    span_name = metadata.get("spanName") or source.get("spanName")
    origin = metadata.get("origin") or source.get("origin")
    trace_id = metadata.get("traceId") or source.get("traceId")
    if trace_id or span_name:
        event_summaries.append(
            {
                "span": span_name,
                "origin": origin,
                "has_trace_id": bool(trace_id),
                "status_code": metadata.get("statusCode") or source.get("statusCode"),
                "duration_ms": metadata.get("duration") or source.get("duration"),
            }
        )

print(
    json.dumps(
        {
            "worker": WORKER,
            "worker_trace_settings": (
                read_worker_settings().get("result", {}).get("observability", {}).get("traces", {})
            ),
            "window_hours": 24,
            "trace_count": len(summaries),
            "traces": summaries[:20],
            "event_row_count": len(event_summaries),
            "trace_event_count": len(event_summaries),
            "trace_events": event_summaries[:50],
            "outbound_fetch_span_count": len(fetch_spans),
            "outbound_fetch_spans": fetch_spans[:50],
        },
        indent=2,
    )
)
