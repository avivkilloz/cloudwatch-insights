"""The catalogue panes are picked from (PLATFORM_PLAN.md §4.8, §19.2, D66).

Categories are data. A pane type suggests one (its manifest's `category`,
else its `group`), matched by the category's fixed `key`; a suggestion no
category has is created. An admin's placement pins a pane type to a category
and a place in it, so a manifest changing its suggestion later -- a plugin
upgrade -- never undoes it. Each person can favourite pane types and hide
them. Every pane type is everyone's (D160): what a group reaches is its
environments, so a pane none of them can run is marked (`no_environment`),
never left out.
"""

from typing import Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from . import models
from .panes import manifest as pane_manifest

# Unplaced panes come after the placed ones in their category, in manifest order.
_UNPLACED = 10_000

# What the categories the bundled panes suggest are, until an admin says
# otherwise -- these were the browser's own until categories could carry one.
DESCRIPTIONS = {
    "Services": "A window onto an AWS service, across every environment you have access to.",
    "Tools": "Self-contained utilities, for the things you would otherwise leave the app to do.",
    "Platform": "This platform's own features -- they work across the pages below rather than wrapping one service.",
}

# Long enough for a sentence or two under a heading, not a page of help.
DESCRIPTION_CHARS = 300


class CatalogueError(ValueError):
    """A request an admin can correct; its message says how."""


def suggestion(m: pane_manifest.Manifest) -> str:
    return m.category or m.group


def ensure_categories(db: Session) -> None:
    """Creates the category a pane suggests when none has that key and the
    pane isn't placed. Idempotent; a deleted category whose panes were moved
    (placed) elsewhere doesn't come back."""
    placed = {p.pane_type for p in db.query(models.CataloguePlacement).all()}
    keys = {c.key for c in db.query(models.CatalogueCategory).all()}
    names = {c.name for c in db.query(models.CatalogueCategory).all()}
    position = (db.query(func.max(models.CatalogueCategory.position)).scalar() or 0) + 1
    created = False
    for m in sorted(pane_manifest.manifests().values(), key=lambda m: m.order):
        key = suggestion(m)
        if m.id in placed or key in keys:
            continue
        name = key if key not in names else f"{key} ({m.label})"
        db.add(models.CatalogueCategory(key=key, name=name, position=position))
        keys.add(key)
        names.add(name)
        position += 1
        created = True
    if created:
        db.commit()


def arrangement(db: Session) -> list[tuple[models.CatalogueCategory, list[str]]]:
    """Every category in order, with every pane type in it in order."""
    ensure_categories(db)
    categories = db.query(models.CatalogueCategory).order_by(models.CatalogueCategory.position, models.CatalogueCategory.id).all()
    by_key = {c.key: c for c in categories}
    placements = {p.pane_type: p for p in db.query(models.CataloguePlacement).all()}
    slots: dict[int, list[tuple[int, str]]] = {c.id: [] for c in categories}
    for m in pane_manifest.manifests().values():
        p = placements.get(m.id)
        if p is not None and p.category_id in slots:
            slots[p.category_id].append((p.position, m.id))
        else:
            slots[by_key[suggestion(m)].id].append((_UNPLACED + m.order, m.id))
    return [(c, [t for _, t in sorted(slots[c.id])]) for c in categories]


def description(c: models.CatalogueCategory) -> str:
    return DESCRIPTIONS.get(c.key, "") if c.description is None else c.description


def _description(text: Optional[str]) -> str:
    text = (text or "").strip()
    if len(text) > DESCRIPTION_CHARS:
        raise CatalogueError(f"A description is {DESCRIPTION_CHARS} characters at most.")
    return text


def category_of(db: Session) -> dict[str, str]:
    """Pane type -> its category's name, for the agent."""
    return {t: c.name for c, types in arrangement(db) for t in types}


def _category(db: Session, category_id: int) -> models.CatalogueCategory:
    c = db.get(models.CatalogueCategory, category_id)
    if c is None:
        raise CatalogueError("That category doesn't exist any more.")
    return c


def _unique_name(db: Session, name: str, but: Optional[int] = None) -> str:
    name = name.strip()
    if not name:
        raise CatalogueError("A category needs a name.")
    clash = db.query(models.CatalogueCategory).filter(func.lower(models.CatalogueCategory.name) == name.lower())
    if but is not None:
        clash = clash.filter(models.CatalogueCategory.id != but)
    if clash.first() is not None:
        raise CatalogueError(f'There is already a category called "{name}".')
    return name


def create(db: Session, name: str, about: Optional[str] = None) -> models.CatalogueCategory:
    name = _unique_name(db, name)
    # Keyed by its first name, so a plugin suggesting the same category later
    # lands in this one.
    if db.query(models.CatalogueCategory).filter(models.CatalogueCategory.key == name).first() is not None:
        raise CatalogueError(f'A category was once called "{name}"; rename that one instead.')
    position = (db.query(func.max(models.CatalogueCategory.position)).scalar() or 0) + 1
    c = models.CatalogueCategory(key=name, name=name, description=_description(about), position=position)
    db.add(c)
    db.commit()
    return c


def rename(db: Session, category_id: int, name: str, about: Optional[str] = None) -> models.CatalogueCategory:
    """Its name, and its description when one is given ("" clears it)."""
    c = _category(db, category_id)
    c.name = _unique_name(db, name, but=c.id)
    if about is not None:
        c.description = _description(about)
    db.commit()
    return c


def delete(db: Session, category_id: int, move_to: int) -> None:
    """Deletes a category, placing its panes at the end of `move_to`."""
    c = _category(db, category_id)
    target = _category(db, move_to)
    if target.id == c.id:
        raise CatalogueError("Choose another category for its panes.")
    layout = dict((cat.id, types) for cat, types in arrangement(db))
    # The target's own panes keep their order, the moved ones after them.
    for i, pane_type in enumerate(layout[target.id] + layout[c.id]):
        _place(db, pane_type, target.id, i)
    db.flush()
    db.delete(c)
    db.commit()


def _place(db: Session, pane_type: str, category_id: int, position: int) -> None:
    p = db.get(models.CataloguePlacement, pane_type)
    if p is None:
        db.add(models.CataloguePlacement(pane_type=pane_type, category_id=category_id, position=position))
    else:
        p.category_id = category_id
        p.position = position


def set_layout(db: Session, layout: list[tuple[int, list[str]]]) -> None:
    """The whole arrangement: categories in this order, each with these panes
    in this order. Every pane listed is placed (pinned); a category left out
    keeps its panes and goes after the listed ones."""
    known = pane_manifest.manifests()
    seen: set[str] = set()
    for category_id, types in layout:
        _category(db, category_id)
        for t in types:
            if t not in known:
                raise CatalogueError(f"There is no pane type {t}.")
            if t in seen:
                raise CatalogueError(f"{known[t].label} is listed twice.")
            seen.add(t)
    listed = [cid for cid, _ in layout]
    rest = [c for c in db.query(models.CatalogueCategory).order_by(models.CatalogueCategory.position).all() if c.id not in listed]
    for i, cid in enumerate(listed + [c.id for c in rest]):
        _category(db, cid).position = i
    for cid, types in layout:
        for i, t in enumerate(types):
            _place(db, t, cid, i)
    db.commit()


def preferences(db: Session, user: models.User) -> tuple[list[str], list[str]]:
    rows = db.query(models.CataloguePreference).filter(models.CataloguePreference.user_id == user.id).order_by(models.CataloguePreference.id).all()
    return [r.pane_type for r in rows if r.favourite], [r.pane_type for r in rows if r.hidden]


def set_preference(db: Session, user: models.User, pane_type: str, favourite: Optional[bool], hidden: Optional[bool]) -> None:
    if pane_type not in pane_manifest.manifests():
        raise CatalogueError(f"There is no pane type {pane_type}.")
    row = (
        db.query(models.CataloguePreference)
        .filter(models.CataloguePreference.user_id == user.id, models.CataloguePreference.pane_type == pane_type)
        .one_or_none()
    )
    if row is None:
        row = models.CataloguePreference(user_id=user.id, pane_type=pane_type, favourite=False, hidden=False)
        db.add(row)
    if favourite is not None:
        row.favourite = favourite
    if hidden is not None:
        row.hidden = hidden
    # Neither any more: nothing to keep.
    if not row.favourite and not row.hidden:
        if row.id is not None:
            db.delete(row)
        else:
            db.expunge(row)
    db.commit()


def no_environment(db: Session, user: models.User, reachable: list[dict]) -> dict[str, str]:
    """The pane types a person can't run anywhere, each with why: one whose
    required connection input is of a type none of their environments has a
    connection of. A connection that may be left unset (the HTTP client's
    Target) doesn't count -- the pane works without one."""
    have = {t["type_id"] for t in reachable}
    names = {r.id: r.label for r in db.query(models.ConnectionType).all()}
    out: dict[str, str] = {}
    for m in pane_manifest.manifests().values():
        missing = sorted({i.connection_type for i in m.inputs if i.type in ("connection", "connections")
                          and i.connection_type and not i.optional and i.connection_type not in have})
        if missing:
            out[m.id] = (f"None of your environments has a connection to "
                         f"{' or '.join(names.get(t, t) for t in missing)} yet.")
    return out
