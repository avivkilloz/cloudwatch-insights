"""Telling a user's open browsers that one of their sessions changed.

Until now the browser owned the workspace and the server only stored it, so
nothing ever needed to reach a browser unasked. That stops being true the
moment something other than the browser you're looking at can change a
session: another tab, another machine, or -- the reason this exists -- the
platform agent acting on the server. So every write to a live session is
announced, and each browser holding an event stream open hears about the
ones that are its user's.

Announcements go through Postgres (NOTIFY on write, LISTEN here), not an
in-process broadcast: the backend runs several replicas behind one Service,
and a browser's stream is held by whichever replica it happened to reach,
not necessarily the one that handled the write. NOTIFY issued inside the
writing transaction is delivered on commit and dropped on rollback, which is
exactly "announce what actually happened".

An event carries only what changed and who changed it -- never session
state. A browser that cares fetches the row through the normal, auth-checked
GET, so this channel can't leak one user's sessions to another even in
principle, and a NOTIFY payload stays far under Postgres's 8000-byte limit.
"""

import asyncio
import json
import logging
import select
import threading
from dataclasses import dataclass
from typing import Optional

import psycopg2
from sqlalchemy import text
from sqlalchemy.orm import Session

from .db import engine

logger = logging.getLogger(__name__)

CHANNEL = "live_sessions"


# Postgres refuses a NOTIFY payload of 8000 bytes or more. A reorder's id list
# is the one thing that could grow toward that; past this it's left out and
# listeners re-read the list instead.
MAX_PAYLOAD_BYTES = 7000


def notify(
    db: Session,
    user_id: int,
    kind: str,
    client_id: Optional[str],
    version: Optional[int],
    origin: Optional[str],
    order: Optional[list[str]] = None,
) -> None:
    """Queue an announcement on the caller's transaction; it goes out when the
    caller commits. `origin` is the writer's own id (a browser tab's, or
    "agent"), so a writer can ignore the echo of its own change. `order` is a
    reorder's new id order -- ids, not state, so it's safe to broadcast."""
    event = {"user_id": user_id, "kind": kind, "client_id": client_id, "version": version, "origin": origin}
    if order is not None:
        event["order"] = order
    payload = json.dumps(event)
    if len(payload.encode()) > MAX_PAYLOAD_BYTES:
        event.pop("order", None)
        payload = json.dumps(event)
    db.execute(text("SELECT pg_notify(:channel, :payload)"), {"channel": CHANNEL, "payload": payload})


@dataclass(eq=False)
class _Subscriber:
    user_id: int
    queue: "asyncio.Queue[dict]"
    loop: asyncio.AbstractEventLoop


class _Listener:
    """One LISTEN connection per process, fanning events out to the event
    streams open on it. Started on the first subscription rather than at
    import, so a process that never serves a stream (a test run, a one-off
    script) never opens it."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._subscribers: set[_Subscriber] = set()
        self._thread: Optional[threading.Thread] = None

    def subscribe(self, user_id: int) -> _Subscriber:
        sub = _Subscriber(user_id=user_id, queue=asyncio.Queue(), loop=asyncio.get_running_loop())
        with self._lock:
            self._subscribers.add(sub)
            if self._thread is None or not self._thread.is_alive():
                self._thread = threading.Thread(target=self._run, name="live-sessions-listen", daemon=True)
                self._thread.start()
        return sub

    def unsubscribe(self, sub: _Subscriber) -> None:
        with self._lock:
            self._subscribers.discard(sub)

    def _dispatch(self, event: dict) -> None:
        with self._lock:
            targets = [s for s in self._subscribers if s.user_id == event.get("user_id")]
        for sub in targets:
            # The stream's own event loop owns its queue; this thread doesn't.
            sub.loop.call_soon_threadsafe(sub.queue.put_nowait, event)

    def _run(self) -> None:
        # Reconnects rather than dying: a database restart or failover would
        # otherwise leave every stream on this replica silently deaf until the
        # process restarted. Streams keep their heartbeats in the meantime and
        # browsers re-fetch on reconnect, so a gap costs staleness, not data.
        backoff = 1.0
        while True:
            try:
                conn = psycopg2.connect(engine.url.render_as_string(hide_password=False).replace("+psycopg2", ""))
                conn.set_isolation_level(psycopg2.extensions.ISOLATION_LEVEL_AUTOCOMMIT)
                with conn.cursor() as cur:
                    cur.execute(f"LISTEN {CHANNEL};")
                backoff = 1.0
                while True:
                    if select.select([conn], [], [], 30) == ([], [], []):
                        continue
                    conn.poll()
                    while conn.notifies:
                        note = conn.notifies.pop(0)
                        try:
                            self._dispatch(json.loads(note.payload))
                        except ValueError:
                            logger.warning("Ignoring a malformed %s notification", CHANNEL)
            except Exception:  # noqa: BLE001 -- anything here means "reconnect"
                logger.exception("Lost the %s listener connection; reconnecting in %.0fs", CHANNEL, backoff)
                threading.Event().wait(backoff)
                backoff = min(backoff * 2, 30.0)


listener = _Listener()
