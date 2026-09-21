"""The sessions open in someone's side panel, autosaved.

Nothing here is a "save" in the sense the Saved items page means it. A
SavedSession is a named template holding a page's inputs, created when someone
presses a button. These rows are the live working state of sessions that are
already open -- written back whenever the browser has something new, so a
refresh, another browser or another machine puts you back where you were.

The browser owns the ids and the ordering; this module owns durability and
scoping. Closing a session keeps the row and stamps `closed_at`: it leaves the
strip of tabs but stays in the side panel's list, ready to reopen. Deleting is
the only thing that removes one.
"""

import datetime
import json
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import auth, models, schemas
from ..db import get_db

router = APIRouter(prefix="/api/live-sessions", tags=["live-sessions"])

# Nothing here trims itself. Closing a session is how you put it away, not how
# you get rid of it -- the panel lists closed sessions alongside open ones, and
# deleting is the only thing that removes one. A cap would mean a session the
# owner considers kept disappearing without them asking.
#
# What that would otherwise cost is paid for in the listing below: a closed
# session's rows are not sent until it is reopened.

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


def _mine(db: Session, user: models.User):
    return db.query(models.LiveSession).filter(models.LiveSession.user_id == user.id)


@router.get("", response_model=list[schemas.LiveSessionOut])
def list_live_sessions(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    """The caller's open sessions, in panel order, with their state: these are
    the tabs the browser has to put back on screen."""
    return (
        _mine(db, current_user)
        .filter(models.LiveSession.closed_at.is_(None))
        .order_by(models.LiveSession.position, models.LiveSession.id)
        .all()
    )


@router.get("/closed", response_model=list[schemas.LiveSessionSummary])
def list_closed_live_sessions(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    """The closed ones, most recently closed first -- names only.

    Nothing trims this list, so it is the one that grows, and sending every
    closed session's rows on every page load would make opening the app cost
    more the longer you had used it. The panel only needs the names; the state
    comes with `GET /{client_id}` when one is actually reopened.
    """
    return (
        _mine(db, current_user)
        .filter(models.LiveSession.closed_at.isnot(None))
        .order_by(models.LiveSession.closed_at.desc())
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
    return list_live_sessions(db=db, current_user=current_user)


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
    db.refresh(row)
    return row


@router.get("/{client_id}", response_model=schemas.LiveSessionOut)
def get_live_session(
    client_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    """One session with its whole state. What reopening a closed session reads,
    since the closed listing deliberately leaves the state out."""
    return _owned(db, current_user, client_id)


@router.delete("/{client_id}", status_code=204)
def delete_live_session(
    client_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    db.delete(_owned(db, current_user, client_id))
    db.commit()
    return None
