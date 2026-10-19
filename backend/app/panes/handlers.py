"""Server actions a manifest names by `handler` (PLATFORM_PLAN.md §16.3.1).

One code path for the browser and the agent: the pane calls
`POST /api/panes/{type}/actions/{action}` (routers/panes.py), the agent's
`run_pane` calls the same function (platform_tools/panes._handler_runner),
and both get the same outputs, keyed by the manifest's output names. Before
this, each pane called its own routes and the agent ran separate functions
that wrote the page's keys -- the drift D5 exists to end.

Each handler takes the pane's inputs (by the manifest's input keys) and, for
a paged action, the cursor its last run returned, and returns outputs. The
group's flag is checked before any handler runs (routers/panes.run_handler);
each handler resolves its connection and identity as the caller, through
`resolve` like everything else. DynamoDB's, Cognito's and S3's per-service
routes, which 3b-1's handlers wrapped, are gone (D49); their bodies are here.

A loader -- what fills a picker's options (D47) -- returns
`{"options": [{"value", "label"}]}`.

Errors are the routes' own `HTTPException`s, with a sentence the user can act
on; a missing input is the manifest's `requires` message, checked before a
handler runs.
"""

import datetime
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Optional

from fastapi import HTTPException
from sqlalchemy.orm import Session

from .. import aws_client, cognito_client, connections, dynamodb_client, iot_client, models, opensearch_client, s3_client, schemas
from ..live_store import untag
from ..resolve import ResolveError, Target, resolve_identity, resolve_target
from . import timewindow

Handler = Callable[[Session, models.User, dict[str, Any], Any], dict[str, Any]]


def _limit(value: Any, default: int, high: int) -> int:
    try:
        return min(max(int(value), 1), high)
    except (TypeError, ValueError):
        return default


# ---------------------------------------------------------------- one connection


def _one(db: Session, user: models.User, inputs: dict[str, Any], key: str = "connection") -> tuple[Target, aws_client.Identity]:
    """The AWS connection an input names, as the caller, and who they are
    there: the same checks (and sentences) the per-service routes made."""
    try:
        target = resolve_target(db, int(inputs[key]), user)
        return target, resolve_identity(db, target, user)
    except (TypeError, ValueError, KeyError):
        raise HTTPException(status_code=400, detail="Choose an environment first.") from None
    except ResolveError as e:
        raise HTTPException(status_code=400, detail=str(e)) from None


def _aws(message: str, call: Callable[[], Any]) -> Any:
    """An AWS call whose failure is a 502 saying what failed, in AWS's words."""
    try:
        return call()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"{message}: {e}") from e


# ---------------------------------------------------------------- DynamoDB


def dynamodb_list_tables(db: Session, user: models.User, inputs: dict[str, Any], _cursor: Any) -> dict[str, Any]:
    t, identity = _one(db, user, inputs)
    listed = _aws("Failed to list tables", lambda: dynamodb_client.list_tables(t.account_id, t.region, identity))
    return {"options": [{"value": name, "label": name} for name in listed]}


def dynamodb_describe(db: Session, user: models.User, inputs: dict[str, Any], _cursor: Any) -> dict[str, Any]:
    t, identity = _one(db, user, inputs)
    name = str(inputs["tableName"])
    info = _aws(
        f"Failed to describe table '{name}'",
        lambda: dynamodb_client.describe_table(t.account_id, t.region, identity, name),
    )
    return {"tableInfo": schemas.DynamoTableInfo(**info).model_dump()}


def dynamodb_scan(db: Session, user: models.User, inputs: dict[str, Any], cursor: Any) -> dict[str, Any]:
    t, identity = _one(db, user, inputs)
    name = str(inputs["tableName"])
    scanned = schemas.DynamoScanResponse(
        **_aws(
            f"Failed to scan table '{name}'",
            lambda: dynamodb_client.scan_items(
                t.account_id,
                t.region,
                identity,
                name,
                str(inputs.get("queryString") or ""),
                _limit(inputs.get("limit"), 25, 200),
                cursor,
            ),
        )
    )
    return {
        "items": scanned.items,
        "lastEvaluatedKey": scanned.last_evaluated_key,
        "scannedCount": scanned.scanned_count,
    }


# ---------------------------------------------------------------- Cognito


def cognito_list_user_pools(db: Session, user: models.User, inputs: dict[str, Any], _cursor: Any) -> dict[str, Any]:
    t, identity = _one(db, user, inputs)
    pools = _aws("Failed to list user pools", lambda: cognito_client.list_user_pools(t.account_id, t.region, identity))
    return {"options": [{"value": p["id"], "label": f"{p.get('name') or p['id']} ({p['id']})"} for p in pools]}


def cognito_search(db: Session, user: models.User, inputs: dict[str, Any], cursor: Any) -> dict[str, Any]:
    t, identity = _one(db, user, inputs)
    pool = str(inputs["userPoolId"])
    request = schemas.CognitoUserSearchRequest(
        environment_id=t.id, user_pool_id=pool, query_string=str(inputs.get("queryString") or ""), pagination_token=cursor
    )
    found = schemas.CognitoUserSearchResponse(
        **_aws(
            f"Failed to search users in pool '{pool}'",
            lambda: cognito_client.search_users(
                t.account_id, t.region, identity, pool, request.query_string, request.limit, request.pagination_token
            ),
        )
    )
    return {"users": [u.model_dump() for u in found.users], "paginationToken": found.pagination_token}


# ---------------------------------------------------------------- S3


def s3_list_buckets(db: Session, user: models.User, inputs: dict[str, Any], _cursor: Any) -> dict[str, Any]:
    t, identity = _one(db, user, inputs)
    listed = _aws("Failed to list buckets", lambda: s3_client.list_buckets(t.account_id, t.region, identity))
    return {"options": [{"value": b["name"], "label": b["name"]} for b in listed]}


def s3_browse(db: Session, user: models.User, inputs: dict[str, Any], cursor: Any) -> dict[str, Any]:
    t, identity = _one(db, user, inputs)
    bucket = str(inputs["bucket"])
    request = schemas.S3BrowseRequest(
        environment_id=t.id,
        bucket=bucket,
        prefix=str(inputs.get("prefix") or ""),
        search=str(inputs.get("search") or ""),
        continuation_token=cursor,
    )
    browsed = schemas.S3BrowseResponse(
        **_aws(
            f"Failed to browse bucket '{bucket}'",
            lambda: s3_client.browse_bucket(
                t.account_id,
                t.region,
                identity,
                bucket,
                request.prefix,
                request.search,
                request.max_results,
                request.continuation_token,
            ),
        )
    )
    # The listing's own prefix and bucket aren't written back: the inputs are
    # the source of truth in v2 (§16.2). What the listing was made with that
    # the inputs may no longer say -- the search typed since -- is an output.
    return {
        "bucketRegion": browsed.bucket_region,
        "activeSearch": request.search,
        "folders": [f.model_dump() for f in browsed.folders],
        "files": [f.model_dump() for f in browsed.files],
        "continuationToken": browsed.continuation_token,
    }


# ---------------------------------------------------------------- fan-out


_executor = ThreadPoolExecutor(max_workers=16)


def connection_ids(value: Any) -> list[int]:
    """A `connections` input as ids: a plain list (v2), or the tagged Set a
    session saved before the port still holds."""
    value = untag(value)
    if not isinstance(value, (list, tuple, set)):
        return []
    out = []
    for v in value:
        try:
            out.append(int(v))
        except (TypeError, ValueError):
            continue
    return sorted(set(out))


def fan_out(
    db: Session,
    user: models.User,
    ids: list[int],
    rows: str,
    run: Callable[[str, str, aws_client.Identity], list[dict]],
) -> list[dict[str, Any]]:
    """One group per AWS connection, `{environment_id, environment_name,
    account_id, region, <rows>: [...], error}` -- the shape every pane that
    searches several environments has always stored (§16.4.1). A connection
    that can't be reached or whose call fails is that group's `error`, never
    the whole run's: partial failures are reported per account.

    Each connection and identity is resolved here, in the request's thread,
    and `run` gets plain strings (account, region) and the identity: the
    database session isn't shared across threads, and a commit while
    resolving (an identity's use is audited) expires the connection row, so
    reading it from a worker would load it there.
    Only the AWS calls run in parallel."""
    groups: list[dict[str, Any]] = []
    pending = []
    for connection_id in ids:
        group: dict[str, Any] = {
            "environment_id": connection_id,
            "environment_name": str(connection_id),
            "account_id": "",
            "region": "",
            rows: [],
            "error": None,
        }
        groups.append(group)
        try:
            target = resolve_target(db, connection_id, user)
            group.update(environment_name=target.name, account_id=target.account_id, region=target.region)
            identity = resolve_identity(db, target, user)
        except ResolveError as e:
            group["error"] = str(e)
            continue
        pending.append((group, _executor.submit(run, group["account_id"], group["region"], identity)))
    for group, future in pending:
        try:
            group[rows] = future.result()
        except Exception as e:  # noqa: BLE001 - one environment's failure is its own row, not the run's
            group["error"] = str(e)
    return groups


def _resolve_each(db: Session, user: models.User, ids: list[int]) -> list[tuple[dict[str, Any], Optional[aws_client.Identity]]]:
    """Each connection as the caller, in this thread: its group's labels, and
    who the caller is there (None, with the group's error, where they can't
    be anyone). What `fan_out` does first, for a handler whose call differs
    per connection (a CloudWatch query's log groups)."""
    out = []
    for connection_id in ids:
        group: dict[str, Any] = {
            "environment_id": connection_id,
            "environment_name": str(connection_id),
            "account_id": "",
            "region": "",
            "error": None,
        }
        identity = None
        try:
            target = resolve_target(db, connection_id, user)
            group.update(environment_name=target.name, account_id=target.account_id, region=target.region)
            identity = resolve_identity(db, target, user)
        except ResolveError as e:
            group["error"] = str(e)
        out.append((group, identity))
    return out


def _parallel(jobs: list[tuple[dict[str, Any], Callable[[], Any]]], key: str) -> None:
    """Runs each job's call in the pool and stores its result in its group
    under `key`, or the group's error -- one environment's failure is its own."""
    pending = [(group, _executor.submit(call)) for group, call in jobs]
    for group, future in pending:
        try:
            group[key] = future.result()
        except Exception as e:  # noqa: BLE001
            group["error"] = str(e)


# ---------------------------------------------------------------- logs (CloudWatch, OpenSearch)

CLOUDWATCH_DONE = {"Complete", "Failed", "Cancelled", "Timeout"}


def _range(inputs: dict[str, Any]) -> tuple[int, int]:
    try:
        return timewindow.window(inputs, inputs.get("_tz"))
    except timewindow.TimeRangeError as e:
        raise HTTPException(status_code=400, detail=str(e)) from None


def _names(value: Any) -> list[str]:
    value = untag(value)
    if isinstance(value, dict):
        value = list(value)
    return [str(v) for v in value] if isinstance(value, (list, tuple, set)) else []


def _log_group_targets(inputs: dict[str, Any]) -> dict[int, list[str]]:
    selection = untag(inputs.get("logGroupSelection")) or {}
    out: dict[int, list[str]] = {}
    for env, names in (selection.items() if isinstance(selection, dict) else []):
        listed = _names(names)
        if listed:
            try:
                out[int(env)] = listed
            except (TypeError, ValueError):
                continue
    return out


def _limit_of(inputs: dict[str, Any], high: int) -> int:
    return _limit(inputs.get("limit"), 100, high)


def logs_list_log_groups(db: Session, user: models.User, inputs: dict[str, Any], _cursor: Any) -> dict[str, Any]:
    """Every log group in each chosen environment: a two-level picker's
    options (D47, in the tab), one group per environment with its own error."""
    groups = fan_out(
        db,
        user,
        connection_ids(inputs.get("connections")),
        "items",
        lambda account, region, identity: [lg["name"] for lg in aws_client.list_log_groups(account, region, identity)],
    )
    return {"groups": groups}


def _histogram_group(group: dict[str, Any], buckets: list[dict[str, int]], error: Optional[str]) -> dict[str, Any]:
    return {
        **{k: group.get(k) for k in ("environment_id", "environment_name", "account_id", "region")},
        "buckets": buckets,
        "error": error,
    }


def _filled(counts: dict[int, int], start: int, end: int, step: int) -> list[dict[str, int]]:
    """A bar for every step of the window, empty ones at 0: neither Logs
    Insights' `bin()` nor a reader can tell a gap from a quiet spell
    otherwise. Bars start on multiples of the step, as `bin()`'s do."""
    first = start - start % step
    return [{"t": t * 1000, "count": counts.get(t * 1000, 0)} for t in range(first, end + 1, step)]


def _histogram(start: int, end: int, step_text: str, groups: list[dict[str, Any]], note: Optional[str] = None) -> dict[str, Any]:
    """The log-volume histogram (D52): a group of bars per target, the
    window and the step, so every target's bars share one time axis."""
    return {"start": start * 1000, "end": end * 1000, "interval": step_text, "groups": groups, "note": note}


def cloudwatch_start(db: Session, user: models.User, inputs: dict[str, Any], _cursor: Any) -> dict[str, Any]:
    """Starts one Logs Insights query per environment with log groups chosen,
    and with Histogram on, a second one counting its matches per bar (D52).
    Returns the handles a background run polls (D51), and a result for every
    environment that couldn't start, so the pane says why at once."""
    targets = _log_group_targets(inputs)
    if not targets:
        raise HTTPException(status_code=400, detail="Select at least one log group to query.")
    start, end = _range(inputs)
    query = str(inputs.get("queryString") or "")
    limit = _limit_of(inputs, 10000)
    step, step_text = timewindow.interval(start, end)
    count: Optional[str] = None
    note: Optional[str] = None
    if inputs.get("histogram"):
        try:
            count = timewindow.count_query(query, step_text)
        except timewindow.NoHistogram as e:
            note = str(e)
    resolved = _resolve_each(db, user, sorted(targets))
    jobs = []
    counting: list[dict[str, Any]] = []
    for group, identity in resolved:
        if identity is None:
            continue
        names = targets[group["environment_id"]]
        jobs.append(
            (
                group,
                lambda g=group, i=identity, n=names: aws_client.start_query(
                    g["account_id"], g["region"], i, n, query, start, end, limit
                ),
            )
        )
        if count is not None:
            # Its own dict: the main query's id and error must not mix with it.
            twin = {k: group[k] for k in ("environment_id", "environment_name", "account_id", "region")}
            twin.update(role="histogram", error=None, step=step, bin=step_text, start=start, end=end)
            counting.append(twin)
            jobs.append(
                (
                    twin,
                    lambda g=group, i=identity, n=names: aws_client.start_query(
                        g["account_id"], g["region"], i, n, count, start, end, 10000
                    ),
                )
            )
    _parallel(jobs, "query_id")
    handles = [{**g, "query_id": g.get("query_id")} for g, _ in resolved] + counting
    failed = [
        {**{k: h[k] for k in ("environment_id", "environment_name", "account_id", "region")},
         "query_id": "", "status": "Failed", "rows": [], "statistics": None, "error": h["error"]}
        for h in handles
        if h.get("role") != "histogram" and (h.get("error") or not h.get("query_id"))
    ]
    out: dict[str, Any] = {"handles": handles, "results": failed}
    if inputs.get("histogram"):
        out["volume"] = _histogram(start, end, step_text, [
            _histogram_group(h, _filled({}, start, end, step), h.get("error")) for h in counting
        ], note)
    else:
        # Off: a histogram from an earlier run mustn't sit over these results.
        out["volume"] = None
    return out


def _rows(data: dict[str, Any]) -> list[list[dict[str, str]]]:
    return [[{"field": f["field"], "value": f["value"]} for f in row] for row in data.get("results") or []]


def _bin_ms(value: str) -> Optional[int]:
    """A `bin()` bucket's time, as Logs Insights writes it ("2026-01-01
    00:05:00.000", UTC), in epoch milliseconds."""
    try:
        parsed = datetime.datetime.strptime(value[:19], "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return None
    return int(parsed.replace(tzinfo=datetime.timezone.utc).timestamp() * 1000)


def _counts(data: dict[str, Any]) -> dict[int, int]:
    counts: dict[int, int] = {}
    for row in data.get("results") or []:
        fields = {f["field"]: f["value"] for f in row}
        bucket = next((v for k, v in fields.items() if k.startswith("bin(")), None)
        t = _bin_ms(bucket) if bucket else None
        if t is not None:
            try:
                counts[t] = counts.get(t, 0) + int(float(fields.get("count") or 0))
            except ValueError:
                continue
    return counts


def cloudwatch_poll(db: Session, user: models.User, inputs: dict[str, Any], _cursor: Any) -> dict[str, Any]:
    """Each running query's results so far, its histogram's bars if it counts
    one, and whether all are finished. Run as whoever started the queries
    (the background run knows who)."""
    handles = [h for h in inputs.get("handles") or [] if isinstance(h, dict)]
    live = [h for h in handles if h.get("query_id") and not h.get("error")]
    resolved = dict(
        (g["environment_id"], (g, i)) for g, i in _resolve_each(db, user, sorted({int(h["environment_id"]) for h in live}))
    )
    results: list[dict[str, Any]] = []
    counted: list[dict[str, Any]] = []
    jobs = []
    for h in handles:
        base = {k: h.get(k) for k in ("environment_id", "environment_name", "account_id", "region")}
        into = counted if h.get("role") == "histogram" else results
        if not (h.get("query_id") and not h.get("error")):
            into.append({**base, "_handle": h, "query_id": "", "status": "Failed", "rows": [], "statistics": None,
                         "error": h.get("error") or "The query didn't start."})
            continue
        group, identity = resolved.get(int(h["environment_id"]), ({}, None))
        item = {**base, "_handle": h, "query_id": h["query_id"], "status": "Running", "rows": [], "statistics": None,
                "error": None}
        into.append(item)
        if identity is None:
            item.update(status="Failed", error=group.get("error") or "You can't reach this environment any more.")
            continue
        jobs.append((item, lambda h=h, i=identity: aws_client.get_query_results(h["account_id"], h["region"], i, h["query_id"])))
    _parallel(jobs, "_data")
    bars: list[dict[str, Any]] = []
    for item in results + counted:
        handle = item.pop("_handle")
        data = item.pop("_data", None)
        if item.get("error") and data is None:
            item["status"] = "Failed"
        elif data is not None:
            item.update(status=data["status"], rows=_rows(data), statistics=data.get("statistics"))
        if handle.get("role") == "histogram":
            counts = _counts(data or {})
            bars.append(_histogram_group(item, _filled(counts, handle["start"], handle["end"], handle["step"]), item["error"]))
    out: dict[str, Any] = {
        "results": results,
        "done": all(r["status"] in CLOUDWATCH_DONE for r in results + counted),
    }
    if counted:
        first = next(h for h in handles if h.get("role") == "histogram")
        out["volume"] = _histogram(first["start"], first["end"], first["bin"], bars)
    return out


def cloudwatch_stop(db: Session, user: models.User, inputs: dict[str, Any], _cursor: Any) -> dict[str, Any]:
    """Stops each query still running; best-effort, as stopping always was."""
    handles = [h for h in inputs.get("handles") or [] if isinstance(h, dict) and h.get("query_id")]
    resolved = dict(
        (g["environment_id"], i) for g, i in _resolve_each(db, user, sorted({int(h["environment_id"]) for h in handles}))
    )
    jobs = []
    for h in handles:
        identity = resolved.get(int(h["environment_id"]))
        if identity is not None:
            jobs.append(({}, lambda h=h, i=identity: aws_client.stop_query(h["account_id"], h["region"], i, h["query_id"])))
    _parallel(jobs, "_stopped")
    return {}


def opensearch_list_domains(db: Session, user: models.User, inputs: dict[str, Any], _cursor: Any) -> dict[str, Any]:
    groups = fan_out(
        db,
        user,
        connection_ids(inputs.get("connections")),
        "items",
        lambda account, region, identity: opensearch_client.list_domains(account, region, identity),
    )
    return {"groups": groups}


def opensearch_list_indices(db: Session, user: models.User, inputs: dict[str, Any], _cursor: Any) -> dict[str, Any]:
    """One domain's indices, for its level of the picker."""
    t, identity = _one(db, user, inputs)
    endpoint = str(inputs.get("domainEndpoint") or "")
    listed = _aws("Failed to list indices", lambda: opensearch_client.list_indices(t.account_id, t.region, identity, endpoint))
    return {"options": [{"value": i["index"], "label": i["index"], "docs_count": i.get("docs_count")} for i in listed]}


def opensearch_search(db: Session, user: models.User, inputs: dict[str, Any], _cursor: Any) -> dict[str, Any]:
    """One Lucene search per chosen domain, its hits as the rows the log list
    draws. A single request each: no start, poll or stop."""
    selection = untag(inputs.get("openSearchSelection")) or {}
    targets: list[tuple[int, str, str, list[str]]] = []
    for env, domains in (selection.items() if isinstance(selection, dict) else []):
        for domain, chosen in (domains or {}).items():
            indices = _names((chosen or {}).get("indices"))
            if indices:
                targets.append((int(env), domain, str(chosen.get("domain_endpoint") or ""), indices))
    if not targets:
        raise HTTPException(status_code=400, detail="Select at least one index to search.")
    start, end = _range(inputs)
    query = str(inputs.get("queryString") or "")
    field = str(inputs.get("timestampField") or "@timestamp")
    # 1000: the most the search asks OpenSearch for (§4.7 found the page offering 10000).
    limit = _limit_of(inputs, 1000)
    step, step_text = timewindow.interval(start, end)
    by_env = {g["environment_id"]: (g, i) for g, i in _resolve_each(db, user, sorted({t[0] for t in targets}))}
    results = []
    jobs = []
    for env, domain, endpoint, indices in targets:
        group, identity = by_env[env]
        item = {
            **{k: group[k] for k in ("environment_id", "environment_name", "account_id", "region")},
            "domain_name": domain, "indices": indices, "status": "Complete", "rows": [], "total_hits": None,
            "error": group["error"],
        }
        results.append(item)
        if identity is None:
            item["status"] = "Failed"
            continue
        jobs.append(
            (item, lambda i=identity, g=group, e=endpoint, x=indices: opensearch_client.search(
                g["account_id"], g["region"], i, e, x, query, start, end, field, limit, step_text))
        )
    _parallel(jobs, "_data")
    bars = []
    several = len({item["environment_id"] for item in results}) < len(results)
    for item in results:
        data = item.pop("_data", None)
        # Always (D52): an aggregation on the same search, so it's free.
        counts = {b["t"]: b["count"] for b in (data or {}).get("buckets") or []}
        bar = _histogram_group(item, _filled(counts, start, end, step), item["error"])
        if several:
            bar["environment_name"] = f"{item['environment_name']} · {item['domain_name']}"
        bars.append(bar)
        if data is None:
            item["status"] = "Failed" if item["error"] else item["status"]
            continue
        item["rows"] = opensearch_client.hits_to_rows(data["hits"], item["domain_name"])
        item["total_hits"] = data.get("total")
    return {"results": results, "volume": _histogram(start, end, step_text, bars)}


# ---------------------------------------------------------------- IoT

IOT_DEFAULT_QUERY = {"things": "thingName:*", "certificates": "status:ACTIVE"}


def iot_search(db: Session, user: models.User, inputs: dict[str, Any], _cursor: Any) -> dict[str, Any]:
    """Things by Fleet Indexing query, or certificates, across the chosen
    connections. Writes both outputs, the other mode's empty, so a pane never
    shows a search that isn't the one it ran."""
    mode = "certificates" if inputs.get("searchMode") == "certificates" else "things"
    query = str(inputs.get("queryString") or "").strip()
    if not query:
        raise HTTPException(status_code=400, detail=f"Enter a search query (e.g. {IOT_DEFAULT_QUERY[mode]}).")
    most = _limit(inputs.get("maxResults"), 50, 500)
    ids = connection_ids(inputs.get("connections"))
    if mode == "certificates":
        found = fan_out(
            db,
            user,
            ids,
            "certificates",
            lambda account, region, identity: [
                schemas.IotCertificateInfo(**c).model_dump()
                for c in iot_client.search_certificates(account, region, identity, query, most)
            ],
        )
        return {"certResults": found, "thingResults": []}
    found = fan_out(
        db,
        user,
        ids,
        "things",
        lambda account, region, identity: [
            schemas.IotThingSummary(**c).model_dump()
            for c in iot_client.search_things(account, region, identity, query, most)
        ],
    )
    return {"thingResults": found, "certResults": []}


def iot_thing_detail(db: Session, user: models.User, inputs: dict[str, Any], _cursor: Any) -> dict[str, Any]:
    """A thing's shadows, certificates (with their policies) and jobs: what
    expanding its row shows, and what inspect_row hands the agent."""
    target, identity = _one(db, user, inputs)
    name = str(inputs["thingName"])
    try:
        detail = iot_client.get_thing_detail(target.account_id, target.region, identity, name)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Failed to load thing '{name}': {e}") from e
    return schemas.IotThingDetail(**detail).model_dump()


def iot_cert_detail(db: Session, user: models.User, inputs: dict[str, Any], _cursor: Any) -> dict[str, Any]:
    """Which things a certificate is attached to (its search row already
    carries its policies)."""
    target, identity = _one(db, user, inputs)
    cert = str(inputs["certificateId"])
    try:
        detail = iot_client.get_certificate_detail(target.account_id, target.region, identity, cert)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Failed to load certificate '{cert}': {e}") from e
    return schemas.IotCertificateDetail(**detail).model_dump()


# ---------------------------------------------------------------- HTTP client

BODYLESS = ("GET", "HEAD")


def _header_rows(value: Any) -> list[schemas.ToolHeader]:
    rows = value if isinstance(value, list) else []
    return [
        schemas.ToolHeader(key=str(r.get("key") or ""), value=str(r.get("value") or ""))
        for r in rows
        if isinstance(r, dict) and str(r.get("key") or "").strip()
    ]


def http_send(db: Session, user: models.User, inputs: dict[str, Any], _cursor: Any) -> dict[str, Any]:
    """The HTTP client's Send, through `/api/tools/http-request`'s own
    function: the SSRF guard, the target's base URL and identity, the
    credential's `inject` and the masking all stay exactly where they were.

    Besides the response it returns the exchange -- the request as sent
    beside its response -- which the pane always offers the agent to attach
    ("why is this a 403?" can't be answered without what was sent). Built
    here, so the joined URL is the server's own; the auth is said by name,
    and nothing secret is in it: the credential's values were applied below
    this, and anything they produced is masked in the reply."""
    from ..routers import tools

    method = str(inputs.get("method") or "GET")
    url = str(inputs.get("url") or "").strip()
    target_id = inputs.get("targetId")
    target_id = int(target_id) if target_id not in (None, "") else None
    credential_id = inputs.get("credentialId")
    credential_id = int(credential_id) if credential_id not in (None, "") else None
    if not url and target_id is None:
        raise HTTPException(status_code=400, detail="Enter a URL.")
    headers = _header_rows(inputs.get("headerRows"))
    body = None if method in BODYLESS else (str(inputs.get("body") or "") or None)
    response = tools.send_http_request(
        payload=schemas.HttpToolRequest(
            method=method, url=url, headers=headers, body=body, credential_id=credential_id, target_id=target_id
        ),
        db=db,
        current_user=user,
    )
    request: dict[str, Any] = {
        "method": method,
        "url": url,
        "headers": [h.model_dump() for h in headers],
        "body": body,
    }
    if target_id is not None:
        target = resolve_target(db, target_id, user, type_id=connections.HTTP_API)
        request["url"] = connections.join_url(target.config["base_url"], url)
        request["target"] = target.name
    if credential_id is not None:
        credential = db.get(models.Credential, credential_id)
        request["auth"] = f'credential "{credential.name}"' if credential else "a credential"
    elif target_id is not None:
        request["auth"] = f"your group's identity on {request['target']}, if it has one"
    exchange = {"request": request, "response": response.model_dump()}
    return {"response": response.model_dump(), "exchange": [exchange]}


# ---------------------------------------------------------------- MQTT (D54)


def _topics(value: Any) -> list[str]:
    return [t.strip() for t in (value if isinstance(value, list) else []) if isinstance(t, str) and t.strip()]


def _doors():
    """The workflow pane's handlers (D97) live with the other doors between
    workflows and sessions; imported when called, as they import a great deal."""
    from .. import workflow_doors

    return workflow_doors


def mqtt_connect(db: Session, user: models.User, inputs: dict[str, Any], _cursor: Any) -> dict[str, Any]:
    """Opens an MQTT connection to the environment's IoT Core endpoint, as
    the caller, subscribed to the pane's topics. A background run (D54)
    polls it; it lives on this replica, under its handle's key."""
    import uuid

    from .. import mqtt_client

    t, identity = _one(db, user, inputs)
    topics = _topics(inputs.get("topics"))
    key = uuid.uuid4().hex
    try:
        sub = mqtt_client.open_subscription(key, t.account_id, t.region, identity, topics)
    except mqtt_client.MqttError as e:
        raise HTTPException(status_code=502, detail=str(e)) from None
    except Exception as e:  # noqa: BLE001 - IoT's own words: no endpoint, no role, no network
        raise HTTPException(status_code=502, detail=f"Couldn't connect to IoT Core: {e}") from None
    handle = {
        "key": key, "connection": t.id, "account_id": t.account_id, "region": t.region,
        "topics": topics, "environment_name": t.name,
    }
    listening = f", listening to {', '.join(topics)}" if topics else "; add a topic to listen to"
    return {"handles": [handle], "status": f"Connected to {sub.endpoint} as {sub.client_id}{listening}."}


def mqtt_poll(db: Session, user: models.User, inputs: dict[str, Any], _cursor: Any) -> dict[str, Any]:
    """What each connection received since the last poll, newest first. A
    connection this replica doesn't hold -- its holder died and this one
    claimed the run -- or one that dropped is opened again, as whoever
    connected (the run's starter), with a fresh presigned URL."""
    from .. import mqtt_client

    messages: list[dict[str, Any]] = []
    out: dict[str, Any] = {"done": False}
    for h in inputs.get("handles") or []:
        sub = mqtt_client.get(h["key"])
        if sub is None or sub.conn is None or not sub.conn.alive():
            lost = sub.conn.error() if sub is not None and sub.conn is not None else None
            if sub is not None:
                messages.extend(sub.drain())
            if mqtt_client.closed(h["key"]):
                continue  # stopped while this poll ran: the tick sees the run stopped
            t, identity = _one(db, user, {"connection": h["connection"]})
            try:
                sub = mqtt_client.open_subscription(
                    h["key"], t.account_id, t.region, identity, h.get("topics") or [], reopen=True
                )
            except Exception as e:  # noqa: BLE001
                raise HTTPException(status_code=502, detail=f"The connection was lost and couldn't be reopened: {e}") from None
            if sub is None:
                continue
            if lost:
                out["status"] = f"Reconnected to {sub.endpoint} as {sub.client_id} ({lost})"
        messages.extend(sub.drain())
    messages.sort(key=lambda m: m["timestamp"], reverse=True)
    out["messages"] = messages
    return out


def mqtt_close(db: Session, user: models.User, inputs: dict[str, Any], _cursor: Any) -> dict[str, Any]:
    from .. import mqtt_client

    for h in inputs.get("handles") or []:
        mqtt_client.close(h["key"])
    # The run's own note says who disconnected it; "Connected to ..." mustn't
    # stay beside it.
    return {"status": None}


def iot_publish(db: Session, user: models.User, inputs: dict[str, Any], _cursor: Any) -> dict[str, Any]:
    """One message through IoT's data plane, as the caller. A person's action
    (`effects: external`): the agent can't publish until approval exists."""
    import time

    topic = str(inputs.get("publishTopic") or "").strip()
    if not topic:
        raise HTTPException(status_code=400, detail="Enter a topic to publish to.")
    if "+" in topic or "#" in topic:
        raise HTTPException(status_code=400, detail="A message is published to one topic: no + or # wildcards.")
    payload = str(inputs.get("payload") or "")
    t, identity = _one(db, user, inputs)
    _aws("Failed to publish", lambda: iot_client.publish(t.account_id, t.region, identity, topic, payload))
    # In UTC and said so: the server's clock zone is nobody's.
    sent = time.strftime("%H:%M:%S UTC", time.gmtime())
    return {"published": f"Published {len(payload.encode())} bytes to {topic} at {sent}."}


ACTIONS: dict[str, Handler] = {
    "aws.dynamodb.list_tables": dynamodb_list_tables,
    "aws.dynamodb.describe": dynamodb_describe,
    "aws.dynamodb.scan": dynamodb_scan,
    "aws.cognito.list_user_pools": cognito_list_user_pools,
    "aws.cognito.search": cognito_search,
    "aws.s3.list_buckets": s3_list_buckets,
    "aws.s3.browse": s3_browse,
    "aws.iot.search": iot_search,
    "aws.iot.thing_detail": iot_thing_detail,
    "aws.iot.cert_detail": iot_cert_detail,
    "http.send": http_send,
    "platform.workflows.list": lambda db, user, inputs, _c: _doors().pane_list(db, user, inputs),
    "platform.workflows.start": lambda db, user, inputs, _c: _doors().pane_start(db, user, inputs),
    "platform.workflows.poll": lambda db, user, inputs, _c: _doors().pane_poll(db, user, inputs),
    "platform.workflows.cancel": lambda db, user, inputs, _c: _doors().pane_cancel(db, user, inputs),
    "aws.logs.list_log_groups": logs_list_log_groups,
    "aws.cloudwatch.start": cloudwatch_start,
    "aws.cloudwatch.poll": cloudwatch_poll,
    "aws.cloudwatch.stop": cloudwatch_stop,
    "aws.opensearch.list_domains": opensearch_list_domains,
    "aws.opensearch.list_indices": opensearch_list_indices,
    "aws.opensearch.search": opensearch_search,
    "aws.iot.mqtt_connect": mqtt_connect,
    "aws.iot.mqtt_poll": mqtt_poll,
    "aws.iot.mqtt_close": mqtt_close,
    "aws.iot.publish": iot_publish,
}


def missing(action_requires: dict[str, str], inputs: dict[str, Any]) -> Optional[str]:
    """The first `requires` message whose input isn't set, if any."""
    for key, message in action_requires.items():
        if inputs.get(key) in (None, "", []):
            return message
    return None
