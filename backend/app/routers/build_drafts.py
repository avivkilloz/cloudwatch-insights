"""Drafts of what's being built, over HTTP (D125): saved by the Builder's and
the Workflows page's editors as their builder types, listed beside what's
built, and opened again as they were left -- the chat with them."""

from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .. import auth, build_drafts, models
from ..db import get_db

router = APIRouter(prefix="/api/build-drafts", tags=["builder"])


class DraftIn(BaseModel):
    kind: str
    # The pane type, step type or workflow it changes; none for a new one.
    target_id: Optional[str] = None
    new_id: Optional[str] = None
    source: Optional[str] = None
    files: Optional[dict[str, str]] = None
    chat: Optional[list[Any]] = None


class DraftChange(BaseModel):
    # A new one's draft, once it's created: that one's from now on.
    target_id: Optional[str] = None
    new_id: Optional[str] = None
    source: Optional[str] = None
    files: Optional[dict[str, str]] = None
    chat: Optional[list[Any]] = None


class DraftOut(BaseModel):
    id: int
    kind: str
    target_id: Optional[str] = None
    new_id: str = ""
    label: str = ""
    updated_at: datetime
    turns: int = 0
    # False for a saved one's draft holding only its chat.
    changed: bool = True
    source: Optional[str] = None
    files: Optional[dict[str, str]] = None
    chat: Optional[list[Any]] = Field(default=None)


def _guard(fn):
    try:
        return fn()
    except build_drafts.DraftError as e:
        raise HTTPException(status_code=e.status, detail=str(e)) from None


@router.get("", response_model=list[DraftOut])
def list_drafts(kind: Optional[str] = None, target: Optional[str] = None, db: Session = Depends(get_db),
                user: models.User = Depends(auth.get_current_user)):
    rows = build_drafts.listed(db, user, kind)
    if target is not None:
        # The one of an existing thing, opened with it: in full.
        return [build_drafts.out(db, r, full=True) for r in rows if r.target_id == target]
    return [build_drafts.out(db, r) for r in rows]


@router.get("/{draft_id}", response_model=DraftOut)
def get_draft(draft_id: int, db: Session = Depends(get_db), user: models.User = Depends(auth.get_current_user)):
    return build_drafts.out(db, _guard(lambda: build_drafts.mine(db, user, draft_id)), full=True)


@router.post("", response_model=DraftOut, status_code=201)
def save_draft(payload: DraftIn, db: Session = Depends(get_db), user: models.User = Depends(auth.get_current_user)):
    row = _guard(lambda: build_drafts.save(db, user, payload.kind, payload.target_id, payload.source, payload.new_id,
                                           payload.chat, payload.files))
    return build_drafts.out(db, row)


@router.put("/{draft_id}", response_model=DraftOut)
def change_draft(draft_id: int, payload: DraftChange, db: Session = Depends(get_db),
                 user: models.User = Depends(auth.get_current_user)):
    row = _guard(lambda: build_drafts.mine(db, user, draft_id))
    return build_drafts.out(db, _guard(lambda: build_drafts.update(db, user, row, payload.source, payload.new_id,
                                                                  payload.chat, payload.target_id, payload.files)))


@router.delete("/{draft_id}", status_code=204)
def discard_draft(draft_id: int, db: Session = Depends(get_db), user: models.User = Depends(auth.get_current_user)):
    row = _guard(lambda: build_drafts.mine(db, user, draft_id))
    db.delete(row)
    db.commit()
    return None
