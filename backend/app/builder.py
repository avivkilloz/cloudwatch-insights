"""The Builder, its first part (PLATFORM_PLAN.md §24, D71, D103-D106): pane
types made in the platform.

A built pane type is a manifest -- the same YAML, checked by the same strict
model, drawn by the same renderer and run through the same action endpoint as
a bundled one -- kept in Postgres (`built_pane_types`) and the store repo
(`panes/<name>.yaml`), and merged into the manifest registry beside the files
(`pane_manifest.set_built`). Nothing about it is the builder's own code: its
actions are declarative requests (D67) and handlers the platform already has,
run as whoever uses the pane, through their group's grants and connections.

Who builds is a group's Builder (`builder_enabled`) or an admin. A new type is
granted to its builder's group at once (they use what they made); every other
group gets it when an admin ticks it in Users -> Groups -> Panes (D65).

Replicas: the one that saves loads at once; the others notice the generation
(a Settings row bumped in the save's transaction) within `REFRESH_SECONDS`.
"""

from __future__ import annotations

import asyncio
import datetime
import logging
import re
from typing import Any, Optional

import yaml
from pydantic import ValidationError
from sqlalchemy.orm import Session

from . import aws_request, catalogue, models, pane_access, row_paths, runner_client, store
from .db import SessionLocal
from .panes import handlers as pane_handlers
from .panes import live as pane_live
from .panes import manifest as pane_manifest

logger = logging.getLogger(__name__)

ID_RE = re.compile(r"^[a-z][a-z0-9_]{1,47}$")
GENERATION_KEY = "builder.generation"
REFRESH_SECONDS = 5.0

STARTER = """# A pane type: its inputs, the actions that fill its outputs, and how it's laid out.
# Check finds any mistake with its line; Create makes it, for your group at once.
label: Service status
description: The status of a service, from an HTTP API connection.
category: Tools
inputs:
  - key: connection
    type: connection
    connection_type: http_api
    label: Connection
  - key: path
    type: text
    label: Path
    default: /status
actions:
  - id: fetch
    main: true
    run_label: Check
    request: { method: GET, connection: connection, path: path }
outputs:
  - key: response
    render: json
layout:
  - title: Service
    items:
      - input: connection
      - input: path
      - toolbar:
          - action: fetch
  - title: Status
    when: { output: response, present: true }
    items:
      - output: response
"""


class BuilderError(ValueError):
    """A definition or a request about one that can't be accepted. `errors`
    lists every problem found, each `{line, message}`."""

    def __init__(self, message: str, errors: Optional[list[dict]] = None):
        super().__init__(message)
        self.errors = errors or [{"line": None, "message": message}]


def can_build(user: models.User) -> bool:
    group = user.group
    return bool(group and (group.is_admin or group.builder_enabled))


def _line(source: str, path: tuple) -> Optional[int]:
    from .workflows import _line as line_of

    return line_of(source, path)


def where(e: dict) -> str:
    """"Line 4: " / "health.py, line 12: " -- an error's place, said."""
    if e.get("file") and e.get("line"):
        return f"{e['file']}, line {e['line']}: "
    if e.get("file"):
        return f"{e['file']}: "
    return f"Line {e['line']}: " if e.get("line") else ""


def _fail(errors: list[dict]) -> BuilderError:
    text = "\n".join(f"{where(e)}{e['message']}" for e in errors[:8])
    return BuilderError(text, errors)


def parse(source: str, type_id: Optional[str], files: Optional[dict[str, str]] = None) -> pane_manifest.Manifest:
    """The manifest in `source`, as the pane type `type_id`, checked in full:
    the strict model a bundled manifest passes, then what only a built one
    must -- it draws itself, it runs nothing the platform doesn't have.
    `type_id` None: a draft whose id isn't decided yet, its own `id:` line
    not held to anything (it was held to "draft", and that error, dropped by
    Check, stopped every check after it: a draft with an id line checked
    clean whatever it said)."""
    try:
        data = yaml.safe_load(source or "")
    except yaml.YAMLError as e:
        mark = getattr(e, "problem_mark", None)
        raise _fail([{"line": mark.line + 1 if mark else None, "message": f"Not valid YAML: {getattr(e, 'problem', e)}"}])
    if not isinstance(data, dict):
        raise _fail([{"line": 1, "message": "A pane type is a mapping: label, inputs, actions, outputs, layout."}])
    # The name alone is the same id: with a store, what's made here is put in
    # its namespace (`lambda` is saved as `default:lambda`, D78), and the
    # saved file's id line says so. Writing the name was refused as a mistake.
    if type_id is not None and data.get("id") not in (None, type_id, store.split_id(type_id)[1]):
        raise _fail([{"line": _line(source, ("id",)), "message": f"Its id is {type_id} (the Id above), not {data['id']}."}])
    # What every built pane is, said for it: drawn from its layout, its keys
    # under in./out./view. A built one can't be anything else.
    data = {"state": "v2", "rendered": True, **data, "id": type_id or "draft"}
    # What the agent reads about it: its description, unless it says more.
    if "about" not in data and (data.get("description") or data.get("label")):
        data["about"] = data.get("description") or data.get("label")
    try:
        manifest = pane_manifest.Manifest.model_validate(data)
    except ValidationError as e:
        errors = []
        for err in e.errors():
            loc = tuple(err["loc"])
            where = ".".join(str(p) for p in loc)
            message = err["msg"].removeprefix("Value error, ")
            if err["type"] == "extra_forbidden":
                # Said with what may be there: "Extra inputs are not permitted"
                # left a model guessing, and it guessed `when` on an action.
                fields = _fields_at(loc[:-1])
                key = str(loc[-1])
                if "." in key and key.split(".")[0] in fields:
                    # A key named like a path (`layout.3:`): a change written
                    # with dots, made into a key. Listing every field the top
                    # may have sent the model round again.
                    message = (f"{key} is a key named like a path, not a part of the {key.split('.')[0]}: remove it "
                               f"(a change {{\"op\": \"remove\", \"path\": \"{key}\"}}) and make that change at "
                               f"{key.replace('.', '/')}")
                elif fields:
                    message = f"there is no {key} here; it may say: {', '.join(fields)}"
            errors.append({"line": _line(source, loc) if loc else None, "message": f"{where}: {message}" if where else message})
        raise _fail(errors) from None
    manifest._files = dict(files or {})
    errors = check(manifest, source)
    if errors:
        raise _fail(errors)
    return manifest


def _model_in(annotation: Any) -> Any:
    """The pydantic model an annotation holds (through Optional, list, Union)."""
    from typing import get_args

    from pydantic import BaseModel

    if isinstance(annotation, type) and issubclass(annotation, BaseModel):
        return annotation
    for arg in get_args(annotation):
        found = _model_in(arg)
        if found is not None:
            return found
    return None


def _fields_at(loc: tuple) -> list[str]:
    """The fields the part of a manifest at `loc` may have."""
    model: Any = pane_manifest.Manifest
    for part in loc:
        if isinstance(part, int):
            continue
        field = model.model_fields.get(str(part)) if model is not None else None
        model = _model_in(field.annotation) if field is not None else None
        if model is None:
            return []
    return [name for name in model.model_fields if name not in ("legacy_key",)]


def check(manifest: pane_manifest.Manifest, source: str = "") -> list[dict]:
    errors: list[dict] = []
    # The files beside it (D136): each problem says its file, and its line
    # is that file's.
    for name, line, message in runner_client.file_problems(manifest._files):
        errors.append({"line": line, "file": name or None, "message": message})

    def err(path: tuple, message: str) -> None:
        errors.append({"line": _line(source, path) if source else None, "message": message})

    if manifest.state != "v2" or not manifest.rendered:
        err(("state",), "A built pane is drawn from its layout: state v2, rendered true.")
    if manifest.flag:
        err(("flag",), "A built pane has no flag: groups are granted it in Users -> Groups -> Panes.")
    if manifest.connection_types:
        err(("connection_types",), "Make a connection type in Settings -> Environments -> Types, and name it here.")
    for i, a in enumerate(manifest.actions):
        for path, name in ((("handler",), a.handler), (("poll", "handler"), a.poll.handler if a.poll else None),
                           (("poll", "stop"), a.poll.stop if a.poll else None)):
            if name and name not in pane_handlers.ACTIONS:
                err(("actions", i, *path), f"There is no handler {name}. Handlers: {', '.join(sorted(pane_handlers.ACTIONS))}.")
        if aws_request.is_aws(a.request):
            for path, message in aws_request.problems(manifest, a.request or {}, a.args):
                err(("actions", i, "request", *path), message)
        elif a.request is not None:
            for path, message in _path_problems((a.request or {}).get("rows")):
                err(("actions", i, "request", "rows", *path), message)
        if a.code is not None:
            # Inline code's lines, under `code: |`, are counted from the line after
            # it; a file's are the file's own.
            base = _line(source, ("actions", i, "code")) if source else None
            for file, at, message in runner_client.entry_problems(a.code, manifest._files):
                if file:
                    errors.append({"line": at, "file": file, "message": message})
                else:
                    errors.append({"line": base + at if base and at and isinstance(a.code, str) else base,
                                   "message": f"actions.{i}.code: {message}"})
        if a.live and a.live not in pane_live.FUNCTIONS:
            err(("actions", i, "live"), f"There is no live function {a.live}. They are: {', '.join(sorted(pane_live.FUNCTIONS))}.")
    views = {v.key for v in manifest.views}
    for i, o in enumerate(manifest.outputs):
        allowed = CONFIG.get(o.render)
        if allowed is not None:
            for key in o.config:
                if key not in allowed:
                    err(("outputs", i, "config", key),
                        f"A {o.render} output's config has no {key}; it may say: {', '.join(allowed)}. Rows that "
                        "open to show more are `detail: {action: <a row action>}` with `expand:` (the reference's "
                        "`rows that open (example)`).")
        detail = o.config.get("detail")
        if isinstance(detail, dict):
            for key in detail:
                if key not in DETAIL_KEYS:
                    err(("outputs", i, "config", "detail", key),
                        f"A row detail has no {key}; it may say: {', '.join(DETAIL_KEYS)}.")
        sections = detail.get("sections") if isinstance(detail, dict) else detail
        for path, message in _section_problems(sections, ("outputs", i, "config", "detail")
                                               + (("sections",) if isinstance(detail, dict) else ())):
            err(path, message)
        if detail is not None and o.render in ("table", "list"):
            expand = o.config.get("expand")
            if not isinstance(expand, str) or expand not in views:
                err(("outputs", i, "config"),
                    f"Rows open only with `expand:` naming a view key that holds which are open -- add "
                    f"`expand: expanded` here and `views: [{{key: expanded, default: []}}]` at the top level.")
        if isinstance(detail, dict):
            for path, message in _opening_problems(manifest, o, detail, ("outputs", i, "config", "detail")):
                err(path, message)
    if manifest.id in pane_manifest.bundled():
        err(("id",), f"{manifest.id} is one of the platform's own pane types.")
    return errors


# What a table's or a list's `config` may say (the browser's TableView and
# panes/ListView.tsx read these): a key it doesn't read did nothing, so a
# model's made-up `on_select` looked like a feature that didn't work.
CONFIG: dict[str, tuple[str, ...]] = {
    "table": ("detail", "expand", "domain", "chart"),
    "list": ("summary", "detail", "expand", "row_key", "groups", "count", "empty", "export", "toolbar", "domain",
             "busy", "chart"),
}
DETAIL_KEYS = ("action", "sections", "include", "include_help", "noun", "merge")
# What a detail section may say (panes/DetailSections.tsx).
SECTION_KEYS = ("title", "fields", "entries", "list", "summary", "detail", "open", "gap", "table", "columns", "tags",
                "grid", "json", "empty", "warnings", "prefix")


def _section_problems(sections: Any, at: tuple) -> list[tuple[tuple, str]]:
    if not isinstance(sections, list):
        return []
    out: list[tuple[tuple, str]] = []
    for n, section in enumerate(sections):
        if not isinstance(section, dict):
            out.append(((*at, n), "A detail section is a mapping, e.g. {title: Tags, table: Tags, columns: [...]}."))
            continue
        for key in section:
            if key not in SECTION_KEYS:
                out.append(((*at, n, key), f"A detail section has no {key}; it may say: {', '.join(SECTION_KEYS)}."))
        out += _section_problems(section.get("detail"), (*at, n, "detail"))
    return out


# A template's reads of the detail: `d.job.jobId`, `d.Tags[Key=Name].Value`.
_D_REF = re.compile(r"(?<![\w.])d((?:\.[A-Za-z_][\w-]*|\[[^\]]*\])+)")
# What a section names by path, into the detail.
_SECTION_PATHS = ("entries", "list", "table", "tags", "json", "warnings")


def _producer(manifest: pane_manifest.Manifest, key: str) -> Optional[pane_manifest.ManifestAction]:
    """The request whose rows fill an output, when one does: the one naming
    it as its `output`, else (for `rows`) one naming none."""
    for a in manifest.actions:
        if a.request is None or a.args:
            continue
        into = (a.request or {}).get("output")
        if into == key or (into is None and key == "rows"):
            return a
    return None


def _columns(manifest: pane_manifest.Manifest, action: pane_manifest.ManifestAction) -> Optional[set[str]]:
    """The columns a request's rows have, when its `rows` names them; None
    when only running it would say (no columns, or code)."""
    columns = ((action.request or {}).get("rows") or {}).get("columns")
    if not isinstance(columns, dict) or not columns:
        return None
    out = set(columns)
    conn = next((i for i in manifest.inputs if i.key == (action.request or {}).get("connection")), None)
    if conn is not None and conn.type == "connections" and not action.args:
        out.add("Environment")  # stamped on each row of a fan-out (a row action runs on one)
    return out


def _opening_problems(manifest: pane_manifest.Manifest, output: Any, detail: dict,
                      at: tuple) -> list[tuple[tuple, str]]:
    """What makes rows open onto nothing, offline (both checked clean and
    showed every field empty): a row action reading a column the rows don't
    have, and a detail's templates reading what its AWS reply doesn't hold."""
    action = next((a for a in manifest.actions if a.id == detail.get("action") and a.args), None)
    if action is None:
        return []
    out: list[tuple[tuple, str]] = []
    producer = _producer(manifest, output.key)
    columns = _columns(manifest, producer) if producer is not None else None
    if columns is not None:
        index = manifest.actions.index(action)
        for arg, path in action.args.items():
            head, _, rest = path.partition(".")
            column = rest.split(".")[0].split("[")[0]
            if head == "row" and column and column not in columns:
                like = _same_name(column, columns)
                out.append((("actions", index, "args", arg),
                            f"row.{column} isn't a column of the {output.key} rows, so the row action gets nothing "
                            f"for {arg}. " + (f"The column is row.{like}, as written in its rows' columns." if like
                                              else f"Their columns: {', '.join(sorted(columns))}.")))
    shape, what = _detail_shape(action)
    own = _columns(manifest, action)
    if shape is None and own is None:
        return out
    for n, section in enumerate(detail.get("sections") or []):
        if not isinstance(section, dict):
            continue
        reads: list[tuple[tuple, str]] = []
        for key in _SECTION_PATHS:
            if isinstance(section.get(key), str):
                reads.append(((n, key), section[key]))
        texts = [((n, "title"), section.get("title"))]
        texts += [((n, "fields", f, "value"), field.get("value")) for f, field in enumerate(section.get("fields") or [])
                  if isinstance(field, dict)]
        for where, text in texts:
            for expr in re.findall(r"\{\{(.*?)\}\}", text) if isinstance(text, str) else []:
                for ref in _D_REF.findall(expr):
                    reads.append((where, ref.lstrip(".")))
        for where, path in reads:
            if not path or path.startswith(("in.", "out.")):
                continue
            if shape is None:
                # A request whose rows have columns opens onto its one row.
                first = path.split(".")[0].split("[")[0]
                if own and first not in own | {"rows"}:
                    out.append(((*at, "sections", *where), f"The detail ({action.id}'s one row) has no {first}: "
                                                           f"its columns are {', '.join(sorted(own))}."))
                continue
            found, why = aws_request._walk(shape, path)
            if found is None:
                out.append(((*at, "sections", *where), f"The detail ({what}; `d` in a template) has no {path}: "
                                                       f"{why}."))
    return out


def _same_name(name: str, names: set[str]) -> Optional[str]:
    """The column a name means when it's written otherwise: jobId for
    `Job ID` (a model renamed the columns and kept reading the field)."""
    def plain(text: str) -> str:
        return re.sub(r"[^a-z0-9]", "", text.lower())
    return next((n for n in sorted(names) if plain(n) == plain(name)), None)


def _detail_shape(action: pane_manifest.ManifestAction) -> tuple[Any, str]:
    """The shape of what a row action that's an AWS request opens onto, as
    the browser reads it: the reply when it has no list, an item of
    `rows.at` when its rows have no columns. (None, "") when only running it
    would say: code, a handler, columns (a row's keys are checked as such)."""
    spec = action.request or {}
    if not aws_request.is_aws(spec):
        return None, ""
    try:
        name = aws_request.operation_name(spec["service"], spec["operation"])
        model = aws_request._botocore.get_service_model(spec["service"]).operation_model(name)
    except Exception:  # noqa: BLE001 -- said by aws_request.problems already
        return None, ""
    reply = model.output_shape
    if reply is None or reply.type_name != "structure":
        return None, ""
    rows = spec.get("rows")
    if rows is None:
        if any(m.type_name == "list" for m in reply.members.values()):
            return None, ""  # one of its rows, or {rows}: depends on the reply
        return reply, f"{name}'s reply"
    if isinstance(rows, dict) and not rows.get("columns") and rows.get("at") and not rows.get("explode"):
        listed, _ = aws_request._walk(reply, str(rows["at"]))
        if listed is not None and listed.type_name == "list" and listed.member.type_name == "structure":
            return listed.member, f"an item of {name}'s {rows['at']}"
    return None, ""


def _path_problems(rows: Any) -> list[tuple[tuple, str]]:
    """A request's `rows` paths that aren't paths (row_paths): checked for
    any request, where an AWS one's are also held to its reply."""
    if not isinstance(rows, dict):
        return []
    out: list[tuple[tuple, str]] = []
    paths = [((key,), rows.get(key)) for key in ("at", "explode", "spread")]
    for column, source in (rows.get("columns") or {}).items():
        paths.append((("columns", column), source.get("from") if isinstance(source, dict) else source))
    for path, value in paths:
        if isinstance(value, str) and value:
            try:
                row_paths.parts(value)
            except row_paths.PathError as e:
                out.append((path, str(e)))
    return out


# ---------------------------------------------------------------- the examples (D72)

# Top-level keys a bundled manifest has and a built one may not (`check`):
# the id is the Builder's Id field; a flag and connection types are an
# admin's to grant and make.
_NOT_BUILT = ("id", "flag", "connection_types")


def example_source(type_id: str) -> str:
    """A bundled pane type's file as a start for a built one: comments and
    all, without what a built pane may not say -- started from as it was,
    IoT failed Check on its `flag:` line before anything was changed."""
    text = (pane_manifest.MANIFEST_DIR / f"{type_id}.yaml").read_text()
    out: list[str] = []
    skipping = False
    for line in text.splitlines():
        top = re.match(r"^([A-Za-z_][\w-]*)\s*:", line)
        if top:
            skipping = top.group(1) in _NOT_BUILT
        elif line and not line[0].isspace() and not line.startswith("#"):
            skipping = False
        if not skipping:
            out.append(line)
    label = pane_manifest.bundled()[type_id].label
    head = f"# Started from {label}: its id, flag and connection types left out -- a built pane has none of its own.\n"
    return head + "\n".join(out).strip("\n") + "\n"


# ---------------------------------------------------------------- which handlers a builder may name (D113)


def handler_owners() -> dict[str, set[str]]:
    """Each handler, and the platform's own pane types that run it."""
    owners: dict[str, set[str]] = {}
    for m in pane_manifest.bundled().values():
        for a in m.actions:
            for name in (a.handler, a.poll.handler if a.poll else None, a.poll.stop if a.poll else None):
                if name:
                    owners.setdefault(name, set()).add(m.id)
    return owners


def usable_handlers(user: Any) -> set[str]:
    """The handlers a built pane of this user's may run: those of the pane
    types their group may use (admins: all). A built pane is granted to its
    builder's group at once (D105), so a handler from a pane their group
    wasn't given -- DynamoDB's scan, say -- reached what an admin hadn't
    granted them."""
    group = getattr(user, "group", None)
    if group is not None and group.is_admin:
        return set(pane_handlers.ACTIONS)
    return {h for h, owners in handler_owners().items() if any(pane_access.allowed(group, o) for o in owners)}


def access_errors(manifest: pane_manifest.Manifest, user: Any, source: str = "") -> list[dict]:
    """Handlers in `manifest` its builder's group may not run, with their lines."""
    usable = usable_handlers(user)
    owners = handler_owners()
    out = []
    for i, a in enumerate(manifest.actions):
        for path, name in ((("handler",), a.handler), (("poll", "handler"), a.poll.handler if a.poll else None),
                           (("poll", "stop"), a.poll.stop if a.poll else None)):
            if name and name in pane_handlers.ACTIONS and name not in usable:
                labels = sorted(pane_manifest.bundled()[o].label for o in owners.get(name, ()))
                whose = f" -- it's what {', '.join(labels)} run{'s' if len(labels) == 1 else ''}" if labels else ""
                out.append({"line": _line(source, ("actions", i, *path)) if source else None,
                            "message": f"Your group can't use the handler {name}{whose}, and your group isn't granted that."})
    return out


# ---------------------------------------------------------------- the preview (5-2c, D112)


def preview(source: str, type_id: Optional[str], user: Any,
            files: Optional[dict[str, str]] = None) -> pane_manifest.Manifest:
    """The draft, checked as Check checks it and held to its builder's
    handlers, ready to be drawn by the pane renderer: what the editor holds,
    never saved and never granted to anyone."""
    manifest = parse(source, type_id, files)
    errors = access_errors(manifest, user, source)
    if errors:
        raise _fail(errors)
    return manifest


def run_preview(db: Session, user: Any, source: str, type_id: Optional[str], action_id: str,
                inputs: dict[str, Any], cursor: Any = None, files: Optional[dict[str, str]] = None) -> dict[str, Any]:
    """One of the draft's actions, as its builder, through the very functions
    a saved pane's actions go through (`run_request`/`run_handler`, D49):
    the same identity, connection checks and masking. Nothing is stored: a
    preview is in no session."""
    from fastapi import HTTPException

    from .routers import panes as panes_router

    if not can_build(user):
        raise HTTPException(status_code=403, detail="Building pane types isn't turned on for your group.")
    try:
        manifest = preview(source, type_id, user, files)
    except BuilderError as e:
        first = e.errors[0] if e.errors else {"message": str(e)}
        raise HTTPException(status_code=400, detail=f"The draft has a problem: {where(first)}{first['message']}") \
            from None
    action = next((a for a in manifest.actions if a.id == action_id), None)
    if action is None:
        raise HTTPException(status_code=404, detail=f"The draft has no action {action_id}.")
    if action.poll is not None:
        raise HTTPException(status_code=400, detail="A background run can't be previewed: Create it, then Open in a session.")
    if action.live is not None:
        raise HTTPException(status_code=400, detail=f"{action_id} is worked out as you type, in the pane itself.")
    if action.request is not None:
        return panes_router.run_request(db, user, manifest, action, inputs, draft=True)
    return panes_router.run_handler(db, user, manifest, action, inputs, cursor, draft=True)


def _bump(db: Session) -> None:
    row = db.get(models.Setting, GENERATION_KEY)
    if row is None:
        db.add(models.Setting(key=GENERATION_KEY, value="1"))
    else:
        row.value = str(int(row.value or "0") + 1)


def save(db: Session, user: models.User, requested_id: Optional[str], source: str,
         row: Optional[models.BuiltPaneType] = None, files: Optional[dict[str, str]] = None) -> models.BuiltPaneType:
    if not can_build(user):
        raise BuilderError("Building pane types isn't turned on for your group.")
    if row is None:
        try:
            type_id = store.full_id(db, requested_id or "", ID_RE)
        except store.StoreError as e:
            raise BuilderError(str(e)) from None
        if db.get(models.BuiltPaneType, type_id) is not None or type_id in pane_manifest.bundled():
            raise BuilderError(f"A pane type {type_id} already exists.")
    else:
        type_id = row.id
    errors = access_errors(parse(source, type_id, files), user, source)
    if errors:
        raise _fail(errors)
    # Its file in the store names it, as a workflow's does (a restore reads the id there).
    from .workflows import ensure_id_line

    source = ensure_id_line(source, type_id)
    now = datetime.datetime.utcnow()
    if row is None:
        row = models.BuiltPaneType(id=type_id, created_by_id=user.id, created_at=now)
        db.add(row)
        # Its builder's group uses it at once; any other group when an admin
        # grants it (D65, D105).
        if user.group and not user.group.is_admin:
            db.add(models.GroupPaneGrant(group_id=user.group.id, pane_type=type_id))
    row.source, row.files, row.updated_by_id, row.updated_at = source, dict(files or {}), user.id, now
    _bump(db)
    db.flush()
    store.record(db, "pane", row.id, "write", user)
    db.commit()
    load(db)
    return row


def delete(db: Session, user: models.User, row: models.BuiltPaneType) -> None:
    if not can_build(user):
        raise BuilderError("Building pane types isn't turned on for your group.")
    db.query(models.GroupPaneGrant).filter_by(pane_type=row.id).delete()
    db.query(models.CataloguePlacement).filter_by(pane_type=row.id).delete()
    store.record(db, "pane", row.id, "delete", user)
    from . import build_drafts

    build_drafts.forget(db, "pane", row.id)
    db.delete(row)
    _bump(db)
    db.commit()
    load(db)


# ---------------------------------------------------------------- the registry


_generation: Optional[str] = None


def load(db: Session) -> None:
    """Every built pane type into the registry. One that no longer passes
    (a handler it named was removed) is left out and logged, not fatal."""
    global _generation
    built: dict[str, pane_manifest.Manifest] = {}
    for row in db.query(models.BuiltPaneType).all():
        try:
            built[row.id] = parse(row.source, row.id, row.files)
        except BuilderError as e:
            logger.warning("Built pane type %s doesn't load: %s", row.id, e)
    setting = db.get(models.Setting, GENERATION_KEY)
    _generation = setting.value if setting else None
    pane_manifest.set_built(built)
    catalogue.ensure_categories(db)
    # Step types after the panes they may name (D122); one generation for both.
    from . import step_types

    step_types.load(db)


def refresh(db: Session) -> None:
    """Loads again if another replica saved since this one last loaded."""
    setting = db.get(models.Setting, GENERATION_KEY)
    if (setting.value if setting else None) != _generation:
        load(db)


async def manager() -> None:
    """Keeps this replica's registry in step with saves made in others."""
    while True:
        await asyncio.sleep(REFRESH_SECONDS)
        try:
            await asyncio.to_thread(_refresh_once)
        except Exception as e:  # noqa: BLE001 -- logged; the next tick tries again
            logger.warning("Built pane types didn't refresh: %s", e)


def _refresh_once() -> None:
    with SessionLocal() as db:
        refresh(db)


# ---------------------------------------------------------------- the store's kind


def store_load(db: Session, data: dict, row: Optional[models.BuiltPaneType],
               actor: Optional[models.User]) -> models.BuiltPaneType:
    type_id = str(data.get("id") or "")
    if not store.valid_id(type_id, ID_RE):
        raise store.StoreError(f"'{type_id}' isn't a pane type id.")
    source = str(data.get("__source__") or "")
    files = dict(data.get("__files__") or {})
    try:
        parse(source, type_id, files)
    except BuilderError as e:
        raise store.StoreError(f"Pane type {type_id}: {e}") from None
    if row is None:
        row = models.BuiltPaneType(id=type_id, created_by_id=actor.id if actor else None)
        db.add(row)
    row.source, row.files, row.updated_at = source, files, datetime.datetime.utcnow()
    _bump(db)
    return row


def schema(user: Any = None) -> dict[str, Any]:
    """What a definition may say, for the editor's reference (and the agent's,
    D72): the manifest's own JSON schema and the handlers and live functions
    there are to name -- the handlers this user's group may use (D113)."""
    return {
        "schema": pane_manifest.Manifest.model_json_schema(),
        "handlers": sorted(usable_handlers(user) if user is not None else pane_handlers.ACTIONS),
        "live": sorted(pane_live.FUNCTIONS),
        # What the form editor offers in its pickers (5-2d).
        "input_types": list(pane_manifest.InputType.__args__),
        "renders": list(pane_manifest.Render.__args__),
        "examples": sorted(pane_manifest.bundled()),
        "starter": STARTER,
        # Code (D134): a working example, and whether it can run here (D135).
        "code_example": CODE_EXAMPLE,
        "code_example_files": CODE_EXAMPLE_FILES,
        "runner": runner_client.configured(),
    }



# ---------------------------------------------------------------- for the agent (5-2, D72)


def _fields(model: Any) -> dict[str, str]:
    """A model's fields, their types and what each means, as one line each:
    the reference a model reads, shorter than its JSON schema and from the
    same source -- the meaning from `panes/manifest_docs.py` (D151), where a
    test holds every field to having one."""
    from .panes import manifest_docs

    out: dict[str, str] = {}
    for name, field in model.model_fields.items():
        annotation = str(field.annotation).replace("typing.", "").replace("app.panes.manifest.", "")
        annotation = annotation.replace("app.workflows.", "").replace("<class '", "").replace("'>", "")
        key = field.alias or name
        meaning = manifest_docs.describe(model.__name__, key)
        out[key] = annotation + (" (required)" if field.is_required() else "") + (f" -- {meaning}" if meaning else "")
    return out


# How a reply becomes rows (platform_tools/panes.extract_rows), for both kinds of request.
ROWS_DOC = (
    "{at: where the list is (a path), columns: {Column name: path in each item, or {from: path, as: "
    "text|number|time}}, explode: a list in each item to make a row per element of, spread: an object whose keys "
    "become columns}; without columns, each item is the row. Paths: " + row_paths.SYNTAX
)

# What a table's or list's `config` says (CONFIG), for the reference.
CONFIG_DOC = {
    "table": {
        "detail": "rows that open: {action: a row action (one with args), sections: what the opened row shows "
                  "(left out: its detail as JSON)}",
        "expand": "the view key holding which rows are open (declare it: views: [{key: expanded, default: []}]; "
                  "the action that lists the rows resets it: resets: [view.expanded])",
        "domain": "what the agent's chat calls attached rows", "chart": "the view key of its chart",
    },
    "list": {
        "summary": "each row's line: [{tag|msg|muted: template over row, when: {field, equals|present}}]",
        "detail": "as a table's; or `json` (the row itself), or sections over the row",
        "expand": "as a table's", "row_key": "the field that names a row", "groups": "a fan-out's groups",
        "count": "template", "empty": "text when there are no rows", "export": "file name",
        "toolbar": "always | rows",
    },
    "row action": "an action with args: {input: row.<column> | group.<field>} -- its inputs read from the row, "
                  "not the pane's, by the column names its rows have (row.Job ID for a column `Job ID: jobId`). A request as one (AWS: connection: <the connections input>, args giving it "
                  "row.Environment) answers with its one row as the detail, or {rows} when the reply held "
                  "several; without `rows`, the whole reply",
    "sections": "[{title}, {fields: [{label, value: template over d}]}, {entries: an object's path}, "
                "{table: a list's path, columns: [{label, value: template over row}]}, {list: path, summary}, "
                "{tags: path}, {json: path}, {grid: [{title, json}]}] -- d is the detail: an AWS request's reply as "
                "describe_aws_operation shows it (d.job.status), its one row's columns, or what code's run returns",
}

# An action that's code (D134), run in the runner as whoever uses the pane.
CODE_EXAMPLE = """label: Devices, online first
description: Code that reshapes an API's reply -- online devices first.
inputs:
  - key: connection
    type: connection
    connection_type: http_api
    label: API
actions:
  - id: list
    main: true
    run_label: List
    # Its code is a file beside this one (devices.py): run(inputs, ctx) is called.
    code:
      file: devices.py
outputs:
  - key: rows
    render: table
    actions: [copy, export]
  - key: error
    render: error
layout:
  - title: Devices
    clear: [rows]
    items:
      - input: connection
      - toolbar:
          - action: list
      - output: error
      - output: rows
"""
CODE_EXAMPLE_FILES = {"devices.py": """def run(inputs, ctx):
    reply = ctx.http(inputs["connection"], "/devices")
    items = reply.json()["items"]
    items.sort(key=lambda d: not d.get("online"))
    ctx.log(len(items), "devices")
    return {"rows": items}
"""}

# Rows that open to show more, from a request of their own (a working pane type).
DETAIL_EXAMPLE = """label: Stacks
description: CloudFormation stacks; open one for its resources.
category: Services
inputs:
  - {key: connections, type: connections, connection_type: aws, label: Environments}
actions:
  - id: list
    main: true
    run_label: List
    resets: [view.expanded]
    request:
      connection: connections
      service: cloudformation
      operation: DescribeStacks
      paginate: true
      rows:
        at: Stacks
        columns:
          Stack: StackName
          Status: StackStatus
          Owner: Tags[Key=owner].Value
          Created: CreationTime
  - id: resources
    args: {connections: row.Environment, stack: row.Stack}
    request:
      connection: connections
      service: cloudformation
      operation: DescribeStackResources
      params: {StackName: {input: stack}}
      rows:
        at: StackResources
        columns: {Resource: LogicalResourceId, Type: ResourceType, Status: ResourceStatus}
outputs:
  - key: rows
    render: table
    actions: [select, copy, export, attach]
    config:
      expand: expanded
      detail:
        action: resources
        sections:
          - title: Resources
            table: rows
            columns:
              - {label: Resource, value: "{{ row.Resource }}"}
              - {label: Type, value: "{{ row.Type }}"}
              - {label: Status, value: "{{ row.Status }}"}
  - key: error
    render: error
views:
  - {key: expanded, default: []}
layout:
  - title: Stacks
    clear: [rows]
    items:
      - input: connections
      - toolbar:
          - action: list
      - output: error
      - output: rows
"""

OUTPUT_DOC = (
    "the output its rows go to (declared in outputs, render table); left out, `rows` -- and running it then clears "
    "every output, so a pane with more than one request gives each its own output"
)

# What an AWS request looks like whole, for the agent (a working pane type).
AWS_EXAMPLE = """label: Lambda functions
description: The Lambda functions in each environment, with their runtime and size.
category: Services
inputs:
  - key: connections
    type: connections
    connection_type: aws
    label: Environments
actions:
  - id: list
    main: true
    run_label: List
    request:
      connection: connections
      service: lambda
      operation: ListFunctions
      paginate: true
      rows:
        at: Functions
        columns:
          Name: FunctionName
          Runtime: Runtime
          Memory: {from: MemorySize, as: number}
          Modified: LastModified
outputs:
  - key: rows
    render: table
    actions: [select, copy, export, attach]
  - key: error
    render: error
layout:
  - title: Functions
    items:
      - input: connections
      - toolbar:
          - action: list
      - output: error
      - output: rows
"""


def reference(db: Session, kind: str, user: Any) -> dict[str, Any]:
    """What a pane type's or a workflow's definition may say, generically --
    the models' own fields, the names there are to use, and where to read
    examples (D72: no per-service hints; the schema, examples and the check's
    errors are enough to build anything)."""
    from . import pane_access, step_types, workflows
    from .panes import manifest_docs

    if kind == "pane":
        m = pane_manifest
        return {
            "kind": "pane",
            "what": "A pane type's manifest, as YAML. Top level, then each part's fields.",
            # What the Builder sets itself, or a built type may not say, left out.
            "manifest": {
                k: v.replace(" (required)", "") if k == "about" else v
                for k, v in _fields(m.Manifest).items()
                if k not in ("id", "state", "rendered", "flag", "connection_types", "legacy_drop", "group")
            },
            "input": _fields(m.ManifestInput),
            "action": _fields(m.ManifestAction),
            # A request is a mapping the action endpoint reads (routers/panes.run_request).
            # An action's `request:` is one mapping, read two ways: to a
            # connection of an HTTP type, or -- with `service` and
            # `operation` -- an AWS API call (D110). Kept as two entries:
            # nested under an `aws` key, a model wrote an `aws:` key that
            # doesn't exist.
            "request (HTTP)": {
                "what": "an action's `request:` mapping, on a connection input of an HTTP type: a GET",
                "connection": "the input holding the connection",
                "path": "the input holding the path after the base URL", "fixed_path": "a path of its own instead",
                "query": "the input holding name -> value parameters (a headers input)",
                "params": "{name: literal | {input: key} | {window: start|end|step}}",
                "window": "{preset, start, end}: the time-range inputs a {window: ...} param reads",
                "rows_at": "the input naming where the rows are in the reply (a dotted path)",
                "rows": ROWS_DOC,
                "output": OUTPUT_DOC,
            },
            "request (AWS)": {
                "what": "the same `request:` mapping with `service` and `operation` (there is no `aws:` key): an AWS "
                        "API call that reads, as the user's group",
                "connection": "an input of type connection (one account) or connections (several: the rows of each, "
                              "an Environment column first, and the ones that failed in output `error`), "
                              "connection_type aws",
                "service": "botocore's service name: lambda, ecs, sqs, iot, rds, ec2…",
                "operation": "the API operation, ListFunctions (or list_functions); only reads: "
                             + ", ".join(aws_request.READS) + "…, never one that hands out secrets",
                "params": "{Name: literal | {input: key} | {window: start|end|step}}; Filter.Name nests",
                "paginate": "true: every page, up to max_items (default 1000, at most 5000)",
                "rows": ROWS_DOC + "; left out, the reply's first list",
                "output": OUTPUT_DOC,
                "outputs": "rows, or the one `output` names (render table); response (one connection, without "
                           "`output`); error (several connections: the ones that failed)",
                "example": AWS_EXAMPLE,
            },
            "code (an action's)": {**runner_client.SDK_DOC, "example": CODE_EXAMPLE,
                                   "example's file (devices.py)": CODE_EXAMPLE_FILES["devices.py"]},
            "output": _fields(m.ManifestOutput),
            "output config": CONFIG_DOC,
            "rows that open (example)": DETAIL_EXAMPLE,
            "card": _fields(m.Card),
            "layout_item": _fields(m.LayoutItem),
            "when": {**_fields(m.When), "what": "a layout item shown only when it holds; an action's `main` may be "
                                               "one, on an input"},
            "input_types": {t: manifest_docs.INPUT_TYPES.get(t, "") for t in m.InputType.__args__},
            "renders": {r: manifest_docs.RENDERS.get(r, "") for r in m.Render.__args__},
            "handlers": sorted(usable_handlers(user)),
            "live_functions": sorted(pane_live.FUNCTIONS),
            "examples": sorted(m.bundled()),
            "built_here": sorted(set(m.manifests()) - set(m.bundled())),
            "rules": [
                "Leave out id (the editor's Id field, or the saved type's), state and rendered (set for you); "
                "about defaults to the description.",
                "An action is a request (a GET to a connection of an HTTP type, or with `service` any AWS read "
                "API on an AWS connection), a handler from `handlers`, or a live function from `live_functions`. "
                "A pane for an AWS service no handler covers is an AWS request: never say it can't be built.",
                "read_definition shows any example's YAML; check_definition says every problem with its line; "
                "preview_definition runs one of a draft's actions as the user, to see what its reply holds; "
                "describe_aws_operation says what an AWS operation takes and answers (where its lists are, their "
                "fields), with no call.",
                "Two requests in one pane each name their own `output`: without it, both write `rows`.",
                "An action may be code where data runs out: reshaping a reply, joining two calls. The code is a "
                "Python file beside the YAML (`code: {file: health.py}` -- the file written as a file, never Python "
                "in a YAML string) defining run(inputs, ctx). It runs in the runner as whoever uses the pane, "
                "reaching connections only through ctx.http / ctx.aws, and returns the outputs. Prefer a request "
                "when one will do.",
                "A Clear button is a card's `clear: [output keys]` -- the results it empties (never `run`); it "
                "shows by itself while one of them holds something. It isn't an action, and an action with nothing "
                "to run doesn't check.",
                "Rows that open to show more (a row's detail): the table's config.detail names a row action -- an "
                "action with args read from the row -- and config.expand a declared view key; see `rows that "
                "open (example)`. An output's config says only what `output config` lists.",
                "A pane with modes (a choice input) whose button does a different thing per mode: one action per "
                "mode, each `main: {input: <mode>, equals: <value>}` (or one `main: true` for the rest), each "
                "button in the layout shown with `when` for its mode. Actions have no `when`; layout items do.",
                "Keep what already works: change or add what's asked, never replace a working action.",
                "Handlers are only those listed here: the ones of pane types the user's group may use.",
            ],
        }
    usable = [x for x in pane_manifest.manifests().values() if pane_access.allowed(user.group, x.id)]
    examples = [w.id for w in workflows.runnable(db, user)]
    return {
        "kind": "workflow",
        "what": "A workflow, as YAML: label, description, parameters, steps. Templates are CEL in {{ }}.",
        "definition": _fields(workflows.Definition),
        "parameter": _fields(workflows.Param),
        "step": _fields(workflows.Step),
        "template_scope": ["params.<key>", "steps.<id>.outputs", "steps.<id>.status", "item", "index", "run"],
        "panes": [
            {
                "pane": x.id,
                "label": x.label,
                "actions": [
                    {"id": a.id, "runs": "request" if a.request else ("background" if a.poll else "handler"),
                     **({"effects": a.effects} if a.effects else {})}
                    for a in x.actions if (a.served or a.request) and not a.live
                ],
                "inputs": [i.key for i in x.inputs if not i.sensitive],
            }
            for x in usable
        ],
        "examples": examples,
        # Made in the Builder (D122): used as `step: <id>` with `with:` its inputs.
        "step_types": [
            {"id": k, "label": d.label, "inputs": [p.key for p in d.inputs],
             "changes_something": step_types.external(d)}
            for k, d in sorted(step_types.REGISTRY.items())
        ],
        "rules": [
            "A step is a pane's action (pane, action, with: its inputs), a step type (step: its id, with: its "
            "inputs), a note, an artifact or an approval.",
            "A step type that changes something waits for a person when the workflow runs, as an external action "
            "does.",
            "read_definition shows an existing workflow's YAML; check_definition says every problem with its line.",
        ],
    }
