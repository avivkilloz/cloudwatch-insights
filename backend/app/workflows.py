"""Workflows (PLATFORM_PLAN.md §5, §22, D82-D86): parameters and a list of
steps, run with parameters on a page of their own, each run recorded.

A step is an Action a pane already runs -- a manifest's `request` or
`handler`, called through the very functions the browser's action endpoint
and the agent's `run_pane` call (`routers/panes.run_request`/`run_handler`)
-- so a workflow needs no code of its own and reaches nothing a person's own
click wouldn't: every step acts as whoever started the run, through the pane's
access check and its connection's. Or a `note`: text, for a summary.

The definition is YAML, kept verbatim (it's the store repo's file, D70) and
checked in full on save (D83): the schema, unique ids, every pane, action and
input existing, every expression compiling, and every `steps.<id>` naming an
earlier step. Expressions are CEL inside `{{ … }}` (D8): a value that is one
template is its typed result, text around templates makes a string. They see
`params`, `steps.<id>.outputs`/`.status`, `item`, `index` and `run`, never a
secret.

Runs are run in-process (D85): started as `queued`, claimed by any replica
(`FOR UPDATE SKIP LOCKED`) and run on a thread by `manager`, step by step, each
step recorded as it goes. One whose replica went away (no heartbeat) is marked
failed, not resumed. Cancel is looked for between steps and items.
"""

from __future__ import annotations

import asyncio
import contextlib
import datetime
import functools
import json
import logging
import os
import re
import socket
from typing import Any, Literal, Optional

import yaml
from cel_expr_python import cel
from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy.orm import Session

from . import connections, masking, models, pane_access, pane_outputs
from .db import SessionLocal
from .panes import manifest as pane_manifest
from .resolve import ResolveError

log = logging.getLogger("workflows")

ID_RE = re.compile(r"^[a-z][a-z0-9_]{1,63}$")
STEP_ID_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
MAX_STEPS = 50
MAX_ITEMS = 200
# A step's outputs are capped like a pane's (cut down, not refused): the run
# page and later steps see the start of a long list.
STEP_OUTPUT_BYTES = 1024 * 1024
HEARTBEAT_STALE_SECONDS = 300
SCOPE = ("params", "steps", "item", "index", "run")
REPLICA = f"{socket.gethostname()}:{os.getpid()}"
FINISHED = ("succeeded", "failed", "cancelled")


class WorkflowError(ValueError):
    """A definition, parameters or a request about a workflow that can't be
    accepted, said so a person can act on it. `errors` lists every problem
    found (each `{line, message}`), the message the first ones."""

    def __init__(self, message: str, errors: Optional[list[dict]] = None):
        super().__init__(message)
        self.errors = errors or [{"line": None, "message": message}]


class StepError(RuntimeError):
    """A step that failed as it ran."""


# ------------------------------------------------------------------- the definition


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


ParamType = Literal["text", "int", "bool", "choice", "connection", "connections"]


class Param(_Strict):
    key: str
    type: ParamType = "text"
    label: Optional[str] = None
    help: str = ""
    default: Any = None
    required: bool = False
    choices: list[Any] = []
    connection_type: Optional[str] = None


class Step(_Strict):
    id: str
    label: Optional[str] = None
    pane: Optional[str] = None
    action: Optional[str] = None
    with_: dict[str, Any] = Field(default_factory=dict, alias="with")
    note: Optional[str] = None
    if_: Optional[str] = Field(default=None, alias="if")
    for_each: Optional[Any] = None
    continue_on_error: bool = False


class Definition(_Strict):
    id: Optional[str] = None
    label: str
    description: Optional[str] = None
    parameters: list[Param] = []
    steps: list[Step]


def _line(source: str, path: tuple) -> Optional[int]:
    """The source line a path into the YAML starts on, for an error to point at."""
    try:
        node = yaml.compose(source)
    except yaml.YAMLError:
        return None
    for part in path:
        if isinstance(node, yaml.MappingNode):
            node = next((v for k, v in node.value if k.value == part), None)
        elif isinstance(node, yaml.SequenceNode) and isinstance(part, int) and part < len(node.value):
            node = node.value[part]
        else:
            break
        if node is None:
            return None
    return node.start_mark.line + 1 if node is not None else None


def _fail(errors: list[dict]) -> WorkflowError:
    text = "\n".join(f"Line {e['line']}: {e['message']}" if e.get("line") else e["message"] for e in errors[:8])
    return WorkflowError(text, errors)


def parse(source: str) -> Definition:
    """The definition in `source`, checked in full, or a WorkflowError listing
    every problem with the line it's on."""
    try:
        data = yaml.safe_load(source or "")
    except yaml.YAMLError as e:
        mark = getattr(e, "problem_mark", None)
        raise _fail([{"line": mark.line + 1 if mark else None, "message": f"Not valid YAML: {getattr(e, 'problem', e)}"}])
    if not isinstance(data, dict):
        raise _fail([{"line": 1, "message": "A workflow is a mapping: label, parameters, steps."}])
    try:
        definition = Definition.model_validate(data)
    except ValidationError as e:
        errors = []
        for err in e.errors():
            loc = tuple(p if not isinstance(p, str) else {"with_": "with", "if_": "if"}.get(p, p) for p in err["loc"])
            where = ".".join(str(p) for p in loc)
            errors.append({"line": _line(source, loc), "message": f"{where}: {err['msg']}"})
        raise _fail(errors) from None
    errors = check(definition, source)
    if errors:
        raise _fail(errors)
    return definition


def check(definition: Definition, source: str = "") -> list[dict]:
    """Everything a run would trip on, found before it starts."""
    errors: list[dict] = []

    def err(path: tuple, message: str) -> None:
        errors.append({"line": _line(source, path) if source else None, "message": message})

    keys: set[str] = set()
    for i, p in enumerate(definition.parameters):
        if not STEP_ID_RE.match(p.key):
            err(("parameters", i), f"'{p.key}' can't be a parameter's key: lowercase letters, digits and _.")
        if p.key in keys:
            err(("parameters", i), f"Two parameters are called {p.key}.")
        keys.add(p.key)
        if p.type == "choice" and not p.choices:
            err(("parameters", i), f"{p.key} is a choice with nothing to choose from.")
        if p.type in ("connection", "connections") and not p.connection_type:
            err(("parameters", i), f"{p.key} needs a connection_type (aws, or an HTTP type's id).")
    if not definition.steps:
        err(("steps",), "A workflow needs at least one step.")
    if len(definition.steps) > MAX_STEPS:
        err(("steps",), f"A workflow has at most {MAX_STEPS} steps.")

    earlier: list[str] = []
    for i, step in enumerate(definition.steps):
        here = ("steps", i)
        if not STEP_ID_RE.match(step.id):
            err(here, f"'{step.id}' can't be a step's id: lowercase letters, digits and _.")
        if step.id in earlier:
            err(here, f"Two steps are called {step.id}.")
        if step.note is None and not (step.pane and step.action):
            err(here, f"Step {step.id} needs a pane and an action, or a note.")
        if step.note is not None and (step.pane or step.action or step.with_):
            err(here, f"Step {step.id} is a note: it has no pane, action or with.")
        if step.pane and step.action:
            for where, message in _check_action(step):
                err(here + where, message)
        for path, text in _templates(step):
            for expr in _expressions(text, whole=path[0] in ("if", "for_each")):
                try:
                    _compiled(expr)
                except WorkflowError as e:
                    err(here + path, f"Step {step.id}: {e}")
                    continue
                for ref in _step_refs(expr):
                    if ref == step.id:
                        err(here + path, f"Step {step.id} refers to its own outputs.")
                    elif ref not in earlier:
                        err(here + path, f"Step {step.id} refers to steps.{ref}, which isn't a step before it.")
                if "item" in _names(expr) and step.for_each is None and path[0] != "for_each":
                    err(here + path, f"Step {step.id} uses item, but it has no for_each.")
        earlier.append(step.id)
    return errors


def _check_action(step: Step) -> list[tuple[tuple, str]]:
    """What's wrong with a step's pane, action and inputs, each with the field it's on."""
    manifest = pane_manifest.get(step.pane or "")
    if manifest is None:
        return [(("pane",), f"Step {step.id}: there is no pane type '{step.pane}'.")]
    action = next((a for a in manifest.actions if a.id == step.action), None)
    if action is None:
        known = ", ".join(a.id for a in manifest.actions if a.request is not None or a.handler)
        return [(("action",), f"Step {step.id}: {manifest.label} has no action '{step.action}' (it has: {known or 'none'}).")]
    out: list[tuple[tuple, str]] = []
    if action.poll is not None:
        out.append((("action",), f"Step {step.id}: {manifest.label}'s {action.id} runs in the background; steps like it come next (4b-2)."))
    elif action.effects == "external":
        out.append((("action",), f"Step {step.id}: {manifest.label}'s {action.id} acts outside the platform, which needs an approval step (4b-2)."))
    elif action.request is None and not action.handler:
        out.append((("action",), f"Step {step.id}: {manifest.label}'s {action.id} runs in the browser, not on the server."))
    inputs = {i.key: i for i in manifest.inputs}
    for key in step.with_:
        if key not in inputs:
            out.append((("with", key), f"Step {step.id}: {manifest.label} has no input '{key}' (it has: {', '.join(inputs)})."))
        elif inputs[key].sensitive:
            out.append((("with", key), f"Step {step.id}: {manifest.label}'s {key} is sensitive and never goes in a workflow."))
    return out


def _templates(step: Step) -> list[tuple[tuple, str]]:
    """Every string of a step that may hold expressions, with where it is."""
    out: list[tuple[tuple, str]] = []

    def walk(value: Any, path: tuple) -> None:
        if isinstance(value, str):
            out.append((path, value))
        elif isinstance(value, dict):
            for k, v in value.items():
                walk(v, path + (k,))
        elif isinstance(value, list):
            for j, v in enumerate(value):
                walk(v, path + (j,))

    walk(step.with_, ("with",))
    if step.note is not None:
        out.append((("note",), step.note))
    if step.if_ is not None:
        out.append((("if",), step.if_))
    if isinstance(step.for_each, str):
        out.append((("for_each",), step.for_each))
    return out


# ------------------------------------------------------------------- expressions

_TEMPLATE = re.compile(r"\{\{(.*?)\}\}", re.S)


def _expressions(text: str, whole: bool = False) -> list[str]:
    """The expressions in a string: its templates', or -- for `if` and
    `for_each`, which are expressions -- the string itself without braces."""
    found = [m.group(1).strip() for m in _TEMPLATE.finditer(text)]
    if found or not whole:
        return found
    return [text.strip()] if text.strip() else []


def _step_refs(expr: str) -> set[str]:
    return set(re.findall(r"\bsteps\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)", expr)) | set(
        re.findall(r"\bsteps\s*\[\s*['\"]([^'\"]+)['\"]\s*\]", expr)
    )


def _names(expr: str) -> set[str]:
    return set(re.findall(r"(?<![.\w])([A-Za-z_][A-Za-z0-9_]*)", expr))


@functools.lru_cache(maxsize=1024)
def _compiled(expression: str):
    env = cel.NewEnv(variables={name: cel.Type.DYN for name in SCOPE})
    try:
        return env.compile(expression)
    except RuntimeError as e:
        raw = str(e).split("ERROR: <input>:", 1)[-1].split("\n", 1)[0].strip()
        raise WorkflowError(f"`{expression}` doesn't compile: {raw}") from None


def evaluate(expression: str, scope: dict[str, Any]) -> Any:
    result = _compiled(expression).eval(data={name: scope.get(name) for name in SCOPE})
    if result.type() == cel.Type.ERROR:
        raise StepError(f"`{expression}` failed: {result.plain_value()}")
    return result.plain_value()


def _text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        return json.dumps(value, default=str)
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def render(value: Any, scope: dict[str, Any]) -> Any:
    """`value` with its templates worked out: a string that is one template is
    the expression's own value (a list stays a list); text around templates
    makes a string; dicts and lists are rendered all through."""
    if isinstance(value, dict):
        return {k: render(v, scope) for k, v in value.items()}
    if isinstance(value, list):
        return [render(v, scope) for v in value]
    if not isinstance(value, str):
        return value
    matches = list(_TEMPLATE.finditer(value))
    if not matches:
        return value
    if len(matches) == 1 and matches[0].span() == (0, len(value.strip())) and value == value.strip():
        return evaluate(matches[0].group(1).strip(), scope)
    return _TEMPLATE.sub(lambda m: _text(evaluate(m.group(1).strip(), scope)), value)


def _condition(text: Any, scope: dict[str, Any]) -> Any:
    """`if`/`for_each`: an expression, braces optional."""
    if not isinstance(text, str):
        return text
    exprs = _expressions(text, whole=True)
    if len(exprs) == 1 and (not _TEMPLATE.search(text) or text.strip().startswith("{{") and text.strip().endswith("}}")):
        return evaluate(exprs[0], scope)
    return render(text, scope)


# ------------------------------------------------------------------- access (D84)


def can_edit(user: models.User) -> bool:
    return bool(user.group and user.group.is_admin)


def can_run(db: Session, user: models.User, workflow: models.Workflow) -> bool:
    if user.group is None:
        return False
    if user.group.is_admin:
        return True
    return (
        db.query(models.WorkflowGrant).filter_by(workflow_id=workflow.id, group_id=user.group_id).first() is not None
    )


def can_read(user: models.User, run: models.WorkflowRun) -> bool:
    """A run's inputs and outputs are its starter's, their group's and admins':
    they came from the starter's environments (D84)."""
    if user.group is not None and user.group.is_admin:
        return True
    return run.started_by_id == user.id or (run.group_id is not None and run.group_id == user.group_id)


def runnable(db: Session, user: models.User) -> list[models.Workflow]:
    rows = db.query(models.Workflow).order_by(models.Workflow.label).all()
    return [w for w in rows if can_run(db, user, w)]


# ------------------------------------------------------------------- saving


def ensure_id_line(source: str, workflow_id: str) -> str:
    """The source with its id as the first line, so the store's file says what
    it is; an id already there is replaced, the rest kept as written."""
    lines = source.splitlines()
    kept = [ln for ln in lines if not re.match(r"^id\s*:", ln)]
    return "\n".join([f"id: {workflow_id}", *kept]).rstrip() + "\n"


def save(db: Session, workflow_id: Optional[str], requested_id: Optional[str], source: str,
         actor: models.User) -> models.Workflow:
    """Creates (`workflow_id` None) or replaces a workflow from its source."""
    from . import store

    if workflow_id is None:
        try:
            new_id = store.full_id(db, requested_id or "", ID_RE)
        except store.StoreError as e:
            raise WorkflowError(str(e)) from None
        if db.get(models.Workflow, new_id) is not None:
            raise WorkflowError(f"There is already a workflow {new_id}.")
        row = models.Workflow(id=new_id, created_by_id=actor.id)
        db.add(row)
    else:
        row = db.get(models.Workflow, workflow_id)
        if row is None:
            raise WorkflowError("That workflow doesn't exist any more.")
    source = ensure_id_line(source, row.id)
    definition = parse(source)
    row.label, row.description = definition.label, definition.description
    row.source = source
    row.definition = definition.model_dump(by_alias=True, exclude_none=True)
    row.updated_by_id, row.updated_at = actor.id, datetime.datetime.utcnow()
    db.flush()
    store.record(db, "workflow", row.id, "write", actor)
    db.commit()
    return row


def delete(db: Session, workflow_id: str, actor: models.User) -> None:
    from . import store

    row = db.get(models.Workflow, workflow_id)
    if row is None:
        return
    db.delete(row)
    store.record(db, "workflow", workflow_id, "delete", actor)
    db.commit()


def set_grants(db: Session, workflow: models.Workflow, group_ids: list[int]) -> None:
    db.query(models.WorkflowGrant).filter_by(workflow_id=workflow.id).delete()
    for gid in sorted(set(group_ids)):
        group = db.get(models.UserGroup, gid)
        if group is None:
            raise WorkflowError(f"There is no group {gid}.")
        if not group.is_admin:
            db.add(models.WorkflowGrant(workflow_id=workflow.id, group_id=gid))
    db.commit()


# ------------------------------------------------------------------- starting a run


def coerce_params(db: Session, user: models.User, definition: dict, given: dict[str, Any]) -> dict[str, Any]:
    """The parameters a run starts with: defaults filled in, each the type it
    says, required ones present, and a connection one the starter can reach."""
    params = Definition.model_validate(definition).parameters
    known = {p.key for p in params}
    unknown = sorted(set(given) - known)
    if unknown:
        raise WorkflowError(f"This workflow has no parameter {', '.join(unknown)}.")
    out: dict[str, Any] = {}
    for p in params:
        value = given.get(p.key, p.default)
        if value in (None, "", []):
            if p.required:
                raise WorkflowError(f"Fill in {p.label or p.key}.")
            out[p.key] = None if p.type != "connections" else []
            continue
        try:
            if p.type == "int":
                value = int(value)
            elif p.type == "bool":
                value = value if isinstance(value, bool) else str(value).lower() in ("1", "true", "yes", "on")
            elif p.type == "connection":
                value = int(value)
            elif p.type == "connections":
                value = [int(v) for v in (value if isinstance(value, list) else [value])]
            elif p.type == "text":
                value = str(value)
        except (TypeError, ValueError):
            raise WorkflowError(f"{p.label or p.key} isn't a valid {p.type}.") from None
        if p.type == "choice" and value not in p.choices and str(value) not in [str(c) for c in p.choices]:
            raise WorkflowError(f"{p.label or p.key} must be one of {', '.join(map(str, p.choices))}.")
        if p.type in ("connection", "connections"):
            reachable = {t["id"] for t in connections.targets(db, user, p.connection_type)}
            for cid in value if isinstance(value, list) else [value]:
                if cid not in reachable:
                    raise WorkflowError(f"{p.label or p.key}: connection {cid} isn't one you can reach.")
        out[p.key] = value
    return out


def start(db: Session, user: models.User, workflow: models.Workflow, given: dict[str, Any], *,
          trigger: str = "manual", timezone: Optional[str] = None, rerun_of: Optional[int] = None) -> models.WorkflowRun:
    if not can_run(db, user, workflow):
        raise WorkflowError(f"Your group may not run {workflow.label}.")
    params = coerce_params(db, user, workflow.definition, given)
    db.query(models.Workflow).filter_by(id=workflow.id).with_for_update().one()
    number = (
        db.query(models.WorkflowRun.number)
        .filter_by(workflow_id=workflow.id)
        .order_by(models.WorkflowRun.number.desc())
        .limit(1)
        .scalar()
        or 0
    ) + 1
    run = models.WorkflowRun(
        workflow_id=workflow.id, number=number, status="queued", params=params, definition=workflow.definition,
        started_by_id=user.id, started_by_name=user.username, group_id=user.group_id, trigger=trigger,
        rerun_of=rerun_of, timezone=timezone,
    )
    db.add(run)
    db.flush()
    for position, step in enumerate(workflow.definition.get("steps") or []):
        db.add(models.WorkflowRunStep(run_id=run.id, position=position, step_id=step["id"], label=step.get("label")))
    db.commit()
    manager.kick()
    return run


def cancel(db: Session, run: models.WorkflowRun) -> None:
    if run.status in FINISHED:
        raise WorkflowError(f"Run #{run.number} has already {run.status}.")
    if run.status == "queued":
        _finish(db, run, "cancelled")
        for s in run_steps(db, run):
            if s.status == "pending":
                s.status = "cancelled"
        db.commit()
        return
    run.cancel_requested = True
    db.commit()


def run_steps(db: Session, run: models.WorkflowRun) -> list[models.WorkflowRunStep]:
    return (
        db.query(models.WorkflowRunStep)
        .filter_by(run_id=run.id)
        .order_by(models.WorkflowRunStep.position)
        .all()
    )


# ------------------------------------------------------------------- executing


def _now() -> datetime.datetime:
    return datetime.datetime.utcnow()


def _finish(db: Session, run: models.WorkflowRun, status: str, error: Optional[str] = None) -> None:
    run.status, run.error, run.finished_at = status, error, _now()


def claim(db: Session) -> Optional[int]:
    """Takes the oldest queued run for this replica, if any."""
    run = (
        db.query(models.WorkflowRun)
        .filter(models.WorkflowRun.status == "queued")
        .order_by(models.WorkflowRun.id)
        .with_for_update(skip_locked=True)
        .first()
    )
    if run is None:
        db.rollback()
        return None
    run.status, run.replica, run.started_at, run.heartbeat_at = "running", REPLICA, _now(), _now()
    db.commit()
    return run.id


def sweep(db: Session) -> list[int]:
    """Marks failed the runs whose replica stopped beating: interrupted, not
    resumed (D85) -- a step half done can't safely be done again by itself."""
    cutoff = _now() - datetime.timedelta(seconds=HEARTBEAT_STALE_SECONDS)
    stale = (
        db.query(models.WorkflowRun)
        .filter(models.WorkflowRun.status == "running", models.WorkflowRun.heartbeat_at < cutoff)
        .with_for_update(skip_locked=True)
        .all()
    )
    for run in stale:
        _finish(db, run, "failed", "Interrupted: the server running it went away. Rerun it to try again.")
        for s in run_steps(db, run):
            if s.status in ("pending", "running"):
                s.status = "cancelled" if s.status == "pending" else "failed"
                s.error = s.error or ("Interrupted." if s.status == "failed" else None)
    db.commit()
    return [r.id for r in stale]


def execute(run_id: int) -> str:
    """Runs a claimed run to its end, recording every step. Returns its status."""
    db = SessionLocal()
    try:
        run = db.get(models.WorkflowRun, run_id)
        if run is None:
            return "gone"
        user = db.get(models.User, run.started_by_id) if run.started_by_id else None
        if user is None:
            _finish(db, run, "failed", "Whoever started it no longer exists.")
            db.commit()
            return run.status
        try:
            return _execute(db, run, user)
        except Exception as e:  # noqa: BLE001 -- a run must always finish
            db.rollback()
            log.exception("Workflow run %s failed", run_id)
            run = db.get(models.WorkflowRun, run_id)
            _finish(db, run, "failed", masking.mask(f"The run stopped on an unexpected error: {e}"))
            db.commit()
            return run.status
    finally:
        masking.reset()
        db.close()


def _cancelled(db: Session, run: models.WorkflowRun) -> bool:
    db.refresh(run, attribute_names=["cancel_requested"])
    return bool(run.cancel_requested)


def _beat(db: Session, run: models.WorkflowRun) -> None:
    run.heartbeat_at = _now()
    db.commit()


def _execute(db: Session, run: models.WorkflowRun, user: models.User) -> str:
    definition = Definition.model_validate(run.definition)
    records = {s.position: s for s in run_steps(db, run)}
    scope: dict[str, Any] = {
        "params": dict(run.params or {}),
        "steps": {},
        "item": None,
        "index": None,
        "run": {"id": run.id, "number": run.number, "started_by": run.started_by_name},
    }
    failed = False
    for position, step in enumerate(definition.steps):
        record = records[position]
        if _cancelled(db, run):
            for later in range(position, len(definition.steps)):
                records[later].status = "cancelled"
            _finish(db, run, "cancelled")
            db.commit()
            return run.status
        record.status, record.started_at = "running", _now()
        _beat(db, run)
        try:
            if step.if_ is not None and not _truthy(_condition(step.if_, scope)):
                record.status, record.finished_at = "skipped", _now()
                scope["steps"][step.id] = {"status": "skipped", "outputs": {}}
                db.commit()
                continue
            if step.for_each is not None:
                outputs, inputs, item_failed = _run_each(db, run, user, step, scope)
            else:
                inputs, outputs = _run_one(db, run, user, step, scope)
                item_failed = None
            record.inputs, record.trimmed = _bounded(inputs)
            record.outputs, trimmed = _bounded(outputs)
            record.trimmed = record.trimmed or trimmed
            if item_failed:
                raise StepError(item_failed)
            record.status = "succeeded"
            scope["steps"][step.id] = {"status": "succeeded", "outputs": record.outputs}
        except (StepError, WorkflowError, ResolveError, HTTPException, pane_outputs.OutputError) as e:
            message = masking.mask(str(getattr(e, "detail", e)))
            record.status, record.error = "failed", message
            scope["steps"][step.id] = {"status": "failed", "outputs": record.outputs or {}}
            if not step.continue_on_error:
                failed = True
        except _Cancelled:
            record.status = "cancelled"
            for later in range(position + 1, len(definition.steps)):
                records[later].status = "cancelled"
            record.finished_at = _now()
            _finish(db, run, "cancelled")
            db.commit()
            return run.status
        record.finished_at = _now()
        _beat(db, run)
        if failed:
            for later in range(position + 1, len(definition.steps)):
                records[later].status = "cancelled"
            _finish(db, run, "failed", f"Step {step.id} failed: {record.error}")
            db.commit()
            return run.status
    _finish(db, run, "succeeded")
    db.commit()
    return run.status


class _Cancelled(Exception):
    pass


def _truthy(value: Any) -> bool:
    return bool(value) and value not in ("false", "False", "0")


def _run_each(db: Session, run: models.WorkflowRun, user: models.User, step: Step, scope: dict):
    items = _condition(step.for_each, scope)
    if not isinstance(items, list):
        raise StepError(f"Step {step.id}'s for_each must be a list; it is {type(items).__name__}.")
    if len(items) > MAX_ITEMS:
        raise StepError(f"Step {step.id}'s for_each has {len(items)} items; at most {MAX_ITEMS}.")
    outputs, inputs, first_error = [], [], None
    for index, item in enumerate(items):
        if _cancelled(db, run):
            raise _Cancelled()
        here = {**scope, "item": item, "index": index}
        try:
            one_inputs, one_outputs = _run_one(db, run, user, step, here)
            inputs.append(one_inputs)
            outputs.append(one_outputs)
        except (StepError, WorkflowError, ResolveError, HTTPException) as e:
            message = masking.mask(str(getattr(e, "detail", e)))
            inputs.append(None)
            outputs.append({"error": message})
            first_error = first_error or f"Item {index}: {message}"
            if not step.continue_on_error:
                return {"items": outputs}, {"items": inputs}, first_error
        _beat(db, run)
    return {"items": outputs}, {"items": inputs}, first_error


def _run_one(db: Session, run: models.WorkflowRun, user: models.User, step: Step, scope: dict) -> tuple[dict, dict]:
    if step.note is not None:
        text = _text(render(step.note, scope))
        return {}, {"text": text}
    from .routers import panes as panes_router  # it imports a great deal

    manifest = pane_manifest.get(step.pane or "")
    action = next((a for a in manifest.actions if a.id == step.action), None) if manifest else None
    if manifest is None or action is None:
        raise StepError(f"{step.pane}'s {step.action} doesn't exist any more.")
    # As the starter's own click would: the pane granted to their group (D65).
    pane_access.require(user, manifest.id, manifest.label)
    given = render(step.with_, scope)
    inputs = {**{i.key: i.default for i in manifest.inputs if i.default is not None}, **given}
    call_inputs = {**inputs, **({"_tz": run.timezone} if run.timezone else {})}
    if action.request is not None:
        result = panes_router.run_request(db, user, manifest, action, call_inputs)
    else:
        result = panes_router.run_handler(db, user, manifest, action, call_inputs)
    db.commit()  # a handler may have audited a credential's use
    return inputs, {k: v for k, v in (result or {}).items() if not k.startswith("__")}


def _bounded(values: Any) -> tuple[Any, bool]:
    """Outputs kept to STEP_OUTPUT_BYTES, the longest list halved until they fit."""
    if values is None:
        return None, False
    try:
        copy = json.loads(json.dumps(values, default=str))
    except (TypeError, ValueError):
        return {"note": "These outputs couldn't be kept."}, True
    if not isinstance(copy, dict):
        copy = {"value": copy}
    try:
        trimmed = pane_outputs.fit(copy, STEP_OUTPUT_BYTES)
    except pane_outputs.OutputError:
        return {"note": f"These outputs were over {STEP_OUTPUT_BYTES} bytes, even cut down."}, True
    return copy, trimmed


def drain() -> list[int]:
    """Runs every queued run here and now, one after another: the tests' way
    in, and what the manager does each time it's kicked."""
    done = []
    while True:
        db = SessionLocal()
        try:
            run_id = claim(db)
        finally:
            db.close()
        if run_id is None:
            return done
        execute(run_id)
        done.append(run_id)


# ------------------------------------------------------------------- the runner


class Manager:
    """Runs queued runs on threads, and marks interrupted ones, in every
    replica; SKIP LOCKED gives each run to exactly one."""

    IDLE_SECONDS = 5.0

    def __init__(self) -> None:
        self.loop: Optional[asyncio.AbstractEventLoop] = None
        self._event: Optional[asyncio.Event] = None
        self._task: Optional[asyncio.Task] = None
        self._running: set[asyncio.Future] = set()

    @property
    def active(self) -> bool:
        return self.loop is not None

    def kick(self) -> None:
        if self.loop is not None and self._event is not None:
            self.loop.call_soon_threadsafe(self._event.set)

    async def _run(self) -> None:
        while True:
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(self._event.wait(), timeout=self.IDLE_SECONDS)
            self._event.clear()
            try:
                await asyncio.to_thread(_sweep_once)
                while True:
                    run_id = await asyncio.to_thread(_claim_once)
                    if run_id is None:
                        break
                    task = asyncio.ensure_future(asyncio.to_thread(execute, run_id))
                    self._running.add(task)
                    task.add_done_callback(self._running.discard)
            except Exception:  # noqa: BLE001 -- the loop must outlive any one failure
                log.exception("Workflows: the runner's loop failed")

    def start(self) -> None:
        self.loop = asyncio.get_running_loop()
        self._event = asyncio.Event()
        self._task = self.loop.create_task(self._run())
        self.kick()

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
        self.loop = None


def _claim_once() -> Optional[int]:
    db = SessionLocal()
    try:
        return claim(db)
    finally:
        db.close()


def _sweep_once() -> None:
    db = SessionLocal()
    try:
        sweep(db)
    finally:
        db.close()


manager = Manager()


# ------------------------------------------------------------------- reading


def summary(db: Session, run: models.WorkflowRun, user: models.User, detail: bool = False) -> dict[str, Any]:
    readable = can_read(user, run)
    workflow = db.get(models.Workflow, run.workflow_id)
    out: dict[str, Any] = {
        "id": run.id,
        "workflow_id": run.workflow_id,
        "workflow_label": workflow.label if workflow else run.workflow_id,
        "number": run.number,
        "status": run.status,
        "trigger": run.trigger,
        "started_by": run.started_by_name,
        "created_at": _iso(run.created_at),
        "started_at": _iso(run.started_at),
        "finished_at": _iso(run.finished_at),
        "readable": readable,
        "cancel_requested": bool(run.cancel_requested),
        "rerun_of": run.rerun_of,
    }
    if not readable:
        return out
    out["params"] = run.params
    out["error"] = run.error
    steps = run_steps(db, run)
    out["steps"] = [
        {
            "position": s.position,
            "id": s.step_id,
            "label": s.label,
            "status": s.status,
            "started_at": _iso(s.started_at),
            "finished_at": _iso(s.finished_at),
            "error": s.error,
            **({"inputs": s.inputs, "outputs": s.outputs, "trimmed": bool(s.trimmed)} if detail else {}),
        }
        for s in steps
    ]
    if detail:
        out["definition"] = run.definition
    return out


def _iso(value: Optional[datetime.datetime]) -> Optional[str]:
    return value.replace(microsecond=0).isoformat() + "Z" if value else None
