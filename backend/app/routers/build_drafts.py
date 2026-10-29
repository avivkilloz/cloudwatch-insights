"""Drafts of what's being built, over HTTP (D125): saved by the Builder's
editors as they're typed in, listed beside what's built, and opened again as
they were left -- the chat with them. One per saved thing, shared by everyone
who may change it (D161)."""

from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, Depends, Header, HTTPException
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
    # The editor thinks it's making the saved one's draft (D161): one made by
    # someone else meanwhile is a 409, which it merges into.
    expect_new: bool = False


class DraftChange(BaseModel):
    # A new one's draft, once it's created: that one's from now on.
    target_id: Optional[str] = None
    new_id: Optional[str] = None
    source: Optional[str] = None
    files: Optional[dict[str, str]] = None
    chat: Optional[list[Any]] = None
    # The version the text was edited from (D157): a save on an older one is
    # a 409, not a write over what changed since. Left out by a chat-only save.
    base_version: Optional[int] = None


class DraftOut(BaseModel):
    id: int
    kind: str
    target_id: Optional[str] = None
    new_id: str = ""
    label: str = ""
    updated_at: datetime
    turns: int = 0
    version: int = 0
    # False for a saved one's draft holding only its chat.
    changed: bool = True
    # More than one person works in it (D161, D163).
    shared: bool = False
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
    if target is not None:
        # The one of an existing thing, opened with it, in full -- for anyone
        # who may change it, a participant or not (an admin).
        q = db.query(models.BuildDraft).filter_by(target_id=target)
        rows = q.filter_by(kind=kind).all() if kind else q.all()
        out = []
        for r in rows:
            try:
                out.append(build_drafts.out(db, build_drafts.reachable(db, user, r.id), full=True))
            except build_drafts.DraftError:
                pass
        return out
    return [build_drafts.out(db, r) for r in build_drafts.listed(db, user, kind)]


@router.get("/{draft_id}", response_model=DraftOut)
def get_draft(draft_id: int, db: Session = Depends(get_db), user: models.User = Depends(auth.get_current_user)):
    return build_drafts.out(db, _guard(lambda: build_drafts.reachable(db, user, draft_id)), full=True)


@router.post("", response_model=DraftOut, status_code=201)
def save_draft(payload: DraftIn, db: Session = Depends(get_db), user: models.User = Depends(auth.get_current_user),
               origin: Optional[str] = Header(default=None, alias="X-Sync-Origin", max_length=64)):
    row = _guard(lambda: build_drafts.save(db, user, payload.kind, payload.target_id, payload.source, payload.new_id,
                                           payload.chat, payload.files, origin=origin,
                                           expect_new=payload.expect_new))
    return build_drafts.out(db, row)


@router.put("/{draft_id}", response_model=DraftOut)
def change_draft(draft_id: int, payload: DraftChange, db: Session = Depends(get_db),
                 user: models.User = Depends(auth.get_current_user),
                 origin: Optional[str] = Header(default=None, alias="X-Sync-Origin", max_length=64)):
    row = _guard(lambda: build_drafts.reachable(db, user, draft_id))
    return build_drafts.out(db, _guard(lambda: build_drafts.update(db, user, row, payload.source, payload.new_id,
                                                                  payload.chat, payload.target_id, payload.files,
                                                                  origin=origin, base_version=payload.base_version)))


@router.delete("/{draft_id}", status_code=204)
def discard_draft(draft_id: int, db: Session = Depends(get_db), user: models.User = Depends(auth.get_current_user),
                  origin: Optional[str] = Header(default=None, alias="X-Sync-Origin", max_length=64)):
    row = _guard(lambda: build_drafts.reachable(db, user, draft_id))
    _guard(lambda: build_drafts.discard(db, user, row, origin))
    return None
