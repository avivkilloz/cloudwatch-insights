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
import json
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional

from fastapi import HTTPException
from sqlalchemy.orm import Session

from .. import connections, models, row_paths, schemas
from ..panes import live
from ..panes import manifest as pane_manifest
from ..live_store import tag_set, untag


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
    # Its choices come from a loader: list_options lists them.
    options: bool = False

    def describe(self) -> dict:
        type_name = _TYPE_NAMES[self.kind]
        if self.kind == "connection" and self.connection_type == "aws":
            type_name = _TYPE_NAMES["environment"]
        if self.kind == "connections" and self.connection_type == "aws":
            type_name = _TYPE_NAMES["environments"]
        out: dict[str, Any] = {"key": self.key, "type": type_name, "help": self.help}
        if self.kind in ("connection", "connections") and self.connection_type and self.connection_type != "aws":
            out["connection_type"] = self.connection_type
        if self.choices:
            out["choices"] = list(self.choices)
        if self.minimum is not None:
            out["min"] = self.minimum
        if self.maximum is not None:
            out["max"] = self.maximum
        if self.options:
            out["options"] = "list_options lists them"
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
    "topics": "list of MQTT topic filters (+ one level, # the rest)",
    "headers": "object: name -> value",
    "workflow_params": "object: parameter key -> value (list_workflows gives the workflow's parameters)",
    "credential": "credential name or id (get_context lists the ones the user can use)",
    "connection": "connection id or name (get_context's http_apis, of this input's connection_type)",
    "connections": "list of connection ids or names",
}

MAX_TEXT = 100_000

# A chart over a pane's rows (D53), as set_pane_view takes it.
CHART_TYPES = ("timeseries", "bar", "pie", "stat")
CHART_AGGS = ("count", "sum", "avg", "min", "max")
CHART_HELP = (
    'A chart of the rows: {"type": "timeseries"|"bar"|"pie"|"stat", "x": a field, "y": a field or "count", '
    '"agg": "count"|"sum"|"avg"|"min"|"max", "series": a field (optional)}; null removes it. Fields are the '
    "rows' own column names, as the run returned them."
)


def chart_spec(value: Any) -> Optional[dict[str, Any]]:
    """A chart spec the pane can draw, or why not. Its field names can't be
    checked here -- the columns are whatever the last run returned -- so a
    name with no column is the pane's to say."""
    if value is None:
        return None
    if not isinstance(value, dict):
        raise InputError(CHART_HELP)
    unknown = set(value) - {"type", "x", "y", "agg", "series"}
    if unknown:
        raise InputError(f"A chart has no {', '.join(sorted(unknown))}. {CHART_HELP}")
    type_ = value.get("type")
    if type_ not in CHART_TYPES:
        raise InputError(f"A chart's type is one of {', '.join(CHART_TYPES)}, not {type_!r}.")
    agg = value.get("agg") or "count"
    if agg not in CHART_AGGS:
        raise InputError(f"A chart's agg is one of {', '.join(CHART_AGGS)}, not {agg!r}.")
    y = str(value.get("y") or "count")
    x = value.get("x")
    if type_ != "stat" and not x:
        raise InputError(f"A {type_} chart needs an x field.")
    spec: dict[str, Any] = {"type": type_, "x": str(x or ""), "y": y, "agg": "count" if y == "count" else agg}
    if value.get("series"):
        spec["series"] = str(value["series"])
    return spec


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


def agent_value(spec: Input, stored: Any) -> Any:
    """A stored input in the shape `convert` takes it back in, so what the
    agent reads it can write. The two differ only where the pane keeps rows
    for its editor: a headers input is name -> value to the agent."""
    if spec.kind in ("headers", "workflow_params") and isinstance(stored, list):
        return {str(r.get("key")): r.get("value", "") for r in stored if isinstance(r, dict) and r.get("key")}
    return stored


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
    if kind == "topics":
        if isinstance(value, str):
            value = [value]
        if not isinstance(value, list) or not all(isinstance(t, str) and t.strip() for t in value):
            raise InputError(f"{spec.key} must be a list of MQTT topic filters, e.g. [\"devices/+/telemetry\"].")
        return list(dict.fromkeys(t.strip() for t in value))
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
                    "(list_options on this input gives both)."
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
    if kind == "connections":
        # Stored as a plain list (v2), not the tagged Set the hand-drawn
        # pane kept; the renderer reads either.
        if not isinstance(value, list):
            raise InputError(f"{spec.key} must be a list of environment ids.")
        if spec.connection_type == "aws":
            return sorted({_visible_environment(rc, v) for v in value})
        return sorted({_visible_connection(rc, v, spec.connection_type or "") for v in value})
    if kind == "headers":
        # Taken as the object get_session shows (`agent_value`), or as the
        # rows the pane stores: shown the rows, a model sent `[]` back and was
        # refused, and the turn ended there.
        if value is None or value == []:
            value = {}
        if isinstance(value, list) and all(isinstance(r, dict) for r in value):
            value = {r.get("key", r.get("name")): r.get("value", "") for r in value if r.get("key", r.get("name"))}
        if not isinstance(value, dict):
            raise InputError(f'{spec.key} must be an object of name -> value, e.g. {{"page": "2"}} ({{}} for none).')
        rows = [{"id": i + 1, "key": str(k), "value": str(v)} for i, (k, v) in enumerate(value.items())]
        # The editor always ends in an empty row to type the next header into.
        rows.append({"id": len(rows) + 1, "key": "", "value": ""})
        return rows
    if kind == "workflow_params":
        # Checked when the run starts (workflows.coerce_params), against the
        # workflow chosen then -- not here, where the workflow may change next.
        if value is None or value == []:
            return {}
        if isinstance(value, list) and all(isinstance(r, dict) for r in value):
            value = {r.get("key"): r.get("value") for r in value if r.get("key")}
        if not isinstance(value, dict):
            raise InputError(f'{spec.key} must be an object of parameter key -> value, e.g. {{"env": "Prod"}}.')
        return {str(k): v for k, v in value.items()}
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
    # The old group switch that covered it (D65): only informational now --
    # access is the group's grant of this kind's type (pane_access.py).
    flag: Optional[str]
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
    # A view key's kind where its value has a shape to check ("chart", D53).
    view_kinds: dict[str, str] = field(default_factory=dict)
    # What choosing a value of an input sets besides (its manifest
    # `choice_sets`): input -> value -> {other input: value}.
    choice_sets: dict[str, dict[Any, dict[str, Any]]] = field(default_factory=dict)
    # An input's name before its port, where that differs (D40): old -> new.
    aliases: dict[str, str] = field(default_factory=dict)
    # Its main action runs in the background, polled by the server into the
    # pane (D51): run_pane starts it there and waits on it.
    background: bool = False
    # The shortest auto-refresh interval, in seconds, for a kind that can
    # refresh by itself (§18.3); None for one that can't.
    refresh_floor: Optional[int] = None

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
            **({"refresh_floor": self.refresh_floor} if self.refresh_floor else {}),
            **({"stop_pane": "Stops a run still going."} if self.background else {}),
            **(
                {"views": [
                    {"key": k, "default": d, **({"help": CHART_HELP} if self.view_kinds.get(k) == "chart" else {})}
                    for k, d in self.view_defaults.items()
                ]}
                if self.view_defaults
                else {}
            ),
        }


# Every run poll's and wait's upper bound: a turn has to end, and an agent
# waiting minutes on one query is an agent the user has given up on.
RUN_TIMEOUT_SECONDS = 90.0
POLL_SECONDS = 2.0


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


def _call(fn, **kwargs):
    """A router function that reports failure with an HTTPException (the
    single-environment ones), with its message passed on as-is."""
    try:
        return fn(**kwargs)
    except HTTPException as e:
        raise _http_error(e) from None


def _with_log_group_environments(values: dict) -> dict:
    envs = [int(e) for e in (values.get("logGroupSelection") or {})]
    return {"connections": envs} if envs else {}


def _with_opensearch_environments(values: dict) -> dict:
    envs = sorted({int(t["environment_id"]) for t in (values.get("openSearchSelection") or []) if isinstance(t, dict)})
    return {"connections": envs} if envs else {}


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
    try:
        steps = row_paths.parts(path or "")
    except row_paths.PathError as e:
        raise InputError(str(e)) from None
    for part in steps:
        value = row_paths.step(value, part)
        if row_paths.missing(value):
            raise InputError(f"The reply has nothing at {path!r} (stopped at {row_paths.describe(part)!r}).")
    return value


def request_rows(response: Any, rows_at: str) -> list[dict]:
    """The rows of a declarative request's reply: the list at `rows_at`, each
    item a row (a non-object item becomes {"value": item})."""
    listed = _rows_at(response, rows_at)
    if not isinstance(listed, list):
        where = f"at {rows_at!r}" if rows_at else "itself"
        raise InputError(f"The reply {where} isn't a list, so there are no rows; set Rows at to where the list is.")
    return [row if isinstance(row, dict) else {"value": row} for row in listed]


def _at(value: Any, path: str) -> Any:
    """`_rows_at`, but None where nothing is: a column a reply leaves out."""
    try:
        return _rows_at(value, path)
    except InputError:
        return None


def _as(value: Any, kind: str) -> Any:
    if value is None:
        return None
    if kind == "number":
        try:
            n = float(value)
        except (TypeError, ValueError):
            return None
        return int(n) if n.is_integer() and abs(n) < 2**53 else n
    if kind == "time":
        # Epoch seconds (or milliseconds) as the ISO text every chart reads as time.
        try:
            t = float(value)
        except (TypeError, ValueError):
            return str(value)
        if t > 1e11:
            t /= 1000
        return datetime.datetime.fromtimestamp(t, datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    return value if isinstance(value, (str, int, float, bool)) else json.dumps(value)


def _series_name(labels: Any) -> str:
    """A labels object as one name -- `up{job="api"}`, the way Prometheus
    writes a series -- so a chart has one column to tell series apart by."""
    if not isinstance(labels, dict):
        return "" if labels is None else str(labels)
    name = str(labels.get("__name__", ""))
    rest = ", ".join(f'{k}="{v}"' for k, v in sorted(labels.items()) if k != "__name__")
    return f"{name}{{{rest}}}" if rest else (name or "{}")


def extract_rows(response: Any, spec: dict[str, Any]) -> list[dict]:
    """Rows out of a reply as a manifest describes them (D67) -- data, never
    code, so any manifest can say it:

    - `at`: where the list is (a dotted path; digits index a list);
    - `explode`: a list in each item to make one row per element of;
    - `columns`: column -> {from: a path in the element, as: text|number|time};
      without them an element that is an object is the row itself;
    - `spread`: an object in each item whose keys become columns;
    - `labels`: {column, from}: that object as one series name.
    """
    listed = _rows_at(response, str(spec.get("at") or ""))
    if not isinstance(listed, list):
        raise InputError(f"The reply at {spec.get('at')!r} isn't a list, so there are no rows.")
    columns: dict[str, Any] = spec.get("columns") or {}
    rows: list[dict] = []
    for item in listed:
        # The series' name, then its labels, after the element's own columns:
        # a table reads time, value, series before the labels it came from.
        shared: dict[str, Any] = {}
        labels = spec.get("labels")
        if isinstance(labels, dict) and labels.get("column"):
            shared[labels["column"]] = _series_name(_at(item, str(labels.get("from") or "")))
        if spec.get("spread"):
            spread = _at(item, spec["spread"])
            if isinstance(spread, dict):
                shared.update({str(k): _as(v, "text") for k, v in spread.items() if str(k) not in shared})
        elements = _at(item, spec["explode"]) if spec.get("explode") else [item]
        for element in elements if isinstance(elements, list) else []:
            row: dict[str, Any] = {}
            if columns:
                for name, column in columns.items():
                    column = column if isinstance(column, dict) else {"from": column}
                    row[name] = _as(_at(element, str(column.get("from", ""))), column.get("as", "text"))
            elif isinstance(element, dict):
                row.update(element)
            else:
                row["value"] = element
            row.update({k: v for k, v in shared.items() if k not in row})
            rows.append(row)
    return rows


def _request_runner(manifest: pane_manifest.Manifest,
                    action: Optional[pane_manifest.ManifestAction] = None) -> Optional[Runner]:
    """A declarative HTTP action (§15.7), for the agent: the same request the
    pane's Fetch sends, through routers/panes.run_request -- connection,
    identity, SSRF guard and masking included -- with its rows written into
    the pane."""
    requests = [a for a in manifest.actions if a.request and not a.args]
    # The main one, when a pane has several (rows of their own, D118).
    action = action or next((a for a in requests if a.main), requests[0] if requests else None)
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
        rows = outputs.get((action.request or {}).get("output") or "rows") or []
        return RunResult(
            writes={**outputs, **_ran(values)},
            summary={"rows": len(rows), "sample": _sample(rows)},
        )

    return run


def _groups(manifest: pane_manifest.Manifest, key: str) -> Optional[dict]:
    """A list output's `groups` config (§16.4.1): its value is one group per
    connection, each holding its rows."""
    output = next((o for o in manifest.outputs if o.key == key), None)
    groups = output.config.get("groups") if output else None
    return groups if isinstance(groups, dict) else None


def flatten(value: Any, groups: Optional[dict]) -> list[tuple[dict, Optional[dict]]]:
    """A list output's rows, each with its group: the browser's ListView
    flattens the same way, stamping the group's name on each row under `as`
    (what export and attach have always called `environment`)."""
    if not isinstance(value, list):
        return []
    if groups is None:
        return [(r, None) for r in value if isinstance(r, dict)]
    out = []
    for group in value:
        if not isinstance(group, dict):
            continue
        for row in group.get(groups.get("rows", "rows")) or []:
            if groups.get("fields") and isinstance(row, list):
                row = _field_row(row)
            if isinstance(row, dict):
                stamped = {groups["as"]: group.get(groups.get("name", "name"))} if groups.get("as") else {}
                out.append(({**stamped, **row}, group))
    return out


def _field_row(fields: list) -> dict:
    """A logs row -- `[{field, value}]` -- as one object. CloudWatch's @ptr is
    an opaque handle, noise to anyone reading rows."""
    return {f["field"]: f["value"] for f in fields if isinstance(f, dict) and f.get("field") != "@ptr"}


def _summary(manifest: pane_manifest.Manifest, outputs: dict[str, Any], page: Optional[pane_manifest.Page]) -> dict[str, Any]:
    """What a handler run tells the model: each list's length -- or, for a
    list of groups, each connection's count and error -- a sample of the
    paged one (or the first list that has rows), whether there is more, and
    anything small as it is."""
    out: dict[str, Any] = {}
    lists = {k: v for k, v in outputs.items() if isinstance(v, list)}
    rows = {k: [r for r, _ in flatten(v, _groups(manifest, k))] for k, v in lists.items()}
    for key, value in outputs.items():
        groups = _groups(manifest, key)
        if key in lists and groups is not None and not value:
            continue  # the other mode's list, emptied by this run: nothing to say
        if key in lists and groups is not None:
            listed = groups.get("rows", "rows")
            out[key] = {
                "environments": [
                    {
                        "environment": g.get(groups.get("name", "name")),
                        listed: len(g.get(listed) or []),
                        **({"error": g["error"]} if g.get("error") else {}),
                    }
                    for g in value
                    if isinstance(g, dict)
                ],
                "total": len(rows[key]),
            }
        elif key in lists:
            out[key] = len(value)
        elif page is None or key != page.cursor:
            out[key] = value
    sampled = next(
        (k for k in (page.append if page else []) if k in lists),
        next((k for k in lists if rows[k]), next(iter(lists), None)),
    )
    if sampled is not None:
        out["sample"] = _sample(rows[sampled])
    if page is not None:
        out["more"] = outputs.get(page.cursor) is not None
    return out


def _chosen_runner(manifest: pane_manifest.Manifest) -> Optional[Runner]:
    """A pane whose main action an input chooses (D119): each run runs the one
    the pane's inputs choose, as its button would -- a handler or a request."""
    if not any(isinstance(a.main, pane_manifest.When) for a in manifest.actions):
        return None

    async def run(rc: RunContext, values: dict) -> RunResult:
        action = manifest.main_action(values)
        runner = None
        if action is not None and action.handler:
            runner = _handler_runner(manifest, action)
        elif action is not None and action.request is not None:
            runner = _request_runner(manifest, action)
        if runner is None:
            raise InputError(f"{manifest.label} has nothing to run for these inputs.")
        return await runner(rc, values)

    return run


def _handler_runner(manifest: pane_manifest.Manifest,
                    main: Optional[pane_manifest.ManifestAction] = None) -> Optional[Runner]:
    """A ported pane's run, for the agent (§16.3.1): what picking its inputs
    in the pane would have run (the on_change actions whose inputs are set --
    DynamoDB's describe), then its main action, through the very function the
    browser's action endpoint calls. A fresh run, never Load more."""
    main = main or manifest.main_action()
    if manifest.state != "v2" or main is None or main.handler is None:
        return None
    # Reaching outside the platform (the HTTP client's Send) is a person's to
    # do until the approval step exists: no run, and run_help says so. A
    # background action (a CloudWatch query) runs through the session's pane
    # (server.run_pane), since its results are written there as they arrive.
    if main.effects == "external" or main.poll is not None:
        return None
    from ..routers import panes as panes_router  # the router imports this module

    before = [
        a for a in manifest.actions
        if a.handler and a.on_change and a is not main and not _is_loader(manifest, a) and a.effects != "external"
    ]

    async def run(rc: RunContext, values: dict) -> RunResult:
        outputs: dict[str, Any] = {}
        try:
            for action in before:
                if all(values.get(k) not in (None, "", []) for k in action.on_change):
                    outputs.update(
                        await asyncio.to_thread(panes_router.run_handler, rc.db, rc.user, manifest, action, values)
                    )
            found = await asyncio.to_thread(
                panes_router.run_handler, rc.db, rc.user, manifest, main, {**values, "_tz": rc.timezone}
            )
        except HTTPException as e:
            raise _http_error(e) from None
        outputs.update(found)
        writes = {**outputs, **_ran(values)}
        for ref in main.resets:
            part, _, key = ref.partition(".")
            if part == "view":
                writes[ref] = next((v.default for v in manifest.views if v.key == key), None)
        # Everything it ran, so the model sees what describing found too (the
        # table's keys) beside the rows.
        return RunResult(writes=writes, summary=_summary(manifest, outputs, main.page))

    return run


def _is_loader(manifest: pane_manifest.Manifest, action: pane_manifest.ManifestAction) -> bool:
    return any(i.options is not None and i.options.action == action.id for i in manifest.inputs)


def _api_rows(values: dict) -> list[dict]:
    return [r for r in values.get("rows") or [] if isinstance(r, dict)]


# Every pane the agent runs is drawn from its manifest now; a pane still drawn
# by hand would name its own runner here.
HANDLERS: dict[str, Runner] = {}
IMPLIES: dict[str, Callable[[dict], dict]] = {
    "log_group_environments": _with_log_group_environments,
    "opensearch_environments": _with_opensearch_environments,
}
def _list_outputs(manifest: pane_manifest.Manifest) -> list[pane_manifest.ManifestOutput]:
    # A table whose rows open (a built pane's, D124) is one too.
    return [o for o in manifest.outputs if o.render in ("list", "files", "logs")
            or (o.render == "table" and isinstance(o.config.get("detail"), dict))]


def _shown_list(manifest: pane_manifest.Manifest, values: dict) -> Optional[pane_manifest.ManifestOutput]:
    """The list output that holds the last run's rows: the first with any.
    A pane with a mode (IoT's things or certificates) keeps the other mode's
    list empty, so this is the one on screen."""
    for output in _list_outputs(manifest):
        if flatten(values.get(output.key), _groups(manifest, output.key)):
            return output
    return None


def _manifest_rows(manifest: pane_manifest.Manifest) -> RowLister:
    """A ported pane's rows, read from its manifest's list outputs as the
    pane draws them (§16.4.2) -- no lister of its own to keep in step."""

    def rows(values: dict) -> list[dict]:
        output = _shown_list(manifest, values)
        return [r for r, _ in flatten(values.get(output.key), _groups(manifest, output.key))] if output else []

    return rows


def _arg(path: str, row: dict, group: Optional[dict]) -> Any:
    part, _, rest = path.partition(".")
    value: Any = row if part == "row" else (group or {})
    for key in [k for k in rest.split(".") if k]:
        value = value.get(key) if isinstance(value, dict) else None
    return value


def _manifest_detail(manifest: pane_manifest.Manifest) -> Optional[Detailer]:
    """inspect_row's second look-up, through the row action the shown list
    declares (`detail: {action}`) -- the same one expanding the row in the
    pane runs -- with its args read from the row and its group. A list
    without one shows the row as the run left it."""
    if not any(isinstance(o.config.get("detail"), dict) for o in _list_outputs(manifest)):
        return None
    from ..routers import panes as panes_router  # the router imports this module

    async def detail(rc: RunContext, values: dict, row: dict) -> dict:
        output = _shown_list(manifest, values)
        spec = output.config.get("detail") if output else None
        if not isinstance(spec, dict):
            return row
        action = next(a for a in manifest.actions if a.id == spec["action"])
        pairs = flatten(values.get(output.key), _groups(manifest, output.key))
        group = next((g for r, g in pairs if r == row), None)
        args = {name: _arg(path, row, group) for name, path in action.args.items()}
        # A second look-up acts as the caller, like a run: in a shared
        # session the row may be from an environment only its owner has.
        if "connection" in args:
            reachable = {t["id"] for t in connections.targets(rc.db, rc.user, connections.AWS)}
            if args["connection"] not in reachable:
                raise InputError(
                    f"That row is from environment {args['connection']}, which you can't reach, so it can't be "
                    "looked up for you."
                )
        try:
            found = await asyncio.to_thread(panes_router.run_row, rc.db, rc.user, manifest, action, args)
        except HTTPException as e:
            raise _http_error(e) from None
        return {**row, **found}

    return detail


ROW_LISTERS: dict[str, RowLister] = {
    "rows.api-table": _api_rows,
}
DETAILERS: dict[str, Detailer] = {}


def _kind(manifest: pane_manifest.Manifest) -> PaneKind:
    run: Optional[Runner] = None
    # A pane still drawn by hand names its agent runner (HANDLERS); a ported
    # one names server actions (panes/handlers.ACTIONS) the browser runs too.
    if manifest.state != "v2":
        for action in manifest.actions:
            if action.handler:
                run = HANDLERS[action.handler]
                break
    run = run or _chosen_runner(manifest) or _handler_runner(manifest) or _live_runner(manifest) or _request_runner(manifest)
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
                options=i.options is not None,
            )
            for i in manifest.agent_inputs()
        ),
        run=run,
        run_help=manifest.agent.run.strip(),
        implies=IMPLIES[manifest.implies] if manifest.implies else (lambda values: {}),
        rows=(ROW_LISTERS[inspect.rows] if inspect.rows else _manifest_rows(manifest)) if inspect else None,
        detail=(
            (DETAILERS[inspect.detail] if inspect.detail else None if inspect.rows else _manifest_detail(manifest))
            if inspect
            else None
        ),
        detail_help=inspect.help.strip() if inspect else "",
        v2=manifest.state == "v2",
        resets={i.key: tuple(i.resets) for i in manifest.inputs if i.resets},
        view_defaults={v.key: v.default for v in manifest.views},
        view_kinds={v.key: v.kind for v in manifest.views if v.kind},
        choice_sets={i.key: i.choice_sets for i in manifest.inputs if i.choice_sets},
        aliases={i.legacy_key: i.key for i in manifest.agent_inputs() if i.legacy_key and i.legacy_key != i.key},
        background=bool(manifest.main_action() and manifest.main_action().poll),
        refresh_floor=_refresh_floor(manifest),
    )


def _refresh_floor(manifest: pane_manifest.Manifest) -> Optional[int]:
    from ..panes import refresh as pane_refresh  # it reaches the routers, which import this module

    return pane_refresh.floor_seconds(manifest) if manifest.refresh_action() is not None else None


KINDS: dict[str, PaneKind] = {m.id: _kind(m) for m in pane_manifest.manifests().values()}


def _rebuild_kinds() -> None:
    """A pane type built in the platform (§24) is a kind the agent can use
    the moment it's saved, and is gone the moment it's deleted: the same dict,
    changed in place, so every module holding it sees it."""
    fresh = {m.id: _kind(m) for m in pane_manifest.manifests().values()}
    KINDS.clear()
    KINDS.update(fresh)


pane_manifest.on_change(_rebuild_kinds)


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
    # The same grants the browser's pane list and every handler go by (D65).
    from .. import pane_access

    return [k for k in KINDS.values() if pane_access.allowed(user.group, k.type)]


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
