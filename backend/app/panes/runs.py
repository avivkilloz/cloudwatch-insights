"""Long-running pane actions, polled by the server while someone is looking
(PLATFORM_PLAN.md §16.9.1, D51).

A CloudWatch Logs Insights query runs in AWS for seconds to minutes. Its
pane used to poll it from the browser; now the server does, so every tab and
member of a shared session sees one stream of results, a reload carries on,
and anyone who can edit the session -- or the agent -- can Stop it.

- **Start** (`start`) runs the action's handler as the caller (it returns the
  handles to poll and any target that failed at once), records a `PaneRun`,
  writes the pane's `out.run` and first results, and hands the run to a task
  on this replica.
- **The task** (`drive`, one `tick` at a time) polls every `POLL_SECONDS`
  while the session is watched (`presence.watched`): the poll handler runs as
  whoever started the run, and the results are written into the session
  through `live_store.mutate` -- versioned and announced, so open panes follow
  them as they follow the agent -- only when they changed. Unwatched, it
  checks every `IDLE_SECONDS` without calling AWS; unwatched for
  `UNWATCHED_LIMIT_SECONDS`, it stops the queries and ends.
- **Stop** (`stop`) stops the queries, as their starter, and marks the run
  stopped; a task on any replica sees that on its next tick and ends.
- **Replicas.** A task heartbeats its run. `sweep` (every replica, every
  `SWEEP_SECONDS`) claims a running run whose heartbeat is older than
  `STALE_SECONDS`, so a redeploy mid-query carries on elsewhere.

Writes go through `live_store.mutate(..., reopen=False)`: results arriving in
a session someone closed must not put it back in their rail.
"""

import asyncio
import datetime
import hashlib
import json
import logging
import time
import uuid
from dataclasses import dataclass
from typing import Any, Optional

from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session

from .. import live_store, models, pane_outputs, presence
from ..db import SessionLocal
from . import handlers
from . import manifest as pane_manifest

logger = logging.getLogger(__name__)

REPLICA = uuid.uuid4().hex[:12]
POLL_SECONDS = 2.0
IDLE_SECONDS = 10.0
UNWATCHED_LIMIT_SECONDS = 600
STALE_SECONDS = 30
SWEEP_SECONDS = 10.0
ORIGIN = "run"

RUNNING = "running"
DONE = "done"
STOPPED = "stopped"
FAILED = "failed"


def _now() -> datetime.datetime:
    return datetime.datetime.utcnow()


def _ms() -> int:
    return int(time.time() * 1000)


def _fingerprint(value: Any) -> str:
    return hashlib.sha1(json.dumps(value, sort_keys=True, default=str).encode()).hexdigest()


class RunError(Exception):
    """A start or stop that can't be done, in a sentence the user can act on."""


@dataclass
class Tick:
    """What one step of a run decided: stop driving it, or come back later."""

    finished: bool
    wait: float = POLL_SECONDS


# ---------------------------------------------------------------- the session's copy


def _write(
    db: Session,
    user_id: int,
    row: models.LiveSession,
    pane_id: str,
    outputs: dict[str, Any],
    fresh: bool = False,
    resets: tuple[str, ...] = (),
    append: Optional[dict[str, int]] = None,
) -> None:
    """Outputs into the pane's own record (D21, §18.2), cut down to fit as
    every server-side write is. A fresh run also stamps ranAt and a new
    resultsVersion (which clears the row selection) and clears its resets --
    `out.` ones in the record, `view.` ones (an expanded row) in the session.
    An `append` output's new items go in front of what the pane holds, kept
    to its cap (a stream's messages, D54). The session's own version doesn't
    move: a 1-second poll no longer resends the whole session to every tab."""
    view_resets = [r for r in resets if r.startswith("view.")] if fresh else []
    if view_resets:
        manifest = pane_manifest.get(_pane_type(row, pane_id))
        defaults = {v.key: v.default for v in manifest.views} if manifest else {}

        def reset_views(state: dict, _row: models.LiveSession, _member: Optional[models.SessionMember]) -> None:
            for ref in view_resets:
                state[f"{pane_id}.{ref}"] = defaults.get(ref.split(".", 1)[1])

        live_store.mutate(db, user_id, row.client_id, reset_views, ORIGIN, reopen=False)

    def change(values: dict) -> None:
        writes = json.loads(json.dumps(outputs, default=str))
        if fresh:
            values["ranAt"] = _ms()
            values["resultsVersion"] = int(values.get("resultsVersion") or 0) + 1
            for ref in resets:
                if ref.startswith("out."):
                    values.pop(ref.split(".", 1)[1], None)
        for key, cap in (append or {}).items():
            if key in writes:
                held = values.get(key)
                writes[key] = (list(writes[key] or []) + (held if isinstance(held, list) else []))[:cap]
        values.update(writes)
        try:
            trimmed = pane_outputs.fit(values)
        except pane_outputs.OutputError as e:
            raise RunError(str(e)) from None
        if trimmed and isinstance(values.get("run"), dict):
            # Said on the run, so the pane and the agent can own up to it.
            values["run"]["trimmed"] = True

    try:
        pane_outputs.write(db, row, pane_id, change, ORIGIN)
    except pane_outputs.OutputError as e:
        raise RunError("The pane was closed while it was running.") from e


def _pane_type(row: models.LiveSession, pane_id: str) -> str:
    return ((row.state or {}).get("paneTypes") or {}).get(pane_id) or pane_id.split("~")[0]


def _run_out(run: models.PaneRun, extra: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    return {
        "id": run.id,
        "status": run.status,
        "startedAt": int(run.started_at.replace(tzinfo=datetime.timezone.utc).timestamp() * 1000),
        "by": run.user_id,
        **(extra or {}),
    }


# ---------------------------------------------------------------- start / stop


def start(
    db: Session,
    user: models.User,
    row: models.LiveSession,
    member: Optional[models.SessionMember],
    manifest: pane_manifest.Manifest,
    action: pane_manifest.ManifestAction,
    pane_id: str,
    inputs: dict[str, Any],
    agent_seconds: float = 0,
    keep: bool = False,
    refreshing: bool = False,
) -> models.PaneRun:
    """Starts the action's queries as `user` and the run that polls them. A
    run already going in the pane is stopped first: a second Run replaces the
    first, as it always did. `keep` is a restart (`restart_on`: its topics
    changed): what the run had shown stays, its resets aren't applied. A
    viewer may start one only as a refresh (D62), which refresh.py lets
    through once it has checked they can reach every connection it uses."""
    if member is not None and member.permission == "viewer" and not refreshing:
        raise RunError("You have read-only access to this session, so you can't run its panes.")
    if action.max_running:
        going = (
            db.query(models.PaneRun)
            .filter(
                models.PaneRun.user_id == user.id,
                models.PaneRun.pane_type == manifest.id,
                models.PaneRun.action == action.id,
                models.PaneRun.status == RUNNING,
                # This pane's own run is about to be replaced, so it doesn't count.
                ~((models.PaneRun.session_id == row.id) & (models.PaneRun.pane_id == pane_id)),
            )
            .count()
        )
        if going >= action.max_running:
            raise RunError(
                f"You already have {going} {manifest.label} runs going, the most one person may have: "
                "stop one first."
            )
    for previous in (
        db.query(models.PaneRun)
        .filter(models.PaneRun.session_id == row.id, models.PaneRun.pane_id == pane_id, models.PaneRun.status == RUNNING)
        .all()
    ):
        _stop_queries(db, manifest, action, previous)
        previous.status = STOPPED
    db.commit()
    from ..routers import panes as panes_router  # the router imports this module

    started = panes_router.run_handler(db, user, manifest, action, inputs)
    handles = started.pop("handles", [])
    run = models.PaneRun(
        id=uuid.uuid4().hex,
        session_id=row.id,
        pane_id=pane_id,
        pane_type=manifest.id,
        action=action.id,
        user_id=user.id,
        status=RUNNING if any(_live(h) for h in handles) else DONE,
        handles=handles,
        replica=REPLICA,
        heartbeat_at=_now(),
        agent_until=_now() + datetime.timedelta(seconds=agent_seconds) if agent_seconds else None,
    )
    db.add(run)
    db.commit()
    _write(
        db,
        user.id,
        row,
        pane_id,
        {**started, "run": _run_out(run)},
        fresh=not keep,
        resets=() if keep else tuple(r for r in action.resets if not r.startswith("in.")),
    )
    if run.status == RUNNING:
        manager.spawn(run.id)
    return run


def _live(handle: dict[str, Any]) -> bool:
    """Whether a handle is something still to poll: one that didn't fail to
    start (a CloudWatch query with no id did; an MQTT connection has no
    query id at all)."""
    if handle.get("error"):
        return False
    return bool(handle.get("query_id")) if "query_id" in handle else True


def _stop_queries(
    db: Session, manifest: pane_manifest.Manifest, action: pane_manifest.ManifestAction, run: models.PaneRun
) -> dict[str, Any]:
    """Stops what the run started, as its starter, and returns the outputs
    the stop handler says the pane should now show (MQTT clears its
    "Connected to ..." line)."""
    starter = db.get(models.User, run.user_id)
    handler = handlers.ACTIONS.get(action.poll.stop) if action.poll else None
    if starter is None or handler is None:
        return {}
    try:
        return handler(db, starter, {"handles": run.handles}, None) or {}
    except Exception:  # noqa: BLE001 - stopping is best-effort, as it always was
        logger.warning("Stopping run %s failed", run.id, exc_info=True)
        return {}


def stop(db: Session, user: models.User, row: models.LiveSession, member: Optional[models.SessionMember], pane_id: str) -> bool:
    """Stops the pane's running run, if it has one. Anyone who can edit the
    session may: the queries are stopped as whoever started them (stopping
    reads nothing), and the pane says who stopped it. False if none ran."""
    if member is not None and member.permission == "viewer":
        raise RunError("You have read-only access to this session, so you can't stop its runs.")
    run = (
        db.query(models.PaneRun)
        .filter(models.PaneRun.session_id == row.id, models.PaneRun.pane_id == pane_id, models.PaneRun.status == RUNNING)
        .with_for_update()
        .first()
    )
    if run is None:
        db.rollback()
        return False
    manifest = pane_manifest.get(run.pane_type)
    action = next((a for a in manifest.actions if a.id == run.action), None) if manifest else None
    shown = _stop_queries(db, manifest, action, run) if manifest and action else {}
    run.status = STOPPED
    db.commit()
    _write(db, user.id, row, pane_id, {**shown, "run": _run_out(run, {"stoppedBy": user.username})})
    return True


# ---------------------------------------------------------------- driving a run


def tick(run_id: str) -> Tick:
    """One step of a run: heartbeat, then poll if anyone is looking. Its own
    database session, as a background task's must be."""
    with SessionLocal() as db:
        run = db.get(models.PaneRun, run_id)
        if run is not None and run.status == STOPPED and run.replica == REPLICA:
            # Stopped by a request another replica served: what this one holds
            # open for it (an MQTT connection) is this one's to close.
            manifest = pane_manifest.get(run.pane_type)
            action = next((a for a in manifest.actions if a.id == run.action), None) if manifest else None
            if manifest and action:
                _stop_queries(db, manifest, action, run)
            return Tick(finished=True)
        if run is None or run.status != RUNNING or run.replica != REPLICA:
            return Tick(finished=True)
        run.heartbeat_at = _now()
        row = db.get(models.LiveSession, run.session_id)
        manifest = pane_manifest.get(run.pane_type)
        action = next((a for a in manifest.actions if a.id == run.action), None) if manifest else None
        starter = db.get(models.User, run.user_id)
        if row is None or action is None or action.poll is None or starter is None:
            run.status = FAILED
            db.commit()
            return Tick(finished=True)
        if not presence.watched(db, row, run.agent_until):
            run.unwatched_since = run.unwatched_since or _now()
            limit = min(action.poll.unwatched_stop, UNWATCHED_LIMIT_SECONDS)
            if (_now() - run.unwatched_since).total_seconds() < limit:
                db.commit()
                return Tick(finished=False, wait=IDLE_SECONDS)
            # Nobody came back: stop paying for a scan no one will read.
            shown = _stop_queries(db, manifest, action, run)
            run.status = STOPPED
            db.commit()
            _safe_write(db, starter.id, row, run, {**shown, "run": _run_out(run, {"note": "Stopped: no one had the session open."})})
            return Tick(finished=True)
        run.unwatched_since = None
        db.commit()
        poll = handlers.ACTIONS[action.poll.handler]
        try:
            polled = poll(db, starter, {"handles": run.handles}, None)
        except HTTPException as e:
            run.status = FAILED
            db.commit()
            _safe_write(db, starter.id, row, run, {"run": _run_out(run, {"error": str(e.detail)})})
            return Tick(finished=True)
        done = bool(polled.pop("done", False))
        # Nothing new for an appended output is nothing to write (a quiet
        # topic would otherwise announce a change to every tab each second).
        for key in action.poll.append:
            if key in polled and not polled[key]:
                del polled[key]
        db.refresh(run)
        if run.status != RUNNING:  # stopped while we polled
            return Tick(finished=True)
        if done:
            run.status = DONE
            db.commit()
        state_out = pane_outputs.values_of(db, row, run.pane_id).get("run") or {}
        polled_at = _ms()
        outputs = {**polled, "run": _run_out(run, {"polledAt": polled_at})}
        # Written only when something changed: an unchanged poll every 2 s
        # would announce a "change" to every open tab for nothing.
        last = state_out.get("fingerprint")
        mark = _fingerprint(polled)
        if done or (polled and mark != last):
            outputs["run"]["fingerprint"] = mark
            _safe_write(db, starter.id, row, run, outputs, append=action.poll.append)
        return Tick(finished=done, wait=action.poll.every)


def _safe_write(
    db: Session,
    user_id: int,
    row: models.LiveSession,
    run: models.PaneRun,
    outputs: dict[str, Any],
    append: Optional[dict[str, int]] = None,
) -> None:
    try:
        _write(db, user_id, row, run.pane_id, outputs, append=append)
    except (RunError, live_store.StoreError) as e:
        # The pane was closed, or its starter lost access: nothing to show it in.
        logger.info("Run %s can't write its results: %s", run.id, e)
        db.rollback()
        fresh = db.get(models.PaneRun, run.id)
        if fresh is not None and fresh.status == RUNNING:
            fresh.status = FAILED
            db.commit()


class Manager:
    """This replica's driving tasks, and its sweeper. Needs the app's event
    loop (set at startup): a run started without one -- a test, a script --
    is driven by calling `tick` directly, or picked up by a replica's sweep."""

    def __init__(self) -> None:
        self.loop: Optional[asyncio.AbstractEventLoop] = None
        self._tasks: dict[str, asyncio.Future] = {}
        self._sweeper: Optional[asyncio.Task] = None

    def spawn(self, run_id: str) -> None:
        if self.loop is None or run_id in self._tasks:
            return
        future = asyncio.run_coroutine_threadsafe(self.drive(run_id), self.loop)
        self._tasks[run_id] = future
        future.add_done_callback(lambda _f: self._tasks.pop(run_id, None))

    async def drive(self, run_id: str) -> None:
        while True:
            try:
                step = await asyncio.to_thread(tick, run_id)
            except Exception:  # noqa: BLE001 - a run must never take the loop down
                logger.exception("Run %s failed to poll", run_id)
                step = Tick(finished=False, wait=IDLE_SECONDS)
            if step.finished:
                return
            await asyncio.sleep(step.wait)

    async def sweep_forever(self) -> None:
        while True:
            try:
                for run_id in await asyncio.to_thread(claim_stale):
                    self.spawn(run_id)
                await asyncio.to_thread(_sweep_presence)
            except Exception:  # noqa: BLE001
                logger.exception("Sweeping runs failed")
            await asyncio.sleep(SWEEP_SECONDS)

    def start(self) -> None:
        self.loop = asyncio.get_running_loop()
        self._sweeper = self.loop.create_task(self.sweep_forever())

    async def stop(self) -> None:
        if self._sweeper:
            self._sweeper.cancel()
        for future in list(self._tasks.values()):
            future.cancel()
        self._tasks.clear()
        self.loop = None
        # Connections this replica held for its runs (MQTT) close with it; a
        # replica that claims the runs reconnects.
        from .. import mqtt_client

        mqtt_client.close_all()


manager = Manager()


def claim_stale() -> list[str]:
    """Runs a dead (or slow) replica held, taken over by this one: one
    conditional update, so two replicas sweeping at once can't both take one."""
    with SessionLocal() as db:
        rows = db.execute(
            text(
                "UPDATE pane_runs SET replica = :me, heartbeat_at = now() at time zone 'utc' "
                "WHERE id IN (SELECT id FROM pane_runs WHERE status = 'running' AND "
                "(heartbeat_at IS NULL OR heartbeat_at < (now() at time zone 'utc') - make_interval(secs => :stale)) "
                "FOR UPDATE SKIP LOCKED) RETURNING id"
            ),
            {"me": REPLICA, "stale": STALE_SECONDS},
        ).fetchall()
        db.commit()
        return [r[0] for r in rows]


def _sweep_presence() -> None:
    with SessionLocal() as db:
        presence.sweep(db)
