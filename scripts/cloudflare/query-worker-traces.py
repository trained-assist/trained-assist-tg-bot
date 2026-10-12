#!/usr/bin/env python3
"""Read a short, sanitized summary of one sandbox Worker's recent traces."""

import json
import os
import re
import sys
import time
from datetime import datetime, timezone
import urllib.error
import urllib.request


ACCOUNT_ID = os.environ["CF_ACCOUNT_ID"]
TOKEN = os.environ["CF_OBSERVABILITY_TOKEN"]
WORKER = os.environ.get("CF_WORKER_NAME", "trained-assist-tg-ux-sandbox")
ALLOWED_WORKERS = {
    "trained-assist-tg-ux-sandbox",
    "trained-assist-tg-bot",
}
if WORKER not in ALLOWED_WORKERS:
    raise SystemExit("CF_WORKER_NAME must name an approved sandbox or production Worker")
HEALTH_PROBE_COUNT = 80
VIEW = os.environ.get("CF_QUERY_VIEW", "traces")
if VIEW not in {"traces", "events", "invocations"}:
    raise SystemExit("CF_QUERY_VIEW must be traces, events, or invocations")
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
    window_ms = (60 * 60 * 1000) if view in {"events", "invocations"} else 24 * 60 * 60 * 1000
    filters = [{
        "key": "$metadata.service",
        "operation": "eq",
        "type": "string",
        "value": WORKER,
    }]
    if view == "invocations":
        filters.append({
            "key": "$metadata.trigger",
            "operation": "eq",
            "type": "string",
            "value": "POST /webhook",
        })
    body = {
        "queryId": f"adhoc-{WORKER}-{view}",
        "timeframe": {"from": now - window_ms, "to": now},
        "view": view,
        "dry": True,
        "limit": 500,
        "parameters": {
            "datasets": ["cloudflare-workers"],
            "filters": filters,
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


def belongs_to_worker(trace: dict) -> bool:
    services = trace.get("service", trace.get("services"))
    return services == WORKER or (isinstance(services, list) and WORKER in services)


health_probe_count = 0
if os.environ.get("CF_GENERATE_HEALTH_TRAFFIC") == "true":
    if WORKER != "trained-assist-tg-bot":
        raise SystemExit("health traffic generation is only allowed for the production bot Worker")
    health_url = "https://trained-assist-tg-bot.skillset-apply.workers.dev/health"
    for _ in range(HEALTH_PROBE_COUNT):
        request = urllib.request.Request(
            health_url,
            headers={"User-Agent": "trained-assist-trace-probe/1.0"},
            method="GET",
        )
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                health = json.load(response)
                if response.status != 200 or health.get("status") != "alive":
                    raise SystemExit("production health probe returned an unexpected response")
                health_probe_count += 1
        except urllib.error.HTTPError as error:
            print(json.dumps({"health_probe_http_status": error.code}), file=sys.stderr)
            raise SystemExit(1)
        time.sleep(0.25)


response = query(VIEW)
if not response.get("success"):
    print(json.dumps({"errors": response.get("errors", [])}), file=sys.stderr)
    raise SystemExit(1)

ALLOWED_LIFECYCLE_EVENTS = {
    "tg.dispatch.failed", "tg.cp.snapshot_started", "tg.cp.snapshot_persisted",
    "tg.cp.snapshot_failed", "tg.cp.receipt_read_failed", "tg.cp.intake_failed",
    "tg.cp.receipt_persist_failed", "tg.cp.task_accepted", "tg.cp.route_completed",
    "tg.cp.route_pending", "tg.delivery.accepted", "tg.delivery.rejected",
    "tg.agent.run_finished_received",
}


def event_payload(event):
    metadata = event.get("$metadata") or event.get("metadata") or {}
    source = event.get("source")
    for candidate in (
        source,
        source.get("message") if isinstance(source, dict) else None,
        metadata.get("message"),
    ):
        if isinstance(candidate, str):
            try:
                candidate = json.loads(candidate)
            except (TypeError, ValueError):
                continue
        if isinstance(candidate, dict) and candidate.get("event") in ALLOWED_LIFECYCLE_EVENTS:
            return candidate
    return None


if VIEW == "events":
    # Return only bounded lifecycle metadata. Worker logs may also contain user
    # text and identifiers, so never print a raw event or arbitrary log message.
    event_items = response.get("result", {}).get("events", {}).get("events", [])
    safe_events = []
    json_message_shapes = {}
    log_event_counts = {}
    trigger_counts = {}
    worker_event_type_counts = {}
    metadata_type_counts = {}
    webhook_invocations = []
    recent_route_activity = []
    recent_cutoff_ms = int(time.time() * 1000) - 15 * 60 * 1000
    for item in event_items:
        metadata = item.get("$metadata") or item.get("metadata") or {}
        metadata_type = metadata.get("type")
        if isinstance(metadata_type, str):
            metadata_type_counts[metadata_type] = metadata_type_counts.get(metadata_type, 0) + 1
        trigger = metadata.get("trigger")
        if isinstance(trigger, str):
            match = re.match(r"^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+([^?\s]+)", trigger)
            bucket = f"{match.group(1)} {match.group(2).split('/')[1] if len(match.group(2).split('/')) > 1 else '/'}" if match else "other"
            trigger_counts[bucket] = trigger_counts.get(bucket, 0) + 1
            timestamp = item.get("timestamp")
            route = match.group(2).split("?")[0] if match else ""
            if isinstance(timestamp, (int, float)) and timestamp >= recent_cutoff_ms and route in {
                "/webhook", "/ingest", "/append", "/collector-state", "/debug", "/health",
            }:
                record = {"method": match.group(1), "route": route,
                    "timestamp": datetime.fromtimestamp(timestamp / 1000, timezone.utc).isoformat(),
                    "eventType": (item.get("$workers") or {}).get("eventType")}
                status = metadata.get("statusCode") or metadata.get("httpStatus")
                if isinstance(status, int):
                    record["statusCode"] = status
                recent_route_activity.append(record)
            if match and match.group(1) == "POST" and match.group(2).split("?")[0] == "/webhook":
                workers = item.get("$workers") or {}
                record = {"trigger": "POST /webhook"}
                timestamp = item.get("timestamp")
                if isinstance(timestamp, (int, float)):
                    record["timestamp"] = datetime.fromtimestamp(timestamp / 1000, timezone.utc).isoformat()
                event_type = workers.get("eventType")
                if isinstance(event_type, str):
                    record["eventType"] = event_type
                outcome = workers.get("outcome")
                if isinstance(outcome, str) and len(outcome) <= 80:
                    record["outcome"] = outcome
                duration = metadata.get("duration")
                if isinstance(duration, (int, float)):
                    record["durationMs"] = duration
                status = metadata.get("statusCode") or metadata.get("httpStatus")
                if isinstance(status, int):
                    record["statusCode"] = status
                record["errorPresent"] = bool(metadata.get("error"))
                webhook_invocations.append(record)
        workers = item.get("$workers") or {}
        event_type = workers.get("eventType")
        if isinstance(event_type, str):
            worker_event_type_counts[event_type] = worker_event_type_counts.get(event_type, 0) + 1
        source = item.get("source") if isinstance(item, dict) else None
        message = source.get("message") if isinstance(source, dict) else None
        if not isinstance(message, str):
            continue
        for name in re.findall(r"\b(tg\.[A-Za-z0-9_.:-]{1,90})\b", message):
            log_event_counts[name] = log_event_counts.get(name, 0) + 1
        try:
            parsed = json.loads(message)
        except (TypeError, ValueError):
            shape = "non_json"
        else:
            if isinstance(parsed, dict):
                name = parsed.get("event")
                shape = f"json_event:{name}" if isinstance(name, str) and name.replace(".", "").replace("_", "").isalnum() else "json_object"
            else:
                shape = f"json_{type(parsed).__name__}"
        json_message_shapes[shape] = json_message_shapes.get(shape, 0) + 1
    for item in event_items:
        payload = event_payload(item)
        if payload is None:
            continue
        record = {"event": payload["event"]}
        timestamp = item.get("timestamp") or (item.get("$metadata") or {}).get("timestamp")
        if isinstance(timestamp, (int, float)):
            record["timestamp"] = timestamp
        for key in ("component", "status", "outcome", "reasonCode", "route", "answerPresent", "generation", "attempt"):
            value = payload.get(key)
            if isinstance(value, (str, bool, int)) and len(str(value)) <= 120:
                record[key] = value
        safe_events.append(record)
    print(json.dumps({
        "worker": WORKER,
        "view": "events",
        "window_minutes": 60,
        "returned_event_count": len(event_items),
        "truncated": response.get("result", {}).get("truncated", False),
        "lifecycle_events": safe_events,
        "message_shapes": json_message_shapes,
        "log_event_name_counts": log_event_counts,
        "trigger_counts_by_method_and_first_path_segment": trigger_counts,
        "worker_event_type_counts": worker_event_type_counts,
        "metadata_type_counts": metadata_type_counts,
        "webhook_invocations": webhook_invocations,
        "recent_route_activity": sorted(recent_route_activity, key=lambda record: record["timestamp"])[-100:],
        "worker_log_settings": {
            key: value for key, value in (read_worker_settings().get("result", {}).get("observability", {}).get("logs", {}) or {}).items()
            if key in {"enabled", "persist", "invocation_logs", "head_sampling_rate"}
        },
        "event_shape_sample": [{
            "top_level_keys": sorted(str(key) for key in item.keys()),
            "metadata_keys": sorted(str(key) for key in (item.get("$metadata") or item.get("metadata") or {}).keys()),
            "source_type": type(item.get("source")).__name__,
            "source_keys": sorted(str(key) for key in item.get("source", {}).keys()) if isinstance(item.get("source"), dict) else [],
            "source_nested_keys": {str(key): sorted(str(nested_key) for nested_key in value.keys())
                for key, value in item.get("source", {}).items() if isinstance(value, dict)},
            "message_type": type((item.get("$metadata") or item.get("metadata") or {}).get("message")).__name__,
        } for item in event_items[:3] if isinstance(item, dict)],
    }, indent=2))
    raise SystemExit(0)

if VIEW == "invocations":
    invocations = response.get("result", {}).get("invocations", {})
    summaries = []
    for request_id, invocation_events in invocations.items():
        if not isinstance(invocation_events, list):
            continue
        record = {"trigger": "POST /webhook"}
        times = [event.get("timestamp") for event in invocation_events
                 if isinstance(event, dict) and isinstance(event.get("timestamp"), (int, float))]
        if times:
            record["firstEventAt"] = datetime.fromtimestamp(min(times) / 1000, timezone.utc).isoformat()
        event_types = {}
        lifecycle = []
        for event in invocation_events:
            if not isinstance(event, dict):
                continue
            metadata = event.get("$metadata") or event.get("metadata") or {}
            event_type = metadata.get("type")
            if isinstance(event_type, str):
                event_types[event_type] = event_types.get(event_type, 0) + 1
            payload = event_payload(event)
            if payload:
                safe = {"event": payload["event"]}
                for key in ("component", "status", "outcome", "reasonCode", "route", "answerPresent", "generation", "attempt"):
                    value = payload.get(key)
                    if isinstance(value, (str, bool, int)) and len(str(value)) <= 120:
                        safe[key] = value
                lifecycle.append(safe)
        record["eventTypes"] = event_types
        record["lifecycleEvents"] = lifecycle
        summaries.append(record)
    print(json.dumps({"worker": WORKER, "view": "invocations", "window_minutes": 60,
        "invocation_count": len(summaries), "invocations": summaries}, indent=2))
    raise SystemExit(0)

trace_items = response.get("result", {}).get("traces", [])
if health_probe_count:
    for _ in range(3):
        has_worker_trace = any(belongs_to_worker(trace) for trace in trace_items)
        if has_worker_trace:
            break
        time.sleep(15)
        response = query("traces")
        if not response.get("success"):
            print(json.dumps({"errors": response.get("errors", [])}), file=sys.stderr)
            raise SystemExit(1)
        trace_items = response.get("result", {}).get("traces", [])
trace_candidate_count = len(trace_items)
matching_traces = []
for trace in trace_items:
    if belongs_to_worker(trace):
        matching_traces.append(trace)

if health_probe_count and not matching_traces:
    print(
        json.dumps(
            {
                "worker": WORKER,
                "health_probe_count": health_probe_count,
                "trace_count": 0,
                "error": "No sampled production trace appeared after safe health probes",
            }
        ),
        file=sys.stderr,
    )
    raise SystemExit(1)

root_span_counts = {}
root_span_durations = {}
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
        if root_span:
            root_span_durations.setdefault(root_span, []).append(duration)
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
            "health_probe_count": health_probe_count,
            "trace_count": len(matching_traces),
            "trace_candidate_count": trace_candidate_count,
            "traces_truncated": response.get("result", {}).get("truncated", False),
            "root_span_counts": root_span_counts,
            "root_span_duration_ms": {
                name: {
                    "count": len(values),
                    "min": min(values),
                    "max": max(values),
                    "avg": round(sum(values) / len(values), 2),
                }
                for name, values in sorted(root_span_durations.items())
            },
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
