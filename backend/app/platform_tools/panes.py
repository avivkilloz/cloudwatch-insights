"""The pane kinds the platform agent can put in a session, fill in and run.

This is the server's half of `sessions/paneTypes.tsx`: for each kind, which
group flag allows it, which of its session-state keys are inputs (and in what
shape the browser stores them), and how to run it. A run happens here, on the
server, with the same router functions the browser's own requests reach --
same environment checks, same assumed role -- and its results are written into
the pane's own result keys, so they appear in the ordinary pane exactly as if
the user had pressed Run.

The key names and value shapes are the browser's, and have to stay in step
with the pages that read them (InsightsPage, IotPage, TablesPage, BucketsPage,
CognitoPage, and the tools). A kind whose state lives only in the browser's
memory (the MQTT tester, whose connection is the browser's own, and the JWT
tool, which keeps a pasted token out of storage on purpose) is listed with no
inputs: the agent can put one in a session, and name or arrange it, but has
nothing it could fill in there. Leaving them out entirely made the agent tell
a user asking for an MQTT tester that there was no such thing.

Adding a kind is adding an entry to `KINDS`; nothing else here names one.
"""

import asyncio
import base64
import datetime
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import HTTPException
from sqlalchemy.orm import Session

from .. import models, schemas
from ..live_store import tag_set, untag
from ..resolve import user_can_access_environment
from ..routers import buckets, cognito, iot, opensearch, queries, tables


class InputError(Exception):
    """An input or run the agent asked for that can't be done, in a sentence
    it can act on (and pass on)."""


@dataclass(frozen=True)
class RunContext:
    db: Session
    user: models.User
    timezone: Optional[str]


# ---------------------------------------------------------------- inputs


@dataclass(frozen=True)
class Input:
    """One input of a pane: its session-state key, what the agent may put in
    it, and how that is stored. `kind` picks the converter below."""

    key: str
    kind: str
    help: str
    choices: tuple = ()
    minimum: Optional[int] = None
    maximum: Optional[int] = None

    def describe(self) -> dict:
        out: dict[str, Any] = {"key": self.key, "type": _TYPE_NAMES[self.kind], "help": self.help}
        if self.choices:
            out["choices"] = list(self.choices)
        if self.minimum is not None:
            out["min"] = self.minimum
        if self.maximum is not None:
            out["max"] = self.maximum
        return out


_TYPE_NAMES = {
    "text": "string",
    "int": "integer",
    "choice": "one of choices",
    "bool": "boolean",
    "environments": "list of environment ids",
    "environment": "environment id",
    "log_groups": "object: environment id -> list of log group names",
    "opensearch_indices": "list of {environment_id, domain_name, domain_endpoint, indices: [index names]}",
    "headers": "object: header name -> value",
    "credential": "credential name or id (get_context lists the ones the user can use)",
}

MAX_TEXT = 100_000


def _visible_environment(rc: RunContext, value: Any) -> int:
    try:
        environment_id = int(value)
    except (TypeError, ValueError):
        raise InputError(f"'{value}' is not an environment id; environment ids are numbers.") from None
    environment = rc.db.get(models.Environment, environment_id)
    if environment is None or not user_can_access_environment(rc.db, rc.user, environment):
        raise InputError(f"Environment {environment_id} doesn't exist or isn't visible to you.")
    return environment_id


def _usable_credential(rc: RunContext, value: Any) -> Optional[int]:
    """A credential the user's group may use, named or by id, as the id the
    pane stores. Only ever the id: the value stays on the server."""
    from .. import credential_store

    if value in (None, "", 0):
        return None
    query = credential_store.visible(rc.db, rc.user)
    try:
        found = query.filter(models.Credential.id == int(value)).first()
    except (TypeError, ValueError):
        found = query.filter(models.Credential.name == str(value)).first()
    if found is None:
        names = ", ".join(c.name for c in query.order_by(models.Credential.name).limit(20)) or "none"
        raise InputError(f"There's no credential '{value}' this user can use. Theirs: {names}.")
    return found.id


def convert(spec: Input, value: Any, rc: RunContext) -> Any:
    """The agent's value for an input, checked and put into the shape the
    browser stores it in."""
    kind = spec.kind
    if kind == "text":
        if not isinstance(value, str):
            raise InputError(f"{spec.key} must be a string.")
        return value[:MAX_TEXT]
    if kind == "int":
        try:
            number = int(value)
        except (TypeError, ValueError):
            raise InputError(f"{spec.key} must be a whole number.") from None
        if spec.minimum is not None and number < spec.minimum:
            raise InputError(f"{spec.key} must be at least {spec.minimum}.")
        if spec.maximum is not None and number > spec.maximum:
            raise InputError(f"{spec.key} must be at most {spec.maximum}.")
        return number
    if kind == "choice":
        # A number sent as a string ("900") is still the number the choice is.
        if isinstance(value, str) and value.isdigit():
            value = int(value)
        if value not in spec.choices:
            raise InputError(f"{spec.key} must be one of {list(spec.choices)}.")
        return value
    if kind == "bool":
        if not isinstance(value, bool):
            raise InputError(f"{spec.key} must be true or false.")
        return value
    if kind == "environments":
        if not isinstance(value, list):
            raise InputError(f"{spec.key} must be a list of environment ids.")
        return tag_set(sorted({_visible_environment(rc, v) for v in value}))
    if kind == "environment":
        return _visible_environment(rc, value)
    if kind == "log_groups":
        if not isinstance(value, dict):
            raise InputError(f"{spec.key} must map environment ids to lists of log group names.")
        out = {}
        for env, names in value.items():
            if not isinstance(names, list) or not all(isinstance(n, str) for n in names):
                raise InputError(f"{spec.key}: the log groups of environment {env} must be a list of names.")
            out[str(_visible_environment(rc, env))] = tag_set(dict.fromkeys(names))
        return out
    if kind == "opensearch_indices":
        if not isinstance(value, list):
            raise InputError(f"{spec.key} must be a list of {{environment_id, domain_name, domain_endpoint, indices}}.")
        out: dict[str, dict] = {}
        for target in value:
            if not isinstance(target, dict):
                raise InputError(f"Each entry of {spec.key} must be an object.")
            env = str(_visible_environment(rc, target.get("environment_id")))
            domain = target.get("domain_name")
            endpoint = target.get("domain_endpoint")
            indices = target.get("indices")
            if not domain or not endpoint:
                raise InputError(
                    f"{spec.key}: each entry needs a domain_name and its domain_endpoint "
                    "(list_opensearch_domains gives both)."
                )
            if not isinstance(indices, list) or not indices:
                raise InputError(f"{spec.key}: pick at least one index for domain {domain}.")
            out.setdefault(env, {})[domain] = {"domain_endpoint": endpoint, "indices": tag_set(dict.fromkeys(indices))}
        return out
    if kind == "credential":
        return _usable_credential(rc, value)
    if kind == "headers":
        if not isinstance(value, dict):
            raise InputError(f"{spec.key} must be an object of header name -> value.")
        rows = [{"id": i + 1, "key": str(k), "value": str(v)} for i, (k, v) in enumerate(value.items())]
        # The editor always ends in an empty row to type the next header into.
        rows.append({"id": len(rows) + 1, "key": "", "value": ""})
        return rows
    raise InputError(f"Unknown input kind {kind}.")  # a bug here, not the agent's


# ---------------------------------------------------------------- kinds


@dataclass(frozen=True)
class RunResult:
    """What a run leaves in the pane (its result keys, pane-relative) and
    what it tells the agent."""

    writes: dict[str, Any]
    summary: dict[str, Any]


Runner = Callable[[RunContext, dict], Awaitable[RunResult]]
# A pane's last run as rows, in the order its sample listed them.
RowLister = Callable[[dict], list[dict]]
# One of those rows in more detail than a search returns (a second look-up).
Detailer = Callable[[RunContext, dict, dict], Awaitable[dict]]


@dataclass(frozen=True)
class PaneKind:
    type: str
    label: str
    # The UserGroup column that allows this kind -- the same one that shows
    # it in the UI (enabledFor in paneTypes.tsx).
    flag: str
    about: str
    inputs: tuple[Input, ...]
    run: Optional[Runner] = None
    # What run_pane does for this kind, or why it doesn't.
    run_help: str = ""
    # Inputs set together with another: choosing log groups also ticks their
    # environments, as clicking them in the UI does.
    implies: Callable[[dict], dict] = field(default=lambda values: {})
    # What inspect_row can look at: the last run's rows in full (the run's
    # sample cuts long values down), and optionally more of one row than the
    # run fetched. A kind that leaves these out just can't be inspected.
    rows: Optional[RowLister] = None
    detail: Optional[Detailer] = None
    detail_help: str = ""

    def input(self, key: str) -> Optional[Input]:
        return next((i for i in self.inputs if i.key == key), None)

    def describe(self) -> dict:
        return {
            "kind": self.type,
            "label": self.label,
            "about": self.about,
            "inputs": [i.describe() for i in self.inputs],
            "run": self.run_help,
            **({"inspect_row": self.detail_help or "Shows one row of the last run in full."} if self.rows else {}),
        }


# The time presets the query panes offer, in seconds (InsightsPage's select).
PRESETS = (300, 900, 1800, 3600, 10800, 21600, 43200, 86400, 259200, 604800)

_TIME_INPUTS = (
    Input(
        "preset",
        "choice",
        "How far back to search, in seconds, or \"custom\" to use customStart/customEnd.",
        choices=PRESETS + ("custom",),
    ),
    Input("customStart", "text", "Start of a custom range, in the user's local time: \"YYYY-MM-DDTHH:mm\"."),
    Input("customEnd", "text", "End of a custom range, in the user's local time: \"YYYY-MM-DDTHH:mm\"."),
)

# Every run poll's and wait's upper bound: a turn has to end, and an agent
# waiting minutes on one query is an agent the user has given up on.
RUN_TIMEOUT_SECONDS = 90.0
POLL_SECONDS = 2.0


def _zone(rc: RunContext) -> datetime.tzinfo:
    if rc.timezone:
        try:
            return ZoneInfo(rc.timezone)
        except (ZoneInfoNotFoundError, ValueError):
            pass
    return datetime.timezone.utc


def time_range(rc: RunContext, values: dict) -> tuple[int, int]:
    """The run's window in epoch seconds, worked out the way the pane does
    (computeTimeRange): a preset ends now; a custom range is local time in the
    user's own zone, since that's the zone they typed it or read it in."""
    preset = values.get("preset", 900)
    if preset == "custom":
        zone = _zone(rc)
        try:
            start = datetime.datetime.fromisoformat(values.get("customStart") or "").replace(tzinfo=zone)
            end = datetime.datetime.fromisoformat(values.get("customEnd") or "").replace(tzinfo=zone)
        except ValueError:
            raise InputError('A custom range needs customStart and customEnd as "YYYY-MM-DDTHH:mm".') from None
        start_s, end_s = int(start.timestamp()), int(end.timestamp())
    else:
        end_s = int(time.time())
        start_s = end_s - int(preset)
    if end_s <= start_s:
        raise InputError("The end of the time range must be after its start.")
    return start_s, end_s


def _http_error(e: HTTPException) -> InputError:
    return InputError(str(e.detail))


def _ran(values: dict) -> dict:
    """The bookkeeping every run leaves next to its results: when it ran, and
    a new results version (which is what clears the pane's stale "ask about
    these results" thread and its "restored" note)."""
    return {"ranAt": int(time.time() * 1000), "resultsVersion": int(values.get("resultsVersion") or 0) + 1}


# A run's summary is what the model reads, so it is kept to a sample: enough
# rows to answer from or to decide the next query on, not the whole result.
SAMPLE_ROWS = 20
MAX_CELL_CHARS = 300


def _cell(value: Any) -> Any:
    if isinstance(value, str) and len(value) > MAX_CELL_CHARS:
        return value[:MAX_CELL_CHARS] + "…"
    return value


def _sample(rows: list[dict]) -> list[dict]:
    return [{k: _cell(v) for k, v in row.items()} for row in rows[:SAMPLE_ROWS]]


def _field_rows(rows: list[list[dict]]) -> list[dict]:
    # CloudWatch's @ptr is an opaque handle, noise to anyone reading rows.
    return [{f["field"]: f["value"] for f in row if f["field"] != "@ptr"} for row in rows]


async def run_cloudwatch(rc: RunContext, values: dict) -> RunResult:
    selection = values.get("logGroupSelection") or {}
    targets = [
        schemas.QueryTarget(environment_id=int(env), log_group_names=list(names))
        for env, names in selection.items()
        if names
    ]
    if not targets:
        raise InputError("Choose at least one log group first (set logGroupSelection).")
    start, end = time_range(rc, values)
    limit = min(max(int(values.get("limit") or 100), 1), 10000)
    started = await queries.start_queries(
        payload=schemas.StartQueryRequest(
            targets=targets,
            query_string=values.get("queryString") or "",
            start_time=start,
            end_time=end,
            limit=limit,
        ),
        db=rc.db,
        current_user=rc.user,
    )
    # A target that couldn't start is shown the way the pane shows one.
    failed = [
        schemas.QueryResultItem(
            environment_id=q.environment_id,
            environment_name=q.environment_name,
            account_id=q.account_id,
            region=q.region,
            query_id="",
            status="Failed",
            rows=[],
            error=q.error,
        )
        for q in started.queries
        if q.error
    ]
    running = [
        schemas.QueryStatusRequest(environment_id=q.environment_id, query_id=q.query_id)
        for q in started.queries
        if q.query_id
    ]
    items: list[schemas.QueryResultItem] = []
    deadline = time.monotonic() + RUN_TIMEOUT_SECONDS
    while running:
        polled = await queries.get_results(
            payload=schemas.QueryResultsRequest(queries=running), db=rc.db, current_user=rc.user
        )
        items = list(polled.results)
        if polled.all_done:
            break
        if time.monotonic() > deadline:
            await queries.stop_queries(
                payload=schemas.StopQueryRequest(queries=running), db=rc.db, current_user=rc.user
            )
            for item in items:
                if item.status not in queries.TERMINAL_STATUSES:
                    item.status = "Timeout"
                    item.error = (
                        f"Still running after {int(RUN_TIMEOUT_SECONDS)}s, so it was stopped; "
                        "these are the rows it had. Narrow the time range or the query."
                    )
            break
        await asyncio.sleep(POLL_SECONDS)
    results = [r.model_dump() for r in failed + items]
    rows = [row for r in results for row in _field_rows(r["rows"])]
    return RunResult(
        writes={"results": results, "osResults": [], **_ran(values)},
        summary={
            "targets": [
                {
                    "environment": r["environment_name"],
                    "status": r["status"],
                    "rows": len(r["rows"]),
                    **({"error": r["error"]} if r.get("error") else {}),
                }
                for r in results
            ],
            "total_rows": len(rows),
            "sample": _sample(rows),
        },
    )


async def run_opensearch(rc: RunContext, values: dict) -> RunResult:
    selection = values.get("openSearchSelection") or {}
    targets = [
        schemas.OpenSearchTarget(
            environment_id=int(env), domain_name=domain, domain_endpoint=sel["domain_endpoint"], indices=list(sel["indices"])
        )
        for env, domains in selection.items()
        for domain, sel in domains.items()
        if sel.get("indices")
    ]
    if not targets:
        raise InputError("Choose at least one domain and index first (set openSearchSelection).")
    start, end = time_range(rc, values)
    response = await opensearch.search(
        payload=schemas.OpenSearchSearchRequest(
            targets=targets,
            query_string=values.get("queryString") or "",
            start_time=start,
            end_time=end,
            timestamp_field=values.get("timestampField") or "@timestamp",
            limit=min(max(int(values.get("limit") or 100), 1), 1000),
        ),
        db=rc.db,
        current_user=rc.user,
    )
    results = [r.model_dump() for r in response.results]
    rows = [row for r in results for row in _field_rows(r["rows"])]
    return RunResult(
        writes={"osResults": results, "results": [], **_ran(values)},
        summary={
            "targets": [
                {
                    "environment": r["environment_name"],
                    "domain": r["domain_name"],
                    "status": r["status"],
                    "rows": len(r["rows"]),
                    "total_hits": r.get("total_hits"),
                    **({"error": r["error"]} if r.get("error") else {}),
                }
                for r in results
            ],
            "total_rows": len(rows),
            "sample": _sample(rows),
        },
    )


async def run_iot(rc: RunContext, values: dict) -> RunResult:
    environment_ids = list(values.get("selectedEnvironmentIds") or [])
    if not environment_ids:
        raise InputError("Choose at least one environment first (set selectedEnvironmentIds).")
    mode = values.get("searchMode") or "things"
    query_string = values.get("queryString") or ""
    max_results = min(max(int(values.get("maxResults") or 50), 1), 500)
    if mode == "certificates":
        response = await iot.search_certificates(
            payload=schemas.IotCertificateSearchRequest(
                environment_ids=environment_ids, query_string=query_string, max_results=max_results
            ),
            db=rc.db,
            current_user=rc.user,
        )
        results, key, listed = [r.model_dump() for r in response.results], "certResults", "certificates"
    else:
        response = await iot.search_things(
            payload=schemas.IotSearchRequest(
                environment_ids=environment_ids, query_string=query_string or "thingName:*", max_results=max_results
            ),
            db=rc.db,
            current_user=rc.user,
        )
        results, key, listed = [r.model_dump() for r in response.results], "thingResults", "things"
    found = [row for r in results for row in r[listed]]
    return RunResult(
        writes={key: results, **_ran(values)},
        summary={
            "environments": [
                {
                    "environment": r["environment_name"],
                    listed: len(r[listed]),
                    **({"error": r["error"]} if r.get("error") else {}),
                }
                for r in results
            ],
            "total": len(found),
            "sample": _sample(found),
        },
    )


def _query_rows(key: str) -> RowLister:
    """CloudWatch's and OpenSearch's rows, as their runs sampled them."""

    def rows(values: dict) -> list[dict]:
        return [row for r in values.get(key) or [] if isinstance(r, dict) for row in _field_rows(r.get("rows") or [])]

    return rows


def _iot_rows(values: dict) -> list[dict]:
    key, listed = ("certResults", "certificates") if values.get("searchMode") == "certificates" else ("thingResults", "things")
    return [
        {**row, "environment_id": r.get("environment_id"), "environment": r.get("environment_name")}
        for r in values.get(key) or []
        if isinstance(r, dict)
        for row in r.get(listed) or []
    ]


async def _iot_detail(rc: RunContext, values: dict, row: dict) -> dict:
    # A search returns a thing's summary; its shadows, certificates and jobs
    # come only from its own detail -- what the pane shows on expanding a row.
    if values.get("searchMode") == "certificates" or not row.get("thing_name") or row.get("environment_id") is None:
        return row
    detail = await asyncio.to_thread(
        _call,
        iot.get_thing_detail,
        payload=schemas.IotThingDetailRequest(environment_id=int(row["environment_id"]), thing_name=row["thing_name"]),
        db=rc.db,
        current_user=rc.user,
    )
    return {"environment": row.get("environment"), **detail.model_dump()}


def _environment_id(values: dict) -> int:
    environment_id = values.get("environmentId")
    if environment_id in (None, ""):
        raise InputError("Choose an environment first (set environmentId).")
    return int(environment_id)


def _call(fn, **kwargs):
    """A router function that reports failure with an HTTPException (the
    single-environment ones), with its message passed on as-is."""
    try:
        return fn(**kwargs)
    except HTTPException as e:
        raise _http_error(e) from None


async def run_tables(rc: RunContext, values: dict) -> RunResult:
    environment_id = _environment_id(values)
    listed = await asyncio.to_thread(
        _call, tables.list_tables, environment_id=environment_id, db=rc.db, current_user=rc.user
    )
    writes: dict[str, Any] = {"tables": list(listed.tables)}
    table_name = values.get("tableName") or ""
    if not table_name:
        return RunResult(writes=writes, summary={"tables": list(listed.tables)})
    info = await asyncio.to_thread(
        _call,
        tables.describe_table,
        payload=schemas.DynamoTableDescribeRequest(environment_id=environment_id, table_name=table_name),
        db=rc.db,
        current_user=rc.user,
    )
    scanned = await asyncio.to_thread(
        _call,
        tables.scan_table,
        payload=schemas.DynamoScanRequest(
            environment_id=environment_id,
            table_name=table_name,
            query_string=values.get("queryString") or "",
            limit=min(max(int(values.get("limit") or 25), 1), 200),
        ),
        db=rc.db,
        current_user=rc.user,
    )
    writes.update(
        {
            "tableInfo": info.model_dump(),
            "items": scanned.items,
            "lastEvaluatedKey": scanned.last_evaluated_key,
            "scannedCount": scanned.scanned_count,
            "expanded": tag_set([]),
            **_ran(values),
        }
    )
    return RunResult(
        writes=writes,
        summary={
            "table": info.model_dump(),
            "items": len(scanned.items),
            "scanned": scanned.scanned_count,
            "more": scanned.last_evaluated_key is not None,
            "sample": _sample(scanned.items),
        },
    )


async def run_buckets(rc: RunContext, values: dict) -> RunResult:
    environment_id = _environment_id(values)
    listed = await asyncio.to_thread(
        _call, buckets.list_buckets, environment_id=environment_id, db=rc.db, current_user=rc.user
    )
    writes: dict[str, Any] = {"buckets": [b.model_dump() for b in listed.buckets]}
    bucket = values.get("bucket") or ""
    if not bucket:
        return RunResult(writes=writes, summary={"buckets": [b.name for b in listed.buckets]})
    browsed = await asyncio.to_thread(
        _call,
        buckets.browse_bucket,
        payload=schemas.S3BrowseRequest(
            environment_id=environment_id,
            bucket=bucket,
            prefix=values.get("prefix") or "",
            search=values.get("search") or "",
        ),
        db=rc.db,
        current_user=rc.user,
    )
    writes.update(
        {
            "bucket": browsed.bucket,
            "bucketRegion": browsed.bucket_region,
            "prefix": browsed.prefix,
            "activeSearch": values.get("search") or "",
            "folders": [f.model_dump() for f in browsed.folders],
            "files": [f.model_dump() for f in browsed.files],
            "continuationToken": browsed.continuation_token,
            **_ran(values),
        }
    )
    return RunResult(
        writes=writes,
        summary={
            "bucket": browsed.bucket,
            "prefix": browsed.prefix,
            "folders": [f.prefix for f in browsed.folders][:SAMPLE_ROWS],
            "files": len(browsed.files),
            "more": browsed.continuation_token is not None,
            "sample": _sample([f.model_dump() for f in browsed.files]),
        },
    )


async def run_cognito(rc: RunContext, values: dict) -> RunResult:
    environment_id = _environment_id(values)
    pools = await asyncio.to_thread(
        _call, cognito.list_user_pools, environment_id=environment_id, db=rc.db, current_user=rc.user
    )
    writes: dict[str, Any] = {"userPools": [p.model_dump() for p in pools.user_pools]}
    pool_id = values.get("userPoolId") or ""
    if not pool_id:
        return RunResult(writes=writes, summary={"user_pools": [p.model_dump() for p in pools.user_pools]})
    found = await asyncio.to_thread(
        _call,
        cognito.search_users,
        payload=schemas.CognitoUserSearchRequest(
            environment_id=environment_id, user_pool_id=pool_id, query_string=values.get("queryString") or ""
        ),
        db=rc.db,
        current_user=rc.user,
    )
    users = [u.model_dump() for u in found.users]
    writes.update(
        {
            "users": users,
            "paginationToken": found.pagination_token,
            "expanded": tag_set([]),
            **_ran(values),
        }
    )
    return RunResult(
        writes=writes,
        summary={"users": len(users), "more": found.pagination_token is not None, "sample": _sample(users)},
    )


async def run_base64(rc: RunContext, values: dict) -> RunResult:
    # Nothing to store: the pane works its output out from its inputs as it
    # renders. This is only so the agent can read the answer too, computed
    # the way Base64Tool computes it.
    text = values.get("input") or ""
    url_safe = bool(values.get("urlSafe"))
    if (values.get("mode") or "encode") == "encode":
        out = base64.b64encode(text.encode("utf-8")).decode("ascii")
        if url_safe:
            out = out.replace("+", "-").replace("/", "_").rstrip("=")
        return RunResult(writes={}, summary={"output": out})
    normalized = text.strip().replace("-", "+").replace("_", "/")
    try:
        raw = base64.b64decode(normalized + "=" * (-len(normalized) % 4), validate=True)
    except ValueError:
        raise InputError("That doesn't look like valid Base64.") from None
    return RunResult(writes={}, summary={"output": raw.decode("utf-8", errors="replace")})


def _with_log_group_environments(values: dict) -> dict:
    envs = [int(e) for e in (values.get("logGroupSelection") or {})]
    return {"selectedEnvironmentIds": envs} if envs else {}


def _with_opensearch_environments(values: dict) -> dict:
    envs = sorted({int(t["environment_id"]) for t in (values.get("openSearchSelection") or []) if isinstance(t, dict)})
    return {"selectedEnvironmentIds": envs} if envs else {}


_ENVIRONMENTS = Input("selectedEnvironmentIds", "environments", "Which environments to search.")

KINDS: dict[str, PaneKind] = {
    k.type: k
    for k in (
        PaneKind(
            type="logs-cloudwatch",
            label="CloudWatch",
            flag="logs_enabled",
            about="CloudWatch Logs Insights: one query across log groups in several environments, results merged "
            "newest first.",
            inputs=(
                _ENVIRONMENTS,
                Input(
                    "logGroupSelection",
                    "log_groups",
                    "Which log groups to query, per environment (list_log_groups gives the names). Their "
                    "environments are selected with them.",
                ),
                Input("queryString", "text", "The Logs Insights query, in its pipe syntax."),
                Input("limit", "int", "Most rows to return per environment.", minimum=1, maximum=10000),
                *_TIME_INPUTS,
            ),
            run=run_cloudwatch,
            run_help="Runs the query and shows the rows in the pane; you get the row counts and a sample.",
            implies=_with_log_group_environments,
            rows=_query_rows("results"),
        ),
        PaneKind(
            type="logs-opensearch",
            label="OpenSearch",
            flag="opensearch_enabled",
            about="OpenSearch: a Lucene query_string search across domains and indices in several environments.",
            inputs=(
                _ENVIRONMENTS,
                Input(
                    "openSearchSelection",
                    "opensearch_indices",
                    "Which domains and indices to search (list_opensearch_domains and list_opensearch_indices).",
                ),
                Input("queryString", "text", "Lucene query_string syntax, e.g. level:ERROR AND service:checkout."),
                Input("timestampField", "text", "The field the time range applies to (default @timestamp)."),
                Input("limit", "int", "Most hits to return per domain.", minimum=1, maximum=1000),
                *_TIME_INPUTS,
            ),
            run=run_opensearch,
            run_help="Runs the search and shows the hits in the pane; you get the hit counts and a sample.",
            implies=_with_opensearch_environments,
            rows=_query_rows("osResults"),
        ),
        PaneKind(
            type="iot",
            label="IoT",
            flag="iot_enabled",
            about="AWS IoT Core: search things (Fleet Indexing syntax) or certificates across environments.",
            inputs=(
                _ENVIRONMENTS,
                Input("searchMode", "choice", "Search things or certificates.", choices=("things", "certificates")),
                Input(
                    "queryString",
                    "text",
                    "Things: Fleet Indexing syntax, e.g. thingName:robot-* AND connectivity.connected:true. "
                    "Certificates: status:ACTIVE, certid:<id>, or part of a certificate id.",
                ),
                Input("maxResults", "int", "Most results per environment.", minimum=1, maximum=500),
            ),
            run=run_iot,
            run_help="Runs the search and lists the things or certificates in the pane.",
            rows=_iot_rows,
            detail=_iot_detail,
            detail_help="Shows one thing of the last run in full, with its shadows (classic and named), certificates "
            "and jobs.",
        ),
        PaneKind(
            type="tables",
            label="DynamoDB",
            flag="tables_enabled",
            about="DynamoDB: pick a table in one environment and scan it with field:value filters.",
            inputs=(
                Input("environmentId", "environment", "The environment the table is in."),
                Input("tableName", "text", "The table (list_dynamodb_tables gives the names)."),
                Input("queryString", "text", "field:value tokens, ANDed as equality filters; blank for all."),
                Input("limit", "int", "Most items to return.", minimum=1, maximum=200),
            ),
            run=run_tables,
            run_help="Lists the environment's tables, and with a tableName scans it and shows the items.",
        ),
        PaneKind(
            type="buckets",
            label="S3",
            flag="buckets_enabled",
            about="S3: browse a bucket's folders and files in one environment, or search file names under a prefix.",
            inputs=(
                Input("environmentId", "environment", "The environment the bucket is in."),
                Input("bucket", "text", "The bucket (list_s3_buckets gives the names)."),
                Input("prefix", "text", "The folder to open, e.g. logs/2024/ (blank for the top)."),
                Input("search", "text", "Search file names containing this under the prefix, instead of one folder."),
            ),
            run=run_buckets,
            run_help="Lists the environment's buckets, and with a bucket lists its folder or search matches.",
        ),
        PaneKind(
            type="cognito",
            label="Cognito",
            flag="cognito_enabled",
            about="Cognito: search a user pool's users in one environment.",
            inputs=(
                Input("environmentId", "environment", "The environment the user pool is in."),
                Input("userPoolId", "text", "The user pool id (list_cognito_user_pools gives them)."),
                Input("queryString", "text", "One attribute:value, a starts-with match, e.g. email:jane."),
            ),
            run=run_cognito,
            run_help="Lists the environment's user pools, and with a userPoolId searches its users.",
        ),
        PaneKind(
            type="tool-http",
            label="HTTP client",
            flag="tools_enabled",
            about="An HTTP client: method, URL, headers and body, sent from the server.",
            inputs=(
                Input(
                    "method",
                    "choice",
                    "The HTTP method.",
                    choices=("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"),
                ),
                Input("url", "text", "The full URL."),
                Input("headerRows", "headers", "Request headers."),
                Input("body", "text", "The request body (ignored for GET and HEAD)."),
                Input(
                    "credentialId",
                    "credential",
                    "A credential to authenticate with; the server adds it when the request is sent, so its value is "
                    "never in the pane. Only credentials whose type authenticates requests work here.",
                ),
            ),
            run_help="You can fill the request in, but not send it: sending reaches outside the platform, and "
            "needs the user's approval, which isn't available yet. Tell the user to press Send.",
        ),
        PaneKind(
            type="tool-mqtt",
            label="MQTT tester",
            flag="tools_enabled",
            about="An MQTT client on an environment's IoT Core endpoint: subscribe to topics and publish messages.",
            inputs=(),
            run_help="You can add it, but not fill it in or connect it: its environment, topics and connection "
            "live only in the user's browser. Tell the user to pick the environment and press Connect.",
        ),
        PaneKind(
            type="tool-jwt",
            label="JWT",
            flag="tools_enabled",
            about="Decode a JSON Web Token, or build and sign one.",
            inputs=(),
            run_help="You can add it, but not fill it in: a token pasted into it stays in the user's browser, on "
            "purpose, since it's a credential. Tell the user to paste the token into it.",
        ),
        PaneKind(
            type="tool-base64",
            label="Base64",
            flag="tools_enabled",
            about="Base64 encode or decode text; the pane shows the output as soon as its inputs are set.",
            inputs=(
                Input("mode", "choice", "Encode or decode.", choices=("encode", "decode")),
                Input("input", "text", "The text to encode, or the Base64 to decode."),
                Input("urlSafe", "bool", "Use the URL-safe alphabet without padding (encoding)."),
            ),
            run=run_base64,
            run_help="Nothing to run -- the pane shows the output once the inputs are set; run_pane tells you it.",
        ),
        PaneKind(
            type="tool-diff",
            label="Diff",
            flag="tools_enabled",
            about="A text diff; the pane shows the difference as soon as both sides are set.",
            inputs=(
                Input("left", "text", "The original text."),
                Input("right", "text", "The changed text."),
                Input("viewMode", "choice", "How to show it.", choices=("unified", "split", "compact")),
            ),
            run_help="Nothing to run -- the pane shows the diff once left and right are set.",
        ),
    )
}


def available_kinds(user: models.User) -> list[PaneKind]:
    group = user.group
    return [k for k in KINDS.values() if group is not None and getattr(group, k.flag, False)]


def kind_for(user: models.User, type_: str) -> PaneKind:
    kind = KINDS.get(type_)
    if kind is None:
        raise InputError(
            f"There is no pane kind '{type_}' the agent can use. The kinds are: {', '.join(KINDS)}."
        )
    if kind not in available_kinds(user):
        raise InputError(f"Your group doesn't have {kind.label} turned on, so it can't be used here.")
    return kind


def pane_values(state: dict, pane_id: str) -> dict:
    """A pane's keys, without its prefix, as plain values (Sets as lists)."""
    prefix = f"{pane_id}."
    return {k[len(prefix):]: untag(v) for k, v in state.items() if k.startswith(prefix)}
