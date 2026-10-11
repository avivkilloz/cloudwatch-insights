"""The pane kinds the platform agent can put in a session, fill in and run.

Each kind is generated from its pane manifest (`app/panes/manifests/*.yaml`,
PLATFORM_PLAN.md §15.3): the manifest says which group flag allows it, its
inputs and their types, what running it does and what the agent is told
about it. What only code can say -- the run functions, the converters per
input type, `implies`, the row listers and detail look-ups -- stays here and
is named from the manifest (`HANDLERS`, `IMPLIES`, `ROW_LISTERS`,
`DETAILERS`). This used to be a hand-written copy of every page's keys that
had to move with the pages; now a pane and its agent kind are one file.

A run happens here, on the server, with the same router functions the
browser's own requests reach -- same environment checks, same identity --
and its results are written into the pane's own result keys, so they appear
in the pane exactly as if the user had pressed Run. A pane on the v2 state
shape keeps them under `in.`/`out.` (`input_key`/`output_key`); one not yet
ported keeps its page's own keys.

A kind whose state lives only in the browser (the MQTT tester's connection;
JWT's sensitive inputs) is listed with no inputs: the agent can put one in a
session, and name or arrange it, but has nothing it could fill in there.
Leaving them out entirely made the agent tell a user asking for an MQTT
tester that there was no such thing.
"""

import asyncio
import datetime
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import HTTPException
from sqlalchemy.orm import Session

from .. import connections, models, schemas
from ..panes import live
from ..panes import manifest as pane_manifest
from ..live_store import tag_set, untag
from ..routers import iot, opensearch, queries


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
    connection_type: Optional[str] = None

    def describe(self) -> dict:
        type_name = _TYPE_NAMES[self.kind]
        if self.kind == "connection" and self.connection_type == "aws":
            type_name = _TYPE_NAMES["environment"]
        out: dict[str, Any] = {"key": self.key, "type": type_name, "help": self.help}
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
    "environments": "list of environment ids (get_context's environments)",
    "environment": "environment id (get_context's environments)",
    "log_groups": "object: environment id -> list of log group names",
    "opensearch_indices": "list of {environment_id, domain_name, domain_endpoint, indices: [index names]}",
    "headers": "object: name -> value",
    "credential": "credential name or id (get_context lists the ones the user can use)",
    "connection": "connection id or name (get_context's http_apis)",
}

MAX_TEXT = 100_000


def _visible_environment(rc: RunContext, value: Any) -> int:
    """The id of the AWS connection `value` names, as get_context lists them:
    a connection id, a name ("Prod · iot"), or an environment (by id or name)
    when it holds exactly one AWS connection. With several, it says which to
    pick rather than guessing (D32)."""
    targets = connections.targets(rc.db, rc.user, connections.AWS)
    by_id = {t["id"]: t for t in targets}
    by_env: dict[Any, list[dict]] = {}
    for t in targets:
        by_env.setdefault(t["environment_id"], []).append(t)
        by_env.setdefault(t["environment"].lower(), []).append(t)
    try:
        number: Optional[int] = int(value)
    except (TypeError, ValueError):
        number = None
    if number is not None and number in by_id:
        return number
    if number is None:
        named = [t for t in targets if t["label"].lower() == str(value).strip().lower()]
        if named:
            return named[0]["id"]
    in_env = by_env.get(number if number is not None else str(value).strip().lower())
    if in_env and len(in_env) == 1:
        return in_env[0]["id"]
    if in_env:
        choices = ", ".join(f"{t['label']} (id {t['id']})" for t in in_env)
        raise InputError(f"{in_env[0]['environment']} holds several AWS connections; name one: {choices}.")
    raise InputError(f"Environment {value} doesn't exist or isn't visible to you.")


def _visible_connection(rc: RunContext, value: Any, type_id: str) -> int:
    """A connection of `type_id` the user can reach, by id or by its name as
    get_context lists it ("Partner API", or "Partner API · api")."""
    targets = connections.targets(rc.db, rc.user, type_id)
    for t in targets:
        if str(t["id"]) == str(value).strip() or t["label"].lower() == str(value).strip().lower():
            return t["id"]
    names = ", ".join(f"{t['label']} (id {t['id']})" for t in targets) or "none"
    raise InputError(f"{value} isn't a connection you can use here. Yours are: {names}.")


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
    if kind == "connection":
        # An AWS connection is named the way environments always were (by id,
        # label, or an environment with one AWS connection), so the agent
        # needs nothing new for a pane renamed from environment (D40).
        if spec.connection_type == "aws":
            return _visible_environment(rc, value)
        return _visible_connection(rc, value, spec.connection_type or "")
    if kind == "headers":
        if not isinstance(value, dict):
            raise InputError(f"{spec.key} must be an object of name -> value.")
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
    # Stores in./out. keys (the v2 state shape, PLATFORM_PLAN.md §15.4).
    v2: bool = False
    # What a change to each input clears (its manifest `resets`), as keys
    # relative to the pane, and each view key's default.
    resets: dict[str, tuple[str, ...]] = field(default_factory=dict)
    view_defaults: dict[str, Any] = field(default_factory=dict)

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


def _call(fn, **kwargs):
    """A router function that reports failure with an HTTPException (the
    single-environment ones), with its message passed on as-is."""
    try:
        return fn(**kwargs)
    except HTTPException as e:
        raise _http_error(e) from None


def _with_log_group_environments(values: dict) -> dict:
    envs = [int(e) for e in (values.get("logGroupSelection") or {})]
    return {"selectedEnvironmentIds": envs} if envs else {}


def _with_opensearch_environments(values: dict) -> dict:
    envs = sorted({int(t["environment_id"]) for t in (values.get("openSearchSelection") or []) if isinstance(t, dict)})
    return {"selectedEnvironmentIds": envs} if envs else {}


# What a live run hands the agent is the pane's whole output, which a long
# text makes long: lists are cut to this many items, saying how many there were.
LIVE_SUMMARY_ITEMS = 100


def _capped(outputs: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in outputs.items():
        if isinstance(value, list) and len(value) > LIVE_SUMMARY_ITEMS:
            out[key] = value[:LIVE_SUMMARY_ITEMS]
            out[f"{key}_total"] = len(value)
        else:
            out[key] = value
    return out


def _live_runner(manifest: pane_manifest.Manifest) -> Optional[Runner]:
    """A live pane's run, for the agent: its live functions' Python twins
    (D43), worked out from the inputs as the browser does. Nothing is
    stored -- the pane works its outputs out itself as it draws -- and an
    error output is a failed run, in its own words."""
    names = [a.live for a in manifest.actions if a.live and a.run_on == "change"]
    # A pane whose inputs are all sensitive (JWT's) has nothing the agent
    # could set, so it has no run: run_help says why instead.
    if not names or not manifest.agent_inputs():
        return None
    error_keys = [o.key for o in manifest.outputs if o.render == "error"]

    async def run(rc: RunContext, values: dict) -> RunResult:
        outputs: dict[str, Any] = {}
        for name in names:
            outputs.update(live.FUNCTIONS[name](values))
        for key in error_keys:
            if outputs.get(key):
                raise InputError(str(outputs[key]))
        if not outputs:
            raise InputError("There's nothing to work out yet: set the inputs first.")
        return RunResult(writes={}, summary=_capped(outputs))

    return run


def _rows_at(value: Any, path: str) -> Any:
    for part in [p for p in (path or "").split(".") if p]:
        if isinstance(value, dict) and part in value:
            value = value[part]
        elif isinstance(value, list) and part.isdigit() and int(part) < len(value):
            value = value[int(part)]
        else:
            raise InputError(f"The reply has nothing at {path!r} (stopped at {part!r}).")
    return value


def request_rows(response: Any, rows_at: str) -> list[dict]:
    """The rows of a declarative request's reply: the list at `rows_at`, each
    item a row (a non-object item becomes {"value": item})."""
    listed = _rows_at(response, rows_at)
    if not isinstance(listed, list):
        where = f"at {rows_at!r}" if rows_at else "itself"
        raise InputError(f"The reply {where} isn't a list, so there are no rows; set Rows at to where the list is.")
    return [row if isinstance(row, dict) else {"value": row} for row in listed]


def _request_runner(manifest: pane_manifest.Manifest) -> Optional[Runner]:
    """A declarative HTTP action (§15.7), for the agent: the same request the
    pane's Fetch sends, through routers/panes.run_request -- connection,
    identity, SSRF guard and masking included -- with its rows written into
    the pane."""
    action = next((a for a in manifest.actions if a.request), None)
    if action is None:
        return None
    from ..routers import panes as panes_router  # the router imports this module

    async def run(rc: RunContext, values: dict) -> RunResult:
        try:
            outputs = await asyncio.to_thread(
                panes_router.run_request, rc.db, rc.user, manifest, action, values
            )
        except HTTPException as e:
            raise _http_error(e) from None
        rows = outputs.get("rows") or []
        return RunResult(
            writes={**outputs, **_ran(values)},
            summary={"rows": len(rows), "sample": _sample(rows)},
        )

    return run


def _summary(outputs: dict[str, Any], page: Optional[pane_manifest.Page]) -> dict[str, Any]:
    """What a handler run tells the model: each list's length, a sample of
    the paged one (or the first list), whether there is more, and anything
    small as it is."""
    out: dict[str, Any] = {}
    lists = {k: v for k, v in outputs.items() if isinstance(v, list)}
    for key, value in outputs.items():
        if key in lists:
            out[key] = len(value)
        elif page is None or key != page.cursor:
            out[key] = value
    sampled = next((k for k in (page.append if page else []) if k in lists), next(iter(lists), None))
    if sampled is not None:
        out["sample"] = _sample([r for r in lists[sampled] if isinstance(r, dict)])
    if page is not None:
        out["more"] = outputs.get(page.cursor) is not None
    return out


def _handler_runner(manifest: pane_manifest.Manifest) -> Optional[Runner]:
    """A ported pane's run, for the agent (§16.3.1): what picking its inputs
    in the pane would have run (the on_change actions whose inputs are set --
    DynamoDB's describe), then its main action, through the very function the
    browser's action endpoint calls. A fresh run, never Load more."""
    main = manifest.main_action()
    if manifest.state != "v2" or main is None or main.handler is None:
        return None
    from ..routers import panes as panes_router  # the router imports this module

    before = [
        a for a in manifest.actions if a.handler and a.on_change and a is not main and not _is_loader(manifest, a)
    ]

    async def run(rc: RunContext, values: dict) -> RunResult:
        outputs: dict[str, Any] = {}
        try:
            for action in before:
                if all(values.get(k) not in (None, "", []) for k in action.on_change):
                    outputs.update(
                        await asyncio.to_thread(panes_router.run_handler, rc.db, rc.user, manifest, action, values)
                    )
            found = await asyncio.to_thread(panes_router.run_handler, rc.db, rc.user, manifest, main, values)
        except HTTPException as e:
            raise _http_error(e) from None
        outputs.update(found)
        writes = {**outputs, **_ran(values)}
        for ref in main.resets:
            part, _, key = ref.partition(".")
            if part == "view":
                writes[ref] = next((v.default for v in manifest.views if v.key == key), None)
        return RunResult(writes=writes, summary=_summary(found, main.page))

    return run


def _is_loader(manifest: pane_manifest.Manifest, action: pane_manifest.ManifestAction) -> bool:
    return any(i.options is not None and i.options.action == action.id for i in manifest.inputs)


def _api_rows(values: dict) -> list[dict]:
    return [r for r in values.get("rows") or [] if isinstance(r, dict)]


HANDLERS: dict[str, Runner] = {
    "cloudwatch.run": run_cloudwatch,
    "opensearch.run": run_opensearch,
    "iot.run": run_iot,
}
IMPLIES: dict[str, Callable[[dict], dict]] = {
    "log_group_environments": _with_log_group_environments,
    "opensearch_environments": _with_opensearch_environments,
}
def _rows_of(key: str) -> RowLister:
    """A ported pane's rows as its list output holds them."""

    def rows(values: dict) -> list[dict]:
        return [r for r in values.get(key) or [] if isinstance(r, dict)]

    return rows


ROW_LISTERS: dict[str, RowLister] = {
    "rows.tables": _rows_of("items"),
    "rows.cognito": _rows_of("users"),
    "rows.buckets": _rows_of("files"),
    "rows.results": _query_rows("results"),
    "rows.osResults": _query_rows("osResults"),
    "rows.iot": _iot_rows,
    "rows.api-table": _api_rows,
}
DETAILERS: dict[str, Detailer] = {"detail.iot": _iot_detail}


def _kind(manifest: pane_manifest.Manifest) -> PaneKind:
    run: Optional[Runner] = None
    # A pane still drawn by hand names its agent runner (HANDLERS); a ported
    # one names server actions (panes/handlers.ACTIONS) the browser runs too.
    if manifest.state != "v2":
        for action in manifest.actions:
            if action.handler:
                run = HANDLERS[action.handler]
                break
    run = run or _handler_runner(manifest) or _live_runner(manifest) or _request_runner(manifest)
    inspect = manifest.inspect
    return PaneKind(
        type=manifest.id,
        label=manifest.label,
        flag=manifest.flag,
        about=manifest.about.strip(),
        inputs=tuple(
            Input(
                i.key,
                i.type,
                i.help.strip(),
                choices=tuple(i.choices),
                minimum=i.min,
                maximum=i.max,
                connection_type=i.connection_type,
            )
            for i in manifest.agent_inputs()
        ),
        run=run,
        run_help=manifest.agent.run.strip(),
        implies=IMPLIES[manifest.implies] if manifest.implies else (lambda values: {}),
        rows=ROW_LISTERS[inspect.rows] if inspect else None,
        detail=DETAILERS[inspect.detail] if inspect and inspect.detail else None,
        detail_help=inspect.help.strip() if inspect else "",
        v2=manifest.state == "v2",
        resets={i.key: tuple(i.resets) for i in manifest.inputs if i.resets},
        view_defaults={v.key: v.default for v in manifest.views},
    )


KINDS: dict[str, PaneKind] = {m.id: _kind(m) for m in pane_manifest.manifests().values()}


def input_key(kind: PaneKind, pane_id: str, key: str) -> str:
    """Where an input is stored in session state: under `in.` for a pane on
    the v2 shape, at its own name for one not yet ported."""
    return f"{pane_id}.in.{key}" if kind.v2 else f"{pane_id}.{key}"


def output_key(kind: PaneKind, pane_id: str, key: str) -> str:
    """Where a run's result is stored: under `out.` for a v2 pane. A write
    already naming its part (`view.expanded`, reset by a run) goes there."""
    if kind.v2 and key.startswith(("view.", "in.", "out.")):
        return f"{pane_id}.{key}"
    return f"{pane_id}.out.{key}" if kind.v2 else f"{pane_id}.{key}"


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
    """A pane's keys, without its prefix -- and, for a v2 pane, without the
    in./out./view. part, so a runner reads `values["input"]` whichever shape
    the pane stores -- as plain values (Sets as lists)."""
    prefix = f"{pane_id}."
    out = {}
    for k, v in state.items():
        if not k.startswith(prefix):
            continue
        key = k[len(prefix):]
        for part in ("in.", "out.", "view."):
            if key.startswith(part):
                key = key[len(part):]
                break
        out[key] = untag(v)
    return out
