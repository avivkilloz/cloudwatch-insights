"""A request to an AWS connection (PLATFORM_PLAN.md §24, D110): any AWS API a
pane needs, said in its manifest the way an HTTP request is (D67) -- data,
never code -- so a pane type made in the Builder can list Lambda functions,
ECS services or SQS queues without a handler written for each.

    request:
      connection: connection      # an input of type connection (or connections), connection_type aws
      service: lambda             # botocore's service name
      operation: ListFunctions    # the API's operation (list_functions is the same)
      params: {FunctionVersion: ALL, MaxItems: {input: limit}}
      paginate: true              # follow the reply's pages, up to max_items
      rows: {at: Functions, columns: {Name: FunctionName, Runtime: Runtime}}

A `request` with a `service` is this; without one it is an HTTP GET
(`routers/panes.run_request`, which hands this one here), so every place that
runs a request -- the action endpoint, the agent, workflows, refresh -- runs
it too. It runs as the caller's group's identity on the connection, like any
AWS pane (`resolve.resolve_identity`); with a `connections` input, on each
(`handlers.fan_out`), its rows in one list with an `Environment` column first
-- a table needs nothing more -- and the connections that failed in `error`,
one line each, never failing the rest.

Only reads, for now: an operation named as one (`List…`, `Describe…`,
`Get…`, …) and not one that hands out credentials or secrets
(`GetSecretValue`, `sts`, `GetAuthorizationToken`…, `DENIED`). A write is
an `effects: external` action, which needs the approval step a pane doesn't
have yet. A reply that streams (S3's GetObject) isn't JSON to make rows of.
"""

from __future__ import annotations

import base64
import datetime
import decimal
import json
from typing import Any, Optional

import botocore.session
from botocore import xform_name
from botocore.exceptions import BotoCoreError, ClientError, ParamValidationError
from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy.orm import Session

from . import aws_client, masking, models
from .panes import manifest as pane_manifest
from .panes import timewindow
from .resolve import ResolveError, resolve_identity, resolve_target

# What an operation's name starts with when it only reads.
READS = ("List", "Describe", "Get", "Search", "Query", "Scan", "BatchGet", "Lookup", "Head")

# Reads that hand out credentials, tokens or secret values: a pane anyone
# granted it can open is no place for them (CLAUDE.md: never return
# credentials or assumed-role tokens). "*" is the whole service.
DENIED: dict[str, Any] = {
    "sts": "*",
    "sso": "*",
    "sso-oidc": "*",
    "secretsmanager": {"GetSecretValue", "BatchGetSecretValue"},
    "ssm": {"GetParameter", "GetParameters", "GetParametersByPath", "GetParameterHistory"},
    "cognito-identity": {"GetCredentialsForIdentity", "GetOpenIdToken", "GetOpenIdTokenForDeveloperIdentity"},
    "ecr": {"GetAuthorizationToken"},
    "ecr-public": {"GetAuthorizationToken"},
    "codeartifact": {"GetAuthorizationToken"},
    "redshift": {"GetClusterCredentials", "GetClusterCredentialsWithIAM"},
    "redshift-serverless": {"GetCredentials"},
    "ec2": {"GetPasswordData"},
    "lightsail": {"GetInstanceAccessDetails", "GetRelationalDatabaseMasterUserPassword"},
}

MAX_ITEMS = 5000

# The service models, read from botocore's own data -- no AWS call, no credentials.
_botocore = botocore.session.get_session()


class AwsRequestSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    connection: str
    service: str
    operation: str
    # Each parameter a literal, `{input: key}` (left out while empty) or
    # `{window: start|end|step}` (epoch seconds over the inputs `window`
    # names). A dotted name is nested: `Filter.Name`.
    params: dict[str, Any] = {}
    window: dict[str, str] = {}
    paginate: bool = False
    max_items: int = Field(default=1000, ge=1, le=MAX_ITEMS)
    # How the reply becomes rows (routers/panes' `extract_rows`: at, columns,
    # explode, spread); without it, the first list in the reply.
    rows: Optional[dict[str, Any]] = None


def is_aws(spec: Optional[dict[str, Any]]) -> bool:
    return isinstance(spec, dict) and "service" in spec


class AwsRequestError(ValueError):
    """A request a manifest can't make; its message says why."""


def operation_name(service: str, operation: str) -> str:
    """The API's own name for an operation, given that or its Python one."""
    try:
        model = _botocore.get_service_model(service)
    except Exception:  # noqa: BLE001 -- botocore's UnknownServiceError and kin
        raise AwsRequestError(f"There is no AWS service called {service!r} (botocore's names: lambda, ecs, sqs…).") from None
    if operation in model.operation_names:
        return operation
    for name in model.operation_names:
        if xform_name(name) == operation:
            return name
    raise AwsRequestError(f"{service} has no operation {operation!r}.")


def problems(manifest: pane_manifest.Manifest, spec: dict[str, Any]) -> list[tuple[tuple, str]]:
    """What's wrong with an AWS request, each as (path under `request`, message):
    the spec's shape, its connection input, and the operation -- one that
    exists, reads, hands out nothing secret, and answers with JSON."""
    try:
        parsed = AwsRequestSpec.model_validate(spec)
    except ValidationError as e:
        return [(tuple(err["loc"]), err["msg"]) for err in e.errors()]
    out: list[tuple[tuple, str]] = []
    conn = next((i for i in manifest.inputs if i.key == parsed.connection), None)
    if conn is None or conn.type not in ("connection", "connections") or (conn.connection_type or "aws") != "aws":
        out.append((("connection",), f"{parsed.connection!r} must name an input of type connection or connections, "
                                      "connection_type aws."))
    try:
        name = operation_name(parsed.service, parsed.operation)
    except AwsRequestError as e:
        return [*out, (("operation",), str(e))]
    message = refused(parsed.service, name)
    if message:
        out.append((("operation",), message))
    model = _botocore.get_service_model(parsed.service).operation_model(name)
    if model.has_streaming_output:
        out.append((("operation",), f"{name} answers with a stream, not JSON to make rows of."))
    members = set(model.input_shape.members) if model.input_shape is not None else set()
    for key in parsed.params:
        if key.split(".")[0] not in members:
            known = ", ".join(sorted(members)) or "none"
            out.append((("params", key), f"{name} has no parameter {key.split('.')[0]} (it takes: {known})."))
    for key, source in parsed.params.items():
        if isinstance(source, dict) and "input" in source and source["input"] not in {i.key for i in manifest.inputs}:
            out.append((("params", key), f"{key} reads an input {source['input']} that isn't declared."))
    return out


def refused(service: str, operation: str) -> Optional[str]:
    """Why an operation can't run from a pane, or None."""
    if not operation.startswith(READS):
        return (f"{operation} changes something; a pane's AWS request only reads for now "
                f"(an operation named {', '.join(READS[:4])}…).")
    denied = DENIED.get(service)
    if denied == "*" or (isinstance(denied, set) and operation in denied):
        return f"{service} {operation} hands out credentials or secrets, which a pane never shows."
    return None


def _params(spec: AwsRequestSpec, values: dict[str, Any]) -> dict[str, Any]:
    """The call's parameters, typed as they are (AWS wants numbers and lists,
    not the strings a query string is made of)."""
    out: dict[str, Any] = {}
    span: Optional[tuple[int, int]] = None
    for name, source in spec.params.items():
        if isinstance(source, dict) and "input" in source:
            value = values.get(source["input"])
            if value in (None, "", []):
                continue
            if isinstance(value, set):
                value = sorted(value)
        elif isinstance(source, dict) and "window" in source:
            if span is None:
                keys = spec.window
                span = timewindow.window(
                    {
                        "preset": values.get(keys.get("preset", "")),
                        "customStart": values.get(keys.get("start", "")),
                        "customEnd": values.get(keys.get("end", "")),
                    },
                    values.get("_tz"),
                )
            start, end = span
            value = {"start": start, "end": end, "step": max(60, round((end - start) / 240))}[source["window"]]
        else:
            value = source
        here = out
        *parents, last = name.split(".")
        for part in parents:
            here = here.setdefault(part, {})
        here[last] = value
    return out


def _plain(value: Any) -> Any:
    if isinstance(value, (datetime.datetime, datetime.date)):
        return value.isoformat()
    if isinstance(value, decimal.Decimal):
        return float(value)
    if isinstance(value, (bytes, bytearray)):
        return base64.b64encode(value).decode()
    return str(value)


def call(service: str, operation: str, params: dict[str, Any], account_id: str, region: str,
         identity: aws_client.Identity, paginate: bool = False, max_items: int = 1000) -> dict[str, Any]:
    """The operation's reply as JSON-ready data, every page of it when asked
    (up to max_items). Never given a write or a denied read: checked again
    here, whatever the manifest's check said."""
    message = refused(service, operation)
    if message:
        raise AwsRequestError(message)
    client = aws_client.get_client(service, account_id, region, identity)
    method = xform_name(operation)
    if paginate and client.can_paginate(method):
        pages = client.get_paginator(method).paginate(**params, PaginationConfig={"MaxItems": max_items})
        reply = pages.build_full_result()
    else:
        reply = getattr(client, method)(**params)
    reply.pop("ResponseMetadata", None)
    return json.loads(json.dumps(reply, default=_plain))


def _first_list(reply: Any) -> str:
    """Where a reply keeps its list, when the manifest doesn't say: the first
    key holding one (ListFunctions' `Functions`)."""
    if isinstance(reply, dict):
        for key, value in reply.items():
            if isinstance(value, list):
                return key
    return ""


def _rows(spec: AwsRequestSpec, reply: dict[str, Any]) -> list[dict]:
    from .platform_tools.panes import extract_rows

    return extract_rows(reply, spec.rows if spec.rows is not None else {"at": _first_list(reply)})


def _readable(e: Exception, where: str) -> str:
    if isinstance(e, ClientError):
        err = e.response.get("Error", {})
        return masking.mask(f"{where}: {err.get('Code', 'Error')}: {err.get('Message', str(e))}")
    if isinstance(e, ParamValidationError):
        return masking.mask(f"{where}: {e.kwargs.get('report', e)}".strip())
    return masking.mask(f"{where}: {e}")


def run(db: Session, user: models.User, manifest: pane_manifest.Manifest, spec_data: dict[str, Any],
        values: dict[str, Any]) -> dict[str, Any]:
    """The request, as the caller: `rows` and `response` for one connection;
    for several, `rows` from each with its `Environment`, and `error` naming
    the ones that failed (None when none did, so an old one is cleared)."""
    from .panes import handlers as pane_handlers
    from .platform_tools.panes import InputError

    try:
        spec = AwsRequestSpec.model_validate(spec_data)
        operation = operation_name(spec.service, spec.operation)
    except (ValidationError, AwsRequestError) as e:
        raise HTTPException(status_code=400, detail=f"{manifest.label}'s AWS request: {e}") from None
    message = refused(spec.service, operation)
    if message:
        raise HTTPException(status_code=400, detail=message)
    conn = next((i for i in manifest.inputs if i.key == spec.connection), None)
    chosen = values.get(spec.connection)
    try:
        params = _params(spec, values)
    except timewindow.TimeRangeError as e:
        raise HTTPException(status_code=400, detail=str(e)) from None

    def one(account_id: str, region: str, identity: aws_client.Identity) -> dict[str, Any]:
        return call(spec.service, operation, params, account_id, region, identity, spec.paginate, spec.max_items)

    if conn is not None and conn.type == "connections":
        ids = sorted(chosen) if isinstance(chosen, set) else list(chosen or [])
        if not ids:
            raise HTTPException(status_code=400, detail="Pick an environment first.")

        def rows_of(account_id: str, region: str, identity: aws_client.Identity) -> list[dict]:
            try:
                return _rows(spec, one(account_id, region, identity))
            except ClientError as e:
                # Said as one connection's is ("AccessDeniedException: …"), not
                # botocore's "An error occurred (…) when calling …".
                err = e.response.get("Error", {})
                raise AwsRequestError(f"{err.get('Code', 'Error')}: {err.get('Message', str(e))}") from None

        groups = pane_handlers.fan_out(db, user, [int(i) for i in ids], "rows", rows_of)
        rows: list[dict] = []
        failed: list[str] = []
        for group in groups:
            if group.get("error"):
                # Made into text on a worker thread, without the request's
                # masking: masked here, as one connection's reply is.
                failed.append(masking.mask(f"{group['environment_name']}: {group['error']}"))
            rows.extend({"Environment": group["environment_name"], **row} for row in group.get("rows") or [])
        if failed and len(failed) == len(groups):
            raise HTTPException(status_code=400, detail="\n".join(failed))
        return {"rows": json.loads(masking.mask(json.dumps(rows))), "error": "\n".join(failed) or None}

    if chosen in (None, ""):
        raise HTTPException(status_code=400, detail="Pick an environment first.")
    try:
        target = resolve_target(db, int(chosen), user)
        identity = resolve_identity(db, target, user)
    except (ResolveError, ValueError) as e:
        raise HTTPException(status_code=400, detail=masking.mask(str(e))) from None
    try:
        reply = one(target.account_id, target.region, identity)
    except (ClientError, ParamValidationError, BotoCoreError, aws_client.AssumeRoleError, AwsRequestError) as e:
        raise HTTPException(status_code=400, detail=_readable(e, target.name)) from None
    reply = json.loads(masking.mask(json.dumps(reply)))
    try:
        rows = _rows(spec, reply)
    except InputError as e:
        raise HTTPException(status_code=400, detail=str(e)) from None
    return {"rows": rows, "response": reply}
