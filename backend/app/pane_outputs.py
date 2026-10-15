"""A pane's outputs, kept apart from its session's state (PLATFORM_PLAN.md
D21, §18.2).

A session's state is what people edit -- inputs, views, the layout, the
chat -- and the browser saves it whole. A pane's outputs are what runs
write. Kept in the state (`<pane>.out.<key>`), every write of one -- a
1-second MQTT poll, a Load more, an auto-refresh -- resent the whole session
to every tab that had it open, moved its version under whoever was typing a
query (their save became a 409 to merge), and past 4 MiB the browser dropped
every pane's results at once.

So each pane's outputs are one record (`models.PaneOutput`) with a version of
its own, written only here, by the server: the action endpoint, background
runs and the agent all come through `write`. A write is announced as
`{kind: "outputs", client_id, pane, version}`; a tab fetches that one pane's
outputs, and the session's own version doesn't move.

Outputs left in a session's state -- a row from before this, an old tab's
PUT, a browser's IndexedDB copy -- are moved into a record when the pane has
none (`move_out`) and dropped when it has one, which is newer: on every write
of the state, with no marker, the way v2 keys are migrated. Reads (`read`)
show them meanwhile.
"""

import copy
import datetime
import json
from typing import Any, Callable, Iterable, Optional, TypeVar

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from . import models
from .live_events import notify

T = TypeVar("T")

# What one pane's outputs may hold: the whole session's old budget, now per
# pane. The browser keeps them in memory, not in IndexedDB, so the cap is
# about what a tab can comfortably draw and fetch, not storage.
OUTPUT_BYTES = 4 * 1024 * 1024

_OUT = ".out."


class OutputError(Exception):
    """A write that can't be made, in a sentence the caller can pass on."""


def output_bytes(values: dict) -> int:
    return len(json.dumps(values))


def _longest_list(value: Any) -> Optional[list]:
    """The longest list anywhere inside some outputs: the thing to halve when
    they don't fit."""
    best: Optional[list] = None
    stack = [value]
    while stack:
        item = stack.pop()
        if isinstance(item, list):
            if best is None or len(item) > len(best):
                best = item
            stack.extend(item)
        elif isinstance(item, dict):
            stack.extend(item.values())
    return best if best else None


def fit(values: dict, budget: Optional[int] = None) -> bool:
    """Cuts the longest list in half until the outputs fit (90% of a pane's
    limit, unless told), keeping its start (newest first, for what's sorted
    that way); whether it cut any. Raises when there's nothing left to cut."""
    budget = int(OUTPUT_BYTES * 0.9) if budget is None else budget
    trimmed = False
    while output_bytes(values) > budget:
        longest = _longest_list(values)
        if longest is None or len(longest) <= 1:
            raise OutputError(f"These results are over the {OUTPUT_BYTES}-byte limit a pane can hold, even cut down.")
        del longest[len(longest) // 2 :]
        trimmed = True
    return trimmed


def split(state: dict) -> tuple[dict, dict[str, dict]]:
    """The state without its panes' outputs, and those outputs by pane."""
    kept: dict = {}
    found: dict[str, dict] = {}
    for key, value in state.items():
        pane, sep, rest = key.partition(_OUT)
        if sep and pane and "." not in pane and rest:
            found.setdefault(pane, {})[rest] = value
        else:
            kept[key] = value
    return kept, found


def _participants(db: Session, row: models.LiveSession) -> list[int]:
    from .live_store import _participants as participants

    return participants(db, row)


def _record(db: Session, row: models.LiveSession, pane: str, lock: bool = False) -> Optional[models.PaneOutput]:
    query = db.query(models.PaneOutput).filter(
        models.PaneOutput.session_id == row.id, models.PaneOutput.pane_id == pane
    )
    return (query.with_for_update() if lock else query).one_or_none()


def read(db: Session, row: models.LiveSession, panes: Optional[Iterable[str]] = None) -> dict[str, dict]:
    """`{pane: {"version", "values"}}` for the session's panes (or those
    named): its records, and outputs still sitting in the state for a pane
    that has no record yet (version 0)."""
    wanted = set(panes) if panes is not None else None
    query = db.query(models.PaneOutput).filter(models.PaneOutput.session_id == row.id)
    if wanted is not None:
        query = query.filter(models.PaneOutput.pane_id.in_(wanted))
    out = {r.pane_id: {"version": r.version, "values": r.data or {}} for r in query}
    _, leftover = split(row.state or {})
    for pane, values in leftover.items():
        if pane not in out and (wanted is None or pane in wanted):
            out[pane] = {"version": 0, "values": values}
    return out


def values_of(db: Session, row: models.LiveSession, pane: str) -> dict:
    return read(db, row, [pane]).get(pane, {}).get("values", {})


def move_out(db: Session, row: models.LiveSession, state: dict) -> dict:
    """The state with its outputs moved into their panes' records (on the
    caller's transaction): kept for a pane without a record, dropped for one
    with -- a record is always newer than what a state still carries."""
    kept, found = split(state)
    for pane, values in found.items():
        if row.id is not None and _record(db, row, pane) is not None:
            continue
        if row.id is None:
            db.flush()
        db.add(models.PaneOutput(session_id=row.id, pane_id=pane, data=values, version=1))
    return kept


def prune(db: Session, row: models.LiveSession, panes: Iterable[str]) -> None:
    """Drops the records of panes the session no longer has, on the caller's
    transaction: pane ids are reused, and a pane added later must not come
    back holding a closed one's results."""
    keep = set(panes)
    for record in db.query(models.PaneOutput).filter(models.PaneOutput.session_id == row.id):
        if record.pane_id not in keep:
            db.delete(record)


def _locked(db: Session, row: models.LiveSession, pane: str) -> models.PaneOutput:
    """The pane's record, locked -- made if it has none. Two writers making
    the first one at once: the loser's insert fails on the unique key, and it
    takes the winner's."""
    record = _record(db, row, pane, lock=True)
    if record is not None:
        return record
    try:
        with db.begin_nested():
            record = models.PaneOutput(session_id=row.id, pane_id=pane, data={}, version=0)
            db.add(record)
    except IntegrityError:
        record = _record(db, row, pane, lock=True)
    return record


def write(
    db: Session,
    row: models.LiveSession,
    pane: str,
    change: Callable[[dict], T],
    origin: Optional[str],
) -> tuple[models.PaneOutput, T]:
    """Read-modify-write one pane's outputs under its record's lock, then
    commit and announce it. `change` edits a copy in place; what it returns
    is handed back. Refused for a pane the session doesn't have (closed while
    a run was finishing)."""
    record = _locked(db, row, pane)
    # Read after taking the lock: a pane closed meanwhile has had its record
    # pruned, and writing would bring it back.
    db.refresh(row)
    if pane not in (row.state or {}).get("services", []):
        db.rollback()
        raise OutputError(f"This session has no pane '{pane}' any more.")
    values = copy.deepcopy(record.data or {})
    try:
        result = change(values)
        size = output_bytes(values)
        if size > OUTPUT_BYTES:
            raise OutputError(
                f"That would make this pane's results {size} bytes, over the {OUTPUT_BYTES}-byte limit. "
                "Ask for fewer results."
            )
    except Exception:
        db.rollback()
        raise
    record.data = values
    record.version = (record.version or 0) + 1
    record.updated_at = datetime.datetime.utcnow()
    db.flush()
    for user_id in _participants(db, row):
        notify(db, user_id, "outputs", row.client_id, record.version, origin, pane=pane)
    db.commit()
    db.refresh(record)
    return record, result


def clear(db: Session, row: models.LiveSession, pane: str, keys: Iterable[str], origin: Optional[str]) -> Optional[models.PaneOutput]:
    """Removes some outputs -- what an input's `resets` names -- if the pane
    has any of them; None when there was nothing to clear."""
    keys = [k for k in keys if k]
    current = values_of(db, row, pane)
    if not any(k in current for k in keys):
        return None

    def drop(values: dict) -> None:
        for key in keys:
            values.pop(key, None)

    record, _ = write(db, row, pane, drop, origin)
    return record
