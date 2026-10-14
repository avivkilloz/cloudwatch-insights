"""A logs pane's time range as epoch seconds: its `preset` (seconds back from
now) or, with `preset: custom`, `customStart`/`customEnd` in the user's own
local time -- the zone they typed it in, which the browser sends with a run
(`_tz` in the action's inputs) and the agent has from its caller.

One function for the pane, the agent and a background run, so a custom range
means the same instant whoever runs it (it was the browser's
`computeTimeRange` and the agent's `time_range`, kept in step by hand).
"""

import datetime
import re
import time
from typing import Any, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

DEFAULT_PRESET = 900


class TimeRangeError(ValueError):
    """A range that can't be searched, in a sentence the user can act on."""


def zone(name: Optional[str]) -> datetime.tzinfo:
    if name:
        try:
            return ZoneInfo(name)
        except (ZoneInfoNotFoundError, ValueError):
            pass
    return datetime.timezone.utc


def window(values: dict[str, Any], timezone: Optional[str] = None) -> tuple[int, int]:
    preset = values.get("preset", DEFAULT_PRESET)
    if preset in (None, ""):
        preset = DEFAULT_PRESET
    if preset == "custom":
        tz = zone(timezone)
        try:
            start = datetime.datetime.fromisoformat(values.get("customStart") or "").replace(tzinfo=tz)
            end = datetime.datetime.fromisoformat(values.get("customEnd") or "").replace(tzinfo=tz)
        except ValueError:
            raise TimeRangeError('A custom range needs a start and an end as "YYYY-MM-DDTHH:mm".') from None
        start_s, end_s = int(start.timestamp()), int(end.timestamp())
    else:
        try:
            seconds = int(preset)
        except (TypeError, ValueError):
            raise TimeRangeError(f"{preset!r} isn't a time range: give seconds back from now, or custom.") from None
        end_s = int(time.time())
        start_s = end_s - seconds
    if end_s <= start_s:
        raise TimeRangeError("End time must be after start time.")
    return start_s, end_s


# A histogram's bar width: the smallest of these that keeps a window to about
# BARS bars. Readable steps, written the way both Logs Insights' `bin()` and
# OpenSearch's `fixed_interval` take them.
STEPS: list[tuple[int, str]] = [
    (1, "1s"), (5, "5s"), (10, "10s"), (30, "30s"),
    (60, "1m"), (300, "5m"), (600, "10m"), (1800, "30m"),
    (3600, "1h"), (10800, "3h"), (21600, "6h"), (43200, "12h"), (86400, "1d"),
]
BARS = 60


def interval(start: int, end: int) -> tuple[int, str]:
    """The step for a histogram over [start, end], in seconds and as text."""
    wanted = max(1, (end - start) / BARS)
    return next((step for step in STEPS if step[0] >= wanted), STEPS[-1])


def _commands(query: str) -> list[str]:
    """A Logs Insights query's commands: split on `|`, except inside quotes or
    a /regex/ (`filter @message like /a|b/` is one command)."""
    parts: list[str] = []
    current: list[str] = []
    quote: Optional[str] = None
    i = 0
    while i < len(query):
        ch = query[i]
        if quote is not None:
            current.append(ch)
            if ch == "\\" and i + 1 < len(query):
                current.append(query[i + 1])
                i += 2
                continue
            if ch == quote:
                quote = None
        elif ch in "\"'`":
            quote = ch
            current.append(ch)
        elif ch == "/" and re.search(r"(like|=~)\s*$", "".join(current), re.IGNORECASE):
            # A regex literal starts only where a regex can: after `like` or `=~`.
            quote = "/"
            current.append(ch)
        elif ch == "|":
            parts.append("".join(current))
            current = []
        else:
            current.append(ch)
        i += 1
    parts.append("".join(current))
    return [p.strip() for p in parts if p.strip()]


# What only shapes the rows shown; a count of what matched doesn't need it.
_SHAPING = ("fields", "display", "sort", "limit", "dedup")


class NoHistogram(ValueError):
    """Why a query can't be counted over time, in a sentence for the pane."""


def count_query(query: str, bin_text: str) -> str:
    """The user's Logs Insights query as one that counts its matches per bar:
    its filters and parses kept, what only shapes the rows dropped, and a
    `stats count(*) by bin()` appended (D52)."""
    kept = []
    for command in _commands(query):
        word = command.split(None, 1)[0].lower()
        if word == "stats":
            raise NoHistogram("No histogram for a query with its own stats: chart its results instead.")
        if word not in _SHAPING:
            kept.append(command)
    return " | ".join([*kept, f"stats count(*) as count by bin({bin_text})"])
