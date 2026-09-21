"""The sessions open in someone's side panel, autosaved.

Nothing here is a "save" in the sense the Saved items page means it. A
SavedSession is a named template holding a page's inputs, created when someone
presses a button. These rows are the live working state of sessions that are
already open -- written back whenever the browser has something new, so a
refresh, another browser or another machine puts you back where you were.

The browser owns the ids and the ordering; this module owns durability and
scoping. A session is closed by keeping the row and stamping `closed_at`, so it
can be reopened from "Recently closed"; deleting is what actually removes it.
"""

import datetime
import json
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import auth, models, schemas
from ..db import get_db

router = APIRouter(prefix="/api/live-sessions", tags=["live-sessions"])

# How many closed sessions to keep per user. "Recently closed" is an undo for a
# ✕ you didn't mean, not an archive -- past this the oldest are dropped so the
# table doesn't grow without bound for someone who opens and closes all day.
MAX_CLOSED_SESSIONS = 20

# A hard ceiling on one session's state. The browser already drops a session's
# results at its own, lower cap and flags it as truncated; this is the backstop
# for anything that gets past it, so one runaway session can't fill the
# database. Measured on the JSON as it will be stored.
MAX_STATE_BYTES = 8 * 1024 * 1024


def _owned(db: Session, user: models.User, client_id: str) -> models.LiveSession:
    row = (
        db.query(models.LiveSession)
        .filter(models.LiveSession.user_id == user.id, models.LiveSession.client_id == client_id)
        .one_or_none()
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return row


@router.get("", response_model=list[schemas.LiveSessionOut])
def list_live_sessions(
    closed: Optional[bool] = None,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    """The caller's open sessions in panel order, or -- with `closed=true` --
    the ones they closed, most recently closed first."""
    query = db.query(models.LiveSession).filter(models.LiveSession.user_id == current_user.id)
    if closed:
        return (
            query.filter(models.LiveSession.closed_at.isnot(None))
            .order_by(models.LiveSession.closed_at.desc())
            .all()
        )
    return (
        query.filter(models.LiveSession.closed_at.is_(None))
        .order_by(models.LiveSession.position, models.LiveSession.id)
        .all()
    )


@router.post("/reorder", response_model=list[schemas.LiveSessionOut])
def reorder_live_sessions(
    payload: schemas.LiveSessionOrder,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    rows = {
        row.client_id: row
        for row in db.query(models.LiveSession).filter(models.LiveSession.user_id == current_user.id)
    }
    for position, client_id in enumerate(payload.client_ids):
        row = rows.get(client_id)
        if row is not None:
            row.position = position
    db.commit()
    return list_live_sessions(closed=None, db=db, current_user=current_user)


@router.put("/{client_id}", response_model=schemas.LiveSessionOut)
def upsert_live_session(
    client_id: str,
    payload: schemas.LiveSessionUpsert,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    """Create or overwrite one session. The browser sends whole sessions rather
    than patches: its copy is the live one, and a partial update from a stale
    tab would be harder to reason about than a last-write-wins whole one."""
    size = len(json.dumps(payload.state))
    if size > MAX_STATE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=(
                f"Session state is {size} bytes, over the {MAX_STATE_BYTES}-byte limit. "
                "Send the session without its results."
            ),
        )

    row = (
        db.query(models.LiveSession)
        .filter(models.LiveSession.user_id == current_user.id, models.LiveSession.client_id == client_id)
        .one_or_none()
    )
    if row is None:
        row = models.LiveSession(user_id=current_user.id, client_id=client_id)
        db.add(row)
    row.type = payload.type
    row.title = payload.title
    row.position = payload.position
    row.state = payload.state
    row.truncated = payload.truncated
    # Writing to a closed session is how a reopened one comes back.
    row.closed_at = None
    db.commit()
    db.refresh(row)
    return row


@router.post("/{client_id}/close", response_model=schemas.LiveSessionOut)
def close_live_session(
    client_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    row = _owned(db, current_user, client_id)
    row.closed_at = datetime.datetime.utcnow()
    db.commit()

    # Trim the tail rather than the whole table: only this user's closed rows,
    # oldest first, and only the ones past the cap.
    stale = (
        db.query(models.LiveSession)
        .filter(models.LiveSession.user_id == current_user.id, models.LiveSession.closed_at.isnot(None))
        .order_by(models.LiveSession.closed_at.desc())
        .offset(MAX_CLOSED_SESSIONS)
        .all()
    )
    for old in stale:
        db.delete(old)
    if stale:
        db.commit()

    db.refresh(row)
    return row


@router.delete("/{client_id}", status_code=204)
def delete_live_session(
    client_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    db.delete(_owned(db, current_user, client_id))
    db.commit()
    return None
