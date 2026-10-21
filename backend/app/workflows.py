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

4b-2 (§22.8, D87-D93): a step may be a background run (polled here until it's
done, or listened to for a while), wait on an approval -- always, when its
action reaches outside the platform -- retry and time out, or write an
artifact. A run waiting on an approval holds no thread: it is `waiting`, and a
decision queues it again; it then carries on from its records, as a rerun from
a stage does from the ones it copied.
"""

from __future__ import annotations

import asyncio
import contextlib
import contextvars
import csv
import datetime
import functools
import io
import json
import logging
import os
import re
import socket
import threading
import time
from typing import Any, Callable, Literal, Optional

import yaml
from cel_expr_python import cel
from cel_expr_python.ext.ext_math import ExtMath
from cel_expr_python.ext.ext_strings import ExtStrings
from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy.orm import Session

from . import blobs, connections, live_events, masking, models, pane_access, pane_outputs
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
# `inputs`: a step type's (D122), where a workflow has `params`.
SCOPE = ("params", "steps", "item", "index", "run", "inputs")
REPLICA = f"{socket.gethostname()}:{os.getpid()}"
FINISHED = ("succeeded", "failed", "cancelled")
# A step's own end, whatever happened to the run around it: what a resumed
# run (or a rerun from a later stage) reads back rather than runs again.
STEP_DONE = ("succeeded", "failed", "skipped")
# Each attempt's bound, unless the step says (D89): a call, a background run.
CALL_TIMEOUT = 600.0
BACKGROUND_TIMEOUT = 3600.0
APPROVAL_TIMEOUT = 86400.0
# A refusal is an answer: retrying it can only be refused again.
REFUSED = (401, 403, 404)
APPROVAL_DETAIL_ITEMS = 20


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


class OptionsFrom(_Strict):
    """A parameter whose choices a pane input's loader lists (D94): the log
    groups of the environment chosen above. `with` gives the loader's inputs,
    templates over the other parameters only."""

    pane: str
    input: str
    with_: dict[str, Any] = Field(default_factory=dict, alias="with")


class Param(_Strict):
    key: str
    type: ParamType = "text"
    label: Optional[str] = None
    help: str = ""
    default: Any = None
    required: bool = False
    choices: list[Any] = []
    connection_type: Optional[str] = None
    # A list of values rather than one (text only): several log groups.
    multiple: bool = False
    options_from: Optional[OptionsFrom] = None


class ApprovalSpec(_Strict):
    """`approval:` on a step (D88): it waits for a person before it runs."""

    message: Optional[str] = None
    by: Literal["anyone", "others", "admins"] = "anyone"
    timeout: float = Field(default=APPROVAL_TIMEOUT, ge=60, le=7 * 86400)


class ArtifactSpec(_Strict):
    """`artifact:` (D92): a file the run hands on, written to the blob store."""

    name: str
    value: Any
    format: Literal["json", "csv", "text"] = "json"


class Step(_Strict):
    id: str
    label: Optional[str] = None
    pane: Optional[str] = None
    action: Optional[str] = None
    # A step type made in the Builder (D122): its inputs are `with`.
    step: Optional[str] = None
    with_: dict[str, Any] = Field(default_factory=dict, alias="with")
    note: Optional[str] = None
    artifact: Optional[ArtifactSpec] = None
    approval: Optional[ApprovalSpec] = None
    if_: Optional[str] = Field(default=None, alias="if")
    for_each: Optional[Any] = None
    continue_on_error: bool = False
    retry: int = Field(default=0, ge=0, le=5)
    retry_delay: float = Field(default=5.0, ge=0, le=300)
    timeout: Optional[float] = Field(default=None, ge=1, le=86400)
    listen: Optional[float] = Field(default=None, ge=1, le=3600)


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

    check_params(definition.parameters, err, "parameters")
    if not definition.steps:
        err(("steps",), "A workflow needs at least one step.")
    if len(definition.steps) > MAX_STEPS:
        err(("steps",), f"A workflow has at most {MAX_STEPS} steps.")
    check_steps(definition.steps, err, ("steps",))
    return errors


def check_params(params: list[Param], err: Callable[[tuple, str], None], field: str) -> None:
    """A workflow's parameters, or a step type's inputs (D122): the same shape."""
    keys: set[str] = set()
    noun = "parameter" if field == "parameters" else "input"
    for i, p in enumerate(params):
        if not STEP_ID_RE.match(p.key):
            err((field, i), f"'{p.key}' can't be a {noun}'s key: lowercase letters, digits and _.")
        if p.key in keys:
            err((field, i), f"Two {noun}s are called {p.key}.")
        keys.add(p.key)
        if p.type == "choice" and not p.choices:
            err((field, i), f"{p.key} is a choice with nothing to choose from.")
        if p.type in ("connection", "connections") and not p.connection_type:
            err((field, i), f"{p.key} needs a connection_type (aws, or an HTTP type's id).")
        if (p.multiple or p.options_from) and p.type != "text":
            err((field, i), f"{p.key}: multiple and options_from are for a text {noun}.")
        if p.options_from is not None:
            for where, message in _check_options_from(p, [q.key for q in params]):
                err((field, i, "options_from") + where, message)


def check_steps(steps: list[Step], err: Callable[[tuple, str], None], prefix: tuple,
                within: Optional[str] = None, chain: tuple = ()) -> None:
    """A list of steps: a workflow's, or -- `within` -- a composed step type's
    (D122), where what waits for a person or writes a run's files has no place
    (the outer step is what's approved), and `chain` is the step types it's
    inside of, so one can't contain itself."""
    from . import step_types

    earlier: list[str] = []
    for i, step in enumerate(steps):
        here = prefix + (i,)
        if not STEP_ID_RE.match(step.id):
            err(here, f"'{step.id}' can't be a step's id: lowercase letters, digits and _.")
        if step.id in earlier:
            err(here, f"Two steps are called {step.id}.")
        is_pane = bool(step.pane or step.action or (step.with_ and step.step is None))
        kinds = [k for k, there in (("a pane action", is_pane), ("a step type", step.step is not None),
                                    ("a note", step.note is not None), ("an artifact", step.artifact is not None))
                 if there]
        if len(kinds) > 1:
            err(here, f"Step {step.id} is {' and '.join(kinds)}: a step is one of them.")
        elif not kinds and step.approval is None:
            err(here, f"Step {step.id} needs a pane and an action, a step type, a note, an artifact or an approval.")
        if is_pane and not (step.pane and step.action):
            err(here, f"Step {step.id} needs both a pane and an action.")
        if not is_pane and step.step is None:
            for field in ("retry", "timeout", "listen"):
                if field in step.model_fields_set:
                    err(here + (field,), f"Step {step.id}: only a pane action or a step type has {field}.")
        if step.pane and step.action:
            for where, message in _check_action(step):
                err(here + where, message)
        if step.step is not None:
            for where, message in step_types.check_use(step, chain):
                err(here + where, message)
        if within is not None:
            for field, what in (("approval", "an approval"), ("artifact", "an artifact"), ("listen", "listen")):
                if field in step.model_fields_set:
                    err(here + (field,), f"Step {step.id}: a step type's steps have no {what} -- the workflow's "
                                         "step that uses it is what's approved.")
            action = _action_of(step)
            if action is not None and action.poll is not None:
                err(here + ("action",), f"Step {step.id}: a background run can't be inside a step type, yet.")
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
                if within is not None and "params" in _names(expr):
                    err(here + path, f"Step {step.id}: a step type reads its inputs (inputs.<key>), not params.")
        earlier.append(step.id)


def _check_options_from(p: Param, keys: list[str]) -> list[tuple[tuple, str]]:
    source = p.options_from
    manifest = pane_manifest.get(source.pane)
    if manifest is None:
        return [(("pane",), f"{p.key}: there is no pane type '{source.pane}'.")]
    spec = next((i for i in manifest.inputs if i.key == source.input), None)
    loading = [i.key for i in manifest.inputs if i.options is not None]
    if spec is None or spec.options is None:
        return [(("input",), f"{p.key}: {manifest.label} has no input '{source.input}' whose options load "
                            f"(it has: {', '.join(loading) or 'none'}).")]
    out: list[tuple[tuple, str]] = []
    inputs = {i.key for i in manifest.inputs}
    for key, value in source.with_.items():
        if key not in inputs:
            out.append((("with", key), f"{p.key}: {manifest.label} has no input '{key}'."))
        for text in [value] if isinstance(value, str) else []:
            for expr in _expressions(text):
                try:
                    _compiled(expr)
                except WorkflowError as e:
                    out.append((("with", key), f"{p.key}: {e}"))
                    continue
                if _names(expr) & {"steps", "item", "index"}:
                    out.append((("with", key), f"{p.key}: options are listed before the run, from the other parameters only."))
                for ref in _param_refs(expr):
                    if ref == p.key or ref not in keys:
                        out.append((("with", key), f"{p.key}: params.{ref} isn't another parameter."))
    return out


def _param_refs(text: str) -> set[str]:
    return set(re.findall(r"\bparams\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)", text))


def _stream(action: pane_manifest.ManifestAction) -> bool:
    """A background run that never says done (MQTT's connection): the manifest
    says how long the agent waits on one -- `agent_wait` -- and only a stream
    has that, since waiting on a query is waiting for its end."""
    return action.poll is not None and action.poll.agent_wait is not None


def _check_action(step: Step) -> list[tuple[tuple, str]]:
    """What's wrong with a step's pane, action and inputs, each with the field it's on."""
    manifest = pane_manifest.get(step.pane or "")
    if manifest is None:
        return [(("pane",), f"Step {step.id}: there is no pane type '{step.pane}'.")]
    action = next((a for a in manifest.actions if a.id == step.action), None)
    if action is None:
        known = ", ".join(a.id for a in manifest.actions if a.request is not None or a.served)
        return [(("action",), f"Step {step.id}: {manifest.label} has no action '{step.action}' (it has: {known or 'none'}).")]
    out: list[tuple[tuple, str]] = []
    # A background run is waited for (D87); one reaching outside the platform
    # waits for a person first (D88) -- `_gate` -- so neither is refused.
    if action.request is None and not action.served:
        out.append((("action",), f"Step {step.id}: {manifest.label}'s {action.id} runs in the browser, not on the server."))
    if step.listen is not None and not _stream(action):
        out.append((("listen",), f"Step {step.id}: {manifest.label}'s {action.id} finishes by itself; listen is for a connection that doesn't."))
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
    if step.artifact is not None:
        out.append((("artifact", "name"), step.artifact.name))
        walk(step.artifact.value, ("artifact", "value"))
    if step.approval is not None and step.approval.message:
        out.append((("approval", "message"), step.approval.message))
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
    # The strings and math extensions (join, split, lowerAscii, replace;
    # math.greatest...): a summary of a list of rows has nothing to say it
    # with otherwise. Both are pure functions over what's in scope.
    env = cel.NewEnv(variables={name: cel.Type.DYN for name in SCOPE}, extensions=[ExtStrings(), ExtMath()])
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


def can_create(user: models.User) -> bool:
    """Admins, and since 5-3 a group's builders (D121)."""
    group = user.group
    return bool(group and (group.is_admin or group.builder_enabled))


def can_edit(user: models.User, workflow: Optional[models.Workflow] = None) -> bool:
    """Whether `user` may change `workflow` (D121): an admin any; a builder
    those their group made. Without a workflow: whether they may make one."""
    if workflow is None:
        return can_create(user)
    group = user.group
    if group is None:
        return False
    if group.is_admin:
        return True
    return bool(group.builder_enabled and workflow.owner_group_id is not None and workflow.owner_group_id == group.id)


def sees_all(user: models.User) -> bool:
    return bool(user.group and user.group.is_admin)


def visible(db: Session, user: models.User, workflow: models.Workflow) -> bool:
    return can_edit(user, workflow) or can_run(db, user, workflow)


def access_errors(db: Session, definition: "Definition", user: models.User, source: str = "") -> list[dict]:
    """A builder names only panes their group may use, as a built pane names
    only their handlers (D113): a workflow of theirs is their group's to run
    at once (D121), and a step of a pane they were never granted would only
    fail for every one of them. Admins may name any."""
    if user.group is not None and user.group.is_admin:
        return []
    errors = []
    for i, step in enumerate(definition.steps):
        if step.pane and not pane_access.allowed(user.group, step.pane):
            manifest = pane_manifest.get(step.pane)
            errors.append({"line": _line(source, ("steps", i, "pane")) if source else None,
                           "message": f"Step {step.id}: your group can't use {manifest.label if manifest else step.pane} "
                                      "panes, so a workflow of yours can't run one."})
    return errors


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


def listed(db: Session, user: models.User) -> list[models.Workflow]:
    """What the Workflows page lists: every one for an admin; the ones a
    person may run or edit for anyone else."""
    rows = db.query(models.Workflow).order_by(models.Workflow.label).all()
    return rows if sees_all(user) else [w for w in rows if visible(db, user, w)]


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
        if not can_create(actor):
            raise WorkflowError("Making workflows is for admins and builders.")
        try:
            new_id = store.full_id(db, requested_id or "", ID_RE)
        except store.StoreError as e:
            raise WorkflowError(str(e)) from None
        if db.get(models.Workflow, new_id) is not None:
            raise WorkflowError(f"There is already a workflow {new_id}.")
        row = models.Workflow(id=new_id, created_by_id=actor.id)
        if actor.group is not None and not actor.group.is_admin:
            # A builder's: their group's to edit, and to run at once (the
            # grant, below); any other group when an admin grants it (D121, as
            # D105 for a built pane).
            row.owner_group_id = actor.group.id
        db.add(row)
    else:
        row = db.get(models.Workflow, workflow_id)
        if row is None:
            raise WorkflowError("That workflow doesn't exist any more.")
        if not can_edit(actor, row):
            raise WorkflowError("Only an admin, or a builder of the group that made it, may change this workflow.")
    source = ensure_id_line(source, row.id)
    definition = parse(source)
    errors = access_errors(db, definition, actor, source)
    if errors:
        db.rollback()
        raise _fail(errors)
    row.label, row.description = definition.label, definition.description
    row.source = source
    row.definition = definition.model_dump(by_alias=True, exclude_none=True)
    row.updated_by_id, row.updated_at = actor.id, datetime.datetime.utcnow()
    db.flush()
    if workflow_id is None and row.owner_group_id is not None:
        db.add(models.WorkflowGrant(workflow_id=row.id, group_id=row.owner_group_id))
    store.record(db, "workflow", row.id, "write", actor)
    db.commit()
    return row


def delete(db: Session, workflow_id: str, actor: models.User) -> None:
    from . import store

    row = db.get(models.Workflow, workflow_id)
    if row is None:
        return
    # Its runs go with it (ON DELETE CASCADE), and so do their files: the rows
    # would cascade, the bytes in the store wouldn't.
    run_ids = [r.id for r in db.query(models.WorkflowRun.id).filter_by(workflow_id=workflow_id)]
    if run_ids:
        blobs.remove(db, db.query(models.Blob).filter(models.Blob.run_id.in_(run_ids)).all())
    from . import build_drafts

    build_drafts.forget(db, "workflow", workflow_id)
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
    reach: dict[Optional[str], list[dict]] = {}

    def targets(kind: Optional[str]) -> list[dict]:
        if kind not in reach:
            reach[kind] = connections.targets(db, user, kind)
        return reach[kind]

    def connection(p: Param, raw: Any) -> int:
        """A connection by id, or -- typed as text, in the workflow pane's
        rows -- by its name as the pickers show it (D97)."""
        if isinstance(raw, int) or str(raw).strip().isdigit():
            return int(raw)
        named = [t["id"] for t in targets(p.connection_type) if str(t["label"]).lower() == str(raw).strip().lower()]
        if len(named) != 1:
            raise WorkflowError(f"{p.label or p.key}: there is no connection called {raw} that you can reach.")
        return named[0]

    for p in params:
        value = given.get(p.key, p.default)
        # A list typed as text (the workflow pane's rows) is comma-separated.
        if (p.multiple or p.type == "connections") and isinstance(value, str):
            value = [v.strip() for v in value.split(",") if v.strip()]
        if p.multiple:
            # A list of texts; a lone value (an old form, the agent) is one item.
            value = [str(v).strip() for v in (value if isinstance(value, list) else [value]) if v not in (None, "")]
            value = [v for v in value if v]
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
                value = connection(p, value)
            elif p.type == "connections":
                value = [connection(p, v) for v in (value if isinstance(value, list) else [value])]
            elif p.type == "text" and not p.multiple:
                value = str(value)
        except WorkflowError:
            raise  # already said, by name (a ValueError too)
        except (TypeError, ValueError):
            raise WorkflowError(f"{p.label or p.key} isn't a valid {p.type}.") from None
        if p.type == "choice" and value not in p.choices and str(value) not in [str(c) for c in p.choices]:
            raise WorkflowError(f"{p.label or p.key} must be one of {', '.join(map(str, p.choices))}.")
        if p.type in ("connection", "connections"):
            reachable = {t["id"] for t in targets(p.connection_type)}
            for cid in value if isinstance(value, list) else [value]:
                if cid not in reachable:
                    raise WorkflowError(f"{p.label or p.key}: connection {cid} isn't one you can reach.")
        out[p.key] = value
    return out


def parameter_options(db: Session, user: models.User, workflow: models.Workflow, key: str,
                      given: dict[str, Any]) -> dict[str, Any]:
    """A parameter's choices, listed by its pane input's loader as the person
    filling in the form (D94) -- their group's grant, connections and identity,
    as the pane's own picker would. Until the parameters it reads are set it
    says which (`needs`); a loader's failure is said, never raised: the field
    still takes typed text."""
    from .routers import panes as panes_router

    definition = Definition.model_validate(workflow.definition)
    p = next((q for q in definition.parameters if q.key == key), None)
    if p is None or p.options_from is None:
        raise WorkflowError(f"{workflow.label} has no parameter {key} with options to list.")
    source = p.options_from
    manifest = pane_manifest.get(source.pane)
    spec = next((i for i in manifest.inputs if i.key == source.input), None) if manifest else None
    action = next((a for a in manifest.actions if a.id == spec.options.action), None) if spec and spec.options else None
    if manifest is None or action is None:
        raise WorkflowError(f"{p.label or key}'s options come from something that doesn't exist any more.")
    by_key = {q.key: q for q in definition.parameters}
    params: dict[str, Any] = {}
    needs: list[str] = []
    for ref in sorted(_param_refs(json.dumps(source.with_))):
        q, value = by_key.get(ref), given.get(ref)
        if value in (None, "", []):
            needs.append(q.label or ref if q else ref)
            continue
        try:
            if q is not None and q.type in ("connection", "int"):
                value = int(value)
            elif q is not None and q.type == "connections":
                value = [int(v) for v in (value if isinstance(value, list) else [value])]
        except (TypeError, ValueError):
            needs.append(q.label or ref)
            continue
        params[ref] = value
    if needs:
        return {"options": [], "needs": needs}
    scope = {"params": params, "steps": {}, "item": None, "index": None, "run": None}
    try:
        inputs = _inputs(manifest, render(source.with_, scope))
        if action.request is not None:
            out = panes_router.run_request(db, user, manifest, action, inputs)
        else:
            out = panes_router.run_handler(db, user, manifest, action, inputs)
        db.commit()  # a handler may have audited a credential's use
    except (StepError, HTTPException, ResolveError) as e:
        db.rollback()
        return {"options": [], "error": masking.mask(str(getattr(e, "detail", e)))}
    return _flat_options(out or {})


def _flat_options(out: dict[str, Any]) -> dict[str, Any]:
    """A loader's answer as one list: `{options: [{value, label}]}` as it is, a
    two-level picker's `{groups: [...]}` (one per environment) flattened, each
    item said with its environment when there are several, and a group that
    failed said as an error."""
    options: list[dict[str, str]] = []
    errors: list[str] = []
    if isinstance(out.get("options"), list):
        for o in out["options"]:
            if isinstance(o, dict) and o.get("value") not in (None, ""):
                options.append({"value": str(o["value"]), "label": str(o.get("label") or o["value"])})
    groups = [g for g in out.get("groups") or [] if isinstance(g, dict)]
    for g in groups:
        if g.get("error"):
            errors.append(f"{g.get('environment_name') or g.get('environment_id')}: {g['error']}")
        for item in g.get("items") or g.get("options") or []:
            value = item.get("value") if isinstance(item, dict) else item
            if value in (None, ""):
                continue
            label = item.get("label", value) if isinstance(item, dict) else value
            where = f" ({g.get('environment_name')})" if len(groups) > 1 and g.get("environment_name") else ""
            options.append({"value": str(value), "label": f"{label}{where}"})
    seen: set[str] = set()
    unique = [o for o in options if not (o["value"] in seen or seen.add(o["value"]))]
    return {"options": unique, **({"errors": errors} if errors else {})}


def start(db: Session, user: models.User, workflow: models.Workflow, given: dict[str, Any], *,
          trigger: str = "manual", timezone: Optional[str] = None, rerun_of: Optional[int] = None) -> models.WorkflowRun:
    if not can_run(db, user, workflow):
        raise WorkflowError(f"Your group may not run {workflow.label}.")
    params = coerce_params(db, user, workflow.definition, given)
    params = _as_listed(db, user, workflow, params)
    return _create(db, user, workflow, workflow.definition, params, trigger=trigger, timezone=timezone,
                   rerun_of=rerun_of)


def _as_listed(db: Session, user: models.User, workflow: models.Workflow, params: dict[str, Any]) -> dict[str, Any]:
    """A parameter whose choices are listed (`options_from`), given as one of
    them but not exactly -- another case, or part of just one name -- is taken
    as that choice. Asked for "/fake/API", a run queried a log group that
    doesn't exist; S3 and CloudWatch names are case-sensitive, people and the
    agent aren't. Anything not plainly one choice is kept as given (the
    loader may not list everything); the run's parameters say what was used."""
    definition = Definition.model_validate(workflow.definition)
    out = dict(params)
    for p in definition.parameters:
        value = out.get(p.key)
        if p.options_from is None or value in (None, "", []):
            continue
        listed = [o["value"] for o in parameter_options(db, user, workflow, p.key, out).get("options", [])]
        if not listed:
            continue
        values = value if isinstance(value, list) else [value]
        matched = [_listed(str(v), listed) for v in values]
        out[p.key] = matched if isinstance(value, list) else matched[0]
    return out


def _listed(value: str, listed: list[str]) -> str:
    if value in listed:
        return value
    lowered = value.lower()
    same = [o for o in listed if o.lower() == lowered]
    if len(same) == 1:
        return same[0]
    within = [o for o in listed if lowered and lowered in o.lower()]
    return within[0] if len(within) == 1 else value


def rerun_from(db: Session, user: models.User, old: models.WorkflowRun, step_id: str, *,
               timezone: Optional[str] = None) -> models.WorkflowRun:
    """A new run of `old`'s definition and parameters from `step_id` on, the
    stages before it copied as they were (D90): they ran against that
    definition, so the new run does too, whatever the workflow says now."""
    workflow = db.get(models.Workflow, old.workflow_id)
    if workflow is None or not can_run(db, user, workflow):
        raise WorkflowError("Your group may not run this workflow.")
    if not can_read(user, old):
        raise WorkflowError(f"Run #{old.number}'s stages aren't yours to see, so you can't rerun it from one.")
    if old.status not in FINISHED:
        raise WorkflowError(f"Run #{old.number} is still {old.status}; rerun it from a stage once it has finished.")
    ids = [s.get("id") for s in old.definition.get("steps") or []]
    if step_id not in ids:
        raise WorkflowError(f"Run #{old.number} has no step {step_id}.")
    # The asker's own reach: a connection in the parameters must be one they can use.
    params = coerce_params(db, user, old.definition, old.params or {})
    upto = ids.index(step_id)
    copied = {s.position: s for s in run_steps(db, old) if s.position < upto}
    unfinished = [s.step_id for s in copied.values() if s.status not in STEP_DONE]
    if unfinished:
        raise WorkflowError(f"Run #{old.number} didn't finish {', '.join(unfinished)}, which comes before {step_id}.")
    return _create(db, user, workflow, old.definition, params, trigger="rerun", timezone=timezone or old.timezone,
                   rerun_of=old.id, rerun_from=step_id, copied=copied)


def _create(db: Session, user: models.User, workflow: models.Workflow, definition: dict, params: dict, *,
            trigger: str, timezone: Optional[str], rerun_of: Optional[int], rerun_from: Optional[str] = None,
            copied: Optional[dict[int, models.WorkflowRunStep]] = None) -> models.WorkflowRun:
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
        workflow_id=workflow.id, number=number, status="queued", params=params, definition=definition,
        started_by_id=user.id, started_by_name=user.username, group_id=user.group_id, trigger=trigger,
        rerun_of=rerun_of, rerun_from=rerun_from, timezone=timezone,
    )
    db.add(run)
    db.flush()
    for position, step in enumerate(definition.get("steps") or []):
        record = models.WorkflowRunStep(run_id=run.id, position=position, step_id=step["id"], label=step.get("label"))
        was = (copied or {}).get(position)
        if was is not None:
            record.status, record.inputs, record.outputs, record.trimmed = was.status, was.inputs, was.outputs, was.trimmed
            record.error, record.started_at, record.finished_at = was.error, was.started_at, was.finished_at
            record.attempts, record.reused = was.attempts, True
            record.outputs_blob_id = _copy_blob(db, was.outputs_blob_id, run, user)
        db.add(record)
    db.commit()
    manager.kick()
    return run


def _copy_blob(db: Session, blob_id: Optional[str], run: models.WorkflowRun, user: models.User) -> Optional[str]:
    """A copied stage's whole outputs, kept again for the new run: each run's
    files are its own, to be cleaned up with it."""
    if not blob_id:
        return None
    row = db.get(models.Blob, blob_id)
    if row is None:
        return None
    try:
        return blobs.put(db, blobs.read(row), name=row.name, content_type=row.content_type, kind=row.kind,
                         run_id=run.id, position=row.position, owner_id=user.id, group_id=user.group_id).id
    except blobs.BlobError:
        log.warning("Couldn't copy blob %s into run %s", blob_id, run.id, exc_info=True)
        return None


def cancel(db: Session, run: models.WorkflowRun) -> None:
    if run.status in FINISHED:
        raise WorkflowError(f"Run #{run.number} has already {run.status}.")
    if run.status in ("queued", "waiting"):
        # Nothing holds it: it ends here. A waiting step's approval goes with it.
        for approval in db.query(models.Approval).filter_by(run_id=run.id, status="pending"):
            approval.status, approval.decided_at = "cancelled", _now()
        for s in run_steps(db, run):
            if s.status in ("pending", "waiting"):
                s.status = "cancelled"
        _finish(db, run, "cancelled")
        _announce_approvals(db, run)
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


# ------------------------------------------------------------------- approvals (D88)


def may_decide(user: models.User, approval: models.Approval, run: Optional[models.WorkflowRun]) -> bool:
    if run is None:
        return False
    if approval.decide_by == "admins":
        return bool(user.group and user.group.is_admin)
    if approval.decide_by == "others" and user.id == run.started_by_id:
        return False
    return can_read(user, run)


def pending_for(db: Session, user: models.User) -> list[models.Approval]:
    """What waits for this person's decision, oldest first."""
    rows = db.query(models.Approval).filter_by(status="pending").order_by(models.Approval.id).all()
    return [a for a in rows if may_decide(user, a, db.get(models.WorkflowRun, a.run_id) if a.run_id else None)]


def _announce_approvals(db: Session, run: models.WorkflowRun) -> None:
    """Tells everyone who might decide (whoever may read the run) that what
    waits for them changed: the rail's count follows it. Ids only."""
    groups = [g.id for g in db.query(models.UserGroup).filter(models.UserGroup.is_admin.is_(True))]
    if run.group_id is not None:
        groups.append(run.group_id)
    users = {u.id for u in db.query(models.User.id).filter(models.User.group_id.in_(groups or [-1]))}
    if run.started_by_id is not None:
        users.add(run.started_by_id)
    for uid in users:
        live_events.notify(db, uid, "approvals", None, None, None)


def decide(db: Session, user: models.User, approval_id: int, approve: bool, comment: Optional[str] = None) -> models.Approval:
    """Approve (the run carries on) or deny (the step fails) -- once, by
    someone the approval allows."""
    approval = db.query(models.Approval).filter_by(id=approval_id).with_for_update().first()
    run = db.query(models.WorkflowRun).filter_by(id=approval.run_id).with_for_update().first() if approval and approval.run_id else None
    if approval is None or run is None or not can_read(user, run) and not may_decide(user, approval, run):
        raise WorkflowError("There is no such approval for you.")
    if not may_decide(user, approval, run):
        raise PermissionError(
            {"admins": "Only an admin may decide this one.",
             "others": "Someone other than whoever started the run must decide this one."}.get(
                approval.decide_by, "You may not decide this one.")
        )
    if approval.status != "pending":
        raise WorkflowError(f"It has already been {approval.status}.")
    approval.status = "approved" if approve else "denied"
    approval.decided_by_id, approval.decided_by_name, approval.decided_at = user.id, user.username, _now()
    approval.comment = (comment or "").strip()[:2000] or None
    if approve:
        run.status = "queued"
    else:
        said = f": {approval.comment}" if approval.comment else ""
        _refuse(db, run, approval, f"Denied by {user.username}{said}")
    _announce_approvals(db, run)
    db.commit()
    if approve or run.status == "queued":
        manager.kick()
    return approval


def _refuse(db: Session, run: models.WorkflowRun, approval: models.Approval, message: str) -> None:
    """A step that wasn't approved has failed: the run fails with it, or
    carries on past it under `continue_on_error`."""
    definition = Definition.model_validate(run.definition)
    records = {s.position: s for s in run_steps(db, run)}
    record = records.get(approval.position)
    step = definition.steps[approval.position] if approval.position is not None and approval.position < len(definition.steps) else None
    if record is not None:
        record.status, record.error, record.finished_at = "failed", message, _now()
    if step is not None and step.continue_on_error:
        run.status = "queued"
        return
    for position, later in records.items():
        if approval.position is not None and position > approval.position and later.status == "pending":
            later.status = "cancelled"
    _finish(db, run, "failed", f"Step {approval.step_id} failed: {message}")


def _gate(step: Step, action: Optional[pane_manifest.ManifestAction]) -> Optional[ApprovalSpec]:
    """The approval a step waits on: its own, or -- always, for an action that
    reaches outside the platform, or a step type that does (D122) -- one asked
    of whoever may read the run."""
    from . import step_types

    if step.approval is not None:
        return step.approval
    if action is not None and action.effects == "external":
        return ApprovalSpec()
    defined = step_types.get(step.step) if step.step else None
    if defined is not None and step_types.external(defined):
        return ApprovalSpec()
    return None


def _ask(db: Session, run: models.WorkflowRun, step: Step, position: int, record: models.WorkflowRunStep,
         gate: ApprovalSpec, scope: dict) -> None:
    """Parks the step on an approval: what it will do, worked out now (and
    again, the same, once approved), and who may say yes."""
    manifest = pane_manifest.get(step.pane or "") if step.pane else None
    action = next((a for a in manifest.actions if a.id == step.action), None) if manifest else None
    details: dict[str, Any] = {}
    if manifest is not None and action is not None:
        if step.for_each is not None:
            items = _items(step, scope)
            details = {
                "count": len(items),
                "items": [_readable(manifest, _inputs(manifest, render(step.with_, {**scope, "item": it, "index": i})))
                          for i, it in enumerate(items[:APPROVAL_DETAIL_ITEMS])],
            }
        else:
            details = {"inputs": _readable(manifest, _inputs(manifest, render(step.with_, scope)))}
    from . import step_types

    defined = step_types.get(step.step) if step.step else None
    if defined is not None:
        if step.for_each is not None:
            items = _items(step, scope)
            details = {"count": len(items), "items": [render(step.with_, {**scope, "item": it, "index": i})
                                                      for i, it in enumerate(items[:APPROVAL_DETAIL_ITEMS])]}
        else:
            details = {"inputs": render(step.with_, scope)}
    if gate.message:
        message = _text(render(gate.message, scope))
    elif defined is not None:
        many = f", {details['count']} times" if "count" in details else ""
        reach = " It changes something outside the platform." if step_types.external(defined) else ""
        message = f"{defined.label}{many}, as {run.started_by_name}.{reach}"
    elif manifest is not None and action is not None:
        what = action.run_label or action.id
        many = f", {details['count']} times" if "count" in details else ""
        reach = " It acts outside the platform." if action.effects == "external" else ""
        message = f"{manifest.label}: {what}{many}, as {run.started_by_name}.{reach}"
    else:
        message = f"Approve to carry on with {step.label or step.id}."
    bounded, _ = _bounded(details)
    db.add(models.Approval(
        kind="workflow_step", run_id=run.id, position=position, step_id=step.id, message=message[:2000],
        details=bounded, decide_by=gate.by, requested_by_id=run.started_by_id, group_id=run.group_id,
        status="pending", expires_at=_now() + datetime.timedelta(seconds=gate.timeout),
    ))
    record.status, record.inputs = "waiting", bounded
    run.status = "waiting"
    _announce_approvals(db, run)
    db.commit()


def _readable(manifest: pane_manifest.Manifest, inputs: dict) -> dict:
    """Inputs as a person deciding reads them: headers as name -> value (the
    editor's rows, an empty one included, read as noise), empty ones left out."""
    kinds = {i.key: i.type for i in manifest.inputs}
    out: dict[str, Any] = {}
    for key, value in inputs.items():
        if kinds.get(key) == "headers" and isinstance(value, list):
            value = {str(r.get("key")): r.get("value", "") for r in value if isinstance(r, dict) and r.get("key")}
        if value in (None, "", [], {}):
            continue
        out[key] = value
    return out


def _expire(db: Session) -> list[int]:
    """Approvals nobody decided in time: the step fails, as a denial would."""
    rows = (
        db.query(models.Approval)
        .filter(models.Approval.status == "pending", models.Approval.expires_at < _now())
        .with_for_update(skip_locked=True)
        .all()
    )
    carry_on = False
    for approval in rows:
        run = db.get(models.WorkflowRun, approval.run_id) if approval.run_id else None
        approval.status, approval.decided_at = "expired", _now()
        if run is not None and run.status == "waiting":
            _refuse(db, run, approval, "No one decided in time.")
            _announce_approvals(db, run)
            carry_on = carry_on or run.status == "queued"
    db.commit()
    if carry_on:
        manager.kick()
    return [a.id for a in rows]


# ------------------------------------------------------------------- executing


def _now() -> datetime.datetime:
    return datetime.datetime.utcnow()


def _finish(db: Session, run: models.WorkflowRun, status: str, error: Optional[str] = None) -> None:
    run.status, run.error, run.finished_at = status, error, _now()


def claim(db: Session) -> Optional[int]:
    """Takes the oldest queued run for this replica, if any -- a new one, or one
    a decision has let carry on (it keeps when it started)."""
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
    run.status, run.replica, run.heartbeat_at = "running", REPLICA, _now()
    run.started_at = run.started_at or _now()
    db.commit()
    return run.id


def sweep(db: Session) -> list[int]:
    """Marks failed the runs whose replica stopped beating: interrupted, not
    resumed (D85) -- a step half done can't safely be done again by itself.
    And expires the approvals nobody decided."""
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
    _expire(db)
    return [r.id for r in stale]


def execute(run_id: int) -> str:
    """Runs a claimed run until it ends or waits, recording every step."""
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
        if record.status in STEP_DONE:
            # Done before this claim -- before an approval, or in the run this
            # one reran from a later stage of (D90): read back, not run again.
            scope["steps"][step.id] = {"status": record.status, "outputs": _whole_outputs(db, record)}
            continue
        if _cancelled(db, run):
            for later in range(position, len(definition.steps)):
                if records[later].status not in STEP_DONE:
                    records[later].status = "cancelled"
            _finish(db, run, "cancelled")
            db.commit()
            return run.status
        approved = None
        if record.status == "waiting":
            # Its approval was decided: a denial never queues it with the step
            # still waiting (`_refuse`), so this one said yes.
            approved = (
                db.query(models.Approval)
                .filter_by(run_id=run.id, position=position)
                .order_by(models.Approval.id.desc())
                .first()
            )
        else:
            record.started_at = _now()
        record.status, record.error = "running", None
        _beat(db, run)
        try:
            if approved is None:
                if step.if_ is not None and not _truthy(_condition(step.if_, scope)):
                    record.status, record.finished_at = "skipped", _now()
                    scope["steps"][step.id] = {"status": "skipped", "outputs": {}}
                    db.commit()
                    continue
                gate = _gate(step, _action_of(step))
                if gate is not None:
                    _ask(db, run, step, position, record, gate, scope)
                    return run.status
            if step.pane is None and step.note is None and step.artifact is None and step.step is None:
                # A bare approval: what it says is who said yes.
                inputs, outputs, item_failed = (
                    {}, {"approved_by": approved.decided_by_name if approved else None,
                         "comment": approved.comment if approved else None}, None,
                )
            elif step.for_each is not None:
                outputs, inputs, item_failed = _run_each(db, run, user, step, scope, record)
            else:
                inputs, outputs = _run_one(db, run, user, step, scope, record)
                item_failed = None
            record.inputs, inputs_trimmed = _bounded(inputs)
            whole = _keep_outputs(db, run, user, record, outputs)
            record.trimmed = record.trimmed or inputs_trimmed
            if item_failed:
                raise StepError(item_failed)
            record.status = "succeeded"
            scope["steps"][step.id] = {"status": "succeeded", "outputs": whole}
        except (StepError, WorkflowError, ResolveError, HTTPException, pane_outputs.OutputError, blobs.BlobError) as e:
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


def _action_of(step: Step) -> Optional[pane_manifest.ManifestAction]:
    manifest = pane_manifest.get(step.pane or "") if step.pane else None
    return next((a for a in manifest.actions if a.id == step.action), None) if manifest else None


def _items(step: Step, scope: dict) -> list:
    items = _condition(step.for_each, scope)
    if not isinstance(items, list):
        raise StepError(f"Step {step.id}'s for_each must be a list; it is {type(items).__name__}.")
    if len(items) > MAX_ITEMS:
        raise StepError(f"Step {step.id}'s for_each has {len(items)} items; at most {MAX_ITEMS}.")
    return items


def _run_each(db: Session, run: models.WorkflowRun, user: models.User, step: Step, scope: dict,
              record: models.WorkflowRunStep, depth: int = 0):
    items = _items(step, scope)
    outputs, inputs, first_error = [], [], None
    for index, item in enumerate(items):
        if _cancelled(db, run):
            raise _Cancelled()
        here = {**scope, "item": item, "index": index}
        try:
            one_inputs, one_outputs = _run_one(db, run, user, step, here, record, depth)
            inputs.append(one_inputs)
            outputs.append(one_outputs)
        except (StepError, WorkflowError, ResolveError, HTTPException, blobs.BlobError) as e:
            message = masking.mask(str(getattr(e, "detail", e)))
            inputs.append(None)
            outputs.append({"error": message})
            first_error = first_error or f"Item {index}: {message}"
            if not step.continue_on_error:
                return {"items": outputs}, {"items": inputs}, first_error
        _beat(db, run)
    return {"items": outputs}, {"items": inputs}, first_error


def _inputs(manifest: pane_manifest.Manifest, given: Any) -> dict:
    """What an action runs with: what the step gave, over the inputs' defaults.
    A text input given a map or a list (`body: "{{ {'reason': params.why} }}"`)
    takes its JSON: handed on as it was, a handler's str() made Python's repr
    of it, which no API reads -- and CEL has no way to write JSON itself."""
    kinds = {i.key: i.type for i in manifest.inputs}
    given = {
        k: json.dumps(v, default=str) if kinds.get(k) == "text" and isinstance(v, (dict, list)) else v
        for k, v in (given or {}).items()
    }
    return {**{i.key: i.default for i in manifest.inputs if i.default is not None}, **given}


def _run_one(db: Session, run: models.WorkflowRun, user: models.User, step: Step, scope: dict,
             record: models.WorkflowRunStep, depth: int = 0) -> tuple[dict, dict]:
    if step.note is not None:
        text = _text(render(step.note, scope))
        return {}, {"text": text}
    if step.artifact is not None:
        return _artifact(db, run, user, step, scope, record)
    if step.step is not None:
        return _run_step_type(db, run, user, step, scope, record, depth)
    from .routers import panes as panes_router  # it imports a great deal

    manifest = pane_manifest.get(step.pane or "")
    action = next((a for a in manifest.actions if a.id == step.action), None) if manifest else None
    if manifest is None or action is None:
        raise StepError(f"{step.pane}'s {step.action} doesn't exist any more.")
    # As the starter's own click would: the pane granted to their group (D65).
    pane_access.require(user, manifest.id, manifest.label)
    # Worked out once, outside the retries (D89): an expression fails the same way every time.
    inputs = _inputs(manifest, render(step.with_, scope))
    call_inputs = {**inputs, **({"_tz": run.timezone} if run.timezone else {})}

    if action.poll is not None:
        def attempt() -> dict:
            return _background(db, run, user, step, manifest, action, call_inputs)
    elif action.request is not None:
        def attempt() -> dict:
            return _call(user.id, lambda d, u: panes_router.run_request(d, u, manifest, action, call_inputs),
                         step.timeout or CALL_TIMEOUT)
    else:
        def attempt() -> dict:
            return _call(user.id, lambda d, u: panes_router.run_handler(d, u, manifest, action, call_inputs),
                         step.timeout or CALL_TIMEOUT)

    result = _with_retries(db, run, step, record, attempt)
    return inputs, {k: v for k, v in (result or {}).items() if not k.startswith("__")}


def _run_step_type(db: Session, run: models.WorkflowRun, user: models.User, step: Step, scope: dict,
                   record: models.WorkflowRunStep, depth: int) -> tuple[dict, dict]:
    """A step type made in the Builder (D122): its request, sent as the
    starter; or its steps, run here one after another through the same
    runners as a workflow's, their outputs what its `outputs` says."""
    from . import step_types

    defined = step_types.get(step.step or "")
    if defined is None:
        raise StepError(f"The step type {step.step} doesn't exist any more.")
    if depth >= step_types.MAX_DEPTH:
        raise StepError(f"{defined.label} runs too deep: step types inside step types, {step_types.MAX_DEPTH} at most.")
    inputs = step_types.inputs_for(defined, render(step.with_, scope))
    if defined.request is not None:
        def attempt() -> dict:
            return _call(user.id, lambda d, u: step_types.send(d, u, defined, inputs), step.timeout or CALL_TIMEOUT)

        return inputs, _with_retries(db, run, step, record, attempt)
    if defined.code is not None:
        # In the runner, as the starter (D134); one that changes something got
        # here only through `_gate`'s approval, so its calls may.
        def attempt() -> dict:
            return _call(user.id, lambda d, u: step_types.run_code(
                d, u, defined, inputs, f"step:{step.step}", may_change=defined.changes), step.timeout or CALL_TIMEOUT)

        result = _with_retries(db, run, step, record, attempt) or {}
        return inputs, {k: v for k, v in result.items() if not k.startswith("__")}
    inner: dict[str, Any] = {"inputs": inputs, "steps": {}, "item": None, "index": None, "run": scope.get("run")}
    for each in defined.steps or []:
        if _cancelled(db, run):
            raise _Cancelled()
        if each.if_ is not None and not _truthy(_condition(each.if_, inner)):
            inner["steps"][each.id] = {"status": "skipped", "outputs": {}}
            continue
        try:
            if each.for_each is not None:
                outputs, _, failed = _run_each(db, run, user, each, inner, record, depth + 1)
                if failed:
                    raise StepError(failed)
            else:
                _, outputs = _run_one(db, run, user, each, inner, record, depth + 1)
            inner["steps"][each.id] = {"status": "succeeded", "outputs": outputs}
        except (StepError, WorkflowError, ResolveError, HTTPException, blobs.BlobError) as e:
            message = masking.mask(str(getattr(e, "detail", e)))
            if not each.continue_on_error:
                raise StepError(f"{defined.label}, its step {each.id}: {message}") from None
            inner["steps"][each.id] = {"status": "failed", "outputs": {"error": message}}
        _beat(db, run)
    if defined.outputs:
        outputs = render(defined.outputs, inner)
    else:
        outputs = {k: v["outputs"] for k, v in inner["steps"].items()}
    return inputs, outputs if isinstance(outputs, dict) else {"value": outputs}


def _with_retries(db: Session, run: models.WorkflowRun, step: Step, record: models.WorkflowRunStep,
                  attempt: Callable[[], dict]) -> dict:
    tries = 0
    while True:
        tries += 1
        record.attempts = max(record.attempts or 0, tries)
        try:
            return attempt()
        except (StepError, HTTPException) as e:
            status = getattr(e, "status_code", None)
            if tries > step.retry or status in REFUSED:
                raise
            log.info("Workflow run %s step %s: attempt %s failed, retrying", run.id, step.id, tries)
        deadline = time.monotonic() + step.retry_delay
        while time.monotonic() < deadline:
            if _cancelled(db, run):
                raise _Cancelled()
            time.sleep(min(1.0, max(0.0, deadline - time.monotonic())))
        _beat(db, run)


def _call(user_id: int, fn: Callable[[Session, models.User], dict], timeout: float) -> dict:
    """`fn` as the starter, on a thread of its own with a session of its own,
    bounded by `timeout` (D89): a call can't be interrupted, so one past it is
    left to finish and its result dropped. Its error comes back masked here --
    a secret it resolved is registered in its own context, not the runner's."""
    box: dict[str, Any] = {}

    def work() -> None:
        with SessionLocal() as db:
            try:
                box["value"] = fn(db, db.get(models.User, user_id))
                db.commit()  # a handler may have audited a credential's use
            except HTTPException as e:
                db.rollback()
                box["error"] = HTTPException(status_code=e.status_code, detail=masking.mask(str(e.detail)))
            except ResolveError as e:
                db.rollback()
                box["error"] = HTTPException(status_code=403, detail=masking.mask(str(e)))
            except Exception as e:  # noqa: BLE001 -- said in the step, never lost
                db.rollback()
                log.exception("A workflow step's call failed")
                box["error"] = StepError(masking.mask(f"It failed on an unexpected error: {e}"))

    thread = threading.Thread(target=contextvars.copy_context().run, args=(work,), name="workflow-call", daemon=True)
    thread.start()
    thread.join(timeout)
    if thread.is_alive():
        raise StepError(f"It took longer than {_seconds(timeout)}, so the run stopped waiting for it.")
    if "error" in box:
        raise box["error"]
    return box.get("value") or {}


def _seconds(value: float) -> str:
    value = int(round(value))
    if value < 120:
        return f"{value} s"
    return f"{value // 60} min" if value < 7200 else f"{value // 3600} h"


def _background(db: Session, run: models.WorkflowRun, user: models.User, step: Step,
                manifest: pane_manifest.Manifest, action: pane_manifest.ManifestAction, inputs: dict) -> dict:
    """A background run as a step (D87): started and polled here, as the
    starter, until its poll says done; a stream is listened to for `listen`
    seconds and stopped. The pane's own machinery (`pane_runs`, presence)
    isn't used: there's no session and no one to watch it."""
    from .panes import handlers
    from .panes import runs as pane_runs
    from .routers import panes as panes_router

    started = _call(user.id, lambda d, u: panes_router.run_handler(d, u, manifest, action, inputs), CALL_TIMEOUT)
    handles = started.pop("handles", []) or []
    outputs = {k: v for k, v in started.items() if not k.startswith("__")}
    if not any(pane_runs._live(h) for h in handles):
        return outputs  # nothing started: its outputs say why (each environment's error)
    stream = _stream(action)
    limit = (step.listen or action.poll.agent_wait) if stream else (step.timeout or BACKGROUND_TIMEOUT)
    deadline = time.monotonic() + float(limit)
    poll, stop = handlers.ACTIONS[action.poll.handler], handlers.ACTIONS.get(action.poll.stop)
    done = False
    try:
        while True:
            pause = time.monotonic() + min(action.poll.every, max(0.0, deadline - time.monotonic()))
            while time.monotonic() < pause:
                if _cancelled(db, run):
                    raise _Cancelled()
                time.sleep(min(0.5, max(0.0, pause - time.monotonic())))
            polled = _call(user.id, lambda d, u: poll(d, u, {"handles": handles}, None), CALL_TIMEOUT)
            done = bool(polled.pop("done", False))
            for key, most in action.poll.append.items():
                if key in polled:
                    outputs[key] = ((polled.pop(key) or []) + (outputs.get(key) or []))[:most]
            outputs.update(polled)
            _beat(db, run)
            if done:
                return outputs
            if time.monotonic() >= deadline:
                if stream:
                    return outputs
                raise StepError(f"It was still running after {_seconds(limit)}, so it was stopped.")
    finally:
        if not done and stop is not None:
            try:
                outputs.update(_call(user.id, lambda d, u: stop(d, u, {"handles": handles}, None) or {}, CALL_TIMEOUT))
            except (StepError, HTTPException):
                log.warning("Workflow run %s: stopping step %s failed", run.id, step.id, exc_info=True)


def _artifact(db: Session, run: models.WorkflowRun, user: models.User, step: Step, scope: dict,
              record: models.WorkflowRunStep) -> tuple[dict, dict]:
    """A file the run hands on (D92), in the blob store."""
    spec = step.artifact
    name = re.sub(r"[^\w.\- ]+", "_", os.path.basename(_text(render(spec.name, scope)).strip()))[:120].strip(". ")
    if not name:
        raise StepError(f"Step {step.id}'s artifact needs a name.")
    value = render(spec.value, scope)
    if spec.format == "json":
        data, content_type = json.dumps(value, indent=2, default=str).encode(), "application/json"
    elif spec.format == "text":
        data, content_type = _text(value).encode(), "text/plain; charset=utf-8"
    else:
        data, content_type = _csv(step, value).encode(), "text/csv; charset=utf-8"
    blob = blobs.put(db, data, name=name, content_type=content_type, kind="artifact", run_id=run.id,
                     position=record.position, owner_id=user.id, group_id=run.group_id)
    db.commit()
    return {"name": name, "format": spec.format}, {"artifact": _blob_out(blob)}


def _csv(step: Step, value: Any) -> str:
    if not isinstance(value, list):
        raise StepError(f"Step {step.id}'s artifact is csv, so its value must be a list of rows; it is {type(value).__name__}.")
    out = io.StringIO()
    if all(isinstance(r, dict) for r in value):
        columns: list[str] = []
        for row in value:
            columns.extend(k for k in row if k not in columns)
        writer = csv.DictWriter(out, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        for row in value:
            writer.writerow({k: _text(v) for k, v in row.items()})
    else:
        writer = csv.writer(out)
        for row in value:
            writer.writerow([_text(v) for v in row] if isinstance(row, list) else [_text(row)])
    return out.getvalue()


def _blob_out(blob: models.Blob) -> dict:
    return {"id": blob.id, "name": blob.name, "size": blob.size, "content_type": blob.content_type}


def _keep_outputs(db: Session, run: models.WorkflowRun, user: models.User, record: models.WorkflowRunStep,
                  outputs: Any) -> Any:
    """Keeps a step's outputs: in the row while they fit its 1 MiB, else the
    row holds them cut down and the blob store the whole (D91). Returns what
    later steps see -- the whole, unless even the store couldn't take it."""
    shown, trimmed = _bounded(outputs)
    record.outputs, record.trimmed = shown, trimmed
    if not trimmed:
        return shown
    try:
        whole = json.loads(json.dumps(outputs, default=str))
        if not isinstance(whole, dict):
            whole = {"value": whole}
        pane_outputs.fit(whole, blobs.MAX_BYTES)
        data = json.dumps(whole, default=str).encode()
        blob = blobs.put(db, data, name=f"{record.step_id}-outputs.json", content_type="application/json",
                         kind="step_outputs", run_id=run.id, position=record.position, owner_id=user.id,
                         group_id=run.group_id)
        record.outputs_blob_id = blob.id
        return whole
    except (blobs.BlobError, pane_outputs.OutputError, TypeError, ValueError):
        log.warning("Workflow run %s: step %s's whole outputs couldn't be kept", run.id, record.step_id, exc_info=True)
        return shown


def _whole_outputs(db: Session, record: models.WorkflowRunStep) -> Any:
    """A recorded step's outputs as later steps see them: the whole, from the
    blob store, when the row holds them cut down."""
    if record.outputs_blob_id:
        row = db.get(models.Blob, record.outputs_blob_id)
        if row is not None:
            try:
                return json.loads(blobs.read(row))
            except (blobs.BlobError, ValueError):
                log.warning("Step %s's whole outputs couldn't be read back", record.id, exc_info=True)
    return record.outputs or {}


def _bounded(values: Any) -> tuple[Any, bool]:
    """Outputs kept to STEP_OUTPUT_BYTES, the longest list halved until they fit."""
    if values is None:
        return None, False
    try:
        copy_ = json.loads(json.dumps(values, default=str))
    except (TypeError, ValueError):
        return {"note": "These outputs couldn't be kept."}, True
    if not isinstance(copy_, dict):
        copy_ = {"value": copy_}
    try:
        trimmed = pane_outputs.fit(copy_, STEP_OUTPUT_BYTES)
    except pane_outputs.OutputError:
        return {"note": f"These outputs were over {STEP_OUTPUT_BYTES} bytes, even cut down."}, True
    return copy_, trimmed


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
    CLEAN_SECONDS = 3600.0

    def __init__(self) -> None:
        self.loop: Optional[asyncio.AbstractEventLoop] = None
        self._event: Optional[asyncio.Event] = None
        self._task: Optional[asyncio.Task] = None
        self._running: set[asyncio.Future] = set()
        self._cleaned = 0.0

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
                if time.monotonic() - self._cleaned > self.CLEAN_SECONDS:
                    self._cleaned = time.monotonic()
                    await asyncio.to_thread(_clean_once)
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


def _clean_once() -> None:
    db = SessionLocal()
    try:
        blobs.clean(db)
    except blobs.BlobError:
        log.warning("Workflows: cleaning up the blob store failed", exc_info=True)
    finally:
        db.close()
    db = SessionLocal()
    try:
        from . import runner_client

        runner_client.prune(db)
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
        "rerun_from": run.rerun_from,
    }
    if not readable:
        return out
    out["params"] = run.params
    out["error"] = run.error
    steps = run_steps(db, run)
    approvals = {
        a.position: a
        for a in db.query(models.Approval).filter_by(run_id=run.id).order_by(models.Approval.id)
    }
    out["steps"] = [
        {
            "position": s.position,
            "id": s.step_id,
            "label": s.label,
            "status": s.status,
            "started_at": _iso(s.started_at),
            "finished_at": _iso(s.finished_at),
            "error": s.error,
            "attempts": s.attempts or 0,
            "reused": bool(s.reused),
            **({"approval": approval_out(approvals[s.position], user, run)} if s.position in approvals else {}),
            **({"inputs": s.inputs, "outputs": s.outputs, "trimmed": bool(s.trimmed),
                "outputs_blob": s.outputs_blob_id} if detail else {}),
        }
        for s in steps
    ]
    if detail:
        out["definition"] = run.definition
        out["artifacts"] = [
            {**_blob_out(b), "position": b.position}
            for b in db.query(models.Blob).filter_by(run_id=run.id, kind="artifact").order_by(models.Blob.created_at)
        ]
    return out


def approval_out(approval: models.Approval, user: models.User, run: Optional[models.WorkflowRun]) -> dict[str, Any]:
    return {
        "id": approval.id,
        "status": approval.status,
        "message": approval.message,
        "details": approval.details,
        "by": approval.decide_by,
        "step_id": approval.step_id,
        "run_id": approval.run_id,
        "created_at": _iso(approval.created_at),
        "expires_at": _iso(approval.expires_at),
        "decided_by": approval.decided_by_name,
        "decided_at": _iso(approval.decided_at),
        "comment": approval.comment,
        "can_decide": approval.status == "pending" and may_decide(user, approval, run),
    }


def _iso(value: Optional[datetime.datetime]) -> Optional[str]:
    return value.replace(microsecond=0).isoformat() + "Z" if value else None
