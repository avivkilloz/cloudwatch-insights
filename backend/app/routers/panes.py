"""Pane types and their server-side actions (PLATFORM_PLAN.md §15).

`GET /api/pane-types` hands the browser every manifest the caller's group
may use: the renderer draws a manifest pane from it alone. `POST
/api/panes/{type}/actions/{action}` runs a manifest action that has to run
on the server: a declarative HTTP request (the API table's Fetch), or a
handler registered by name (`app/panes/handlers.py`: DynamoDB's scan, a
picker's loader). Live actions run in the browser; the agent runs their
Python twins (`app/panes/live.py`).
"""

import json
from typing import Any, Optional
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import auth, connections, credential_types, live_store, masking, models, pane_access, pane_outputs, tools_http_client
from ..db import get_db
from ..panes import handlers as pane_handlers
from ..panes import manifest as pane_manifest
from ..panes import runs
from ..panes import timewindow
from ..panes.timewindow import TimeRangeError
from ..resolve import ResolveError, resolve_identity_values, resolve_target

router = APIRouter(prefix="/api", tags=["panes"])


def _allowed(user: models.User, manifest: pane_manifest.Manifest) -> bool:
    return pane_access.allowed(user.group, manifest.id)


@router.get("/pane-types")
def list_pane_types(current_user: models.User = Depends(auth.get_current_user)) -> list[dict[str, Any]]:
    """Every pane type the caller's group may use, as its manifest says --
    with `refresh` (its shortest interval) when it can refresh by itself."""
    from ..panes import refresh as pane_refresh

    out = []
    for m in pane_manifest.manifests().values():
        if not _allowed(current_user, m):
            continue
        body = m.model_dump(by_alias=True, exclude_none=True)
        if m.refresh_action() is not None:
            body["refresh"] = {"floor": pane_refresh.floor_seconds(m)}
        out.append(body)
    return out


class ActionRun(BaseModel):
    inputs: dict[str, Any] = {}
    # A paged action's cursor from its last run: Load more.
    cursor: Any = None
    # A background action (§16.9.1) writes its run into a session's pane, so
    # it needs to know which: the session's client id and the pane's id.
    session: Optional[str] = None
    pane: Optional[str] = None
    # The browser's own time zone, for a custom time range typed in it.
    timezone: Optional[str] = None
    # A running background run started again because its `restart_on`
    # inputs changed (D54): what it had shown is kept.
    restart: bool = False
    # Outputs an input change made stale (its `resets`), cleared in the same
    # write as this action's results, so the two can't land out of order.
    clear: list[str] = []


class RunStop(BaseModel):
    session: str
    pane: str


class PaneRefresh(BaseModel):
    session: str
    pane: str
    # The interval the asking tab runs at: what "fresh enough" is judged by.
    every: int
    timezone: Optional[str] = None


def run_handler(
    db: Session,
    user: models.User,
    manifest: pane_manifest.Manifest,
    action: pane_manifest.ManifestAction,
    inputs: dict[str, Any],
    cursor: Any = None,
) -> dict[str, Any]:
    """A handler action (§16.3.1), for the browser and the agent alike: the
    group's flag, the manifest's `requires`, then the handler, whose own
    checks (connection, identity) answer in sentences a user can act on."""
    # The group's grant of this pane type (D65), whoever is asking: the action endpoint and the agent
    # both check it first, but a handler never runs without it either.
    try:
        pane_access.require(user, manifest.id, manifest.label)
    except ResolveError as e:
        raise HTTPException(status_code=400, detail=str(e)) from None
    # An input never set is its default, as the pane shows it: a pane the
    # agent made holds only what it was given.
    if not action.args:
        inputs = {**{i.key: i.default for i in manifest.inputs if i.default is not None}, **inputs}
    message = pane_handlers.missing(action.requires, inputs)
    if message:
        raise HTTPException(status_code=400, detail=message)
    handler = pane_handlers.ACTIONS.get(action.handler or "")
    if handler is None:  # a manifest naming a handler that doesn't exist fails its tests
        raise HTTPException(status_code=500, detail=f"{manifest.label}'s {action.id} has no handler.")
    return handler(db, user, inputs, cursor)


def _query(value: Any) -> dict[str, str]:
    """A `headers`-type input -- the editor's {key, value} rows, or a plain
    object -- as query parameters."""
    if isinstance(value, dict):
        return {str(k): str(v) for k, v in value.items() if str(k).strip()}
    if isinstance(value, list):
        return {str(r.get("key")): str(r.get("value") or "") for r in value if isinstance(r, dict) and r.get("key")}
    return {}


# About this many points across the window, for a step worked out from it.
_POINTS = 240


def _params(spec: dict[str, Any], values: dict[str, Any]) -> dict[str, str]:
    """A request's `params` (D67): each query parameter a literal, an input
    (`{input: key}`, left out while empty), or the pane's time window
    (`{window: start|end|step}`, from the inputs `window` names, in the
    browser's zone, epoch seconds)."""
    params = spec.get("params") or {}
    out: dict[str, str] = {}
    span: Optional[tuple[int, int]] = None
    for name, source in params.items():
        if isinstance(source, dict) and "input" in source:
            value = values.get(source["input"])
            if value not in (None, ""):
                out[name] = str(value)
        elif isinstance(source, dict) and "window" in source:
            if span is None:
                keys = spec.get("window") or {}
                span = timewindow.window(
                    {
                        "preset": values.get(keys.get("preset", "")),
                        "customStart": values.get(keys.get("start", "")),
                        "customEnd": values.get(keys.get("end", "")),
                    },
                    values.get("_tz"),
                )
            start, end = span
            out[name] = str({"start": start, "end": end, "step": max(1, round((end - start) / _POINTS))}[source["window"]])
        elif source is not None:
            out[name] = str(source)
    return out


def run_request(
    db: Session,
    user: models.User,
    manifest: pane_manifest.Manifest,
    action: pane_manifest.ManifestAction,
    values: dict[str, Any],
) -> dict[str, Any]:
    """A declarative HTTP request (§15.7, D67): a GET on a connection of any
    HTTP type -- the API table's HTTP API, an admin's or a manifest's own --
    signed with the caller's group identity there (or the connection's own),
    through the SSRF guard, its reply masked and read as JSON. Returns the
    action's outputs: `rows` and `response`."""
    from ..platform_tools.panes import InputError, extract_rows, request_rows

    try:
        pane_access.require(user, manifest.id, manifest.label)
    except ResolveError as e:
        raise HTTPException(status_code=403, detail=str(e)) from None
    spec = action.request or {}
    if (spec.get("method") or "GET").upper() != "GET":
        raise HTTPException(status_code=400, detail="Only GET requests can run from a pane for now.")
    connection_id = values.get(spec.get("connection", ""))
    if connection_id in (None, ""):
        raise HTTPException(status_code=400, detail="Pick a connection first.")
    # The connection's type is its input's: the API table's HTTP API, or a
    # type a pane reaches (Prometheus).
    conn_input = next((i for i in manifest.inputs if i.key == spec.get("connection")), None)
    type_id = (conn_input.connection_type if conn_input else None) or connections.HTTP_API
    try:
        target = resolve_target(db, int(connection_id), user, type_id=type_id)
    except (ResolveError, ValueError) as e:
        raise HTTPException(status_code=400, detail=str(e)) from None
    if not connections.is_http(target.connection.type):
        raise HTTPException(status_code=400, detail=f"{target.name} isn't reached over HTTP.")
    path = spec.get("fixed_path") or str(values.get(spec.get("path", "")) or "")
    url = connections.join_url(target.config["base_url"], path)
    query = _query(values.get(spec.get("query", "")))
    try:
        query.update(_params(spec, values))
    except TimeRangeError as e:
        raise HTTPException(status_code=400, detail=str(e)) from None
    if query:
        url += ("&" if "?" in url else "?") + urlencode(query)
    headers = {"Accept": "application/json"}
    # A public API needs no identity: only one that exists is applied.
    has_identity = (
        connections.group_identity(db, user.group, target.connection) is not None
        or target.connection.credential_id is not None
    )
    try:
        if has_identity:
            type_row, secret_values = resolve_identity_values(db, target, user)
            url, headers = credential_types.apply_inject(type_row, secret_values, url, headers)
        result = tools_http_client.send_request("GET", url, headers=headers)
    except ResolveError as e:
        raise HTTPException(status_code=400, detail=masking.mask(str(e))) from None
    except (tools_http_client.ToolRequestError, credential_types.CredentialTypeError) as e:
        raise HTTPException(status_code=400, detail=masking.mask(str(e))) from None
    except Exception as e:  # noqa: BLE001 -- a connection that fails says so, readably
        raise HTTPException(status_code=502, detail=masking.mask(f"{target.name} didn't answer: {e}")) from None
    body = masking.mask(result["body"])
    if result["status_code"] >= 400:
        raise HTTPException(
            status_code=400,
            detail=masking.mask(f"{target.name} answered HTTP {result['status_code']} {result['status_text']}: {body[:300]}"),
        )
    if result["body_truncated"]:
        raise HTTPException(status_code=400, detail="The reply is too large to show as a table; ask for less.")
    try:
        response = json.loads(body)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"{target.name}'s reply isn't JSON: {body[:200]}") from None
    try:
        if isinstance(spec.get("rows"), dict):
            rows = extract_rows(response, spec["rows"])
        else:
            rows = request_rows(response, str(values.get(spec.get("rows_at", "")) or ""))
    except InputError as e:
        raise HTTPException(status_code=400, detail=str(e)) from None
    return {"rows": rows, "response": response}


@router.post("/panes/{type_id}/actions/{action_id}")
def run_action(
    type_id: str,
    action_id: str,
    payload: ActionRun,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
    origin: Optional[str] = Header(default=None, alias="X-Sync-Origin", max_length=64),
) -> dict[str, Any]:
    """Runs a manifest action that needs the server, returning its outputs.
    Given the session and pane it ran for, it also stores them there (D21,
    §18.2) -- the one place a pane's results are written, for every tab and
    member at once -- and returns what the pane now holds as `__outputs`."""
    manifest = pane_manifest.get(type_id)
    if manifest is None or not _allowed(current_user, manifest):
        raise HTTPException(status_code=404, detail=f"There is no pane type '{type_id}' for you.")
    action = next((a for a in manifest.actions if a.id == action_id), None)
    inputs = {**payload.inputs, **({"_tz": payload.timezone} if payload.timezone else {})}
    if action is not None and action.poll is not None and manifest.state == "v2":
        return _start_run(db, current_user, manifest, action, payload, inputs)
    _unsaved(db, current_user, manifest, payload)
    if action is not None and action.request is not None:
        result = run_request(db, current_user, manifest, action, inputs)
    elif action is not None and action.handler is not None and manifest.state == "v2":
        result = run_handler(db, current_user, manifest, action, inputs, payload.cursor)
    else:
        raise HTTPException(status_code=404, detail=f"{manifest.label} has no server action '{action_id}'.")
    stored = _store(db, current_user, manifest, action, payload, result, origin)
    return {**result, "__outputs": stored} if stored is not None else result


def apply_outputs(
    values: dict,
    manifest: pane_manifest.Manifest,
    action: pane_manifest.ManifestAction,
    result: dict[str, Any],
    load_more: bool = False,
    clear: tuple[str, ...] = (),
) -> None:
    """An action's result written into a pane's outputs, as the pane always
    did it in the browser: a request replaces them all; a handler sets what
    it returned, Load more appending or summing (`page`); the action's `out.`
    resets cleared first (not on Load more), and a fresh run of what the
    pane is for stamps `ranAt` and a new `resultsVersion` (which clears the
    selection). Load more keeps both, so checked rows stay checked."""
    keys = {o.key for o in manifest.outputs}
    stale = list(clear)
    if not load_more:
        stale += [ref.split(".", 1)[1] for ref in action.resets or [] if ref.startswith("out.")]
    if action.request is not None:
        stale += list(keys)
    for key in stale:
        if key != "resultsVersion":
            values.pop(key, None)
    page = action.page
    for key, value in result.items():
        if key not in keys:
            continue
        if load_more and page is not None and key in page.append:
            values[key] = [*(values.get(key) or []), *(value or [])]
        elif load_more and page is not None and key in page.sum:
            values[key] = _number(_number(values.get(key)) + _number(value))
        else:
            values[key] = value
    if not load_more and (action.main or action.page is not None or action.request is not None):
        values["ranAt"] = live_store.now_ms()
        values["resultsVersion"] = int(values.get("resultsVersion") or 0) + 1
    pane_outputs.fit(values)


def _number(value: Any) -> float | int:
    try:
        number = float(value or 0)
    except (TypeError, ValueError):
        return 0
    return int(number) if number.is_integer() else number


# Says "save the session first, then ask again": a pane added a moment ago is
# still in the browser's debounced save. Checked before anything runs, so the
# retry doesn't run it twice.
PANE_NOT_SAVED = "This pane isn't saved yet: save the session and run it again."


def _unsaved(db: Session, user: models.User, manifest: pane_manifest.Manifest, payload: ActionRun) -> None:
    if not payload.session or not payload.pane or manifest.state != "v2":
        return
    row, _ = live_store.reachable(db, user.id, payload.session)
    if row is None or payload.pane not in ((row.state or {}).get("services") or []):
        raise HTTPException(status_code=409, detail=PANE_NOT_SAVED)


def _store(
    db: Session,
    user: models.User,
    manifest: pane_manifest.Manifest,
    action: pane_manifest.ManifestAction,
    payload: ActionRun,
    result: dict[str, Any],
    origin: Optional[str],
) -> Optional[dict]:
    """Stores an action's outputs in the pane it ran for -- if it says which,
    returns any (a picker's options are the tab's, D47), and the caller may
    edit. A viewer's clicks show in their own tab only, as they always did."""
    if not payload.session or not payload.pane or manifest.state != "v2":
        return None
    keys = {o.key for o in manifest.outputs}
    if not payload.clear and not any(k in keys for k in result):
        return None
    row, member = live_store.reachable(db, user.id, payload.session)
    if row is None or (member is not None and member.permission == "viewer"):
        return None
    load_more = payload.cursor is not None
    try:
        record, _ = pane_outputs.write(
            db,
            row,
            payload.pane,
            lambda values: apply_outputs(values, manifest, action, result, load_more, tuple(payload.clear)),
            origin,
        )
    except pane_outputs.OutputError as e:
        raise HTTPException(status_code=400, detail=str(e)) from None
    return {"version": record.version, "values": record.data}


def _pane_of(db: Session, user: models.User, manifest: pane_manifest.Manifest, session: Optional[str], pane: Optional[str]):
    """The session and pane a background run writes into, as the caller can
    reach them (their own, or one shared with them)."""
    if not session or not pane:
        raise HTTPException(status_code=400, detail=f"{manifest.label} runs in a session's pane: say which.")
    row, member = live_store.reachable(db, user.id, session)
    if row is None:
        raise HTTPException(status_code=404, detail="There is no such session for you.")
    state = row.state or {}
    types = state.get("paneTypes") or {}
    if pane not in (state.get("services") or []) or (types.get(pane) or pane.split("~")[0]) != manifest.id:
        raise HTTPException(status_code=404, detail=f"That session has no {manifest.label} pane '{pane}'.")
    return row, member


def _start_run(
    db: Session,
    user: models.User,
    manifest: pane_manifest.Manifest,
    action: pane_manifest.ManifestAction,
    payload: ActionRun,
    inputs: dict[str, Any],
) -> dict[str, Any]:
    """Starts a background action (D51): the server polls it into the
    session, so all the browser gets back is the run; its results arrive the
    way any other write to the session does."""
    row, member = _pane_of(db, user, manifest, payload.session, payload.pane)
    try:
        run = runs.start(
            db, user, row, member, manifest, action, payload.pane, inputs, keep=payload.restart and bool(action.restart_on)
        )
    except runs.RunError as e:
        raise HTTPException(status_code=403 if "read-only" in str(e) else 400, detail=str(e)) from None
    return {"run": {"id": run.id, "status": run.status}}


@router.post("/panes/{type_id}/stop")
def stop_run(
    type_id: str,
    payload: RunStop,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
) -> dict[str, Any]:
    """Stops a pane's running background action -- anyone who can edit the
    session may, as the pane's own Stop button and the agent's stop_pane do."""
    manifest = pane_manifest.get(type_id)
    if manifest is None or not _allowed(current_user, manifest):
        raise HTTPException(status_code=404, detail=f"There is no pane type '{type_id}' for you.")
    row, member = _pane_of(db, current_user, manifest, payload.session, payload.pane)
    try:
        stopped = runs.stop(db, current_user, row, member, payload.pane)
    except runs.RunError as e:
        raise HTTPException(status_code=403, detail=str(e)) from None
    return {"stopped": stopped}


@router.post("/panes/{type_id}/refresh")
def refresh_pane(
    type_id: str,
    payload: PaneRefresh,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
    origin: Optional[str] = Header(default=None, alias="X-Sync-Origin", max_length=64),
) -> dict[str, Any]:
    """Runs a pane again if it's due -- once, however many tabs ask (§18.3)."""
    from ..panes import refresh as pane_refresh

    manifest = pane_manifest.get(type_id)
    if manifest is None or not _allowed(current_user, manifest):
        raise HTTPException(status_code=404, detail=f"There is no pane type '{type_id}' for you.")
    row, member = _pane_of(db, current_user, manifest, payload.session, payload.pane)
    return pane_refresh.refresh(db, current_user, row, member, manifest, payload.pane, payload.every, payload.timezone, origin)
