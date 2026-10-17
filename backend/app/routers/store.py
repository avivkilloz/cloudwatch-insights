"""Settings → Store over HTTP (PLATFORM_PLAN.md §21, D70): where the store
repo is, how it stands, Sync now, and resolving a conflict. Admins only --
the store holds what admins define. No route returns the token or key: the
status says which kind of auth is set, and a Settings store names its
credential."""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import auth, models, schemas, store
from ..db import get_db

router = APIRouter(prefix="/api/store", tags=["store"])


def _guard(fn):
    try:
        return fn()
    except store.StoreError as e:
        raise HTTPException(status_code=400, detail=str(e)) from None


@router.get("")
def get_store(db: Session = Depends(get_db), _admin: models.User = Depends(auth.require_admin)):
    return store.status(db)


@router.put("")
def put_store(payload: schemas.StoreIn, db: Session = Depends(get_db), admin: models.User = Depends(auth.require_admin)):
    """Saves the store and restores from it. A repo that can't be reached is
    saved anyway, with the reason in `last_error` -- it may be a moment away."""
    lines = _guard(lambda: store.configure(db, payload.model_dump(), admin))
    store.flush()
    return {**store.status(db), "restored": lines}


@router.delete("", status_code=204)
def delete_store(db: Session = Depends(get_db), admin: models.User = Depends(auth.require_admin)):
    _guard(lambda: store.unconfigure(db, admin))
    return None


@router.post("/sync")
def sync_store(db: Session = Depends(get_db), _admin: models.User = Depends(auth.require_admin)):
    result = store.flush()
    db.expire_all()
    return {**store.status(db), "result": result}


@router.get("/items/{kind}/{item_id}")
def item_sides(kind: str, item_id: str, db: Session = Depends(get_db), _admin: models.User = Depends(auth.require_admin)):
    """Both versions of a conflicted item, as files."""
    return _guard(lambda: store.sides(db, kind, item_id))


@router.post("/items/{kind}/{item_id}/resolve")
def resolve_item(
    kind: str,
    item_id: str,
    payload: schemas.StoreResolveIn,
    db: Session = Depends(get_db),
    admin: models.User = Depends(auth.require_admin),
):
    _guard(lambda: store.resolve(db, kind, item_id, payload.take, admin))
    store.flush()
    db.expire_all()
    return store.status(db)
