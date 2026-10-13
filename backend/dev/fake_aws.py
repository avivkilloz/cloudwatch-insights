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
"""

from __future__ import annotations

import itertools
import threading
from typing import Any, Optional

from app import aws_client, opensearch_client
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
        }
    return query_id


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
        return {"status": status, "results": _rows(q), "statistics": {"recordsMatched": float(len(_rows(q)))}}


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
) -> dict:
    if not _fake(account_id):
        return _real["search"](
            account_id, region, identity, domain_endpoint, indices, query_string, start_time, end_time, timestamp_field, limit
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
    return {"hits": hits, "total": len(hits)}


for _name, _fn in [
    ("list_log_groups", list_log_groups),
    ("start_query", start_query),
    ("get_query_results", get_query_results),
    ("stop_query", stop_query),
]:
    setattr(aws_client, _name, _fn)
for _name, _fn in [("list_domains", list_domains), ("list_indices", list_indices), ("search", search)]:
    setattr(opensearch_client, _name, _fn)
