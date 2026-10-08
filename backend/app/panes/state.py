"""The v2 state shape, reached by moving legacy keys (PLATFORM_PLAN.md §15.4).

A pane type whose manifest says `state: v2` keeps its inputs at
`<pane>.in.<key>` and its outputs at `<pane>.out.<key>`. Sessions saved
before its port hold the page's own keys (`<pane>.urlSafe`); `migrate()`
moves them, from each manifest's `legacy_key`s.

It runs on every write that reaches the server (the browser's PUT, the
agent's `mutate`) and on what a browser reads back, and it is idempotent: a
legacy key is moved when it appears, whenever that is. No once-only marker
-- a tab left open across the deploy still writes the old keys, and a marker
saying "done" would let those through. When both the old and the new key
are there, the new one wins and the old one goes: the old one can only have
come from such a tab, which reloads itself (§15.4).
"""

from typing import Any

from . import manifest as pane_manifest


def migrate(state: Any) -> Any:
    """`state` with every v2 pane's legacy keys moved under in./out.; the
    same object when there is nothing to move, a new dict otherwise."""
    if not isinstance(state, dict):
        return state
    types = state.get("paneTypes") or {}
    pane_ids = [p for p in state.get("services") or [] if isinstance(p, str)]
    out = None
    for pane_id in pane_ids:
        manifest = pane_manifest.get(types.get(pane_id, pane_id) if isinstance(types, dict) else pane_id)
        if manifest is None or manifest.state != "v2":
            continue
        for old, new in manifest.legacy_map().items():
            old_key, new_key = f"{pane_id}.{old}", f"{pane_id}.{new}"
            if old_key not in state:
                continue
            if out is None:
                out = dict(state)
            value = out.pop(old_key)
            out.setdefault(new_key, value)
    return state if out is None else out
