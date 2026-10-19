"""Published templates over HTTP (PLATFORM_PLAN.md §23, D99-D102).

Publishing, renaming and unpublishing are an admin's (plugin content, like a
workflow's definition, until the Builder grant). Anyone sees and opens the
ones whose every pane their group may use; opening makes a session of theirs
on the server, the environment they chose set first."""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import auth, models, templates
from ..db import get_db

router = APIRouter(prefix="/api/templates", tags=["templates"])


class PublishIn(BaseModel):
    saved_session_id: int
    id: str
    label: str
    description: Optional[str] = None


class TemplateUpdate(BaseModel):
    label: Optional[str] = None
    description: Optional[str] = None


class OpenIn(BaseModel):
    environment: Optional[int] = None


class TemplateOut(BaseModel):
    id: str
    label: str
    description: Optional[str] = None
    pane_types: list[str]
    needs_environment: bool
    # Whether the asker's group may use every pane of it (an admin sees all).
    usable: bool
    store_state: Optional[str] = None
    # The asker's own saved template it was published from, if it was theirs.
    from_saved_session_id: Optional[int] = None


class PublishedOut(TemplateOut):
    # What publishing changed to make it portable, in words.
    changes: list[str]


class OpenedOut(BaseModel):
    session_id: str
    title: str


def _out(db: Session, user: models.User, row: models.PublishedTemplate) -> dict:
    state = row.state or {}
    return {
        "id": row.id,
        "label": row.label,
        "description": row.description,
        "pane_types": templates.pane_types(state),
        "needs_environment": templates.needs_environment(state),
        "usable": templates.usable(user, row),
        "store_state": next(iter(db.query(models.StoreItem.state).filter_by(kind="template", item_id=row.id)), (None,))[0],
        "from_saved_session_id": row.saved_session_id if _own_saved(db, user, row.saved_session_id) else None,
    }


def _own_saved(db: Session, user: models.User, saved_id: Optional[int]) -> bool:
    saved = db.get(models.SavedSession, saved_id) if saved_id else None
    return saved is not None and saved.user_id == user.id


def _guard(fn):
    try:
        return fn()
    except templates.TemplateError as e:
        raise HTTPException(status_code=400, detail=str(e)) from None


def _found(db: Session, user: models.User, template_id: str) -> models.PublishedTemplate:
    row = db.get(models.PublishedTemplate, template_id)
    is_admin = bool(user.group and user.group.is_admin)
    if row is None or not (is_admin or templates.usable(user, row)):
        raise HTTPException(status_code=404, detail="There is no such template.")
    return row


@router.get("", response_model=list[TemplateOut])
def list_templates(db: Session = Depends(get_db), user: models.User = Depends(auth.get_current_user)):
    is_admin = bool(user.group and user.group.is_admin)
    rows = db.query(models.PublishedTemplate).order_by(models.PublishedTemplate.label).all()
    return [_out(db, user, r) for r in rows if is_admin or templates.usable(user, r)]


@router.post("", response_model=PublishedOut, status_code=201)
def publish(payload: PublishIn, db: Session = Depends(get_db), user: models.User = Depends(auth.require_admin)):
    row, changes = _guard(
        lambda: templates.publish(db, user, payload.saved_session_id, payload.id, payload.label, payload.description)
    )
    return {**_out(db, user, row), "changes": changes}


@router.put("/{template_id}", response_model=TemplateOut)
def update(template_id: str, payload: TemplateUpdate, db: Session = Depends(get_db),
           user: models.User = Depends(auth.require_admin)):
    row = _found(db, user, template_id)
    _guard(lambda: templates.update(db, user, row, payload.label, payload.description))
    return _out(db, user, row)


@router.delete("/{template_id}", status_code=204)
def unpublish(template_id: str, db: Session = Depends(get_db), user: models.User = Depends(auth.require_admin)):
    templates.unpublish(db, user, _found(db, user, template_id))


@router.post("/{template_id}/open", response_model=OpenedOut, status_code=201)
def open_template(template_id: str, payload: OpenIn, db: Session = Depends(get_db),
                  user: models.User = Depends(auth.get_current_user)):
    row = _found(db, user, template_id)
    made = _guard(lambda: templates.instantiate(db, user, row, payload.environment))
    return {"session_id": made.client_id, "title": made.title}
