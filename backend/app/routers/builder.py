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
def schema(db: Session = Depends(get_db), _user: models.User = Depends(_builder)) -> dict[str, Any]:
    # The store's namespace, so the editor can say what a new id is saved as
    # (`lambda` -> `default:lambda`, D78) before Create says it in an error.
    from .. import store

    return {**builder.schema(), "namespace": store.namespace(db)}


@router.get("/examples/{type_id}")
def example(type_id: str, _user: models.User = Depends(_builder)) -> dict[str, str]:
    """A bundled pane type's manifest as its file says it -- the examples to
    build from (D72), comments and all."""
    from ..panes import manifest as pane_manifest

    if type_id not in pane_manifest.bundled():
        raise HTTPException(status_code=404, detail="There is no such pane type of the platform's.")
    return {"id": type_id, "source": (pane_manifest.MANIFEST_DIR / f"{type_id}.yaml").read_text()}


@router.get("/panes", response_model=list[PaneTypeOut])
def list_panes(db: Session = Depends(get_db), _user: models.User = Depends(_builder)):
    return [_out(db, r) for r in db.query(models.BuiltPaneType).order_by(models.BuiltPaneType.id).all()]


@router.get("/panes/{type_id}", response_model=PaneTypeOut)
def get_pane(type_id: str, db: Session = Depends(get_db), _user: models.User = Depends(_builder)):
    return _out(db, _found(db, type_id))


@router.post("/check", response_model=CheckOut)
def check(payload: SourceIn, db: Session = Depends(get_db), _user: models.User = Depends(_builder)):
    from .. import store

    type_id = payload.id
    if type_id is None and payload.new_id:
        try:
            type_id = store.full_id(db, payload.new_id, builder.ID_RE)
        except store.StoreError as e:
            return {"ok": False, "errors": [{"line": None, "message": str(e)}]}
    try:
        builder.parse(payload.source, type_id)
    except builder.BuilderError as e:
        return {"ok": False, "errors": e.errors}
    return {"ok": True, "errors": []}


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
