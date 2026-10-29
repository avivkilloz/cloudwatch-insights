"""The doors between workflows and sessions (PLATFORM_PLAN.md §22.10, D95-D98):
a run investigated in a session, a session made repeatable, the workflow pane
that runs one from inside a session, and a run's own chat.

Each goes through the one write path of what it touches -- `live_store` for a
session, `pane_outputs` for a pane's results, `workflows.start` for a run --
and acts as whoever asked, never as the run's starter."""

from __future__ import annotations

import datetime
import json
import re
from typing import Any, Optional

import yaml
from fastapi import HTTPException
from sqlalchemy.orm import Session

from . import connections, live_store, models, pane_outputs, workflows
from .panes import manifest as pane_manifest
from .workflows import WorkflowError

ORIGIN = "workflow"
# A for_each stage opens a pane per item; past this many, a session reads as a wall.
INVESTIGATE_ITEMS = 10
CHAT_KEPT = 40


# ------------------------------------------------------------------- investigate (D95)


def _new_pane(state: dict, pane_type: str, title: str) -> str:
    """A pane id as AggregatorPage.addPane makes one: the type, then `type~2`."""
    ids = list(state.get("services") or [])
    pane_id, n = pane_type, 2
    while pane_id in ids:
        pane_id, n = f"{pane_type}~{n}", n + 1
    state["services"] = ids + [pane_id]
    state.setdefault("paneTypes", {})[pane_id] = pane_type
    state.setdefault("paneTitles", {})[pane_id] = title[:120]
    return pane_id


def investigate(db: Session, user: models.User, run: models.WorkflowRun) -> models.LiveSession:
    """A new session of the asker's holding what the run found: a pane per
    stage that ran a pane action, its inputs as the step ran them and its
    outputs as the pane's own, so the pane renderers draw them. Nothing runs
    again."""
    if not workflows.can_read(user, run):
        raise WorkflowError(f"Run #{run.number}'s stages aren't yours to see, so there is nothing to investigate.")
    workflow = db.get(models.Workflow, run.workflow_id)
    label = workflow.label if workflow else run.workflow_id
    definition = workflows.Definition.model_validate(run.definition)
    records = {r.position: r for r in workflows.run_steps(db, run)}
    state: dict[str, Any] = {"services": [], "paneTypes": {}, "paneTitles": {}, "layout": "stacked"}
    fills: list[tuple[str, dict]] = []
    said: list[str] = []
    from .platform_tools import panes as agent_panes  # it reaches the routers, which import this module

    rc = agent_panes.RunContext(db=db, user=user, timezone=run.timezone)
    for position, step in enumerate(definition.steps):
        record = records.get(position)
        if record is None or record.status not in workflows.STEP_DONE:
            continue
        name = step.label or step.id
        outputs = workflows._whole_outputs(db, record) or {}
        if step.note is not None:
            said.append(f"{name}: {outputs.get('text', '')}")
            continue
        if step.artifact is not None:
            files = [outputs.get("artifact")] if outputs.get("artifact") else [o.get("artifact") for o in outputs.get("items") or [] if isinstance(o, dict)]
            said.extend(f"{name}: file {f['name']}" for f in files if f)
            continue
        if not (step.pane and step.action):
            if record.status == "succeeded" and outputs.get("approved_by"):
                said.append(f"{name}: approved by {outputs['approved_by']}")
            continue
        manifest = pane_manifest.get(step.pane)
        if manifest is None:
            said.append(f"{name}: a {step.pane} pane, which isn't here any more")
            continue
        if step.for_each is not None:
            given = (record.inputs or {}).get("items") or []
            got = outputs.get("items") or []
            pairs = [(given[i] if i < len(given) else None, got[i]) for i in range(min(len(got), INVESTIGATE_ITEMS))]
            titles = [f"{name} · {i + 1}" for i in range(len(pairs))]
            if len(got) > INVESTIGATE_ITEMS:
                said.append(f"{name}: the first {INVESTIGATE_ITEMS} of {len(got)} items")
        else:
            pairs, titles = [(record.inputs, outputs)], [name]
        known = {i.key: i for i in manifest.inputs if not i.sensitive}
        kind = agent_panes.KINDS.get(manifest.id)
        for (inputs, result), title in zip(pairs, titles):
            if not isinstance(result, dict) or set(result) <= {"error"}:
                continue
            pane_id = _new_pane(state, manifest.id, title)
            given = {k: v for k, v in (inputs or {}).items() if k in known and v is not None and v != known[k].default}
            # What picking them by hand would have ticked too (log groups tick
            # their environments): a step sets only the groups, and the pane
            # showed "0 environment(s) selected" over its results.
            if kind is not None:
                given = {**kind.implies(given), **given}
            for key, value in given.items():
                # In the shape the browser stores (a tagged Set where it keeps
                # one), the agent's own conversion -- a plain list where a Set
                # belongs takes the pane down on its first `.has()`.
                spec = kind.input(key) if kind is not None else None
                try:
                    state[f"{pane_id}.in.{key}"] = agent_panes.convert(spec, value, rc) if spec else value
                except agent_panes.InputError as e:
                    said.append(f"{title}: its {key} wasn't kept ({e})")
            fills.append((pane_id, result))
    if not fills:
        raise WorkflowError(f"Run #{run.number} has no stage with a pane's results to look into.")
    state["activePane"] = fills[0][0]
    started = run.started_at.strftime("%Y-%m-%d %H:%M UTC") if run.started_at else ""
    lines = [f"From {label} #{run.number}, started by {run.started_by_name} {started} ({run.status})."] + said
    state["description"] = "\n".join(lines)[:4000]
    row = live_store.create(db, user.id, f"{label} #{run.number}", state, ORIGIN)
    for pane_id, result in fills:

        def store(values: dict, result=result) -> bool:
            values.clear()
            values.update({k: v for k, v in result.items() if not k.startswith("__") and k != "run"})
            values["ranAt"] = live_store.now_ms()
            values["resultsVersion"] = 1
            return pane_outputs.fit(values)

        pane_outputs.write(db, row, pane_id, store, ORIGIN)
    db.refresh(row)
    return row


# ------------------------------------------------------------------- make repeatable (D96)


def _slug(text: str, taken: set[str], fallback: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "_", (text or "").lower()).strip("_")
    base = base if base and base[0].isalpha() else f"{fallback}_{base}".strip("_")
    base = base[:40] or fallback
    out, n = base, 2
    while out in taken:
        out, n = f"{base}_{n}", n + 1
    taken.add(out)
    return out


def _server_action(manifest: pane_manifest.Manifest, inputs: Optional[dict[str, Any]] = None
                   ) -> Optional[pane_manifest.ManifestAction]:
    """What a step would run for this pane: its main action for its inputs if
    the server runs it, else its request (the API table's Fetch)."""
    main = manifest.main_action(inputs)
    if main is not None and (main.served or main.request is not None):
        return main
    return next((a for a in manifest.actions if a.request is not None), None)


class _Dumper(yaml.SafeDumper):
    """A text of several lines (a description, a query) as a `|` block, the
    way a person writes it -- quoted, every line break became a blank line."""


def _text(dumper: yaml.SafeDumper, value: str) -> yaml.ScalarNode:
    if "\n" in value:
        return dumper.represent_scalar("tag:yaml.org,2002:str", value.rstrip() + "\n", style="|")
    return dumper.represent_scalar("tag:yaml.org,2002:str", value)


_Dumper.add_representer(str, _text)


def draft_from_session(db: Session, user: models.User, client_id: str) -> dict[str, Any]:
    """A workflow drafted from a session, as YAML for the editor: a step per
    pane its kind can run on the server, `with` the inputs set away from their
    defaults, every connection a parameter. Checked, but never saved."""
    row, _ = live_store.reachable(db, user.id, client_id)
    if row is None:
        raise WorkflowError("There is no such session for you.")
    state = row.state or {}
    from .platform_tools import panes as agent_panes

    params: list[dict[str, Any]] = []
    by_connection: dict[tuple[str, str], str] = {}
    param_keys: set[str] = set()
    labels: dict[str, dict[int, str]] = {}

    def label_of(kind: str, cid: int) -> str:
        if kind not in labels:
            labels[kind] = {t["id"]: t["label"] for t in connections.targets(db, user, kind)}
        return labels[kind].get(cid, str(cid))

    def param_for(kind: str, ptype: str, value: Any) -> str:
        ident = (ptype, json.dumps(value, sort_keys=True))
        if ident in by_connection:
            return by_connection[ident]
        ids = value if isinstance(value, list) else [value]
        names = ", ".join(label_of(kind, int(i)) for i in ids if str(i).isdigit())
        key = _slug(names or ptype, param_keys, "env")
        params.append({"key": key, "type": ptype, "connection_type": kind, "label": names or key,
                       "default": value, "required": True})
        by_connection[ident] = key
        return key

    steps: list[dict[str, Any]] = []
    step_ids: set[str] = set()
    for pane_id in state.get("services") or []:
        pane_type = (state.get("paneTypes") or {}).get(pane_id, pane_id)
        manifest = pane_manifest.get(pane_type)
        inputs = {i.key: state.get(f"{pane_id}.in.{i.key}") for i in manifest.inputs} if manifest else {}
        action = _server_action(manifest, inputs) if manifest else None
        if manifest is None or action is None:
            continue
        title = (state.get("paneTitles") or {}).get(pane_id) or manifest.label
        # As plain lists: the browser keeps some inputs as tagged Sets.
        values = {
            spec.key: live_store.untag(state.get(f"{pane_id}.in.{spec.key}", state.get(f"{pane_id}.{spec.key}")))
            for spec in manifest.inputs
            if not spec.sensitive
        }
        # An input the others imply (the environments ticked by picking their
        # log groups) is left for the step to work out: given both, a draft
        # had two parameters for one environment.
        kind = agent_panes.KINDS.get(manifest.id)
        implied = set(kind.implies(values)) if kind is not None else set()
        given: dict[str, Any] = {}
        for spec in manifest.inputs:
            value = values.get(spec.key)
            if spec.sensitive or spec.key in implied:
                continue
            if value in (None, "", [], {}) or value == spec.default:
                continue
            kind = spec.connection_type or "aws"
            if spec.type in ("connection", "environment") and str(value).isdigit():
                given[spec.key] = "{{ params.%s }}" % param_for(kind, "connection", int(value))
            elif spec.type in ("connections", "environments") and isinstance(value, list) and value:
                given[spec.key] = "{{ params.%s }}" % param_for(kind, "connections", [int(v) for v in value])
            elif spec.type in ("log_groups", "opensearch_indices") and isinstance(value, dict) and len(value) == 1:
                cid, chosen = next(iter(value.items()))
                key = param_for("aws", "connection", int(cid)) if str(cid).isdigit() else None
                given[spec.key] = ("{{ {string(params.%s): %s} }}" % (key, json.dumps(chosen))) if key else value
            else:
                given[spec.key] = value
        step: dict[str, Any] = {"id": _slug(title, step_ids, "step"), "label": title, "pane": manifest.id,
                                "action": action.id}
        if given:
            step["with"] = given
        steps.append(step)
    if not steps:
        raise WorkflowError(f"{row.title} has no pane with a server action to repeat: its tools run in the browser.")
    definition: dict[str, Any] = {"label": row.title, "description": state.get("description")
                                  or f"Made from the session {row.title}."}
    if params:
        definition["parameters"] = params
    definition["steps"] = steps
    source = (
        f"# Drafted from the session \"{row.title}\":\n"
        "# each pane a step, its environments parameters. Check it, give it an id and Create.\n"
        + yaml.dump(definition, Dumper=_Dumper, sort_keys=False, allow_unicode=True, width=110)
    )
    try:
        workflows.parse(source)
        errors: list[dict] = []
    except WorkflowError as e:
        errors = e.errors
    return {"source": source, "errors": errors, "suggested_id": _slug(row.title, set(), "workflow")}


# ------------------------------------------------------------------- the workflow pane (D97)


def pane_list(db: Session, user: models.User, _inputs: dict[str, Any]) -> dict[str, Any]:
    return {"options": [{"value": w.id, "label": w.label} for w in workflows.listed(db)]}


def _rows_to_params(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return {str(k): v for k, v in value.items() if str(k).strip()}
    if isinstance(value, list):
        return {str(r.get("key")).strip(): r.get("value", "") for r in value if isinstance(r, dict) and str(r.get("key") or "").strip()}
    return {}


def pane_start(db: Session, user: models.User, inputs: dict[str, Any]) -> dict[str, Any]:
    workflow = db.get(models.Workflow, str(inputs.get("workflow") or ""))
    if workflow is None:
        raise HTTPException(status_code=404, detail="There is no such workflow you may run.")
    try:
        run = workflows.start(db, user, workflow, _rows_to_params(inputs.get("params")), trigger="pane",
                              timezone=inputs.get("_tz"))
    except WorkflowError as e:
        raise HTTPException(status_code=400, detail=str(e)) from None
    return {"handles": [{"run_id": run.id}], **_pane_view(db, user, run)}


def _took(run: models.WorkflowRun) -> str:
    if not run.started_at:
        return ""
    end = run.finished_at or datetime.datetime.utcnow()
    return workflows._seconds((end - run.started_at).total_seconds())


def _pane_view(db: Session, user: models.User, run: models.WorkflowRun) -> dict[str, Any]:
    workflow = db.get(models.Workflow, run.workflow_id)
    label = workflow.label if workflow else run.workflow_id
    text = f"{label} #{run.number}: {run.status}"
    if run.started_at:
        text += f" ({'took' if run.status in workflows.FINISHED else 'running for'} {_took(run)})"
    if run.status == "waiting":
        text += ". A step waits for approval on the run's page in Workflows"
    if run.error:
        text += f". {run.error}"
    stages = [
        {"stage": s.label or s.step_id, "status": s.status, "took": _step_took(s), "error": s.error or ""}
        for s in workflows.run_steps(db, run)
    ]
    # The whole run -- each stage's inputs and outputs, its files, Rerun --
    # is the run page's; the pane says where, as a link that opens it in place.
    link = {"label": f"Open {label} #{run.number} on the Workflows page", "href": f"?run={run.id}"}
    return {"summary": text, "stages": stages, "runLink": link}


def _step_took(step: models.WorkflowRunStep) -> str:
    if not step.started_at or not step.finished_at:
        return ""
    return workflows._seconds((step.finished_at - step.started_at).total_seconds())


def pane_poll(db: Session, user: models.User, inputs: dict[str, Any]) -> dict[str, Any]:
    handles = [h for h in inputs.get("handles") or [] if isinstance(h, dict) and h.get("run_id")]
    run = db.get(models.WorkflowRun, int(handles[0]["run_id"])) if handles else None
    if run is None:
        return {"done": True, "summary": "The run isn't there any more (its workflow was deleted)."}
    return {**_pane_view(db, user, run), "done": run.status in workflows.FINISHED}


def pane_cancel(db: Session, user: models.User, inputs: dict[str, Any]) -> dict[str, Any]:
    for h in inputs.get("handles") or []:
        run = db.get(models.WorkflowRun, int(h.get("run_id") or 0)) if isinstance(h, dict) else None
        if run is not None and run.status not in workflows.FINISHED and workflows.can_read(user, run):
            workflows.cancel(db, run)
    return {}


# ------------------------------------------------------------------- this run's chat (D98)


def chat(run: models.WorkflowRun) -> list[dict]:
    return list(run.chat or [])


def add_chat(db: Session, run: models.WorkflowRun, turns: list[dict]) -> list[dict]:
    """Merges turns into the run's chat by id -- a turn sent again (its answer
    arrived) replaces its earlier copy, an answered copy wins over a running
    one -- so two people writing at once both keep their messages."""
    locked = db.query(models.WorkflowRun).filter_by(id=run.id).with_for_update().one()
    kept = {t.get("id"): t for t in locked.chat or [] if isinstance(t, dict) and t.get("id")}
    order = [t.get("id") for t in locked.chat or [] if isinstance(t, dict) and t.get("id")]
    for turn in turns:
        tid = turn.get("id") if isinstance(turn, dict) else None
        if not tid:
            continue
        old = kept.get(tid)
        if old is not None and old.get("status") not in (None, "running") and turn.get("status") == "running":
            continue
        if tid not in kept:
            order.append(tid)
        kept[tid] = turn
    merged = [kept[t] for t in order][-CHAT_KEPT:]
    locked.chat = merged
    db.commit()
    return merged
