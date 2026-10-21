"""What code in the runner sends out, made here as the person running it
(PLATFORM_PLAN.md §25, D133): the SDK's `ctx.http` and `ctx.aws` arrive at
the broker (`routers/runner.py`) and go through the very path a declarative
request takes -- the connection resolved for them, their group's identity
added on the way out, the SSRF guard, the reply masked. Code never holds a
credential, so a pane built to send its user's token somewhere else has
none to send.

Reads only, unless the job may change something (an approved step): an
HTTP call is a GET, an AWS call a read -- and AWS stays reads only until
writes to AWS have an approval of their own."""

from __future__ import annotations

import json
from typing import Any, Optional
from urllib.parse import urlencode

from botocore.exceptions import BotoCoreError, ClientError, ParamValidationError
from sqlalchemy.orm import Session

from . import aws_client, aws_request, connections, credential_types, masking, models, tools_http_client
from .resolve import ResolveError, resolve_identity, resolve_identity_values, resolve_target

METHODS = ("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD")


class OutboundError(Exception):
    """A call that can't be made, in a sentence the code (and its builder) can act on."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def connection_of(db: Session, user: models.User, value: Any, aws: bool) -> int:
    """A connection named by its id or by the name the user sees it by,
    among those they can reach -- AWS ones, or HTTP ones."""
    if isinstance(value, bool):
        raise OutboundError("Name a connection by its id or its name.")
    if isinstance(value, int) or (isinstance(value, str) and value.strip().isdigit()):
        return int(value)
    name = str(value or "").strip().lower()
    # An HTTP type's connections all have a base URL (connections.is_http).
    reachable = [t for t in connections.targets(db, user)
                 if (t["type_id"] == connections.AWS if aws else "base_url" in (t["config"] or {}))]
    for key in ("label", "environment"):
        found = [t["id"] for t in reachable if str(t[key]).lower() == name]
        if len(found) == 1:
            return found[0]
    kind = "AWS" if aws else "HTTP"
    raise OutboundError(f"There is no {kind} connection called {value!r} that you can reach.", 404)


def http(db: Session, user: models.User, call: dict, may_change: bool) -> dict:
    """A request to a connection of an HTTP type, `path` after its base URL:
    `{status, headers, body}` (masked) -- an error status is the code's to
    read, not a failure here."""
    method = str(call.get("method") or "GET").upper()
    if method not in METHODS:
        raise OutboundError(f"The method is one of {', '.join(METHODS)}, not {method}.")
    if method not in ("GET", "HEAD") and not may_change:
        raise OutboundError(f"This code only reads, so it can't send a {method}: a step that changes something "
                            "says `changes: true`, and a person approves it first.", 403)
    try:
        conn_id = connection_of(db, user, call.get("connection"), aws=False)
        conn = db.get(models.Connection, conn_id)
        # Its own type, whichever HTTP type it is; resolve_target holds the
        # caller to environments their group sees.
        target = resolve_target(db, conn_id, user, type_id=conn.type_id if conn else "")
    except (ResolveError, ValueError) as e:
        raise OutboundError(masking.mask(str(e)), 403) from None
    if not connections.is_http(target.connection.type):
        raise OutboundError(f"{target.name} isn't reached over HTTP; ctx.aws reaches an AWS connection.")
    url = connections.join_url(target.config["base_url"], str(call.get("path") or ""))
    query = {str(k): str(v) for k, v in (call.get("query") or {}).items() if v not in (None, "")}
    if query:
        url += ("&" if "?" in url else "?") + urlencode(query)
    headers = {"Accept": "application/json", **{str(k): str(v) for k, v in (call.get("headers") or {}).items()}}
    body = call.get("body")
    data: Optional[str] = None
    if body is not None:
        data = body if isinstance(body, str) else json.dumps(body, default=str)
        headers.setdefault("Content-Type", "application/json")
    has_identity = (connections.group_identity(db, user.group, target.connection) is not None
                    or target.connection.credential_id is not None)
    try:
        if has_identity:
            type_row, secret_values = resolve_identity_values(db, target, user)
            url, headers = credential_types.apply_inject(type_row, secret_values, url, headers)
        result = tools_http_client.send_request(method, url, headers=headers, body=data)
    except ResolveError as e:
        raise OutboundError(masking.mask(str(e)), 403) from None
    except (tools_http_client.ToolRequestError, credential_types.CredentialTypeError) as e:
        raise OutboundError(masking.mask(str(e))) from None
    except Exception as e:  # noqa: BLE001 -- a connection that fails says so, readably
        raise OutboundError(masking.mask(f"{target.name} didn't answer: {e}"), 502) from None
    return {
        "status": result["status_code"],
        "headers": {str(h.get("key")): masking.mask(str(h.get("value"))) for h in (result.get("headers") or [])},
        "body": masking.mask(result["body"]),
    }


def aws(db: Session, user: models.User, call: dict) -> dict:
    """An AWS operation that reads, on one AWS connection, as the user's
    group's identity there: `{reply}` (masked)."""
    service, operation = str(call.get("service") or ""), str(call.get("operation") or "")
    try:
        name = aws_request.operation_name(service, operation)
    except aws_request.AwsRequestError as e:
        raise OutboundError(str(e)) from None
    message = aws_request.refused(service, name)
    if message:
        raise OutboundError(message, 403)
    params = call.get("params") or {}
    if not isinstance(params, dict):
        raise OutboundError("An AWS call's params are a mapping of the operation's parameters.")
    try:
        target = resolve_target(db, connection_of(db, user, call.get("connection"), aws=True), user)
        identity = resolve_identity(db, target, user)
    except (ResolveError, ValueError) as e:
        raise OutboundError(masking.mask(str(e)), 403) from None
    try:
        reply = aws_request.call(service, name, params, target.account_id, target.region, identity,
                                 bool(call.get("paginate")))
    except (ClientError, ParamValidationError, BotoCoreError, aws_client.AssumeRoleError,
            aws_request.AwsRequestError) as e:
        raise OutboundError(aws_request._readable(e, target.name)) from None
    return {"reply": json.loads(masking.mask(json.dumps(reply)))}
