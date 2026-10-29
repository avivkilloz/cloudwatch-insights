"""Published templates (PLATFORM_PLAN.md §23, D76, D99-D102).

A person's saved template (`saved_sessions`) is theirs; Publish makes one
plugin content: kept in its own table and in the store repo, and offered to
every group that may use each of its panes. Published, it has to work in
another deployment and for another team, so it is made **portable** when it
is published, by what each pane's manifest says its inputs are:

- an AWS connection input follows the session's Environment variable, left
  for whoever opens it to choose;
- CloudWatch's log groups, chosen per connection, are kept under a stand-in
  (`$environment`) and given to the environment chosen on opening;
- what names this deployment's own things -- another kind of connection, a
  credential, OpenSearch indices (their domains' endpoints), a workflow's
  connection parameters -- is left out, as is the value of a header whose name
  says it holds a secret: a template goes to a git repo.

Every change is reported to whoever publishes, in words.

Opening one is the server's: the environment is chosen first, the variable
set, each pane's bound inputs copied in (`variables.apply`) and the log groups
re-keyed, then the session is created through `live_store.create` like any
other.
"""

from __future__ import annotations

import copy
import datetime
import re
from typing import Any, Optional

from sqlalchemy.orm import Session

from . import connections, live_store, models, store
from .panes import manifest as pane_manifest
from .panes import variables as pane_variables

ID_RE = re.compile(r"^[a-z][a-z0-9_]{1,63}$")
# A connection id's place in a portable state, filled in on opening.
ENVIRONMENT = "$environment"
ORIGIN = "template"
# Header names whose values aren't to be written to a repo.
SECRETISH = re.compile(r"auth|token|secret|password|passwd|cookie|api[-_]?key|session|signature", re.I)
# What the browser keeps in a saved template that isn't the session's own.
VERSION_KEY = "__savedStateVersion"


class TemplateError(ValueError):
    """A template that can't be published or opened, in a sentence."""


def pane_ids(state: dict) -> list[str]:
    return [p for p in state.get("services") or [] if isinstance(p, str)]


def pane_type(state: dict, pane_id: str) -> str:
    return (state.get("paneTypes") or {}).get(pane_id, pane_id)


def pane_types(state: dict) -> list[str]:
    return sorted({pane_type(state, p) for p in pane_ids(state)})


def _title(state: dict, pane_id: str, manifest: pane_manifest.Manifest) -> str:
    return (state.get("paneTitles") or {}).get(pane_id) or manifest.label


def needs_environment(state: dict) -> bool:
    """Whether a pane of it follows the Environment variable, so opening it
    asks for one."""
    if pane_variables.ENVIRONMENT not in pane_variables.defined(state):
        return False
    for pane_id in pane_ids(state):
        manifest = pane_manifest.get(pane_type(state, pane_id))
        if manifest and pane_variables.ENVIRONMENT in pane_variables.targets(manifest):
            if pane_variables.ENVIRONMENT not in pane_variables.unlinked(state, pane_id):
                return True
    return False


def portable(db: Session, state: dict) -> tuple[dict, list[str]]:
    """The state made to work anywhere, and what was changed, in words."""
    if not isinstance(state, dict) or not pane_ids(state):
        raise TemplateError("That template holds no panes.")
    out = copy.deepcopy(state)
    out.pop(VERSION_KEY, None)
    said: list[str] = []
    follows_environment = False
    for pane_id in pane_ids(out):
        manifest = pane_manifest.get(pane_type(out, pane_id))
        if manifest is None:
            raise TemplateError(f"A pane of it is of a kind this platform doesn't have ({pane_type(out, pane_id)}).")
        title = _title(out, pane_id, manifest)
        bound = pane_variables.targets(manifest).get(pane_variables.ENVIRONMENT, {})
        for spec in manifest.inputs:
            key = f"{pane_id}.in.{spec.key}"
            if key not in out:
                continue
            value = live_store.untag(out[key])
            name = spec.label if isinstance(spec.label, str) and spec.label else spec.key
            if spec.key in bound:
                # Whoever opens it chooses: the pane follows the variable.
                del out[key]
                unlinked = [v for v in pane_variables.unlinked(out, pane_id) if v != pane_variables.ENVIRONMENT]
                if unlinked:
                    out[pane_variables.unlinked_key(pane_id)] = unlinked
                else:
                    out.pop(pane_variables.unlinked_key(pane_id), None)
                follows_environment = True
            elif spec.type in ("connection", "connections", "environment", "environments"):
                if value not in (None, "", []):
                    del out[key]
                    said.append(f"{title}: its {name} is left for whoever opens it to choose.")
            elif spec.type == "credential":
                if value not in (None, ""):
                    del out[key]
                    said.append(f"{title}: its {name} (a credential of this platform's) is left out.")
            elif spec.type == "log_groups":
                if isinstance(value, dict) and value:
                    names: list[str] = []
                    for listed in value.values():
                        names.extend(n for n in (listed or []) if isinstance(n, str) and n not in names)
                    out[key] = {ENVIRONMENT: live_store.tag_set(names)}
                    follows_environment = True
                    if len(value) > 1:
                        said.append(f"{title}: its log groups from {len(value)} environments are one list, "
                                    "for the environment chosen on opening.")
            elif spec.type == "opensearch_indices":
                if value:
                    del out[key]
                    said.append(f"{title}: its indices are left out -- they name this platform's domains.")
            elif spec.type == "headers" and isinstance(value, list):
                hidden = [r.get("key") for r in value
                          if isinstance(r, dict) and r.get("value") and SECRETISH.search(str(r.get("key") or ""))]
                if hidden:
                    out[key] = [{**r, "value": ""} if isinstance(r, dict) and r.get("key") in hidden else r for r in value]
                    said.append(f"{title}: the value{'s' if len(hidden) > 1 else ''} of {', '.join(hidden)} "
                                f"{'are' if len(hidden) > 1 else 'is'} left out.")
            elif spec.type == "workflow_params" and isinstance(value, dict) and value:
                left = _workflow_connection_params(db, out.get(f"{pane_id}.in.{spec.of}"), value)
                if left:
                    out[key] = {k: v for k, v in value.items() if k not in left}
                    said.append(f"{title}: its {', '.join(left)} (connections) are left for whoever opens it.")
    variables = pane_variables.defined(out)
    if follows_environment:
        out[pane_variables.VARIABLES_KEY] = {**variables, pane_variables.ENVIRONMENT: None}
        said.insert(0, "Its AWS panes follow the Environment variable: whoever opens it chooses the environment.")
    elif pane_variables.ENVIRONMENT in variables:
        # Defined but bound to nothing: its value is still this platform's.
        out[pane_variables.VARIABLES_KEY] = {**variables, pane_variables.ENVIRONMENT: None}
    return out, said


def _workflow_connection_params(db: Session, workflow_id: Any, values: dict) -> list[str]:
    workflow = db.get(models.Workflow, str(workflow_id or "")) if workflow_id else None
    if workflow is None:
        return []
    kinds = {p.get("key"): p.get("type") for p in (workflow.definition or {}).get("parameters") or []}
    return [k for k in values if kinds.get(k) in ("connection", "connections")]


# ---------------------------------------------------------------- the catalogue


def usable(user: models.User, row: models.PublishedTemplate) -> bool:
    """Whether every pane of it is one that's here: every pane type is
    everyone's (D160), but a built one may have been deleted since."""
    return set(pane_types(row.state or {})) <= set(pane_manifest.manifests())


def visible(db: Session, user: models.User) -> list[models.PublishedTemplate]:
    rows = db.query(models.PublishedTemplate).order_by(models.PublishedTemplate.label).all()
    return [r for r in rows if usable(user, r)]


# ---------------------------------------------------------------- publish


def publish(
    db: Session,
    user: models.User,
    saved_id: int,
    requested_id: str,
    label: str,
    description: Optional[str],
) -> tuple[models.PublishedTemplate, list[str]]:
    saved = db.get(models.SavedSession, saved_id)
    if saved is None or saved.user_id != user.id:
        raise TemplateError("There is no such template of yours.")
    if saved.page != "aggregator":
        raise TemplateError("Open it and save it again as a template first: it was saved before sessions held panes.")
    state, said = portable(db, saved.state or {})
    live_store._check_size(state)
    try:
        new_id = store.full_id(db, requested_id.strip(), ID_RE)
    except store.StoreError as e:
        raise TemplateError(str(e)) from None
    if db.get(models.PublishedTemplate, new_id) is not None:
        raise TemplateError(f"A published template {new_id} already exists.")
    if not label.strip():
        raise TemplateError("Give it a name.")
    now = datetime.datetime.utcnow()
    row = models.PublishedTemplate(
        id=new_id, label=label.strip(), description=(description or "").strip() or None, state=state,
        saved_session_id=saved.id,
        created_by_id=user.id, created_at=now, updated_by_id=user.id, updated_at=now,
    )
    db.add(row)
    db.flush()
    store.record(db, "template", row.id, "write", user)
    db.commit()
    return row, said


def update(db: Session, user: models.User, row: models.PublishedTemplate, label: Optional[str],
           description: Optional[str]) -> models.PublishedTemplate:
    if label is not None:
        if not label.strip():
            raise TemplateError("Give it a name.")
        row.label = label.strip()
    if description is not None:
        row.description = description.strip() or None
    row.updated_by_id, row.updated_at = user.id, datetime.datetime.utcnow()
    store.record(db, "template", row.id, "write", user)
    db.commit()
    return row


def unpublish(db: Session, user: models.User, row: models.PublishedTemplate) -> None:
    store.record(db, "template", row.id, "delete", user)
    db.delete(row)
    db.commit()


# ---------------------------------------------------------------- open


def instantiate(db: Session, user: models.User, row: models.PublishedTemplate,
                environment: Optional[int]) -> models.LiveSession:
    """A new session of the user's from the template, its Environment
    variable set to the one they chose."""
    if not usable(user, row):
        missing = sorted(set(pane_types(row.state or {})) - set(pane_manifest.manifests()))
        raise TemplateError(f"{row.label} holds panes that aren't here any more ({', '.join(missing)}).")
    state = copy.deepcopy(row.state or {})
    if needs_environment(state):
        reachable = {t["id"] for t in connections.targets(db, user, "aws")}
        if environment is None:
            raise TemplateError(f"Choose the environment {row.label} is for.")
        if int(environment) not in reachable:
            raise TemplateError("That environment isn't one you can reach.")
        state[pane_variables.VARIABLES_KEY] = {**pane_variables.defined(state), pane_variables.ENVIRONMENT: int(environment)}
    chosen = pane_variables.defined(state).get(pane_variables.ENVIRONMENT)
    for pane_id in pane_ids(state):
        manifest = pane_manifest.get(pane_type(state, pane_id))
        if manifest is None:
            continue
        pane_variables.apply(state, pane_id, manifest)
        for spec in manifest.inputs:
            key = f"{pane_id}.in.{spec.key}"
            value = state.get(key)
            if spec.type == "log_groups" and isinstance(value, dict) and ENVIRONMENT in value:
                state[key] = {str(chosen): value[ENVIRONMENT]} if chosen not in (None, "") else {}
    return live_store.create(db, user.id, row.label, state, ORIGIN)


# ---------------------------------------------------------------- the store's kind


def dump(row: models.PublishedTemplate) -> dict:
    out: dict[str, Any] = {"id": row.id, "label": row.label}
    if row.description:
        out["description"] = row.description
    out["state"] = row.state
    return out


def load(db: Session, data: dict, row: Optional[models.PublishedTemplate],
         actor: Optional[models.User]) -> models.PublishedTemplate:
    template_id = str(data.get("id") or "")
    if not store.valid_id(template_id, ID_RE):
        raise store.StoreError(f"'{template_id}' isn't a template id.")
    state = data.get("state")
    if not isinstance(state, dict) or not pane_ids(state):
        raise store.StoreError(f"Template {template_id} holds no panes (state.services).")
    unknown = [t for t in pane_types(state) if pane_manifest.get(t) is None]
    if unknown:
        raise store.StoreError(f"Template {template_id} holds panes this platform doesn't have: {', '.join(unknown)}.")
    if not str(data.get("label") or "").strip():
        raise store.StoreError(f"Template {template_id} has no label.")
    if row is None:
        row = models.PublishedTemplate(id=template_id, created_by_id=actor.id if actor else None)
        db.add(row)
    row.label, row.description, row.state = str(data["label"]).strip(), data.get("description") or None, state
    row.updated_by_id, row.updated_at = (actor.id if actor else None), datetime.datetime.utcnow()
    return row
