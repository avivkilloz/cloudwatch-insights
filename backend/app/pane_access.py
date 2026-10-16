"""Which pane types a group may use (PLATFORM_PLAN.md §19.1, D65).

One row per (group, pane type) in `group_pane_grants`; the Admin group may use
every pane type. This is the one answer for every place that asks -- the pane
list, the action and request endpoints, the HTTP client's Send, the agent's
kinds -- so a pane is never offered in one and refused in another.

The old per-page booleans (`logs_enabled`, `tools_enabled`, …) are shorthand
for grants now: read as "has any pane with that flag", and written by granting
or revoking every pane that names it. They were the only thing a group had;
"Tools" was one switch for six panes, and a plugin's pane would have needed a
column of its own.
"""

import datetime
from typing import Iterable, Optional

from sqlalchemy.orm import Session

from . import models
from .panes import manifest as pane_manifest
from .resolve import ResolveError

MIGRATED_MARKER = "pane_grants_migrated"

# The booleans that covered pane types, in the API's order. `agent_enabled`
# isn't one -- the agent isn't a pane -- and `aggregator_enabled` covered
# nothing once every session was an Aggregator.
LEGACY_FLAGS = (
    "logs_enabled",
    "opensearch_enabled",
    "iot_enabled",
    "tables_enabled",
    "buckets_enabled",
    "cognito_enabled",
    "tools_enabled",
)


def granted(group: Optional[models.UserGroup]) -> set[str]:
    """The pane types this group may use."""
    if group is None:
        return set()
    if group.is_admin:
        return set(pane_manifest.manifests())
    return {g.pane_type for g in group.pane_grants}


def allowed(group: Optional[models.UserGroup], pane_type: str) -> bool:
    return group is not None and (group.is_admin or pane_type in granted(group))


def require(user: models.User, pane_type: str, label: str) -> None:
    """Refuses a pane type the caller's group hasn't been given -- whoever is
    asking, by whatever route: the browser's action, the agent, a handler
    called from somewhere new."""
    if not allowed(user.group, pane_type):
        raise ResolveError(f"Your group doesn't have {label} turned on.")


def legacy_flags(group: models.UserGroup) -> dict[str, bool]:
    """The old booleans, as the grants say them: on when the group has any
    pane that named it."""
    have = granted(group)
    by_flag: dict[str, list[str]] = {}
    for m in pane_manifest.manifests().values():
        if m.flag:
            by_flag.setdefault(m.flag, []).append(m.id)
    return {flag: group.is_admin or any(t in have for t in by_flag.get(flag, [])) for flag in LEGACY_FLAGS}


def _panes_with_flag(flag: str) -> list[str]:
    return [m.id for m in pane_manifest.manifests().values() if m.flag == flag]


def set_grants(db: Session, group: models.UserGroup, pane_types: Iterable[str]) -> None:
    """Exactly these pane types. One that isn't a pane type is refused with
    a sentence an admin can act on."""
    known = pane_manifest.manifests()
    wanted = set(pane_types)
    unknown = sorted(wanted - set(known))
    if unknown:
        raise ValueError(f"There is no pane type {', '.join(unknown)}. The pane types are: {', '.join(sorted(known))}.")
    have = {g.pane_type: g for g in group.pane_grants}
    for pane_type, grant in have.items():
        if pane_type not in wanted:
            group.pane_grants.remove(grant)
    for pane_type in sorted(wanted - set(have)):
        group.pane_grants.append(models.GroupPaneGrant(pane_type=pane_type))
    db.flush()


def apply_legacy(db: Session, group: models.UserGroup, flags: dict[str, bool]) -> None:
    """The shorthand: a boolean turned on grants every pane that names it,
    turned off revokes them; one left out changes nothing."""
    wanted = {g.pane_type for g in group.pane_grants}
    for flag, on in flags.items():
        if flag not in LEGACY_FLAGS or on is None:
            continue
        panes = set(_panes_with_flag(flag))
        wanted = wanted | panes if on else wanted - panes
    set_grants(db, group, wanted)


def migrate(db: Session) -> list[str]:
    """Once per database: each group's booleans become grants of exactly the
    pane types they covered, so nobody gains or loses anything. A marker
    rather than "has no grants yet", so a group an admin later strips of
    every pane doesn't get them back on the next start."""
    if db.get(models.Setting, MIGRATED_MARKER) is not None:
        return []
    lines = []
    for group in db.query(models.UserGroup).all():
        if group.is_admin:
            continue
        on = {flag: bool(getattr(group, flag, False)) for flag in LEGACY_FLAGS}
        apply_legacy(db, group, on)
        lines.append(f"group {group.name}: {', '.join(sorted(granted(group))) or 'no panes'}")
    db.add(models.Setting(key=MIGRATED_MARKER, value=datetime.datetime.utcnow().isoformat()))
    db.commit()
    return lines
