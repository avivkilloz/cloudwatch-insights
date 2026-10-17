"""Workflows over HTTP (PLATFORM_PLAN.md §22): definitions (an admin's until
the Builder grant, D84), who may run them, runs and their steps.

A run's inputs and outputs go only to whoever may read it -- its starter,
their group, admins (`workflows.can_read`); anyone else who may run the
workflow sees that a run happened, not what it found."""

from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import auth, models, workflows
from ..db import get_db

router = APIRouter(prefix="/api/workflows", tags=["workflows"])
runs_router = APIRouter(prefix="/api/workflow-runs", tags=["workflows"])


class WorkflowIn(BaseModel):
    id: Optional[str] = None
    source: str


class SourceIn(BaseModel):
    source: str


class GrantsIn(BaseModel):
    group_ids: list[int]


class RunIn(BaseModel):
    params: dict[str, Any] = {}
    timezone: Optional[str] = None


def _guard(fn):
    try:
        return fn()
    except workflows.WorkflowError as e:
        raise HTTPException(status_code=400, detail=str(e)) from None


def _workflow(db: Session, user: models.User, workflow_id: str) -> models.Workflow:
    row = db.get(models.Workflow, workflow_id)
    if row is None or not (workflows.can_edit(user) or workflows.can_run(db, user, row)):
        raise HTTPException(status_code=404, detail="There is no such workflow for you.")
    return row


def _run(db: Session, user: models.User, run_id: int) -> models.WorkflowRun:
    run = db.get(models.WorkflowRun, run_id)
    workflow = db.get(models.Workflow, run.workflow_id) if run else None
    if run is None or workflow is None or not (workflows.can_edit(user) or workflows.can_run(db, user, workflow)):
        raise HTTPException(status_code=404, detail="There is no such run for you.")
    return run


def _out(db: Session, user: models.User, row: models.Workflow, detail: bool = False) -> dict[str, Any]:
    last = (
        db.query(models.WorkflowRun)
        .filter_by(workflow_id=row.id)
        .order_by(models.WorkflowRun.number.desc())
        .first()
    )
    out: dict[str, Any] = {
        "id": row.id,
        "label": row.label,
        "description": row.description,
        "parameters": row.definition.get("parameters") or [],
        "steps": len(row.definition.get("steps") or []),
        "can_edit": workflows.can_edit(user),
        "can_run": workflows.can_run(db, user, row),
        "last_run": workflows.summary(db, last, user) if last else None,
        "store_state": next(iter(db.query(models.StoreItem.state).filter_by(kind="workflow", item_id=row.id)), (None,))[0],
    }
    if detail:
        out["source"] = row.source
        out["definition"] = row.definition
        if workflows.can_edit(user):
            out["group_ids"] = [g.group_id for g in db.query(models.WorkflowGrant).filter_by(workflow_id=row.id)]
    return out


@router.get("")
def list_workflows(db: Session = Depends(get_db), user: models.User = Depends(auth.get_current_user)):
    rows = db.query(models.Workflow).order_by(models.Workflow.label).all() if workflows.can_edit(user) else workflows.runnable(db, user)
    return [_out(db, user, w) for w in rows]


@router.post("/validate")
def validate(payload: SourceIn, _admin: models.User = Depends(auth.require_admin)):
    """What saving would say, without saving: every problem, with its line."""
    try:
        definition = workflows.parse(payload.source)
    except workflows.WorkflowError as e:
        return {"ok": False, "errors": e.errors}
    return {"ok": True, "errors": [], "definition": definition.model_dump(by_alias=True, exclude_none=True)}


@router.post("", status_code=201)
def create(payload: WorkflowIn, db: Session = Depends(get_db), admin: models.User = Depends(auth.require_admin)):
    row = _guard(lambda: workflows.save(db, None, payload.id, payload.source, admin))
    return _out(db, admin, row, detail=True)


@router.get("/{workflow_id}")
def get_workflow(workflow_id: str, db: Session = Depends(get_db), user: models.User = Depends(auth.get_current_user)):
    return _out(db, user, _workflow(db, user, workflow_id), detail=True)


@router.put("/{workflow_id}")
def update(workflow_id: str, payload: SourceIn, db: Session = Depends(get_db), admin: models.User = Depends(auth.require_admin)):
    row = _guard(lambda: workflows.save(db, workflow_id, None, payload.source, admin))
    return _out(db, admin, row, detail=True)


@router.delete("/{workflow_id}", status_code=204)
def delete(workflow_id: str, db: Session = Depends(get_db), admin: models.User = Depends(auth.require_admin)):
    workflows.delete(db, workflow_id, admin)
    return None


@router.put("/{workflow_id}/grants")
def put_grants(workflow_id: str, payload: GrantsIn, db: Session = Depends(get_db), admin: models.User = Depends(auth.require_admin)):
    row = _workflow(db, admin, workflow_id)
    _guard(lambda: workflows.set_grants(db, row, payload.group_ids))
    return _out(db, admin, row, detail=True)


@router.post("/{workflow_id}/runs", status_code=201)
def start_run(workflow_id: str, payload: RunIn, db: Session = Depends(get_db), user: models.User = Depends(auth.get_current_user)):
    row = _workflow(db, user, workflow_id)
    run = _guard(lambda: workflows.start(db, user, row, payload.params, timezone=payload.timezone))
    return workflows.summary(db, run, user)


@router.get("/{workflow_id}/runs")
def list_runs(workflow_id: str, limit: int = 50, db: Session = Depends(get_db), user: models.User = Depends(auth.get_current_user)):
    row = _workflow(db, user, workflow_id)
    runs = (
        db.query(models.WorkflowRun)
        .filter_by(workflow_id=row.id)
        .order_by(models.WorkflowRun.number.desc())
        .limit(max(1, min(limit, 200)))
        .all()
    )
    return [workflows.summary(db, r, user) for r in runs]


@runs_router.get("")
def recent_runs(
    mine: bool = False,
    status: Optional[str] = None,
    limit: int = 50,
    db: Session = Depends(get_db),
    user: models.User = Depends(auth.get_current_user),
):
    """Recent runs across the workflows the caller may run."""
    visible = {w.id for w in (db.query(models.Workflow).all() if workflows.can_edit(user) else workflows.runnable(db, user))}
    q = db.query(models.WorkflowRun).filter(models.WorkflowRun.workflow_id.in_(visible or {""}))
    if mine:
        q = q.filter(models.WorkflowRun.started_by_id == user.id)
    if status == "running":
        q = q.filter(models.WorkflowRun.status.in_(("queued", "running")))
    elif status:
        q = q.filter(models.WorkflowRun.status == status)
    runs = q.order_by(models.WorkflowRun.id.desc()).limit(max(1, min(limit, 200))).all()
    return [workflows.summary(db, r, user) for r in runs]


@runs_router.get("/{run_id}")
def get_run(run_id: int, db: Session = Depends(get_db), user: models.User = Depends(auth.get_current_user)):
    run = _run(db, user, run_id)
    return workflows.summary(db, run, user, detail=True)


@runs_router.post("/{run_id}/cancel")
def cancel_run(run_id: int, db: Session = Depends(get_db), user: models.User = Depends(auth.get_current_user)):
    run = _run(db, user, run_id)
    if not workflows.can_read(user, run):
        raise HTTPException(status_code=403, detail="Only whoever started it, their group or an admin can cancel it.")
    _guard(lambda: workflows.cancel(db, run))
    return workflows.summary(db, run, user, detail=True)


@runs_router.post("/{run_id}/rerun", status_code=201)
def rerun(run_id: int, payload: Optional[RunIn] = None, db: Session = Depends(get_db),
          user: models.User = Depends(auth.get_current_user)):
    """Runs the same workflow again, with the same parameters or changed ones
    -- as the person asking, whoever ran it first."""
    old = _run(db, user, run_id)
    workflow = _workflow(db, user, old.workflow_id)
    if payload is not None and payload.params:
        params = payload.params
    elif workflows.can_read(user, old):
        params = old.params
    else:
        raise HTTPException(status_code=403, detail="Give the parameters: this run's aren't yours to see.")
    run = _guard(lambda: workflows.start(db, user, workflow, params, trigger="rerun", rerun_of=old.id,
                                         timezone=payload.timezone if payload else None))
    return workflows.summary(db, run, user)
