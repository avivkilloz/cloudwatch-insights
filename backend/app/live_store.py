"""Writing a live session from the server.

The browser writes its sessions through PUT /api/live-sessions/{id}; the
platform agent writes them from here. Both end in `commit_write`, so every
write, whoever makes it, bumps the version under a row lock and is announced
on commit -- which is what lets a browser with the session open merge the
change into its panes instead of overwriting it with its next save (CLAUDE.md,
"Sync is two-way"). Nothing should write `live_sessions` any other way.

The state bag is the browser's own format, which this module has to match
exactly because the browser decodes whatever it gets:

- Keys are `"<paneId>.<key>"` for a pane's values and bare for the session's
  own (`services`, `paneTypes`, `paneTitles`, `layout`, `activePane`,
  `minimized`, `dashboardRects`).
- A `Set` is stored tagged, `{"__cwiSet": [...]}` (sessions/storage.ts). A
  plain list where the browser expects a Set takes the page down on its first
  `.has()`, so `tag_set` is the only way a set goes in.
"""

import copy
import datetime
import json
import secrets
import time
from typing import Any, Callable, Optional, TypeVar

from sqlalchemy import func
from sqlalchemy.orm import Session

from . import models
from .live_events import notify

# Every session is an Aggregator (SESSION_TYPE in SessionContext.tsx).
SESSION_TYPE = "aggregator"

# The database's ceiling on one session's state (the PUT refuses past it).
MAX_STATE_BYTES = 8 * 1024 * 1024

# The browser's own ceiling, lower than the database's: a session over it has
# its results dropped the next time the browser saves it (capSession in
# sessions/storage.ts). So anything the server writes has to leave room under
# *this* one, or the results it just wrote vanish the moment the user touches
# the session.
BROWSER_STATE_BYTES = 4 * 1024 * 1024

SET_TAG = "__cwiSet"

T = TypeVar("T")


class StoreError(Exception):
    """A change that can't be made, in a sentence the caller can pass on."""


def tag_set(values) -> dict:
    return {SET_TAG: list(values)}


def untag(value: Any) -> Any:
    """The state with tagged Sets turned back into plain lists: how a caller
    that isn't the browser (the agent) should read it."""
    if isinstance(value, dict):
        if set(value) == {SET_TAG} and isinstance(value[SET_TAG], list):
            return [untag(v) for v in value[SET_TAG]]
        return {k: untag(v) for k, v in value.items()}
    if isinstance(value, list):
        return [untag(v) for v in value]
    return value


def state_bytes(state: dict) -> int:
    return len(json.dumps(state))


def next_title(label: str, taken: list[str]) -> str:
    """"CloudWatch", then "CloudWatch 2" -- the browser's own rule
    (sessions/naming.ts), so a session or pane the agent makes is named the
    way one made by hand would be."""
    if label not in taken:
        return label
    n = 2
    while f"{label} {n}" in taken:
        n += 1
    return f"{label} {n}"


def new_client_id() -> str:
    # The browser's are "s" + base36 time + a counter; these start with "a" so
    # a row's origin is visible at a glance, and end random rather than
    # counted because several backend replicas mint them.
    return "a" + _base36(int(time.time() * 1000)) + secrets.token_hex(3)


def _base36(n: int) -> str:
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = ""
    while n:
        n, r = divmod(n, 36)
        out = digits[r] + out
    return out or "0"


def _participants(db: Session, row: models.LiveSession) -> list[int]:
    """Everyone an "upsert" of this session's content is announced to: its
    owner, and every invited SessionMember -- true live collaboration, the
    same as a second tab of your own already got before sharing existed.
    A session with no members (almost all of them) costs one extra, cheap,
    indexed query and returns just the owner, same as before this existed."""
    member_ids = [
        uid for (uid,) in db.query(models.SessionMember.user_id).filter(models.SessionMember.session_id == row.id)
    ]
    return [row.user_id, *member_ids]


def commit_write(db: Session, row: models.LiveSession, origin: Optional[str]) -> None:
    """The end of every write to a session: a new version, announced on
    commit to every open tab that can reach it -- the owner's and every
    member's. The row must already be locked (or new)."""
    row.version = (row.version or 0) + 1
    db.flush()
    for user_id in _participants(db, row):
        notify(db, user_id, "upsert", row.client_id, row.version, origin)
    db.commit()
    db.refresh(row)


def get(db: Session, user_id: int, client_id: str, lock: bool = False) -> Optional[models.LiveSession]:
    """Strictly the caller's own row. `reachable` is the membership-aware
    version `mutate` and the platform agent's reads use; this stays
    owner-only for the one caller that still wants exactly that (a test
    helper reading a row back by its known owner)."""
    query = db.query(models.LiveSession).filter(
        models.LiveSession.user_id == user_id, models.LiveSession.client_id == client_id
    )
    return (query.with_for_update() if lock else query).one_or_none()


def reachable(
    db: Session, user_id: int, client_id: str, lock: bool = False
) -> tuple[Optional[models.LiveSession], Optional[models.SessionMember]]:
    """Like `get`, but also recognizes the caller's own membership -- for a
    read that should work for an invited member too (today, only the agent
    chat relay's "which session is this about" check) without granting them
    anything `get` doesn't: no row-level field of theirs is touched here.
    `(None, None)` if the caller is neither the owner nor a member."""
    row = get(db, user_id, client_id, lock)
    if row is not None:
        return row, None
    member_query = (
        db.query(models.SessionMember)
        .join(models.LiveSession, models.SessionMember.session_id == models.LiveSession.id)
        .filter(models.SessionMember.user_id == user_id, models.LiveSession.client_id == client_id)
    )
    member = (member_query.with_for_update(of=models.SessionMember) if lock else member_query).first()
    if member is None:
        return None, None
    row_query = db.query(models.LiveSession).filter(models.LiveSession.id == member.session_id)
    row = (row_query.with_for_update() if lock else row_query).one()
    return row, member


def open_sessions(db: Session, user_id: int) -> list[models.LiveSession]:
    return (
        db.query(models.LiveSession)
        .filter(models.LiveSession.user_id == user_id, models.LiveSession.closed_at.is_(None))
        .order_by(models.LiveSession.position, models.LiveSession.id)
        .all()
    )


def reachable_sessions(db: Session, user_id: int) -> list[models.LiveSession]:
    """Every open session this user can reach: their own, and every one
    shared with them that they haven't closed themselves -- in their own
    panel order (a shared row sorts by *this* user's own position, on their
    SessionMember, not the owner's `row.position`). Mirrors
    `routers/live_sessions.py`'s own `_open_pairs`, for `list_sessions`.
    A caller wanting a shared row's category/closed state for *this* user
    still goes through `_describe_session`, which resolves that itself."""
    owned = [(row, row.position) for row in open_sessions(db, user_id)]
    shared = [
        (member.session, member.position)
        for member in db.query(models.SessionMember).filter(
            models.SessionMember.user_id == user_id, models.SessionMember.closed_at.is_(None)
        )
    ]
    pairs = owned + shared
    pairs.sort(key=lambda pair: (pair[1], pair[0].id))
    return [row for row, _ in pairs]


def create(db: Session, user_id: int, title: str, state: dict, origin: Optional[str]) -> models.LiveSession:
    """A new open session at the end of the owner's panel, named so it doesn't
    clash with one already open."""
    _check_size(state)
    taken = [s.title for s in open_sessions(db, user_id)]
    last = (
        db.query(func.max(models.LiveSession.position)).filter(models.LiveSession.user_id == user_id).scalar()
    )
    row = models.LiveSession(
        user_id=user_id,
        client_id=new_client_id(),
        type=SESSION_TYPE,
        title=next_title(title.strip() or "Session", taken),
        position=(last + 1) if last is not None else 0,
        state=state,
        truncated=False,
        version=0,
    )
    db.add(row)
    commit_write(db, row, origin)
    return row


def mutate(
    db: Session,
    user_id: int,
    client_id: str,
    change: Callable[[dict, models.LiveSession, Optional[models.SessionMember]], T],
    origin: Optional[str],
) -> tuple[models.LiveSession, T]:
    """Read-modify-write one session under its row lock, so a browser save
    landing at the same moment is either before this (and this change is made
    on top of it) or after (and is refused as stale, and merged). `change`
    gets a copy of the state to edit in place, the row (for its title, which
    is shared), and the caller's own `SessionMember` if they're not its
    owner -- `None` for the owner; whatever `change` returns is handed back.

    Reachable through membership as well as ownership, same as the
    browser's own PUT (`routers/live_sessions.py`): a viewer's mutate is
    refused outright (they may still read, through `reachable`/`get_context`/
    `get_session`/`list_sessions`), and an editor's write reopens *their
    own* view of a closed session (`member.closed_at`), never the owner's or
    another member's -- the owner's own mutate still reopens `row.closed_at`
    exactly as before. `change` itself has to route any *other* row-level
    field it sets (as `set_category` does for `row.category_id`) the same
    way, since state is the one thing here that's genuinely shared."""
    row, member = reachable(db, user_id, client_id, lock=True)
    if row is None:
        db.rollback()
        raise StoreError(f"There is no session with id '{client_id}'. List the sessions to find the right one.")
    if member is not None and member.permission == "viewer":
        db.rollback()
        raise StoreError("You have read-only access to this session.")
    state = copy.deepcopy(row.state or {})
    try:
        result = change(state, row, member)
        _check_size(state)
    except Exception:
        db.rollback()
        raise
    # A new object, not the edited original: SQLAlchemy only notices a JSON
    # column changed when it is assigned.
    row.state = state
    if member is None:
        row.closed_at = None
    else:
        member.closed_at = None
    commit_write(db, row, origin)
    return row, result


def _check_size(state: dict) -> None:
    size = state_bytes(state)
    if size > BROWSER_STATE_BYTES:
        raise StoreError(
            f"That would make the session {size} bytes, over the {BROWSER_STATE_BYTES}-byte limit a session can "
            "hold. Ask for fewer results."
        )


def now_ms() -> int:
    return int(datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000)
