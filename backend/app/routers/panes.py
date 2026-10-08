"""Pane types and their server-side actions (PLATFORM_PLAN.md §15).

`GET /api/pane-types` hands the browser every manifest the caller's group
may use: the renderer draws a manifest pane from it alone. `POST
/api/panes/{type}/actions/{action}` runs a manifest action that has to run
on the server -- in PR 1, a declarative HTTP request (the API table's
Fetch). Live actions run in the browser; the agent runs their Python twins
(`app/panes/live.py`).
"""

import json
from typing import Any
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import auth, connections, credential_types, masking, models, tools_http_client
from ..db import get_db
from ..panes import manifest as pane_manifest
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
    if action is None or action.request is None:
        raise HTTPException(status_code=404, detail=f"{manifest.label} has no server action '{action_id}'.")
    return run_request(db, current_user, manifest, action, payload.inputs)
