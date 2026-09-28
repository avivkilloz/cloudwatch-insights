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

The `/members` routes at the bottom are phase 1 of sharing a session with
other users: managing who is invited and at what permission. They don't yet
change what an invited member can reach -- every route above still checks
ownership alone -- that's a later phase.
"""

import asyncio
import datetime
import json
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .. import auth, models, schemas
from ..db import get_db
from ..live_events import listener, notify
from ..live_store import MAX_STATE_BYTES, commit_write

router = APIRouter(prefix="/api/live-sessions", tags=["live-sessions"])

# Nothing here trims itself. Closing a session is how you put it away, not how
# you get rid of it -- the panel lists closed sessions alongside open ones, and
# deleting is the only thing that removes one. A cap would mean a session the
# owner considers kept disappearing without them asking.
#
# What that would otherwise cost is paid for in the listing below: a closed
# session's rows are not sent until it is reopened.

# A hard ceiling on one session's state (MAX_STATE_BYTES, in live_store). The
# browser already drops a session's results at its own, lower cap and flags it
# as truncated; this is the backstop for anything that gets past it, so one
# runaway session can't fill the database. Measured on the JSON as it will be
# stored.


def _owned(db: Session, user: models.User, client_id: str, lock: bool = False) -> models.LiveSession:
    query = db.query(models.LiveSession).filter(
        models.LiveSession.user_id == user.id, models.LiveSession.client_id == client_id
    )
    row = (query.with_for_update() if lock else query).one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return row


def _mine(db: Session, user: models.User):
    return db.query(models.LiveSession).filter(models.LiveSession.user_id == user.id)


# Who is writing: a browser tab's own random id, or "agent" for the platform
# agent. Only ever used to let a writer recognise the echo of its own change
# on the event stream -- never for access control, which is the session
# cookie's job alone.
OriginHeader = Header(default=None, alias="X-Sync-Origin", max_length=64)

# Well inside the 60s idle timeouts nginx (the frontend container's proxy,
# and ingress-nginx) apply by default: without traffic a quiet stream would be
# cut every minute and every browser would reconnect and re-fetch.
HEARTBEAT_SECONDS = 20.0


@router.get("/events")
async def live_session_events(
    request: Request,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    """A server-sent event stream of changes to the caller's sessions:
    `{"kind": "upsert" | "close" | "delete" | "reorder", "client_id", "version",
    "origin"}` per change, and a comment line as a heartbeat. No state rides on
    it -- a browser that wants a changed session GETs it like any other.

    Declared before `/{client_id}`, which would otherwise take "events" for a
    session id."""
    user_id = current_user.id
    # The stream can stay open for hours; a database connection held for its
    # whole life would exhaust the pool at a few dozen open tabs. The user is
    # all the stream needs from the database, and it has that now.
    db.close()

    async def stream():
        sub = listener.subscribe(user_id)
        try:
            # How long a browser waits before reconnecting after a drop.
            yield "retry: 3000\n\n"
            while not await request.is_disconnected():
                try:
                    event = await asyncio.wait_for(sub.queue.get(), timeout=HEARTBEAT_SECONDS)
                except asyncio.TimeoutError:
                    yield ": heartbeat\n\n"
                    continue
                event.pop("user_id", None)
                yield f"data: {json.dumps(event)}\n\n"
        finally:
            listener.unsubscribe(sub)

    # X-Accel-Buffering: nginx (the frontend container's proxy, and
    # ingress-nginx) would otherwise buffer the stream and deliver it in lumps.
    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


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
    origin: Optional[str] = OriginHeader,
):
    rows = {
        row.client_id: row
        for row in db.query(models.LiveSession).filter(models.LiveSession.user_id == current_user.id)
    }
    for position, client_id in enumerate(payload.client_ids):
        row = rows.get(client_id)
        if row is not None:
            row.position = position
    notify(db, current_user.id, "reorder", None, None, origin, order=list(payload.client_ids))
    db.commit()
    return list_live_sessions(db=db, current_user=current_user)


@router.put("/{client_id}", response_model=schemas.LiveSessionOut)
def upsert_live_session(
    client_id: str,
    payload: schemas.LiveSessionUpsert,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
    origin: Optional[str] = OriginHeader,
):
    """Create or overwrite one session. Writers send whole sessions rather
    than patches, with the version they started from: a write from a stale
    one is refused (409) instead of silently undoing a change the writer never
    saw, and the writer merges -- GET the row, fold its own changes in, PUT
    again from the new version. A write with no base version overwrites, which
    is what a browser from before versions existed does."""
    size = len(json.dumps(payload.state))
    if size > MAX_STATE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=(
                f"Session state is {size} bytes, over the {MAX_STATE_BYTES}-byte limit. "
                "Send the session without its results."
            ),
        )

    # Locked for the rest of the transaction: the version check below and the
    # write after it have to be one step. Without the lock two writes made
    # from the same version, landing a few milliseconds apart, both passed the
    # check and the later one silently replaced the earlier -- the exact loss
    # versions exist to prevent (smoke44 caught it about one run in three).
    row = (
        db.query(models.LiveSession)
        .filter(models.LiveSession.user_id == current_user.id, models.LiveSession.client_id == client_id)
        .with_for_update()
        .one_or_none()
    )
    if row is None:
        row = models.LiveSession(user_id=current_user.id, client_id=client_id, version=0)
        db.add(row)
    elif payload.base_version is not None and payload.base_version != row.version:
        raise HTTPException(
            status_code=409,
            detail=(
                f"This session changed elsewhere (it is at version {row.version}, this write was made from "
                f"{payload.base_version}). Fetch it again and reapply your change."
            ),
        )
    row.type = payload.type
    row.title = payload.title
    # Position is set once, on creation. After that the order belongs to
    # /reorder alone: a tab still showing the old order used to send its old
    # positions with every save and quietly undo a reorder made elsewhere.
    if row.id is None:
        row.position = payload.position
    row.category_id = payload.category_id
    row.state = payload.state
    row.truncated = payload.truncated
    # Writing to a closed session is how a reopened one comes back.
    row.closed_at = None
    # The same ending as a write made on the server (live_store.py), so the
    # agent's writes and a browser's are versioned and announced alike.
    commit_write(db, row, origin)
    return row


@router.post("/{client_id}/close", response_model=schemas.LiveSessionOut)
def close_live_session(
    client_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
    origin: Optional[str] = OriginHeader,
):
    row = _owned(db, current_user, client_id, lock=True)
    row.closed_at = datetime.datetime.utcnow()
    row.version = (row.version or 0) + 1
    notify(db, current_user.id, "close", client_id, row.version, origin)
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
    origin: Optional[str] = OriginHeader,
):
    db.delete(_owned(db, current_user, client_id))
    notify(db, current_user.id, "delete", client_id, None, origin)
    db.commit()
    return None


# ---------------------------------------------------------------- members
#
# Phase 1 of sharing a session: managing who is invited, and at what
# permission. This alone doesn't yet let an invited member reach the
# session -- every route above still checks ownership alone, by design --
# that follows in a later phase, alongside extending live sync to members.
# Only the owner manages membership; there's no delegated "can invite" tier.


def _member_out(member: models.SessionMember) -> schemas.SessionMemberOut:
    return schemas.SessionMemberOut(user_id=member.user_id, username=member.user.username, permission=member.permission)


def _member(db: Session, session_id: int, user_id: int) -> models.SessionMember:
    member = (
        db.query(models.SessionMember)
        .filter(models.SessionMember.session_id == session_id, models.SessionMember.user_id == user_id)
        .one_or_none()
    )
    if member is None:
        raise HTTPException(status_code=404, detail="That user is not a member of this session.")
    return member


@router.get("/{client_id}/members", response_model=list[schemas.SessionMemberOut])
def list_session_members(
    client_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    row = _owned(db, current_user, client_id)
    members = db.query(models.SessionMember).filter(models.SessionMember.session_id == row.id).all()
    return [_member_out(m) for m in members]


@router.post("/{client_id}/members", response_model=schemas.SessionMemberOut, status_code=201)
def invite_session_member(
    client_id: str,
    payload: schemas.SessionMemberCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    row = _owned(db, current_user, client_id)
    username = payload.username.strip()
    invitee = db.query(models.User).filter(models.User.username == username).one_or_none()
    if invitee is None:
        raise HTTPException(status_code=404, detail=f'No user named "{username}".')
    if invitee.id == current_user.id:
        raise HTTPException(status_code=400, detail="You already own this session.")
    member = models.SessionMember(session_id=row.id, user_id=invitee.id, permission=payload.permission)
    db.add(member)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail=f'"{username}" is already a member of this session.')
    db.refresh(member)
    return _member_out(member)


@router.put("/{client_id}/members/{user_id}", response_model=schemas.SessionMemberOut)
def update_session_member(
    client_id: str,
    user_id: int,
    payload: schemas.SessionMemberUpdate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    row = _owned(db, current_user, client_id)
    member = _member(db, row.id, user_id)
    member.permission = payload.permission
    db.commit()
    db.refresh(member)
    return _member_out(member)


@router.delete("/{client_id}/members/{user_id}", status_code=204)
def remove_session_member(
    client_id: str,
    user_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    row = _owned(db, current_user, client_id)
    db.delete(_member(db, row.id, user_id))
    db.commit()
    return None
