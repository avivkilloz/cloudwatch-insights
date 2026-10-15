"""The backend with a stand-in for AWS, for the browser suites (never shipped:
the image copies `app/` only).

A CloudWatch query now runs on the server and is polled into the session
(PLATFORM_PLAN.md §16.9, D51), so a suite can no longer fake it by answering
the browser's own requests. Run the backend as `uvicorn dev.fake_aws:app`
instead and every environment whose account id starts with "0000" answers
from here; any other account goes to AWS as before, so the suites that mock
in the browser are untouched.

What it answers, all of it deterministic:
- Logs: two log groups, `/fake/api` and `/fake/worker`. A query finishes on
  its third poll with two rows per log group per poll, newest first;
  `#slow` in the query keeps it running (two more rows a poll) until it is
  stopped, and `#fail` fails it.
- OpenSearch: one domain, `fake-domain`, with indices `app-logs` and
  `audit`; a search returns three hits per index, `#fail` fails it.
- MQTT: an in-process broker. Every second `fake/robot-1/telemetry` gets
  `{"seq": n, "temp": ...}`; a message published to any topic reaches every
  fake connection subscribed to a matching filter.
- HTTP APIs: a host ending in `.fake` answers here, with what a suite put
  for that path (`PUT /api/dev/fake-http?path=/orders`, the JSON body) or a
  404. The API table's Fetch used to be faked in the page, but its results
  are stored by the server now (D21), and a reply faked in one tab never
  reached the store or the session's other tabs.
"""

from __future__ import annotations

import datetime
import itertools
import re
import threading
from typing import Any, Optional

from fastapi import Body, Depends, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session
from urllib.parse import urlparse

from app import auth, aws_client, iot_client, mqtt_client, opensearch_client, tools_http_client
from app.db import get_db
from app.main import app  # noqa: F401 - what uvicorn serves

FAKE_PREFIX = "0000"

_real = {
    "list_log_groups": aws_client.list_log_groups,
    "start_query": aws_client.start_query,
    "get_query_results": aws_client.get_query_results,
    "stop_query": aws_client.stop_query,
    "list_domains": opensearch_client.list_domains,
    "list_indices": opensearch_client.list_indices,
    "search": opensearch_client.search,
}

_lock = threading.Lock()
_ids = itertools.count(1)
_queries: dict[str, dict[str, Any]] = {}


def _fake(account_id: str) -> bool:
    return str(account_id).startswith(FAKE_PREFIX)


def list_log_groups(account_id: str, region: str, identity: Any) -> list[dict]:
    if not _fake(account_id):
        return _real["list_log_groups"](account_id, region, identity)
    return [{"name": n, "stored_bytes": 1024, "creation_time": 0} for n in ("/fake/api", "/fake/worker")]


def start_query(
    account_id: str,
    region: str,
    identity: Any,
    log_group_names: list[str],
    query_string: str,
    start_time: int,
    end_time: int,
    limit: Optional[int] = 1000,
) -> str:
    if not _fake(account_id):
        return _real["start_query"](account_id, region, identity, log_group_names, query_string, start_time, end_time, limit)
    if "#fail" in query_string:
        raise RuntimeError("MalformedQueryException: the fake query failed, as asked (#fail).")
    with _lock:
        query_id = f"fake-{next(_ids)}"
        _queries[query_id] = {
            "account": account_id,
            "groups": list(log_group_names),
            "slow": "#slow" in query_string,
            "limit": limit or 1000,
            "polls": 0,
            "stopped": False,
            "stats": _stats_of(query_string),
            "start": start_time,
            "end": end_time,
        }
    return query_id


_STEP_UNITS = {"s": 1, "m": 60, "h": 3600, "d": 86400}


def _stats_of(query: str) -> Optional[dict[str, Any]]:
    """A `stats count(*) [as name] by bin(<step>)` query's shape, which the
    fake answers with a count per bar; None for a query of rows."""
    m = re.search(r"stats\s+count\(\*\)(?:\s+as\s+(\w+))?\s+by\s+bin\((\d+)([smhd])\)", query)
    if not m:
        return None
    return {"name": m.group(1) or "count(*)", "bin": f"{m.group(2)}{m.group(3)}", "step": int(m.group(2)) * _STEP_UNITS[m.group(3)]}


def _stats_rows(q: dict[str, Any]) -> list[list[dict]]:
    """A count per bar over the query's window, the same every run: 1 to 5
    per log group, by the bar's place, and empty bars left out as Logs
    Insights leaves them."""
    stats = q["stats"]
    step = stats["step"]
    rows = []
    for k, t in enumerate(range(q["start"] - q["start"] % step, q["end"] + 1, step)):
        count = (k % 5 + 1) * len(q["groups"]) if k % 7 != 3 else 0
        if not count:
            continue
        stamp = datetime.datetime.fromtimestamp(t, datetime.timezone.utc).strftime("%Y-%m-%d %H:%M:%S.000")
        rows.append([{"field": f"bin({stats['bin']})", "value": stamp}, {"field": stats["name"], "value": str(count)}])
    return rows


def _rows(q: dict[str, Any]) -> list[list[dict]]:
    rows = []
    per_group = 2 * q["polls"]
    for group in q["groups"]:
        for i in range(per_group):
            # Newest first, a second apart, so sorting by @timestamp interleaves
            # the groups; fixed, not the query's own time, so screenshots of
            # two runs compare.
            ts = 3599 - i * 2 - (0 if group.endswith("api") else 1)
            stamp = f"2026-01-01 00:{(ts // 60) % 60:02d}:{ts % 60:02d}.000"
            rows.append(
                [
                    {"field": "@timestamp", "value": stamp},
                    {"field": "@log", "value": f"{q['account']}:{group}"},
                    {"field": "@message", "value": f"{group} message {i + 1}"},
                    {"field": "@ptr", "value": f"{group}#{i}"},
                ]
            )
    return rows[: q["limit"]]


def get_query_results(account_id: str, region: str, identity: Any, query_id: str) -> dict:
    if not _fake(account_id):
        return _real["get_query_results"](account_id, region, identity, query_id)
    with _lock:
        q = _queries[query_id]
        if not q["stopped"]:
            q["polls"] += 1
        status = "Cancelled" if q["stopped"] else "Running" if q["slow"] or q["polls"] < 3 else "Complete"
        rows = _stats_rows(q) if q["stats"] else _rows(q)
        return {"status": status, "results": rows, "statistics": {"recordsMatched": float(len(rows))}}


def stop_query(account_id: str, region: str, identity: Any, query_id: str) -> None:
    if not _fake(account_id):
        return _real["stop_query"](account_id, region, identity, query_id)
    with _lock:
        if query_id in _queries:
            _queries[query_id]["stopped"] = True


def list_domains(account_id: str, region: str, identity: Any) -> list[dict]:
    if not _fake(account_id):
        return _real["list_domains"](account_id, region, identity)
    return [{"domain_name": "fake-domain", "endpoint": "fake-domain.example.invalid", "engine_version": "OpenSearch_2.11"}]


def list_indices(account_id: str, region: str, identity: Any, domain_endpoint: str) -> list[dict]:
    if not _fake(account_id):
        return _real["list_indices"](account_id, region, identity, domain_endpoint)
    return [
        {"index": "app-logs", "docs_count": 1200, "store_size": "1mb"},
        {"index": "audit", "docs_count": 30, "store_size": "10kb"},
    ]


def search(
    account_id: str,
    region: str,
    identity: Any,
    domain_endpoint: str,
    indices: list[str],
    query_string: str,
    start_time: int,
    end_time: int,
    timestamp_field: str = "@timestamp",
    limit: int = 100,
    histogram_interval: Optional[str] = None,
) -> dict:
    if not _fake(account_id):
        return _real["search"](
            account_id, region, identity, domain_endpoint, indices, query_string, start_time, end_time, timestamp_field,
            limit, histogram_interval,
        )
    if "#fail" in query_string:
        raise RuntimeError("search_phase_execution_exception: the fake search failed, as asked (#fail).")
    hits = [
        {
            "_index": index,
            "_id": f"{index}-{i}",
            "_source": {timestamp_field: f"2026-01-01T00:00:0{i}Z", "level": "ERROR" if i == 0 else "INFO", "message": f"{index} hit {i}"},
        }
        for index in indices
        for i in range(3)
    ][:limit]
    buckets = []
    if histogram_interval:
        step = int(histogram_interval[:-1]) * _STEP_UNITS[histogram_interval[-1]]
        for k, t in enumerate(range(start_time - start_time % step, end_time + 1, step)):
            buckets.append({"t": t * 1000, "count": (k % 4) * len(indices)})
    return {"hits": hits, "total": len(hits), "buckets": buckets}


for _name, _fn in [
    ("list_log_groups", list_log_groups),
    ("start_query", start_query),
    ("get_query_results", get_query_results),
    ("stop_query", stop_query),
]:
    setattr(aws_client, _name, _fn)
for _name, _fn in [("list_domains", list_domains), ("list_indices", list_indices), ("search", search)]:
    setattr(opensearch_client, _name, _fn)


# ---------------------------------------------------------------- MQTT


class _FakeConn:
    def __init__(self, deliver) -> None:
        self.deliver = deliver
        self.filters: list[str] = []
        self.open = True

    def subscribe(self, topic: str) -> None:
        self.filters.append(topic)

    def unsubscribe(self, topic: str) -> None:
        self.filters = [f for f in self.filters if f != topic]

    def alive(self) -> bool:
        return self.open

    def error(self) -> Optional[str]:
        return None

    def close(self) -> None:
        self.open = False
        with _lock:
            if self in _conns:
                _conns.remove(self)

    def offer(self, topic: str, payload: bytes) -> None:
        if self.open and any(mqtt_client.matches(f, topic) for f in self.filters):
            self.deliver(topic, payload)


_conns: list[_FakeConn] = []
_real_connect = mqtt_client.connect
_real_publish = iot_client.publish


def _connect(account_id: str, region: str, identity: Any, client_id: str, deliver):
    if not _fake(account_id):
        return _real_connect(account_id, region, identity, client_id, deliver)
    conn = _FakeConn(deliver)
    with _lock:
        _conns.append(conn)
    return conn, f"fake-ats.iot.{region}.amazonaws.com"


def _broadcast(topic: str, payload: bytes) -> None:
    with _lock:
        conns = list(_conns)
    for conn in conns:
        conn.offer(topic, payload)


def _publish(account_id: str, region: str, identity: Any, topic: str, payload: str, qos: int = 0) -> None:
    if not _fake(account_id):
        return _real_publish(account_id, region, identity, topic, payload, qos)
    _broadcast(topic, payload.encode("utf-8"))


def _telemetry() -> None:
    import json
    import time

    for n in itertools.count(1):
        time.sleep(1.0)
        _broadcast("fake/robot-1/telemetry", json.dumps({"seq": n, "temp": 20 + n % 5}).encode())


mqtt_client.connect = _connect
iot_client.publish = _publish
threading.Thread(target=_telemetry, name="fake-mqtt-telemetry", daemon=True).start()



# ---------------------------------------------------------------- HTTP APIs

_replies: dict[str, Any] = {}
_real_send = tools_http_client.send_request


def _send(method: str, url: str, headers=None, body=None, timeout: float = tools_http_client.REQUEST_TIMEOUT_SECONDS) -> dict:
    import json

    parsed = urlparse(url)
    if not (parsed.hostname or "").endswith(".fake"):
        return _real_send(method, url, headers=headers, body=body, timeout=timeout)
    path = parsed.path
    found = next((v for k, v in _replies.items() if path == k or path.endswith(k)), None)
    status, text = (200, "OK") if found is not None else (404, "Not Found")
    return {
        "status_code": status,
        "status_text": text,
        "headers": [{"key": "content-type", "value": "application/json"}],
        "body": json.dumps(found if found is not None else {"message": f"nothing at {path}"}),
        "body_truncated": False,
        "elapsed_ms": 1,
    }


@app.put("/api/dev/fake-http", include_in_schema=False)
def put_fake_reply(path: str, reply: Any = Body(...), _user=Depends(auth.get_current_user)) -> dict:
    """What a `.fake` host answers at `path` from now on."""
    _replies[path] = reply
    return {"path": path}


tools_http_client.send_request = _send



# ---------------------------------------------------------------- results faked in the page


class _StoreResult(BaseModel):
    type: str
    action: str
    session: str
    pane: str
    cursor: Any = None
    clear: list[str] = []
    result: dict[str, Any] = {}


@app.post("/api/dev/store-result", include_in_schema=False)
def store_result(
    payload: _StoreResult,
    request: Request,
    db: Session = Depends(get_db),
    user=Depends(auth.get_current_user),
) -> Optional[dict]:
    """Stores what a suite faked as an action's reply, as the action endpoint
    stores a real one (D21): only the AWS part of an action is faked in the
    page (harness.mockPaneActions); storing it is the server's own code."""
    from app.panes import manifest as pane_manifest
    from app.routers import panes as panes_router

    manifest = pane_manifest.get(payload.type)
    action = next((a for a in manifest.actions if a.id == payload.action), None) if manifest else None
    if action is None:
        return None
    run = panes_router.ActionRun(session=payload.session, pane=payload.pane, cursor=payload.cursor, clear=payload.clear)
    panes_router._unsaved(db, user, manifest, run)  # 409 until the browser's save lands
    return panes_router._store(db, user, manifest, action, run, payload.result, request.headers.get("x-sync-origin"))
