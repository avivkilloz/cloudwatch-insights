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

from . import aws_client, masking, models, row_paths
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
    # The output the rows go to, when not `rows` (routers/panes.written).
    output: Optional[str] = None


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


def problems(manifest: pane_manifest.Manifest, spec: dict[str, Any],
             args: Optional[dict[str, str]] = None) -> list[tuple[tuple, str]]:
    """What's wrong with an AWS request, each as (path under `request`, message):
    the spec's shape, its connection input, and the operation -- one that
    exists, reads, hands out nothing secret, and answers with JSON. A row
    action's `args` are its inputs: its connection may be one of them (the
    row's Environment), as may what its params read."""
    try:
        parsed = AwsRequestSpec.model_validate(spec)
    except ValidationError as e:
        return [(tuple(err["loc"]), err["msg"]) for err in e.errors()]
    args = args or {}
    out: list[tuple[tuple, str]] = []
    conn = next((i for i in manifest.inputs if i.key == parsed.connection), None)
    if conn is None and parsed.connection in args:
        pass
    elif conn is None or conn.type not in ("connection", "connections") or (conn.connection_type or "aws") != "aws":
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
    known = {i.key for i in manifest.inputs} | set(args)
    for key, source in parsed.params.items():
        for one in source if isinstance(source, list) else [source]:
            if isinstance(one, dict) and "input" in one and one["input"] not in known:
                what = "an input or one of the row action's args" if args else "an input"
                out.append((("params", key), f"{key} reads {one['input']}, which isn't {what}."))
    if isinstance(parsed.rows, dict) and model.output_shape is not None:
        out += _rows_problems(name, model.output_shape, parsed.rows)
    return out


def _walk(shape: Any, path: str) -> tuple[Any, str]:
    """The shape at a path into a reply (row_paths: dotted, with [0] and
    [Key=Name] on a list), and "" -- or (None, why not)."""
    try:
        steps = row_paths.parts(path)
    except row_paths.PathError as e:
        return None, str(e)
    for i, part in enumerate(steps):
        where = "".join(("." if s[0] == "key" and j else "") + row_paths.describe(s)
                        for j, s in enumerate(steps[:i])) or "the top"
        if part[0] == "key" and shape.type_name == "list" and str(part[1]).isdigit():
            shape = shape.member
        elif part[0] == "key" and shape.type_name == "structure" and part[1] in shape.members:
            shape = shape.members[part[1]]
        elif part[0] == "key" and shape.type_name == "map":
            shape = shape.value
        elif part[0] in ("index", "match") and shape.type_name == "list":
            shape = shape.member
            if part[0] == "match" and (shape.type_name != "structure" or part[1] not in shape.members):
                has = ", ".join(shape.members) if shape.type_name == "structure" else shape.type_name
                return None, f"{where}'s items have no {part[1]} to pick one by (they have: {has})"
        elif part[0] == "key" and shape.type_name == "list":
            return None, f"{where} is the list itself, so there is no {part[1]} in it"
        elif part[0] in ("index", "match"):
            return None, f"{where} isn't a list, so {row_paths.describe(part)} picks nothing in it"
        else:
            has = ", ".join(shape.members) if shape.type_name == "structure" else shape.type_name
            return None, f"there is no {part[1]} at {where} (it has: {has})"
    return shape, ""


def lists(shape: Any, prefix: str = "", depth: int = 3) -> list[str]:
    """Where a reply keeps lists (dotted paths): what `rows.at` can name."""
    out: list[str] = []
    if shape is None or depth == 0 or shape.type_name != "structure":
        return out
    for name, member in shape.members.items():
        path = f"{prefix}{name}"
        if member.type_name == "list":
            out.append(path)
        elif member.type_name == "structure":
            out += lists(member, path + ".", depth - 1)
    return out


def _rows_problems(name: str, output: Any, rows: dict[str, Any]) -> list[tuple[tuple, str]]:
    """`rows` held to the operation's reply, offline: `at` a list that's
    there, and each column's path a field of its items. A model that guessed
    `at: jobs.items` got an empty table and no reason why."""
    at = str(rows.get("at") or "")
    if not at:
        return []
    shape, why = _walk(output, at)
    if shape is None or shape.type_name != "list":
        found = ", ".join(lists(output)) or "none"
        reason = why or f"{at} is a {shape.type_name}, not a list"
        return [(("rows", "at"), f"{name}'s reply: {reason}. Its lists are at: {found}.")]
    item = shape.member
    out: list[tuple[tuple, str]] = []
    if rows.get("explode"):
        item, why = _walk(item, str(rows["explode"]))
        if item is None or item.type_name != "list":
            return [(("rows", "explode"), f"{name}'s {at} items: {why or str(rows['explode']) + ' is not a list'}.")]
        item = item.member
    if item.type_name != "structure":
        return out
    for column, source in (rows.get("columns") or {}).items():
        path = source.get("from") if isinstance(source, dict) else source
        if not isinstance(path, str) or not path:
            continue
        found, why = _walk(item, path)
        if found is None:
            # A column is one value: a list in the item gives one item, picked by a field.
            listed, _ = _walk(item, path.rsplit(".", 1)[0]) if "." in path else (None, "")
            if listed is not None and listed.type_name == "list" and listed.member.type_name == "structure":
                field = next(iter(listed.member.members), "Key")
                why += f"; pick one item by a field, as {path.rsplit('.', 1)[0]}[{field}=…].{path.rsplit('.', 1)[1]}"
            items = f"{rows['explode']} (in each of {at})" if rows.get("explode") else f"{at} items"
            out.append((("rows", "columns", column), f"{name}'s {items} have no {path}: {why}."))
    return out


def _sketch(shape: Any, depth: int = 4, seen: Optional[set] = None) -> Any:
    """A reply's shape as a model reads it: {field: type, list: [{...}]}."""
    seen = seen or set()
    kind = shape.type_name
    if kind == "structure":
        if depth == 0 or shape.name in seen:
            return "{…}"
        members = list(shape.members.items())
        out = {k: _sketch(v, depth - 1, seen | {shape.name}) for k, v in members[:30]}
        if len(members) > 30:
            out["…"] = f"{len(members) - 30} more"
        return out
    if kind == "list":
        return [_sketch(shape.member, depth, seen)]
    if kind == "map":
        return {"<key>": _sketch(shape.value, depth - 1, seen)}
    return kind


def describe(service: str, operation: Optional[str] = None) -> dict[str, Any]:
    """What an AWS operation takes and answers, from botocore's model -- no
    call, no credentials: what a builder needs to write `params` and `rows`
    without guessing. Without an operation, the service's reads."""
    import difflib

    services = _botocore.get_available_services()
    if service not in services:
        close = difflib.get_close_matches(service, services, n=5, cutoff=0.5)
        raise AwsRequestError(f"There is no AWS service called {service!r}"
                              + (f"; did you mean {', '.join(close)}?" if close else "."))
    model = _botocore.get_service_model(service)
    if not operation:
        reads = [n for n in model.operation_names if refused(service, n) is None]
        return {"service": service, "reads": reads}
    try:
        name = operation_name(service, operation)
    except AwsRequestError:
        close = difflib.get_close_matches(operation, model.operation_names, n=5, cutoff=0.4)
        raise AwsRequestError(f"{service} has no operation {operation!r}"
                              + (f"; did you mean {', '.join(close)}?" if close else ".")) from None
    op = model.operation_model(name)
    inputs = op.input_shape
    required = set(inputs.required_members) if inputs is not None else set()
    params = {k: v.type_name + (" (required)" if k in required else "")
              for k, v in (inputs.members.items() if inputs is not None else [])}
    out: dict[str, Any] = {"service": service, "operation": name, "params": params}
    message = refused(service, name)
    if message:
        out["refused"] = message
    if op.output_shape is not None:
        out["reply"] = _sketch(op.output_shape)
        out["lists"] = lists(op.output_shape)
    try:
        out["paginates"] = _botocore.get_paginator_model(service).get_paginator(name) is not None
    except Exception:  # noqa: BLE001 -- botocore raises for a service or operation without paginators
        out["paginates"] = False
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
        if isinstance(source, list) and any(isinstance(s, dict) and "input" in s for s in source):
            # `InstanceIds: [{input: id}]`: each item read, a list input's spread in.
            value = []
            for one in source:
                got = values.get(one["input"]) if isinstance(one, dict) and "input" in one else one
                if isinstance(got, (set, list, tuple)):
                    value += sorted(got) if isinstance(got, set) else list(got)
                elif got not in (None, ""):
                    value.append(got)
            if not value:
                continue
        elif isinstance(source, dict) and "input" in source:
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

    if spec.rows is None:
        # A reply with no list (a Describe of one thing) has no rows: its
        # `response` is what there is.
        at = _first_list(reply)
        return extract_rows(reply, {"at": at}) if at or isinstance(reply, list) else []
    return extract_rows(reply, spec.rows)


def _readable(e: Exception, where: str) -> str:
    if isinstance(e, ClientError):
        err = e.response.get("Error", {})
        return masking.mask(f"{where}: {err.get('Code', 'Error')}: {err.get('Message', str(e))}")
    if isinstance(e, ParamValidationError):
        return masking.mask(f"{where}: {e.kwargs.get('report', e)}".strip())
    return masking.mask(f"{where}: {e}")


def _listed(params: dict[str, Any], shape: Any) -> dict[str, Any]:
    """A lone value given where the operation takes a list, as a list of it:
    `InstanceIds: {input: instance_id}` is one instance."""
    if shape is None or shape.type_name != "structure":
        return params
    out: dict[str, Any] = {}
    for key, value in params.items():
        member = shape.members.get(key)
        if member is not None and member.type_name == "list" and not isinstance(value, list):
            value = [value]
        elif member is not None and member.type_name == "structure" and isinstance(value, dict):
            value = _listed(value, member)
        out[key] = value
    return out


def connection_id(db: Session, user: models.User, value: Any) -> int:
    """A connection named by its id, or by the name the user sees it by --
    a row's Environment, which is what a row action has to go on."""
    if isinstance(value, int) or (isinstance(value, str) and value.strip().isdigit()):
        return int(value)
    from . import connections

    name = str(value or "").strip().lower()
    targets = connections.targets(db, user, connections.AWS)
    for key in ("label", "environment"):
        found = [t["id"] for t in targets if t[key].lower() == name]
        if len(found) == 1:
            return found[0]
    raise ResolveError(f"There is no AWS environment called {value!r} that you can reach.")


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
        params = _listed(_params(spec, values), _botocore.get_service_model(spec.service).operation_model(operation)
                         .input_shape)
    except timewindow.TimeRangeError as e:
        raise HTTPException(status_code=400, detail=str(e)) from None

    def one(account_id: str, region: str, identity: aws_client.Identity) -> dict[str, Any]:
        return call(spec.service, operation, params, account_id, region, identity, spec.paginate, spec.max_items)

    # Several connections -- unless one was given: a row action's, from the
    # row's Environment.
    if conn is not None and conn.type == "connections" and (chosen is None or isinstance(chosen, (list, set, tuple))):
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
        target = resolve_target(db, connection_id(db, user, chosen), user)
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
