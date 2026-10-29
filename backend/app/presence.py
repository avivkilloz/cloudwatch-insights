"""Who has a browser open right now, and so which sessions are being looked at
(PLATFORM_PLAN.md D51).

A session is *watched* while any of its participants -- its owner, or a member
-- has a tab whose event stream was seen recently and has the session open in
their own workspace (every open session is mounted in each of their tabs).
A long-running action (a CloudWatch query) is polled only while its session is
watched, so a query nobody is looking at doesn't keep the server calling AWS.

Each tab's event stream (`routers/live_sessions.live_session_events`) writes
its row here when it opens, touches it on every heartbeat and deletes it when
it ends. A replica that dies takes its streams with it without deleting their
rows; those age out by `seen_at`, past `FRESH_SECONDS`.
"""

import datetime
import uuid
from typing import Optional

from sqlalchemy import or_
from sqlalchemy.orm import Session

from . import models

# The event stream's heartbeat is 20 s; two missed beats and the tab counts as
# gone.
FRESH_SECONDS = 50


def _now() -> datetime.datetime:
    return datetime.datetime.utcnow()


def open_tab(db: Session, user_id: int) -> str:
    tab_id = uuid.uuid4().hex
    db.add(models.TabPresence(tab_id=tab_id, user_id=user_id, seen_at=_now()))
    db.commit()
    return tab_id


def touch(db: Session, tab_id: str, user_id: int) -> None:
    row = db.get(models.TabPresence, tab_id)
    if row is None:
        # Swept, or the row was lost: the tab is plainly still here.
        db.add(models.TabPresence(tab_id=tab_id, user_id=user_id, seen_at=_now()))
    else:
        row.seen_at = _now()
    db.commit()


def close_tab(db: Session, tab_id: str) -> None:
    db.query(models.TabPresence).filter(models.TabPresence.tab_id == tab_id).delete()
    db.commit()


def watching_users(db: Session, session_row: models.LiveSession) -> set[int]:
    """The participants who have the session open in a connected browser."""
    fresh = _now() - datetime.timedelta(seconds=FRESH_SECONDS)
    online = {
        user_id
        for (user_id,) in db.query(models.TabPresence.user_id).filter(models.TabPresence.seen_at >= fresh).distinct()
    }
    watching: set[int] = set()
    if session_row.user_id in online and session_row.closed_at is None:
        watching.add(session_row.user_id)
    members = (
        db.query(models.SessionMember)
        .filter(
            models.SessionMember.session_id == session_row.id,
            models.SessionMember.closed_at.is_(None),
            models.SessionMember.user_id.in_(online or {-1}),
        )
        .all()
    )
    watching.update(m.user_id for m in members)
    return watching


def watched(db: Session, session_row: models.LiveSession, agent_until: Optional[datetime.datetime] = None) -> bool:
    """Whether anyone is looking at the session: a participant's browser, or
    an agent turn waiting on a run in it (until `agent_until`)."""
    if agent_until is not None and agent_until > _now():
        return True
    return bool(watching_users(db, session_row))


# A tab says what it shows when that changes and every 30 s while it's open
# (D157); past this it's gone, or asleep.
SCREEN_FRESH_SECONDS = 75


def show(db: Session, user_id: int, origin: str, view: str, session_client_id: Optional[str] = None,
         build_kind: Optional[str] = None, build_target_id: Optional[str] = None, draft_id: Optional[int] = None,
         timezone: Optional[str] = None, visible: bool = True) -> None:
    """What one of the user's tabs has on screen now."""
    row = db.get(models.ScreenView, (user_id, origin))
    if row is None:
        row = models.ScreenView(user_id=user_id, origin=origin)
        db.add(row)
    row.view, row.session_client_id = view, session_client_id
    row.build_kind, row.build_target_id, row.draft_id = build_kind, build_target_id, draft_id
    row.timezone, row.visible, row.updated_at = timezone, visible, _now()
    # Tabs long gone: tidiness only, stale rows are never read.
    db.query(models.ScreenView).filter(models.ScreenView.user_id == user_id,
                                       models.ScreenView.updated_at < _now() - datetime.timedelta(days=1)).delete()
    db.commit()


def on_screen(db: Session, user_id: int) -> list[models.ScreenView]:
    """What the user's open tabs show, the one in front first: a visible tab
    before a hidden one, then the latest to say so."""
    fresh = _now() - datetime.timedelta(seconds=SCREEN_FRESH_SECONDS)
    rows = (db.query(models.ScreenView)
            .filter(models.ScreenView.user_id == user_id, models.ScreenView.updated_at >= fresh).all())
    return sorted(rows, key=lambda v: (not v.visible, -v.updated_at.timestamp()))


def sweep(db: Session) -> int:
    """Forgets tabs nobody has heard from in a long while (a replica that died
    with streams open). Only tidiness: stale rows are ignored anyway."""
    stale = _now() - datetime.timedelta(seconds=FRESH_SECONDS * 10)
    n = db.query(models.TabPresence).filter(or_(models.TabPresence.seen_at < stale)).delete()
    db.commit()
    return n
