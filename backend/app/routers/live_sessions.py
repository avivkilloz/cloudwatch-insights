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

Phase 3 of sharing a session (phase 1 was the roster below, phase 2 the
session card's own Members section) is reachability: every route from here
down accepts either the owner or one of the session's `SessionMember`s, not
ownership alone. A member's *own* view -- their panel position, their own
category, whether they've closed it -- lives on their `SessionMember` row,
never on `LiveSession` itself (that's the owner's), so `_out`/`_summary_out`
below always read the caller's own view rather than the row's raw columns.
`state`, `title`, `type` and `version` are the one document every reachable
caller sees alike -- an editor can write them, a viewer can't (403).
Deleting the session outright, and managing who's on the roster, stay the
owner's alone.

A `client_id` is only unique *per owner* (`uq_live_sessions_user_client` --
two different people's browsers can mint the same one), so a session shared
with the caller is always found through their own `SessionMember` row, never
by client_id alone: that's what stops this from ever resolving to some other
owner's unrelated session that happens to share an id.
"""

import asyncio
import datetime
import json
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .. import auth, live_store, models, pane_outputs, presence, schemas
from ..db import SessionLocal, get_db
from ..panes import state as pane_state
from ..live_events import listener, notify
from ..live_store import MAX_STATE_BYTES, commit_write

router = APIRouter(prefix="/api/live-sessions", tags=["live-sessions"])

# Must match agent/AgentContext.tsx's own SESSION_CHAT_KEY -- see
# upsert_live_session's own use of it below.
SESSION_CHAT_KEY = "agentChat"

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
    """Strictly the caller's own row -- for deleting the session outright and
    for managing its roster, neither of which a mere member may do."""
    query = db.query(models.LiveSession).filter(
        models.LiveSession.user_id == user.id, models.LiveSession.client_id == client_id
    )
    row = (query.with_for_update() if lock else query).one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return row


def _reachable(
    db: Session, user: models.User, client_id: str, lock: bool = False
) -> tuple[models.LiveSession, Optional[models.SessionMember]]:
    """The session, plus the caller's own `SessionMember` row if it isn't
    theirs -- `None` for the owner. 404 if the caller is neither: unreachable
    and nonexistent look the same to them, same as `_owned` already did.
    `live_store.reachable` does the actual lookup; this just turns "neither"
    into the 404 every route here already raises for that."""
    row, member = live_store.reachable(db, user.id, client_id, lock)
    if row is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return row, member


def _role(member: Optional[models.SessionMember]) -> schemas.SessionRole:
    return "owner" if member is None else member.permission


def _out(db: Session, row: models.LiveSession, member: Optional[models.SessionMember]) -> schemas.LiveSessionOut:
    return schemas.LiveSessionOut(
        client_id=row.client_id,
        type=row.type,
        title=row.title,
        position=row.position if member is None else member.position,
        category_id=row.category_id if member is None else member.category_id,
        # A browser always reads the state shape it writes (§15.4) -- and its
        # panes' outputs beside it, never in it (D21, §18.2).
        state=pane_outputs.split(pane_state.migrate(row.state))[0],
        outputs=pane_outputs.read(db, row),
        truncated=row.truncated,
        closed_at=row.closed_at if member is None else member.closed_at,
        version=row.version,
        role=_role(member),
    )


def _summary_out(row: models.LiveSession, member: Optional[models.SessionMember]) -> schemas.LiveSessionSummary:
    return schemas.LiveSessionSummary(
        client_id=row.client_id,
        type=row.type,
        title=row.title,
        truncated=row.truncated,
        closed_at=row.closed_at if member is None else member.closed_at,
        category_id=row.category_id if member is None else member.category_id,
        role=_role(member),
    )


def _open_pairs(db: Session, user: models.User) -> list[tuple[models.LiveSession, Optional[models.SessionMember]]]:
    """Every session this caller can currently see open: their own, and every
    one shared with them that they haven't closed -- each with its own
    position, so the two sources sort into one list."""
    owned = [
        (row, None)
        for row in db.query(models.LiveSession).filter(
            models.LiveSession.user_id == user.id, models.LiveSession.closed_at.is_(None)
        )
    ]
    shared = [
        (member.session, member)
        for member in db.query(models.SessionMember).filter(
            models.SessionMember.user_id == user.id, models.SessionMember.closed_at.is_(None)
        )
    ]
    pairs = owned + shared
    pairs.sort(key=lambda pair: (pair[1].position if pair[1] is not None else pair[0].position, pair[0].id))
    return pairs


def _closed_pairs(db: Session, user: models.User) -> list[tuple[models.LiveSession, Optional[models.SessionMember]]]:
    owned = [
        (row, None)
        for row in db.query(models.LiveSession).filter(
            models.LiveSession.user_id == user.id, models.LiveSession.closed_at.isnot(None)
        )
    ]
    shared = [
        (member.session, member)
        for member in db.query(models.SessionMember).filter(
            models.SessionMember.user_id == user.id, models.SessionMember.closed_at.isnot(None)
        )
    ]
    pairs = owned + shared
    pairs.sort(key=lambda pair: pair[1].closed_at if pair[1] is not None else pair[0].closed_at, reverse=True)
    return pairs


def _next_position(db: Session, user_id: int) -> int:
    """The end of this user's own list of open sessions -- their own and the
    ones shared with them share one position scale in their panel, even
    though it's stored on two different tables."""
    owned_max = db.query(func.max(models.LiveSession.position)).filter(models.LiveSession.user_id == user_id).scalar()
    member_max = db.query(func.max(models.SessionMember.position)).filter(
        models.SessionMember.user_id == user_id
    ).scalar()
    highest = [v for v in (owned_max, member_max) if v is not None]
    return (max(highest) + 1) if highest else 0


# Who is writing: a browser tab's own random id, or "agent" for the platform
# agent. Only ever used to let a writer recognise the echo of its own change
# on the event stream -- never for access control, which is the session
# cookie's job alone.
OriginHeader = Header(default=None, alias="X-Sync-Origin", max_length=64)

# Well inside the 60s idle timeouts nginx (the frontend container's proxy,
# and ingress-nginx) apply by default: without traffic a quiet stream would be
# cut every minute and every browser would reconnect and re-fetch.
HEARTBEAT_SECONDS = 20.0


def _presence(fn, *args):
    with SessionLocal() as db:
        return fn(db, *args)


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
        # This tab is here while its stream is: what makes the sessions it has
        # open "watched", so a long-running query in one is polled (D51).
        # Short sessions of its own, for the same reason the request's was
        # closed above.
        tab_id = await asyncio.to_thread(_presence, presence.open_tab, user_id)
        try:
            # How long a browser waits before reconnecting after a drop.
            yield "retry: 3000\n\n"
            while not await request.is_disconnected():
                try:
                    event = await asyncio.wait_for(sub.queue.get(), timeout=HEARTBEAT_SECONDS)
                except asyncio.TimeoutError:
                    await asyncio.to_thread(_presence, presence.touch, tab_id, user_id)
                    yield ": heartbeat\n\n"
                    continue
                event.pop("user_id", None)
                yield f"data: {json.dumps(event)}\n\n"
        finally:
            listener.unsubscribe(sub)
            await asyncio.to_thread(_presence, presence.close_tab, tab_id)

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
    the tabs the browser has to put back on screen. Their own, and every one
    shared with them that they haven't closed -- indistinguishable here from
    an owned one except by `role`."""
    return [_out(db, row, member) for row, member in _open_pairs(db, current_user)]


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
    return [_summary_out(row, member) for row, member in _closed_pairs(db, current_user)]


def _home_out(db: Session, user: models.User) -> schemas.HomeSessionOut:
    if user.home_session_id is None:
        return schemas.HomeSessionOut(missing=user.home_session_title)
    row = db.get(models.LiveSession, user.home_session_id)
    member = None
    if row is not None and row.user_id != user.id:
        member = (
            db.query(models.SessionMember)
            .filter(models.SessionMember.session_id == row.id, models.SessionMember.user_id == user.id)
            .one_or_none()
        )
        if member is None:
            row = None
    if row is None:
        # Deleted, or they left it (or were removed): the default page, with
        # a note saying which one -- until it's dismissed, which clears this.
        return schemas.HomeSessionOut(missing=user.home_session_title or "your home session")
    closed_at = row.closed_at if member is None else member.closed_at
    return schemas.HomeSessionOut(
        home=schemas.HomeSessionRef(client_id=row.client_id, title=row.title, closed=closed_at is not None)
    )


# Before /{client_id}, which would otherwise take "home" for a session id.
@router.get("/home", response_model=schemas.HomeSessionOut)
def get_home_session(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    """Which session is the caller's home page (R3, D63), if any."""
    return _home_out(db, current_user)


@router.delete("/home", response_model=schemas.HomeSessionOut)
def clear_home_session(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    """Home is the default page again -- also how the "your home page is
    gone" note is dismissed."""
    current_user.home_session_id = None
    current_user.home_session_title = None
    db.commit()
    return _home_out(db, current_user)


@router.put("/{client_id}/home", response_model=schemas.HomeSessionOut)
def set_home_session(
    client_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    """Makes a session the caller can reach -- theirs, or one shared with
    them at any permission -- their home page."""
    row, _member = _reachable(db, current_user, client_id)
    current_user.home_session_id = row.id
    current_user.home_session_title = row.title
    db.commit()
    return _home_out(db, current_user)


@router.post("/reorder", response_model=list[schemas.LiveSessionOut])
def reorder_live_sessions(
    payload: schemas.LiveSessionOrder,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
    origin: Optional[str] = OriginHeader,
):
    """Reorders the caller's own panel. An id they own moves their own
    LiveSession row; one merely shared with them moves their own membership
    row instead -- reordering a shared session in your panel never touches
    the owner's (or any other member's) position for it."""
    owned = {
        row.client_id: row
        for row in db.query(models.LiveSession).filter(models.LiveSession.user_id == current_user.id)
    }
    shared = {
        member.session.client_id: member
        for member in db.query(models.SessionMember).filter(models.SessionMember.user_id == current_user.id)
        if member.session.client_id not in owned
    }
    for position, client_id in enumerate(payload.client_ids):
        if client_id in owned:
            owned[client_id].position = position
        elif client_id in shared:
            shared[client_id].position = position
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
    is what a browser from before versions existed does.

    An existing session reachable only through membership is the one shared
    document either way -- an editor may write its content the same as the
    owner, a viewer may not (403). Either way `category_id`/reopening land on
    the *caller's own* view (their SessionMember row for a member, the row
    itself for the owner), never the other's."""
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
    member: Optional[models.SessionMember] = None
    if row is None:
        # Not the caller's own by this client_id -- maybe it's shared with
        # them. A session that doesn't exist yet is always the caller's own
        # (there is nothing to share before it exists), so membership is only
        # worth checking once an owned row genuinely isn't there.
        member = (
            db.query(models.SessionMember)
            .join(models.LiveSession, models.SessionMember.session_id == models.LiveSession.id)
            .filter(models.SessionMember.user_id == current_user.id, models.LiveSession.client_id == client_id)
            .with_for_update(of=models.SessionMember)
            .first()
        )
        if member is not None:
            row = (
                db.query(models.LiveSession)
                .filter(models.LiveSession.id == member.session_id)
                .with_for_update()
                .one()
            )

    if row is None:
        row = models.LiveSession(user_id=current_user.id, client_id=client_id, version=0)
        db.add(row)
    else:
        if member is not None and member.permission == "viewer":
            # Chatting isn't editing the session -- a write that changes
            # nothing but the chat log still goes through even for a viewer
            # (the frontend's own mirror of this is sync.ts's
            # chatOnlyChange); anything else about the session stays
            # refused. Without this carve-out a viewer's own chat messages,
            # and the agent's replies to them, never left their browser at
            # all -- invisible to the owner and every other participant.
            current_state = pane_outputs.split(pane_state.migrate(row.state or {}))[0]
            incoming_state = pane_outputs.split(pane_state.migrate(payload.state or {}))[0]
            changed_state_keys = {
                k
                for k in set(current_state) | set(incoming_state)
                if current_state.get(k) != incoming_state.get(k)
            }
            if changed_state_keys - {SESSION_CHAT_KEY} or payload.title != row.title or payload.type != row.type:
                raise HTTPException(status_code=403, detail="You have read-only access to this session.")
        if payload.base_version is not None and payload.base_version != row.version:
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
    # Legacy keys of a ported pane are moved on the way in, so a tab still
    # running the old code can't write the old shape back (§15.4); and so are
    # outputs, into their panes' records, where a tab from before them, or an
    # IndexedDB copy, still sends them (§18.2). A pane the session no longer
    # has loses its record: ids are reused.
    state = pane_outputs.move_out(db, row, pane_state.migrate(payload.state))
    row.state = state
    pane_outputs.prune(db, row, state.get("services") or [])
    row.truncated = payload.truncated
    if member is None:
        # The owner's own view: their category, and writing to a closed
        # session is how they reopen it.
        row.category_id = payload.category_id
        row.closed_at = None
    else:
        # A member's write is their own view changing, never the owner's (or
        # any other member's) category or closed state.
        member.category_id = payload.category_id
        member.closed_at = None
    # The same ending as a write made on the server (live_store.py), so the
    # agent's writes and a browser's are versioned and announced alike --
    # and, since commit_write fans out to every participant, every other
    # reachable browser hears about an editor member's write too.
    commit_write(db, row, origin)
    return _out(db, row, member)


@router.post("/{client_id}/close", response_model=schemas.LiveSessionOut)
def close_live_session(
    client_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
    origin: Optional[str] = OriginHeader,
):
    """Puts the session away in the caller's own panel -- their own view of
    it if it's shared with them, closeable and reopenable just like an owned
    one, and never touching anyone else's view of the same session."""
    row, member = _reachable(db, current_user, client_id, lock=True)
    now = datetime.datetime.utcnow()
    if member is None:
        row.closed_at = now
        row.version = (row.version or 0) + 1
    else:
        member.closed_at = now
    # This caller's own view changing, not the shared document -- only their
    # own other tabs need to hear about it, same as an owner's close always
    # only reached their own tabs.
    notify(db, current_user.id, "close", client_id, row.version, origin)
    db.commit()
    db.refresh(row)
    if member is not None:
        db.refresh(member)
    return _out(db, row, member)


@router.get("/{client_id}", response_model=schemas.LiveSessionOut)
def get_live_session(
    client_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    """One session with its whole state. What reopening a closed session reads,
    since the closed listing deliberately leaves the state out. Reachable
    through the caller's own membership as well as their own ownership."""
    row, member = _reachable(db, current_user, client_id)
    return _out(db, row, member)


@router.delete("/{client_id}", status_code=204)
def delete_live_session(
    client_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
    origin: Optional[str] = OriginHeader,
):
    """Deletes the session outright, for everyone it was shared with too
    (SessionMember is ON DELETE CASCADE) -- the owner's alone; a member
    reaches this the same as someone with no access at all (404), and
    leaves instead (`DELETE /{client_id}/members/{their_own_user_id}`)."""
    db.delete(_owned(db, current_user, client_id))
    notify(db, current_user.id, "delete", client_id, None, origin)
    db.commit()
    return None


# ---------------------------------------------------------------- members
#
# Managing who is invited, and at what permission. Only the owner may invite,
# change a permission, or remove someone else -- there's no delegated "can
# invite" tier -- but a member may always remove *themselves* (leave), below.


def _member_out(member: models.SessionMember) -> schemas.SessionMemberOut:
    return schemas.SessionMemberOut(user_id=member.user_id, username=member.user.username, permission=member.permission,
                                    avatar_url=member.user.avatar_url)


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


@router.get("/{client_id}/participants", response_model=list[schemas.SessionParticipant])
def list_session_participants(
    client_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    """Everyone who can reach this session -- the owner and every invited
    member -- for @mentioning them in its chat. Deliberately reachable by any
    participant (`_reachable`), not owner-only like /members above: this is
    read-only and carries none of that route's management capability, and
    knowing who else is on a shared session is not the same thing as being
    able to invite or remove them. Unlike /members, the owner is included
    too, since a member @mentioning someone needs the owner's name as much
    as any other participant's."""
    row, _ = _reachable(db, current_user, client_id)
    owner = db.get(models.User, row.user_id)
    out = [schemas.SessionParticipant(user_id=row.user_id, username=owner.username, role="owner",
                                      avatar_url=owner.avatar_url)] if owner else []
    members = db.query(models.SessionMember).filter(models.SessionMember.session_id == row.id).all()
    out += [
        schemas.SessionParticipant(user_id=m.user_id, username=m.user.username, role=m.permission,
                                   avatar_url=m.user.avatar_url)
        for m in members
    ]
    return out


@router.post("/{client_id}/members", response_model=schemas.SessionMemberOut, status_code=201)
def invite_session_member(
    client_id: str,
    payload: schemas.SessionMemberCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
    origin: Optional[str] = OriginHeader,
):
    row = _owned(db, current_user, client_id)
    username = payload.username.strip()
    invitee = db.query(models.User).filter(models.User.username == username).one_or_none()
    if invitee is None:
        raise HTTPException(status_code=404, detail=f'No user named "{username}".')
    if invitee.id == current_user.id:
        raise HTTPException(status_code=400, detail="You already own this session.")
    # Open and uncategorized, at the end of the invitee's own panel -- being
    # shared with someone should show up for them like anything else newly
    # added to their workspace, not sit invisibly until they go looking.
    member = models.SessionMember(
        session_id=row.id,
        user_id=invitee.id,
        permission=payload.permission,
        position=_next_position(db, invitee.id),
    )
    db.add(member)
    # Told now, on this commit: the invitee's open browser learns of the
    # session from this, not from the owner's next edit -- which used to be
    # the first write announced to them, so it appeared only then.
    notify(db, invitee.id, "upsert", row.client_id, row.version, origin)
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
    origin: Optional[str] = OriginHeader,
):
    row = _owned(db, current_user, client_id)
    member = _member(db, row.id, user_id)
    member.permission = payload.permission
    # The session's version doesn't move (its state didn't), so an "upsert"
    # would be skipped by a browser already holding it; "access" asks it to
    # re-read the row for its role -- a viewer's browser keeps its edits to
    # itself, and one made an editor went on doing so until a reload.
    notify(db, user_id, "access", row.client_id, row.version, origin)
    db.commit()
    db.refresh(member)
    return _member_out(member)


@router.delete("/{client_id}/members/{user_id}", status_code=204)
def remove_session_member(
    client_id: str,
    user_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
    origin: Optional[str] = OriginHeader,
):
    """Removes someone from the roster -- the owner removing anyone, or a
    member leaving (removing themselves). Either way this takes them off the
    session entirely; closing (`POST /{client_id}/close`) is the reversible,
    reopenable version of merely putting it away."""
    if current_user.id == user_id:
        _, member = _reachable(db, current_user, client_id)
        if member is None:
            raise HTTPException(status_code=400, detail="You own this session; delete it instead of leaving it.")
    else:
        row = _owned(db, current_user, client_id)
        member = _member(db, row.id, user_id)
    # Gone from every browser of theirs at once, as a delete is: left in
    # their rail, it 404'd on every save until they reloaded.
    notify(db, user_id, "delete", client_id, None, origin)
    db.delete(member)
    db.commit()
    return None


@router.get("/{client_id}/outputs", response_model=dict[str, schemas.PaneOutputsOut])
def get_pane_outputs(
    client_id: str,
    pane: list[str] = Query(default=[]),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    """Some panes' outputs (all, if none is named): what a tab fetches when an
    "outputs" event says a pane it shows has a newer version (§18.2)."""
    row, _ = _reachable(db, current_user, client_id)
    return pane_outputs.read(db, row, pane or None)


@router.post("/{client_id}/outputs/{pane}/clear", response_model=schemas.PaneOutputsOut)
def clear_pane_outputs(
    client_id: str,
    pane: str,
    payload: schemas.PaneOutputsClear,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
    origin: Optional[str] = OriginHeader,
):
    """Removes outputs an input change made stale -- its manifest `resets` --
    or a results card's Clear names, for everyone looking, as the browser
    already did on screen."""
    row, member = _reachable(db, current_user, client_id)
    if member is not None and member.permission == "viewer":
        raise HTTPException(status_code=403, detail="You have read-only access to this session.")
    try:
        pane_outputs.clear(db, row, pane, payload.keys, origin)
    except pane_outputs.OutputError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    return pane_outputs.read(db, row, [pane]).get(pane, {"version": 0, "values": {}})
