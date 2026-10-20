"""The Builder over HTTP (PLATFORM_PLAN.md §24, D103-D106): pane types made in
the platform, for a group with the Builder (or an admin). Check reports every
problem with its line; Create grants the new type to its builder's group."""

from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import auth, builder, models
from ..db import get_db

router = APIRouter(prefix="/api/builder", tags=["builder"])


class SourceIn(BaseModel):
    source: str
    id: Optional[str] = None
    # Check only: the Id typed for a new one, held to the YAML's own id as
    # Create will save it (in the store's namespace, D78).
    new_id: Optional[str] = None


class PaneTypeOut(BaseModel):
    id: str
    label: str
    source: str
    updated_at: Optional[datetime] = None
    updated_by: Optional[str] = None
    store_state: Optional[str] = None
    # Whether it loads now (a handler it names may have gone since).
    loads: bool = True


class CheckOut(BaseModel):
    ok: bool
    errors: list[dict[str, Any]]


def _builder(user: models.User = Depends(auth.get_current_user)) -> models.User:
    if not builder.can_build(user):
        raise HTTPException(status_code=403, detail="Building pane types isn't turned on for your group.")
    return user


def _out(db: Session, row: models.BuiltPaneType) -> dict[str, Any]:
    from ..panes import manifest as pane_manifest

    loaded = pane_manifest.get(row.id)
    by = db.get(models.User, row.updated_by_id) if row.updated_by_id else None
    return {
        "id": row.id,
        "label": loaded.label if loaded else row.id,
        "source": row.source,
        "updated_at": row.updated_at,
        "updated_by": by.username if by else None,
        "store_state": next(iter(db.query(models.StoreItem.state).filter_by(kind="pane", item_id=row.id)), (None,))[0],
        "loads": loaded is not None,
    }


def _found(db: Session, type_id: str) -> models.BuiltPaneType:
    row = db.get(models.BuiltPaneType, type_id)
    if row is None:
        raise HTTPException(status_code=404, detail="There is no such pane type made here.")
    return row


def _guard(fn):
    try:
        return fn()
    except builder.BuilderError as e:
        raise HTTPException(status_code=400, detail={"message": str(e), "errors": e.errors}) from None


@router.get("/schema")
def schema(db: Session = Depends(get_db), user: models.User = Depends(_builder)) -> dict[str, Any]:
    # The store's namespace, so the editor can say what a new id is saved as
    # (`lambda` -> `default:lambda`, D78) before Create says it in an error.
    from .. import store

    return {**builder.schema(user), "namespace": store.namespace(db)}


@router.get("/examples/{type_id}")
def example(type_id: str, _user: models.User = Depends(_builder)) -> dict[str, str]:
    """A bundled pane type's manifest as a start for a built one (D72),
    comments and all, without what a built pane may not say."""
    from ..panes import manifest as pane_manifest

    if type_id not in pane_manifest.bundled():
        raise HTTPException(status_code=404, detail="There is no such pane type of the platform's.")
    return {"id": type_id, "source": builder.example_source(type_id)}


@router.get("/panes", response_model=list[PaneTypeOut])
def list_panes(db: Session = Depends(get_db), _user: models.User = Depends(_builder)):
    return [_out(db, r) for r in db.query(models.BuiltPaneType).order_by(models.BuiltPaneType.id).all()]


@router.get("/panes/{type_id}", response_model=PaneTypeOut)
def get_pane(type_id: str, db: Session = Depends(get_db), _user: models.User = Depends(_builder)):
    return _out(db, _found(db, type_id))


@router.post("/check", response_model=CheckOut)
def check(payload: SourceIn, db: Session = Depends(get_db), user: models.User = Depends(_builder)):
    from .. import store

    type_id = payload.id
    if type_id is None and payload.new_id:
        try:
            type_id = store.full_id(db, payload.new_id, builder.ID_RE)
        except store.StoreError as e:
            return {"ok": False, "errors": [{"line": None, "message": str(e)}]}
    try:
        builder.preview(payload.source, type_id, user)
    except builder.BuilderError as e:
        return {"ok": False, "errors": e.errors}
    return {"ok": True, "errors": []}


class PreviewOut(BaseModel):
    ok: bool
    errors: list[dict] = []
    # The draft as /api/pane-types serves a pane type, for the renderer to draw.
    manifest: Optional[dict[str, Any]] = None


@router.post("/preview", response_model=PreviewOut)
def preview(payload: SourceIn, db: Session = Depends(get_db), user: models.User = Depends(_builder)):
    """The draft, checked, as a pane type the editor's preview draws (D112)."""
    from .. import store

    type_id = payload.id
    if type_id is None and payload.new_id:
        try:
            type_id = store.full_id(db, payload.new_id, builder.ID_RE)
        except store.StoreError as e:
            return {"ok": False, "errors": [{"line": None, "message": str(e)}]}
    try:
        manifest = builder.preview(payload.source, type_id, user)
    except builder.BuilderError as e:
        return {"ok": False, "errors": e.errors}
    return {"ok": True, "manifest": manifest.model_dump(by_alias=True, exclude_none=True)}


class PreviewRun(BaseModel):
    source: str
    id: Optional[str] = None
    inputs: dict[str, Any] = {}
    cursor: Any = None
    timezone: Optional[str] = None


@router.post("/preview/actions/{action_id}")
def preview_action(action_id: str, payload: PreviewRun, db: Session = Depends(get_db),
                   user: models.User = Depends(_builder)) -> dict[str, Any]:
    """One of the draft's actions, run as its builder; nothing stored (D112)."""
    inputs = {**payload.inputs, **({"_tz": payload.timezone} if payload.timezone else {})}
    return builder.run_preview(db, user, payload.source, payload.id, action_id, inputs, payload.cursor)


@router.post("/panes", response_model=PaneTypeOut, status_code=201)
def create_pane(payload: SourceIn, db: Session = Depends(get_db), user: models.User = Depends(_builder)):
    row = _guard(lambda: builder.save(db, user, payload.id, payload.source))
    return _out(db, row)


@router.put("/panes/{type_id}", response_model=PaneTypeOut)
def update_pane(type_id: str, payload: SourceIn, db: Session = Depends(get_db), user: models.User = Depends(_builder)):
    row = _found(db, type_id)
    _guard(lambda: builder.save(db, user, None, payload.source, row))
    return _out(db, row)


@router.delete("/panes/{type_id}", status_code=204)
def delete_pane(type_id: str, db: Session = Depends(get_db), user: models.User = Depends(_builder)):
    _guard(lambda: builder.delete(db, user, _found(db, type_id)))


# ---------------------------------------------------------------- step types (D122)


class StepTypeOut(BaseModel):
    id: str
    label: str
    description: Optional[str] = None
    # "request", "steps" or "code"; None when it doesn't load now.
    kind: Optional[str] = None
    # Whether a workflow's step using it waits for a person (it changes something).
    external: bool = False
    inputs: list[dict[str, Any]] = []
    source: str
    loads: bool = True
    can_edit: bool = False
    updated_at: Optional[datetime] = None
    updated_by: Optional[str] = None
    store_state: Optional[str] = None


class StepTryIn(BaseModel):
    source: str
    id: Optional[str] = None
    inputs: dict[str, Any] = {}


class StepSchemaOut(BaseModel):
    starter: str
    chain_example: str
    code_example: str
    # Whether code can run here (RUNNER_URL, D135).
    runner: bool = False
    namespace: Optional[str] = None
    reference: dict[str, Any]


def _step_out(db: Session, user: models.User, row: models.BuiltStepType) -> dict[str, Any]:
    from .. import step_types

    by = db.get(models.User, row.updated_by_id) if row.updated_by_id else None
    return {
        **step_types.describe(row),
        "updated_at": row.updated_at,
        "updated_by": by.username if by else None,
        "can_edit": step_types.can_edit(user, row),
        "store_state": next(iter(db.query(models.StoreItem.state).filter_by(kind="step", item_id=row.id)), (None,))[0],
    }


def _found_step(db: Session, type_id: str) -> models.BuiltStepType:
    row = db.get(models.BuiltStepType, type_id)
    if row is None:
        raise HTTPException(status_code=404, detail="There is no such step type.")
    return row


def _step_guard(fn):
    from .. import step_types

    try:
        return fn()
    except step_types.StepTypeError as e:
        raise HTTPException(status_code=400, detail={"message": str(e), "errors": e.errors}) from None


@router.get("/step-schema", response_model=StepSchemaOut)
def step_schema(db: Session = Depends(get_db), user: models.User = Depends(_builder)):
    from .. import step_types, store

    from .. import runner_client

    return {"starter": step_types.STARTER, "chain_example": step_types.CHAIN_EXAMPLE,
            "code_example": step_types.CODE_EXAMPLE, "runner": runner_client.configured(),
            "namespace": store.namespace(db), "reference": step_types.reference(db, user)}


@router.get("/steps", response_model=list[StepTypeOut])
def list_steps(db: Session = Depends(get_db), user: models.User = Depends(_builder)):
    return [_step_out(db, user, r) for r in db.query(models.BuiltStepType).order_by(models.BuiltStepType.id).all()]


@router.get("/steps/{type_id}", response_model=StepTypeOut)
def get_step(type_id: str, db: Session = Depends(get_db), user: models.User = Depends(_builder)):
    return _step_out(db, user, _found_step(db, type_id))


@router.post("/steps/check", response_model=CheckOut)
def check_step(payload: SourceIn, db: Session = Depends(get_db), user: models.User = Depends(_builder)):
    from .. import step_types, store

    type_id = payload.id
    if type_id is None and payload.new_id:
        try:
            type_id = store.full_id(db, payload.new_id, step_types.ID_RE)
        except store.StoreError as e:
            return {"ok": False, "errors": [{"line": None, "message": str(e)}]}
    try:
        definition = step_types.parse(payload.source, type_id)
    except step_types.StepTypeError as e:
        return {"ok": False, "errors": e.errors}
    errors = step_types.access_errors(db, definition, user, payload.source)
    return {"ok": not errors, "errors": errors}


@router.post("/steps/try")
def try_step(payload: StepTryIn, db: Session = Depends(get_db), user: models.User = Depends(_builder)):
    """A draft request step sent once, as the builder -- for real: one that
    changes something does (the editor asks first). A chain is tried in a
    workflow, where its steps run as they will."""
    from .. import step_types

    definition = _step_guard(lambda: step_types.parse(payload.source, payload.id))
    if definition.steps is not None:
        raise HTTPException(status_code=400, detail="A chain of steps is tried in a workflow: save it, then use it in one.")
    try:
        inputs = step_types.inputs_for(definition, payload.inputs)
    except Exception as e:  # noqa: BLE001 -- workflows.StepError: a required input missing
        raise HTTPException(status_code=400, detail=str(e)) from None
    if definition.code is not None:
        # Code that changes something does, here too: the editor asked first.
        outputs = step_types.run_code(db, user, definition, inputs, f"try:{payload.id or 'draft'}",
                                      may_change=definition.changes)
        logs = outputs.pop("__logs", "")
        return {"status": 200, "response": outputs, "logs": logs}
    out = step_types.send(db, user, definition, inputs)
    db.commit()  # a credential's use is audited
    return out


@router.post("/steps", response_model=StepTypeOut, status_code=201)
def create_step(payload: SourceIn, db: Session = Depends(get_db), user: models.User = Depends(_builder)):
    from .. import step_types

    row = _step_guard(lambda: step_types.save(db, user, payload.id, payload.source))
    return _step_out(db, user, row)


@router.put("/steps/{type_id}", response_model=StepTypeOut)
def update_step(type_id: str, payload: SourceIn, db: Session = Depends(get_db), user: models.User = Depends(_builder)):
    from .. import step_types

    row = _found_step(db, type_id)
    _step_guard(lambda: step_types.save(db, user, None, payload.source, row))
    return _step_out(db, user, row)


@router.delete("/steps/{type_id}", status_code=204)
def delete_step(type_id: str, db: Session = Depends(get_db), user: models.User = Depends(_builder)):
    from .. import step_types

    _step_guard(lambda: step_types.delete(db, user, _found_step(db, type_id)))
    return None
