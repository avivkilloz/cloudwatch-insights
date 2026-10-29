"""Who works on something built, over HTTP (D161): its owner and members, as a
session's card shows its members. Read by anyone who may change it; managed
by its owner and admins, and left by a member themselves.

`target` is a saved one's id, or `draft:<id>` for one still being made."""

from typing import Any, Optional

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import auth, build_access, build_drafts, live_events, models
from ..db import get_db

router = APIRouter(prefix="/api/build-members", tags=["builder"])


class Invite(BaseModel):
    username: str


class OwnerIn(BaseModel):
    username: str


def _place(db: Session, user: models.User, kind: str, target: str) -> tuple[Any, Optional[models.BuildDraft]]:
    """The saved one (or None) and the draft (a new one's, or a saved one's
    if it has one) -- if this person may change it."""
    if kind not in build_access.KINDS:
        raise HTTPException(status_code=404, detail=f"Nothing is built of kind {kind}.")
    if target.startswith("draft:"):
        try:
            draft = build_drafts.reachable(db, user, int(target.split(":", 1)[1]))
        except (ValueError, build_drafts.DraftError):
            raise HTTPException(status_code=404, detail="There is no such draft of yours.") from None
        if draft.target_id:
            # Created since: its members are the saved one's now.
            return _place(db, user, kind, draft.target_id)
        return None, draft
    row = db.get(build_access.MODELS[kind], target)
    if row is None:
        raise HTTPException(status_code=404, detail=f"There is no {build_access.NOUNS[kind]} {target}.")
    if not build_access.can_edit(db, user, kind, row) and not build_access.is_member(db, user, kind, target):
        raise HTTPException(status_code=404, detail=f"There is no {build_access.NOUNS[kind]} {target} you can change.")
    return row, db.query(models.BuildDraft).filter_by(kind=kind, target_id=target).first()


def _key(row: Any, draft: Optional[models.BuildDraft]) -> str:
    return row.id if row is not None else build_access.draft_target(draft.id)


def _out(db: Session, user: models.User, kind: str, row: Any, draft: Optional[models.BuildDraft]) -> dict:
    key = _key(row, draft)
    owner_id = row.owner_id if row is not None else draft.user_id
    members = (db.query(models.User).join(models.BuildMember, models.BuildMember.user_id == models.User.id)
               .filter(models.BuildMember.kind == kind, models.BuildMember.target_id == key)
               .order_by(models.User.username).all())
    return {
        "kind": kind,
        "target": key,
        "owner": build_access.person(db.get(models.User, owner_id) if owner_id else None),
        "members": [build_access.person(m) for m in members],
        "can_manage": build_access.can_manage(db, user, kind, row, draft),
        "draft_id": draft.id if draft is not None else None,
    }


def _tell(db: Session, kind: str, row: Any, draft: Optional[models.BuildDraft], also: set[int]) -> None:
    """Who works on it changed: everyone concerned re-reads it -- the lists
    (a draft that's now theirs), the chat (shared or not)."""
    who = build_access.participants(db, kind, row.id if row is not None else None, draft) | also
    for user_id in sorted(who):
        live_events.notify(db, user_id, "build_members", None, None, None, extra={
            "build_kind": kind, "target_id": _key(row, draft), "draft_id": draft.id if draft is not None else None})


def _guard(fn):
    try:
        return fn()
    except build_access.AccessError as e:
        raise HTTPException(status_code=e.status, detail=str(e)) from None


@router.get("/{kind}/{target}")
def members(kind: str, target: str, db: Session = Depends(get_db), user: models.User = Depends(auth.get_current_user)):
    row, draft = _place(db, user, kind, target)
    return _out(db, user, kind, row, draft)


@router.post("/{kind}/{target}/members", status_code=201)
def invite(kind: str, target: str, payload: Invite, db: Session = Depends(get_db),
           user: models.User = Depends(auth.get_current_user)):
    row, draft = _place(db, user, kind, target)
    if not build_access.can_manage(db, user, kind, row, draft):
        raise HTTPException(status_code=403, detail="Only its owner, or an admin, adds members.")
    owner_id = row.owner_id if row is not None else draft.user_id
    if payload.username.strip() == (db.get(models.User, owner_id).username if owner_id else None):
        raise HTTPException(status_code=409, detail="That's its owner: they already change it.")
    who = _guard(lambda: build_access.add(db, user, kind, _key(row, draft), payload.username))
    _tell(db, kind, row, draft, {who.id, user.id})
    db.commit()
    return _out(db, user, kind, row, draft)


@router.delete("/{kind}/{target}/members/{user_id}")
def remove(kind: str, target: str, user_id: int, db: Session = Depends(get_db),
           user: models.User = Depends(auth.get_current_user)):
    row, draft = _place(db, user, kind, target)
    if user_id != user.id and not build_access.can_manage(db, user, kind, row, draft):
        raise HTTPException(status_code=403, detail="Only its owner, or an admin, removes members; you may leave.")
    _tell(db, kind, row, draft, {user_id, user.id})
    build_access.remove(db, kind, _key(row, draft), user_id)
    db.commit()
    if user_id == user.id and not build_access.is_admin(user):
        return {"left": True}
    return _out(db, user, kind, row, draft)


@router.put("/{kind}/{target}/owner")
def hand_on(kind: str, target: str, payload: OwnerIn, db: Session = Depends(get_db),
            user: models.User = Depends(auth.get_current_user)):
    """Hands a saved one on to someone else: its owner's or an admin's to do.
    The old owner stays on as a member -- handing on isn't leaving."""
    row, draft = _place(db, user, kind, target)
    if row is None:
        raise HTTPException(status_code=400, detail="A draft of something new is its starter's until it's created.")
    if not build_access.can_manage(db, user, kind, row, draft):
        raise HTTPException(status_code=403, detail="Only its owner, or an admin, hands it on.")
    who = db.query(models.User).filter(models.User.username == payload.username.strip()).first()
    if who is None:
        raise HTTPException(status_code=404, detail=f"There is no user {payload.username.strip()}.")
    old = row.owner_id
    build_access.remove(db, kind, row.id, who.id)
    row.owner_id = who.id
    if old and old != who.id and not build_access.is_member(db, db.get(models.User, old), kind, row.id):
        db.add(models.BuildMember(kind=kind, target_id=row.id, user_id=old, added_by_id=user.id))
    _tell(db, kind, row, draft, {who.id, user.id})
    db.commit()
    return _out(db, user, kind, row, draft)
