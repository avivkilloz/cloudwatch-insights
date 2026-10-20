"""Step types made in the Builder (PLATFORM_PLAN.md §7.3, §24, D122): a step a
workflow uses by name, written once, as data -- never code (code is Phase 6):

    label: Restart a device
    inputs:
      - {key: connection, type: connection, connection_type: devices_api}
      - {key: device, required: true}
    request:                       # a declarative HTTP request ...
      connection: connection
      method: POST
      path: "/devices/{{ inputs.device }}/restart"
      body: {reason: "{{ inputs.reason }}"}

    steps:                         # ... or a chain of steps used as one
      - {id: find, pane: api-table, action: fetch, with: {...}}
      - {id: each, step: default:restart_device, for_each: "...", with: {...}}
    outputs: {restarted: "{{ steps.each.outputs }}"}

A workflow names one with `step: default:restart_device` and gives its
inputs in `with`. Templates are the workflows' CEL (`{{ … }}`) over `inputs`
-- and, in a chain, `steps`, `item`, `index`, `run`.

What it may reach is its runner's: a request goes out as the person running
the workflow, with their group's identity on the connection (or the
connection's own), through the HTTP client's SSRF guard, the reply masked --
as a pane's request does (`routers/panes.run_request`). A chain's steps run
through the same runners a workflow's do. A step type that changes something
(any method but GET, or a chain holding one) waits for a person in a workflow,
as an `effects: external` action does (`workflows._gate`).

Like built pane types, they are a registry (`REGISTRY`), loaded at start and
after every save, other replicas following the Builder's generation; a
workflow is checked against it.
"""

from __future__ import annotations

import datetime
import json
import logging
import re
from typing import Any, Optional

import yaml
from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy.orm import Session

from . import connections, credential_types, masking, models, store, tools_http_client, workflows
from .resolve import ResolveError, resolve_identity_values, resolve_target

logger = logging.getLogger(__name__)

ID_RE = workflows.ID_RE
METHODS = ("GET", "POST", "PUT", "PATCH", "DELETE")
# A chain inside a chain inside a chain is as deep as a step goes.
MAX_DEPTH = 3
ROWS_KEYS = {"at", "columns", "explode", "spread", "labels"}


class StepTypeError(ValueError):
    """A step type that can't be accepted; `errors` is every problem, each
    `{line, message}`."""

    def __init__(self, message: str, errors: Optional[list[dict]] = None):
        super().__init__(message)
        self.errors = errors or [{"line": None, "message": message}]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class HttpRequest(_Strict):
    # The input holding the connection: one of an HTTP type.
    connection: str
    method: str = "GET"
    # After the connection's base URL. Templates over `inputs`, here and below.
    path: str = ""
    query: dict[str, Any] = {}
    headers: dict[str, str] = {}
    # Sent as JSON (a string as it is).
    body: Any = None
    # How the reply becomes rows (platform_tools/panes.extract_rows): at,
    # columns, explode, spread, labels.
    rows: Optional[dict[str, Any]] = None


class Definition(_Strict):
    id: Optional[str] = None
    label: str
    description: Optional[str] = None
    inputs: list[workflows.Param] = []
    request: Optional[HttpRequest] = None
    steps: Optional[list[workflows.Step]] = None
    # A chain's outputs, each a template over its steps; without them, each
    # step's outputs under its id.
    outputs: dict[str, Any] = {}


REGISTRY: dict[str, Definition] = {}


def get(type_id: str) -> Optional[Definition]:
    return REGISTRY.get(type_id)


def load(db: Session) -> None:
    """Every saved step type into the registry. One that no longer passes
    (a pane it named was removed) is left out and logged, not fatal."""
    found: dict[str, Definition] = {}
    rows = db.query(models.BuiltStepType).all()
    # A chain may name another: loaded until nothing more passes.
    pending = {r.id: r.source for r in rows}
    while pending:
        progress = False
        for type_id, source in list(pending.items()):
            REGISTRY.clear()
            REGISTRY.update(found)
            try:
                found[type_id] = parse(source, type_id)
                del pending[type_id]
                progress = True
            except StepTypeError:
                continue
        if not progress:
            for type_id in pending:
                logger.warning("Step type %s doesn't load", type_id)
            break
    REGISTRY.clear()
    REGISTRY.update(found)


# ---------------------------------------------------------------- the definition


def _line(source: str, path: tuple) -> Optional[int]:
    return workflows._line(source, path)


def parse(source: str, type_id: Optional[str] = None) -> Definition:
    """The step type in `source`, checked in full; StepTypeError with every
    problem, each with its line."""
    try:
        data = yaml.safe_load(source or "")
    except yaml.YAMLError as e:
        mark = getattr(e, "problem_mark", None)
        raise StepTypeError("Not valid YAML", [{"line": mark.line + 1 if mark else None,
                                                "message": f"Not valid YAML: {getattr(e, 'problem', e)}"}]) from None
    if not isinstance(data, dict):
        raise StepTypeError("A step type is a mapping", [{"line": 1, "message": "A step type is a mapping: label, "
                                                                                "inputs, and a request or steps."}])
    if type_id is not None and data.get("id") not in (None, type_id, store.split_id(type_id)[1]):
        raise StepTypeError("Wrong id", [{"line": _line(source, ("id",)),
                                          "message": f"Its id is {type_id} (the Id above), not {data['id']}."}])
    try:
        definition = Definition.model_validate(data)
    except ValidationError as e:
        errors = []
        for err in e.errors():
            loc = tuple(err["loc"])
            where = ".".join(str(p) for p in loc)
            message = err["msg"].removeprefix("Value error, ")
            if err["type"] == "extra_forbidden" and len(loc) == 1:
                message = f"there is no {loc[0]} here; a step type may say: {', '.join(Definition.model_fields)}"
            errors.append({"line": _line(source, loc), "message": f"{where}: {message}" if where else message})
        raise StepTypeError(errors[0]["message"], errors) from None
    errors = check(definition, source, chain=(type_id,) if type_id else ())
    if errors:
        raise StepTypeError(errors[0]["message"], errors)
    return definition


def check(definition: Definition, source: str = "", chain: tuple = ()) -> list[dict]:
    errors: list[dict] = []

    def err(path: tuple, message: str) -> None:
        errors.append({"line": _line(source, path) if source else None, "message": message})

    workflows.check_params(definition.inputs, err, "inputs")
    inputs = {p.key: p for p in definition.inputs}
    if (definition.request is None) == (definition.steps is None):
        err(("request",) if definition.request else (), "A step type is a request or steps: one of them.")
    if definition.request is not None:
        _check_request(definition.request, inputs, err)
        if definition.outputs:
            err(("outputs",), "A request's outputs are its reply: status, response and rows.")
    if definition.steps is not None:
        if not definition.steps:
            err(("steps",), "A step type's steps can't be empty.")
        workflows.check_steps(definition.steps, err, ("steps",), within=definition.label, chain=chain)
        ids = [s.id for s in definition.steps]
        for key, value in definition.outputs.items():
            for path, text in _strings(value, ("outputs", key)):
                for expr in workflows._expressions(text):
                    try:
                        workflows._compiled(expr)
                    except workflows.WorkflowError as e:
                        err(path, f"outputs.{key}: {e}")
                        continue
                    for ref in workflows._step_refs(expr):
                        if ref not in ids:
                            err(path, f"outputs.{key} refers to steps.{ref}, which isn't one of its steps.")
    for path, text in _all_strings(definition):
        for expr in workflows._expressions(text):
            for ref in re.findall(r"\binputs\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)", expr):
                if ref not in inputs:
                    err(path, f"inputs.{ref} isn't one of its inputs ({', '.join(inputs) or 'none'}).")
    return errors


def _check_request(request: HttpRequest, inputs: dict[str, workflows.Param], err) -> None:
    conn = inputs.get(request.connection)
    if conn is None or conn.type != "connection" or conn.connection_type in (None, "aws"):
        err(("request", "connection"), f"{request.connection!r} must name an input of type connection whose "
                                       "connection_type is an HTTP type (http_api, or one made in Settings).")
    if request.method.upper() not in METHODS:
        err(("request", "method"), f"method is one of {', '.join(METHODS)}.")
    if request.rows is not None:
        extra = set(request.rows) - ROWS_KEYS
        if extra:
            err(("request", "rows"), f"rows has no {', '.join(sorted(extra))} (it may say: {', '.join(sorted(ROWS_KEYS))}).")
    for path, text in _strings(request.model_dump(exclude={"rows", "connection", "method"}), ("request",)):
        for expr in workflows._expressions(text):
            try:
                workflows._compiled(expr)
            except workflows.WorkflowError as e:
                err(path, str(e))
                continue
            if workflows._step_refs(expr) or "params" in workflows._names(expr):
                err(path, "A request's templates read its inputs (inputs.<key>), nothing else.")


def _strings(value: Any, path: tuple) -> list[tuple[tuple, str]]:
    out: list[tuple[tuple, str]] = []
    if isinstance(value, str):
        out.append((path, value))
    elif isinstance(value, dict):
        for k, v in value.items():
            out += _strings(v, path + (k,))
    elif isinstance(value, list):
        for i, v in enumerate(value):
            out += _strings(v, path + (i,))
    return out


def _all_strings(definition: Definition) -> list[tuple[tuple, str]]:
    out = _strings(definition.request.model_dump(exclude={"rows"}), ("request",)) if definition.request else []
    for i, step in enumerate(definition.steps or []):
        out += [(("steps", i) + path, text) for path, text in workflows._templates(step)]
    return out + _strings(definition.outputs, ("outputs",))


def external(definition: Definition, depth: int = 0) -> bool:
    """Whether it changes something outside the platform: a request that
    isn't a GET, or a chain holding one (D122) -- so a workflow's step that
    uses it waits for a person, as an `effects: external` action does."""
    if definition.request is not None:
        return definition.request.method.upper() != "GET"
    for step in definition.steps or []:
        action = workflows._action_of(step)
        if action is not None and action.effects == "external":
            return True
        inner = get(step.step) if step.step else None
        if inner is not None and depth < MAX_DEPTH and external(inner, depth + 1):
            return True
    return False


def check_use(step: workflows.Step, chain: tuple) -> list[tuple[tuple, str]]:
    """What's wrong with a workflow step (or a chain's) that names a step
    type: that it exists, isn't inside itself, and is given its inputs."""
    definition = get(step.step or "")
    if definition is None:
        known = ", ".join(sorted(REGISTRY)) or "none yet: make one in the Builder"
        return [(("step",), f"Step {step.id}: there is no step type '{step.step}' (there are: {known}).")]
    if step.step in chain or len(chain) >= MAX_DEPTH:
        return [(("step",), f"Step {step.id}: {step.step} would run inside itself, or too deep ({MAX_DEPTH} at most).")]
    out: list[tuple[tuple, str]] = []
    inputs = {p.key: p for p in definition.inputs}
    for key in step.with_:
        if key not in inputs:
            out.append((("with", key), f"Step {step.id}: {definition.label} has no input '{key}' "
                                       f"(it has: {', '.join(inputs) or 'none'})."))
    for p in definition.inputs:
        if p.required and p.default is None and p.key not in step.with_:
            out.append((("with",), f"Step {step.id}: {definition.label} needs {p.key}."))
    return out


def inputs_for(definition: Definition, given: Any) -> dict[str, Any]:
    """What it runs with: what the step gave, over the defaults; a required
    input missing is the step's failure, said."""
    values = {**{p.key: p.default for p in definition.inputs if p.default is not None}, **(given or {})}
    missing = [p.key for p in definition.inputs if p.required and values.get(p.key) in (None, "", [])]
    if missing:
        raise workflows.StepError(f"{definition.label} needs {', '.join(missing)}.")
    return values


# ---------------------------------------------------------------- running a request


def send(db: Session, user: models.User, definition: Definition, inputs: dict[str, Any]) -> dict[str, Any]:
    """The request, as `user`: the connection theirs to reach, their group's
    identity on it (else the connection's own), the SSRF guard, the reply
    masked. `{status, response, rows?}`."""
    from .platform_tools.panes import InputError, extract_rows

    request = definition.request
    assert request is not None
    conn_input = next(p for p in definition.inputs if p.key == request.connection)
    chosen = inputs.get(request.connection)
    if chosen in (None, ""):
        raise HTTPException(status_code=400, detail=f"{definition.label} needs {request.connection}: a connection.")
    try:
        target = resolve_target(db, int(chosen), user, type_id=conn_input.connection_type)
    except (ResolveError, ValueError) as e:
        raise HTTPException(status_code=403, detail=masking.mask(str(e))) from None
    if not connections.is_http(target.connection.type):
        raise HTTPException(status_code=400, detail=f"{target.name} isn't reached over HTTP.")
    scope = {"inputs": inputs}
    path = workflows._text(workflows.render(request.path, scope))
    url = connections.join_url(target.config["base_url"], path)
    query = {k: workflows._text(v) for k, v in (workflows.render(request.query, scope) or {}).items()
             if v not in (None, "")}
    if query:
        from urllib.parse import urlencode

        url += ("&" if "?" in url else "?") + urlencode(query)
    headers = {"Accept": "application/json", **{k: workflows._text(v) for k, v in
                                                 (workflows.render(request.headers, scope) or {}).items()}}
    body = workflows.render(request.body, scope) if request.body is not None else None
    data: Optional[str] = None
    if body is not None:
        data = body if isinstance(body, str) else json.dumps(body, default=str)
        headers.setdefault("Content-Type", "application/json")
    has_identity = (
        connections.group_identity(db, user.group, target.connection) is not None
        or target.connection.credential_id is not None
    )
    try:
        if has_identity:
            type_row, secret_values = resolve_identity_values(db, target, user)
            url, headers = credential_types.apply_inject(type_row, secret_values, url, headers)
        result = tools_http_client.send_request(request.method.upper(), url, headers=headers, body=data)
    except ResolveError as e:
        raise HTTPException(status_code=403, detail=masking.mask(str(e))) from None
    except (tools_http_client.ToolRequestError, credential_types.CredentialTypeError) as e:
        raise HTTPException(status_code=400, detail=masking.mask(str(e))) from None
    except Exception as e:  # noqa: BLE001 -- a connection that fails says so, readably
        raise HTTPException(status_code=502, detail=masking.mask(f"{target.name} didn't answer: {e}")) from None
    text = masking.mask(result["body"])
    status = result["status_code"]
    if status >= 400:
        # Refused (401/403/404) isn't tried again; anything else may be.
        code = status if status in workflows.REFUSED else 502
        raise HTTPException(status_code=code, detail=masking.mask(
            f"{target.name} answered HTTP {status} {result['status_text']}: {text[:300]}"))
    try:
        response: Any = json.loads(text) if text.strip() else None
    except ValueError:
        response = text
    out: dict[str, Any] = {"status": status, "response": response}
    if request.rows is not None:
        try:
            out["rows"] = extract_rows(response, request.rows)
        except InputError as e:
            raise HTTPException(status_code=400, detail=str(e)) from None
    return out


# ---------------------------------------------------------------- saving


def can_edit(user: models.User, row: Optional[models.BuiltStepType] = None) -> bool:
    """As a workflow (D121): an admin any; a builder their group's; without a
    row, whether they may make one."""
    group = user.group
    if group is None or not (group.is_admin or group.builder_enabled):
        return False
    return row is None or group.is_admin or (row.owner_group_id is not None and row.owner_group_id == group.id)


def save(db: Session, user: models.User, requested_id: Optional[str], source: str,
         row: Optional[models.BuiltStepType] = None) -> models.BuiltStepType:
    from . import builder

    if not can_edit(user, row):
        raise StepTypeError("Only an admin, or a builder of the group that made it, may change this step type."
                            if row else "Making step types is for admins and builders.")
    if row is None:
        try:
            type_id = store.full_id(db, requested_id or "", ID_RE)
        except store.StoreError as e:
            raise StepTypeError(str(e)) from None
        if db.get(models.BuiltStepType, type_id) is not None:
            raise StepTypeError(f"A step type {type_id} already exists.")
    else:
        type_id = row.id
    definition = parse(source, type_id)
    errors = access_errors(db, definition, user, source)
    if errors:
        raise StepTypeError(errors[0]["message"], errors)
    source = workflows.ensure_id_line(source, type_id)
    now = datetime.datetime.utcnow()
    if row is None:
        row = models.BuiltStepType(id=type_id, created_by_id=user.id, created_at=now,
                                   owner_group_id=None if user.group.is_admin else user.group.id)
        db.add(row)
    row.source, row.updated_by_id, row.updated_at = source, user.id, now
    builder._bump(db)
    db.flush()
    store.record(db, "step", row.id, "write", user)
    db.commit()
    load(db)
    return row


def access_errors(db: Session, definition: Definition, user: models.User, source: str = "") -> list[dict]:
    """A chain names only panes the builder's group may use, as a workflow
    does (D121)."""
    if definition.steps is None:
        return []
    return workflows.access_errors(db, workflows.Definition(label=definition.label, steps=definition.steps),
                                   user, source)


def used_by(db: Session, type_id: str) -> list[str]:
    """The workflows and step types that name it."""
    out = [w.label for w in db.query(models.Workflow).all()
           if any(s.get("step") == type_id for s in (w.definition or {}).get("steps") or [])]
    out += [d.label for k, d in REGISTRY.items() if k != type_id and any(s.step == type_id for s in d.steps or [])]
    return out


def delete(db: Session, user: models.User, row: models.BuiltStepType) -> None:
    from . import builder

    if not can_edit(user, row):
        raise StepTypeError("Only an admin, or a builder of the group that made it, may delete this step type.")
    users = used_by(db, row.id)
    if users:
        raise StepTypeError(f"{', '.join(users)} use{'s' if len(users) == 1 else ''} it: change them first.")
    store.record(db, "step", row.id, "delete", user)
    db.delete(row)
    builder._bump(db)
    db.commit()
    load(db)


def store_load(db: Session, data: dict, row: Optional[models.BuiltStepType],
               actor: Optional[models.User]) -> models.BuiltStepType:
    from . import builder

    type_id = str(data.get("id") or "")
    if not store.valid_id(type_id, ID_RE):
        raise store.StoreError(f"'{type_id}' isn't a step type id.")
    source = str(data.get("__source__") or "")
    try:
        definition = parse(source, type_id)
    except StepTypeError as e:
        raise store.StoreError(f"Step type {type_id}: {e}") from None
    if row is None:
        row = models.BuiltStepType(id=type_id, created_by_id=actor.id if actor else None)
        db.add(row)
    row.source, row.updated_at = source, datetime.datetime.utcnow()
    REGISTRY[type_id] = definition
    builder._bump(db)
    return row


def label_of(row: models.BuiltStepType) -> str:
    try:
        return str((yaml.safe_load(row.source) or {}).get("label") or row.id)
    except yaml.YAMLError:
        return row.id


# ---------------------------------------------------------------- what one may say


STARTER = """label: Post a message
description: Posts a message to an HTTP API -- a starting point; change it to what yours takes.
inputs:
  - key: connection
    type: connection
    connection_type: http_api
    label: API
  - key: text
    label: Message
    required: true
request:
  connection: connection
  method: POST
  path: /messages
  body:
    text: "{{ inputs.text }}"
"""

CHAIN_EXAMPLE = """label: Rows, then a note
description: A chain of steps used as one: its inputs in, its outputs out.
inputs:
  - key: connection
    type: connection
    connection_type: http_api
  - key: path
    default: /items
steps:
  - id: fetch
    pane: api-table
    action: fetch
    with:
      connection: "{{ inputs.connection }}"
      path: "{{ inputs.path }}"
  - id: said
    note: "{{ size(steps.fetch.outputs.rows) }} rows from {{ inputs.path }}"
outputs:
  rows: "{{ steps.fetch.outputs.rows }}"
  note: "{{ steps.said.outputs.text }}"
"""


def _fields(model: Any) -> dict[str, str]:
    from . import builder

    return builder._fields(model)


def reference(db: Session, user: models.User) -> dict[str, Any]:
    """What a step type may say, for the editor and the agent (D72): from the
    models, with the step types and the panes' actions there are."""
    from . import builder

    workflow = builder.reference(db, "workflow", user)
    return {
        "kind": "step",
        "what": "A step type, as YAML: label, description, inputs, and a request or steps (with outputs). Templates "
                "are CEL in {{ }} over inputs (and, in steps, steps.<id>.outputs, item, index, run).",
        "definition": _fields(Definition),
        "input": _fields(workflows.Param),
        "request": {**_fields(HttpRequest), "method": " | ".join(METHODS) + " (anything but GET waits for a "
                                                                            "person in a workflow)",
                    "rows": builder.ROWS_DOC},
        "step": _fields(workflows.Step),
        "outputs": "a request's: status, response, rows (when rows is given); steps': what `outputs` says, else "
                   "each step's outputs under its id",
        "panes": workflow.get("panes", []),
        "step_types": [{"id": k, "label": d.label, "inputs": [p.key for p in d.inputs]} for k, d in sorted(REGISTRY.items())],
        "examples": {"request": STARTER, "steps": CHAIN_EXAMPLE},
        "rules": [
            "A request's connection is an input of type connection with an HTTP connection_type (http_api, or one "
            "made in Settings -> Environments -> Types); it runs as whoever runs the workflow.",
            "Steps are a workflow's steps (a pane's action, another step type, a note), reading inputs.<key> where a "
            "workflow reads params; no approval or artifact inside -- the workflow's step that uses it is approved.",
            "A workflow uses it as: - id: x\\n  step: <its id>\\n  with: {<input>: <value>}",
        ],
    }


def describe(row: models.BuiltStepType) -> dict[str, Any]:
    definition = REGISTRY.get(row.id)
    return {
        "id": row.id,
        "label": definition.label if definition else label_of(row),
        "description": definition.description if definition else None,
        "kind": ("request" if definition.request else "steps") if definition else None,
        "external": external(definition) if definition else False,
        "inputs": [p.model_dump(exclude_none=True) for p in definition.inputs] if definition else [],
        "loads": definition is not None,
        "source": row.source,
        "owner_group_id": row.owner_group_id,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }
