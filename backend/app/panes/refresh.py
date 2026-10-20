"""Auto-refresh: a pane run again on a timer, once for everyone watching
(PLATFORM_PLAN.md R4, D22, §18.3).

The timer is the browser's -- it runs only while the session is on screen
and the tab is visible -- but the run is the server's: each tab asks here
when it thinks a pane is due, and the asking is coalesced under the pane's
outputs record lock. Results fresher than most of the interval, a refresh
already under way, or a background run still going all mean "nothing to
do"; otherwise this one marks the record as refreshing, runs the pane's
refresh action with the session's own stored inputs, as the caller, and
writes the result into the record, which every tab follows by its event.
Five tabs watching cause one run.

A failure is kept on the record (`refresh: {failures, error, at}`), so
every viewer sees why, and the browsers back off by it; a success clears it.

A viewer member's tab refreshes too (D62), as the viewer -- a run always acts
as whoever asked -- but only when they can reach every connection the pane's
inputs name. Otherwise the answer is "unreachable": nothing runs, nothing is
written, no failure is counted, and the dashboard waits for someone who can.
"""

import datetime
import os
from typing import Any, Optional

from fastapi import HTTPException
from sqlalchemy.orm import Session

from .. import connections, live_store, models, pane_outputs
from ..live_store import untag
from . import manifest as pane_manifest
from . import runs

# The shortest interval (D22): 10 s, and a minute for a pane whose every run
# costs money. A deployment can raise both, never lower them.
DEFAULT_FLOOR_SECONDS = 10
DEFAULT_COSTLY_FLOOR_SECONDS = 60
# Results this fresh, as a share of the interval, count as just refreshed --
# two tabs whose timers are a few seconds apart then cause one run.
FRESH_SHARE = 0.8
# A refresh marked as under way longer than this is taken as abandoned (its
# replica died) and may be started again.
STALE_REFRESH_SECONDS = 120


def floor_seconds(manifest: pane_manifest.Manifest) -> int:
    if manifest.cost == "per_run":
        return max(DEFAULT_COSTLY_FLOOR_SECONDS, int(os.environ.get("REFRESH_FLOOR_COSTLY_SECONDS") or 0))
    return max(DEFAULT_FLOOR_SECONDS, int(os.environ.get("REFRESH_FLOOR_SECONDS") or 0))


def stored_inputs(row: models.LiveSession, manifest: pane_manifest.Manifest, pane: str) -> dict[str, Any]:
    """The pane's inputs as the session holds them -- what a refresh runs
    with, whoever's tab asked."""
    state = row.state or {}
    out: dict[str, Any] = {}
    for spec in manifest.inputs:
        key = f"{pane}.in.{spec.key}"
        if key in state:
            out[spec.key] = untag(state[key])
    return out


def unreachable(db: Session, user: models.User, manifest: pane_manifest.Manifest, inputs: dict[str, Any]) -> list[str]:
    """The connections the pane's inputs name that this user can't reach --
    in a shared session, ones its owner or an editor picked."""
    reach: dict[str, set[int]] = {}
    out: list[str] = []
    for spec in manifest.inputs:
        if spec.type not in ("connection", "connections") or not spec.connection_type:
            continue
        value = inputs.get(spec.key)
        ids = value if isinstance(value, list) else [] if value in (None, "") else [value]
        if spec.connection_type not in reach:
            reach[spec.connection_type] = {t["id"] for t in connections.targets(db, user, spec.connection_type)}
        for one in ids:
            try:
                if int(one) in reach[spec.connection_type]:
                    continue
            except (TypeError, ValueError):
                pass
            out.append(str(one))
    return out


def _outcome(refreshed: bool, reason: str, record: Optional[models.PaneOutput] = None) -> dict[str, Any]:
    return {"refreshed": refreshed, "reason": reason, "version": record.version if record is not None else None}


def refresh(
    db: Session,
    user: models.User,
    row: models.LiveSession,
    member: Optional[models.SessionMember],
    manifest: pane_manifest.Manifest,
    pane: str,
    every: int,
    timezone: Optional[str],
    origin: Optional[str],
    fresh: Optional[int] = None,
) -> dict[str, Any]:
    """Runs the pane again if it's due, or says why not -- with what the
    pane now holds: the asking tab hears no event of its own write (it
    carries the tab's origin), so the outputs come back with the answer.

    `fresh` is a run on open (D77): due when the outputs are older than that
    many seconds (or there are none), whatever the interval -- so switching
    back to a session, or five members arriving together, runs it once."""
    outcome = _refresh(db, user, row, member, manifest, pane, every, timezone, origin, fresh)
    db.expire_all()
    return {**outcome, "outputs": pane_outputs.read(db, row, [pane]).get(pane)}


def _refresh(
    db: Session,
    user: models.User,
    row: models.LiveSession,
    member: Optional[models.SessionMember],
    manifest: pane_manifest.Manifest,
    pane: str,
    every: int,
    timezone: Optional[str],
    origin: Optional[str],
    fresh: Optional[int] = None,
) -> dict[str, Any]:
    from ..routers import panes as panes_router  # it imports this module
    from . import handlers as pane_handlers

    # The main action for the pane's inputs as stored (D119: IoT's rules mode
    # refreshes its rules, not its things).
    action = manifest.refresh_action(stored_inputs(row, manifest, pane))
    if action is None:
        raise HTTPException(status_code=400, detail=f"{manifest.label} panes don't refresh by themselves.")
    if member is not None and member.permission == "viewer" and unreachable(db, user, manifest, stored_inputs(row, manifest, pane)):
        return _outcome(False, "unreachable", pane_outputs._record(db, row, pane))
    every = max(int(every), floor_seconds(manifest))
    if fresh is not None:
        # A pane whose required inputs aren't set has nothing to run on open:
        # not a failure, nothing to back off from.
        inputs = {**{i.key: i.default for i in manifest.inputs if i.default is not None},
                  **stored_inputs(row, manifest, pane)}
        if pane_handlers.missing(action.requires, inputs):
            return _outcome(False, "not_ready", pane_outputs._record(db, row, pane))

    # Decided under the record's lock, and the decision committed, before the
    # run: another tab asking a moment later sees it and stands back.
    record = pane_outputs._locked(db, row, pane)
    values = record.data or {}
    now = datetime.datetime.utcnow()
    ran_at = values.get("ranAt")
    window_ms = max(int(fresh), floor_seconds(manifest)) * 1000 if fresh is not None else every * 1000 * FRESH_SHARE
    if isinstance(ran_at, (int, float)) and live_store.now_ms() - ran_at < window_ms:
        db.commit()
        return _outcome(False, "fresh", record)
    if record.refreshing_at is not None and now - record.refreshing_at < datetime.timedelta(
        seconds=max(every, STALE_REFRESH_SECONDS)
    ):
        db.commit()
        return _outcome(False, "refreshing", record)
    if action.poll is not None and (
        db.query(models.PaneRun)
        .filter(models.PaneRun.session_id == row.id, models.PaneRun.pane_id == pane, models.PaneRun.status == runs.RUNNING)
        .first()
    ):
        db.commit()
        return _outcome(False, "running", record)
    record.refreshing_at = now
    db.commit()

    inputs = stored_inputs(row, manifest, pane)
    try:
        if action.poll is not None:
            runs.start(
                db, user, row, member, manifest, action, pane, {**inputs, **({"_tz": timezone} if timezone else {})}, refreshing=True
            )
            pane_outputs.clear(db, row, pane, ["refresh"], origin)
            written = None
        else:
            if action.request is not None:
                result = panes_router.run_request(db, user, manifest, action, inputs)
            else:
                result = panes_router.run_handler(db, user, manifest, action, {**inputs, **({"_tz": timezone} if timezone else {})})

            def store(values: dict) -> None:
                panes_router.apply_outputs(values, manifest, action, result)
                values.pop("refresh", None)

            written, _ = pane_outputs.write(db, row, pane, store, origin)
    except (HTTPException, runs.RunError, pane_outputs.OutputError) as e:
        db.rollback()
        message = str(getattr(e, "detail", e))

        def failed(values: dict) -> None:
            previous = values.get("refresh") if isinstance(values.get("refresh"), dict) else {}
            values["refresh"] = {
                "failures": int(previous.get("failures") or 0) + 1,
                "error": message[:500],
                "at": live_store.now_ms(),
            }

        try:
            written, _ = pane_outputs.write(db, row, pane, failed, origin)
        except pane_outputs.OutputError:
            written = None
        return {**_outcome(False, "failed", written), "error": message}
    finally:
        _done(db, row, pane)
    return _outcome(True, "refreshed", written)


def _done(db: Session, row: models.LiveSession, pane: str) -> None:
    record = pane_outputs._record(db, row, pane, lock=True)
    if record is not None:
        record.refreshing_at = None
    db.commit()
