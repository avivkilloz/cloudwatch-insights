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

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import auth, connections, credential_types, live_store, masking, models, tools_http_client
from ..db import get_db
from ..panes import handlers as pane_handlers
from ..panes import manifest as pane_manifest
from ..panes import runs
from ..resolve import ResolveError, require_flag, resolve_identity_values, resolve_target

router = APIRouter(prefix="/api", tags=["panes"])


def _allowed(user: models.User, manifest: pane_manifest.Manifest) -> bool:
    group = user.group
    return group is not None and (group.is_admin or bool(getattr(group, manifest.flag, False)))


@router.get("/pane-types")
def list_pane_types(current_user: models.User = Depends(auth.get_current_user)) -> list[dict[str, Any]]:
    """Every pane type the caller's group may use, as its manifest says."""
    return [
        m.model_dump(by_alias=True, exclude_none=True)
        for m in pane_manifest.manifests().values()
        if _allowed(current_user, m)
    ]


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


class RunStop(BaseModel):
    session: str
    pane: str


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
    # The group's flag, whoever is asking: the action endpoint and the agent
    # both check it first, but a handler never runs without it either.
    try:
        require_flag(user, manifest.flag, manifest.label)
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


def run_request(
    db: Session,
    user: models.User,
    manifest: pane_manifest.Manifest,
    action: pane_manifest.ManifestAction,
    values: dict[str, Any],
) -> dict[str, Any]:
    """A declarative HTTP request (§15.7): a GET on an HTTP API connection,
    signed with the caller's group identity there (or the connection's own),
    through the SSRF guard, its reply masked and read as JSON. Returns the
    action's outputs: `rows` and `response`."""
    from ..platform_tools.panes import InputError, request_rows

    try:
        require_flag(user, manifest.flag, manifest.label)
    except ResolveError as e:
        raise HTTPException(status_code=403, detail=str(e)) from None
    spec = action.request or {}
    if (spec.get("method") or "GET").upper() != "GET":
        raise HTTPException(status_code=400, detail="Only GET requests can run from a pane for now.")
    connection_id = values.get(spec.get("connection", ""))
    if connection_id in (None, ""):
        raise HTTPException(status_code=400, detail="Pick a connection first.")
    try:
        target = resolve_target(db, int(connection_id), user, type_id=connections.HTTP_API)
    except (ResolveError, ValueError) as e:
        raise HTTPException(status_code=400, detail=str(e)) from None
    url = connections.join_url(target.config["base_url"], str(values.get(spec.get("path", "")) or ""))
    query = _query(values.get(spec.get("query", "")))
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
) -> dict[str, Any]:
    """Runs a manifest action that needs the server, returning its outputs.
    The browser writes them into the pane, as it does any run's results."""
    manifest = pane_manifest.get(type_id)
    if manifest is None or not _allowed(current_user, manifest):
        raise HTTPException(status_code=404, detail=f"There is no pane type '{type_id}' for you.")
    action = next((a for a in manifest.actions if a.id == action_id), None)
    inputs = {**payload.inputs, **({"_tz": payload.timezone} if payload.timezone else {})}
    if action is not None and action.poll is not None and manifest.state == "v2":
        return _start_run(db, current_user, manifest, action, payload, inputs)
    if action is not None and action.request is not None:
        return run_request(db, current_user, manifest, action, payload.inputs)
    if action is not None and action.handler is not None and manifest.state == "v2":
        return run_handler(db, current_user, manifest, action, inputs, payload.cursor)
    raise HTTPException(status_code=404, detail=f"{manifest.label} has no server action '{action_id}'.")


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
