"""A logs pane's time range as epoch seconds: its `preset` (seconds back from
now) or, with `preset: custom`, `customStart`/`customEnd` in the user's own
local time -- the zone they typed it in, which the browser sends with a run
(`_tz` in the action's inputs) and the agent has from its caller.

One function for the pane, the agent and a background run, so a custom range
means the same instant whoever runs it (it was the browser's
`computeTimeRange` and the agent's `time_range`, kept in step by hand).
"""

import datetime
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
