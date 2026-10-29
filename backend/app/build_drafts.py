"""Drafts of what's being built (D125): a pane type, a step type, a
workflow or a type as it was left, saved as it's typed, with the chat about
it. Leaving the page used to lose all of it.

One draft per saved thing, shared by everyone who may change it (D161, its
owner, members and admins): each of them works in it, live, and talks in its
chat -- people to each other, and the Builder's agent when it's asked. A new
one's draft is its starter's and the members they add. Deployment state,
never the store's. Making one needs the Builder; a draft of an existing one,
the right to change it. Create or Save leaves the chat (the browser, which
knows the save went through, writes the saved text into it -- a new one's
draft becoming the created one's); deleting the thing removes its draft."""

import datetime
import json
from typing import Any, Optional

import yaml
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from . import build_access, live_events, models

# A credential or connection type's draft is its YAML (D159, `type_defs`).
KINDS = ("pane", "step", "workflow", "credential", "connection")
NOUNS = {"pane": "pane type", "step": "step type", "workflow": "workflow", "credential": "credential type",
         "connection": "connection type"}

# A definition is a page or two of YAML; a chat is kept to its newest turns.
MAX_SOURCE = 200_000
MAX_CHAT_BYTES = 1_000_000


class DraftError(ValueError):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def may_make(user: models.User, kind: str) -> bool:
    return build_access.can_create(user)


def _target(db: Session, user: models.User, kind: str, target_id: str) -> Any:
    """The thing a draft changes, if it's there and theirs to change."""
    row = db.get(_MODELS[kind], target_id)
    if row is None:
        raise DraftError(f"There is no {NOUNS[kind]} {target_id}.", 404)
    why = build_access.why_locked(db, user, kind, row)
    if why:
        raise DraftError(why, 403)
    return row


def label(source: str) -> str:
    """What a draft is called in the lists: its YAML's label, while it has one."""
    try:
        data = yaml.safe_load(source)
    except yaml.YAMLError:
        data = None
    found = data.get("label") if isinstance(data, dict) else None
    return str(found).strip() if isinstance(found, (str, int, float)) and str(found).strip() else ""


def _chat(turns: Any) -> list:
    """The newest turns that fit."""
    if not isinstance(turns, list):
        raise DraftError("A draft's chat is a list of turns.")
    while turns and len(json.dumps(turns)) > MAX_CHAT_BYTES:
        turns = turns[1:]
    return turns


def merge_chat(kept: list, sent: list) -> list:
    """A chat several people write to (D161) is an append log, as a shared
    session's is (mergeChatTurns): each tab sends the chat it has, and a turn
    it doesn't have yet -- someone else's, a second ago -- must survive. By
    turn id: the sent copy of a turn wins (its answer came in), the kept
    turns it lacks stay, in their place."""
    sent_ids = {t.get("id") for t in sent if isinstance(t, dict)}
    out = list(sent)
    for i, turn in enumerate(kept):
        if isinstance(turn, dict) and turn.get("id") not in sent_ids:
            # After the turn it followed, where that's still there; first if it was first.
            before = kept[i - 1].get("id") if i and isinstance(kept[i - 1], dict) else None
            at = 0 if i == 0 else next((j + 1 for j, t in enumerate(out)
                                        if isinstance(t, dict) and t.get("id") == before), None)
            out.insert(at if at is not None else len(out), turn)
            sent_ids.add(turn.get("id"))
    return out


_MODELS = build_access.MODELS


def _same(kind: str, saved: str, source: str) -> bool:
    if kind in ("credential", "connection"):
        from . import type_defs

        return type_defs.same(kind, saved, source)
    return saved == source


def _saved_source(kind: str, saved: Any) -> str:
    if kind in ("credential", "connection"):
        from . import type_defs

        return type_defs.source_of(kind, saved)
    return saved.source


def out(db: Session, row: models.BuildDraft, full: bool = False) -> dict[str, Any]:
    # A saved one's draft may hold only its chat (kept after Save): its text
    # is then what's saved, and it isn't a change.
    saved = db.get(_MODELS[row.kind], row.target_id) if row.target_id else None
    return {
        "id": row.id,
        "kind": row.kind,
        "target_id": row.target_id,
        "new_id": row.new_id,
        "label": label(row.source),
        "updated_at": row.updated_at,
        "turns": len(row.chat or []),
        "version": row.version or 0,
        "changed": saved is None or not _same(row.kind, _saved_source(row.kind, saved), row.source)
        or (row.kind in ("pane", "step") and (getattr(saved, "files", None) or {}) != (row.files or {})),
        # Whether more than one person works in it: its chat is then people
        # talking, the agent answering only when asked (D163).
        "shared": len(build_access.participants(db, row.kind, row.target_id, row)) > 1,
        **({"source": row.source, "files": row.files or {}, "chat": row.chat or []} if full else {}),
    }


def listed(db: Session, user: models.User, kind: Optional[str] = None) -> list[models.BuildDraft]:
    """The drafts someone works in: those they started, and those of what
    they own or are a member of -- not every draft an admin could open."""
    q = db.query(models.BuildDraft)
    if kind:
        q = q.filter_by(kind=kind)
    member_of = {(m.kind, m.target_id) for m in db.query(models.BuildMember).filter_by(user_id=user.id)}
    owned: set[tuple[str, str]] = set()
    for k, model in _MODELS.items():
        owned |= {(k, r.id) for r in db.query(model.id).filter(model.owner_id == user.id)}
    out = []
    for row in q.order_by(models.BuildDraft.updated_at.desc()).all():
        here = (row.kind, row.target_id) if row.target_id else (row.kind, build_access.draft_target(row.id))
        if row.user_id == user.id or here in member_of or here in owned:
            out.append(row)
    return out


def reachable(db: Session, user: models.User, draft_id: int) -> models.BuildDraft:
    """A draft this person may work in: theirs, a member's, or -- of a saved
    one -- whoever may change that; an admin, any."""
    row = db.get(models.BuildDraft, draft_id)
    if row is not None and (build_access.is_admin(user) or row.user_id == user.id):
        return row
    if row is not None and row.target_id:
        target = db.get(_MODELS[row.kind], row.target_id)
        if target is not None and build_access.can_edit(db, user, row.kind, target):
            return row
    elif row is not None and build_access.is_member(db, user, row.kind, build_access.draft_target(row.id)):
        return row
    raise DraftError("There is no such draft of yours.", 404)


# What an older caller called it.
mine = reachable


def _apply(row: models.BuildDraft, source: Optional[str], new_id: Optional[str], chat: Any,
           files: Optional[dict[str, str]] = None) -> None:
    if source is not None:
        if len(source) > MAX_SOURCE:
            raise DraftError("That definition is too long to keep as a draft.")
        row.source = source
    if files is not None:
        # Its files (D136) as they were left -- a name being typed is kept
        # too: Check is what holds them to a module's name.
        if not isinstance(files, dict) or len(files) > 50 or sum(len(str(t)) for t in files.values()) > MAX_SOURCE * 5:
            raise DraftError("Those files are too many, or too long, to keep as a draft.")
        row.files = {str(k)[:80]: str(v) for k, v in files.items()}
    if new_id is not None:
        row.new_id = new_id.strip()[:64]
    if chat is not None:
        # Empty is Clear -- offered only while nobody else is in it (D163);
        # anything else is merged, so a turn another tab added survives.
        row.chat = _chat(merge_chat(list(row.chat or []), chat)) if chat else []
    row.updated_at = datetime.datetime.utcnow()
    row.version = (row.version or 0) + 1


def announce(db: Session, row: models.BuildDraft, origin: Optional[str], by: Optional[str] = None,
             for_tab: Optional[str] = None, also: Optional[int] = None) -> None:
    """Tells everyone working in a draft that it changed (D157, D161), on the
    caller's commit: each editor holding it fetches it and follows. Everyone
    is its participants, whoever made the change (`also`: an admin who isn't
    one), and anyone with it on screen. `by` says who, for its line ("Claude
    Code (laptop)"); `for_tab`, a tab whose editor has no draft yet and should
    take this one (open_draft for what's on screen)."""
    db.flush()
    who = build_access.participants(db, row.kind, row.target_id, row) | ({also} if also else set())
    on_screen = db.query(models.ScreenView.user_id).filter(models.ScreenView.build_kind == row.kind)
    on_screen = on_screen.filter(models.ScreenView.draft_id == row.id) if not row.target_id else \
        on_screen.filter((models.ScreenView.draft_id == row.id) | (models.ScreenView.build_target_id == row.target_id))
    who |= {r.user_id for r in on_screen}
    for user_id in sorted(who):
        live_events.notify(db, user_id, "draft", None, row.version, origin, extra={
            "draft_id": row.id, "build_kind": row.kind, "target_id": row.target_id,
            **({"by": by} if by else {}), **({"for_tab": for_tab} if for_tab and user_id == row.user_id else {})})


class Stale(DraftError):
    """A save made on a version that's no longer the draft's."""

    def __init__(self) -> None:
        super().__init__("This draft was changed elsewhere since you opened it; it's been brought up to date.", 409)


def save(db: Session, user: models.User, kind: str, target_id: Optional[str], source: Optional[str],
         new_id: Optional[str] = None, chat: Any = None, files: Optional[dict[str, str]] = None,
         origin: Optional[str] = None, by: Optional[str] = None, for_tab: Optional[str] = None,
         expect_new: bool = False) -> models.BuildDraft:
    """A new draft -- or, of an existing one, its draft, changed: one for
    everyone who may change it, whoever saves first making it. An editor that
    thought it was making it (`expect_new`) and finds someone else did first
    is told so (409) and merges into theirs, rather than writing over it."""
    if kind not in KINDS:
        raise DraftError(f"A draft is of a {', '.join(KINDS)}.")
    if not target_id and not may_make(user, kind):
        raise DraftError(f"Making a {NOUNS[kind]} is for admins and groups with the Builder.", 403)
    row = None
    if target_id:
        _target(db, user, kind, target_id)
        row = db.query(models.BuildDraft).filter_by(kind=kind, target_id=target_id).first()
        if row is not None and expect_new and source is not None:
            raise Stale()
    if row is None:
        row = models.BuildDraft(user_id=user.id, kind=kind, target_id=target_id or None, source="", chat=[])
        db.add(row)
    _apply(row, source if source is not None else (row.source or ""), None if target_id else new_id, chat, files)
    try:
        announce(db, row, origin, by, for_tab, also=user.id)
        db.commit()
    except IntegrityError:
        # Another tab's first save of the same one won -- or another person's: change that one.
        db.rollback()
        if expect_new:
            raise Stale() from None
        row = db.query(models.BuildDraft).filter_by(kind=kind, target_id=target_id).one()
        _apply(row, source, None, chat, files)
        announce(db, row, origin, by, for_tab, also=user.id)
        db.commit()
    return row


def update(db: Session, user: models.User, row: models.BuildDraft, source: Optional[str], new_id: Optional[str],
           chat: Any, target_id: Optional[str] = None, files: Optional[dict[str, str]] = None,
           origin: Optional[str] = None, base_version: Optional[int] = None) -> models.BuildDraft:
    # Who may work in it was asked when it was reached (`reachable`).
    # Text saved on top of an older version would undo what was done since
    # (Claude Code's changes, another tab's): refused, and the editor follows.
    if base_version is not None and base_version != (row.version or 0) and (source is not None or files is not None):
        raise Stale()
    if target_id and row.target_id != target_id:
        # A new one just created: its draft goes on as that one's -- its chat
        # and its members with it -- in place of any it had.
        if row.target_id is not None:
            raise DraftError("This draft already belongs to another one.")
        saved = _target(db, user, row.kind, target_id)
        db.query(models.BuildDraft).filter(models.BuildDraft.kind == row.kind,
                                           models.BuildDraft.target_id == target_id,
                                           models.BuildDraft.id != row.id).delete()
        build_access.adopt(db, row.kind, row.id, target_id, row.user_id, saved.owner_id)
        row.target_id, row.new_id = target_id, ""
    _apply(row, source, None if row.target_id else new_id, chat, files)
    announce(db, row, origin, also=user.id)
    db.commit()
    return row


def discard(db: Session, user: models.User, row: models.BuildDraft, origin: Optional[str] = None) -> None:
    """Discarding a saved one's draft puts its text back as saved -- the
    chat and the members stay, they're everyone's. A new one's goes, with
    its members: its starter's or an admin's to discard."""
    if row.target_id:
        saved = _target(db, user, row.kind, row.target_id)
        _apply(row, _saved_source(row.kind, saved), None, None,
               dict(getattr(saved, "files", None) or {}) if row.kind in ("pane", "step") else None)
        announce(db, row, origin, also=user.id)
    else:
        if not (row.user_id == user.id or build_access.is_admin(user)):
            raise DraftError("Only whoever started this draft, or an admin, discards it; leave it instead.", 403)
        build_access.forget(db, row.kind, build_access.draft_target(row.id))
        db.delete(row)
    db.commit()


def forget(db: Session, kind: str, target_id: str) -> None:
    """The draft and members of something deleted: nothing left to change.
    The caller commits, with the delete."""
    db.query(models.BuildDraft).filter_by(kind=kind, target_id=target_id).delete()
    build_access.forget(db, kind, target_id)


def fold_duplicates(conn: Any) -> None:
    """Once, on the move to one draft per thing (D161): of several people's
    drafts of one thing, the newest is kept and the others' turns are added
    to its chat. Raw SQL on startup's connection, before the new index."""
    from sqlalchemy import text as sql

    groups = conn.execute(sql("SELECT kind, target_id FROM build_drafts WHERE target_id IS NOT NULL "
                              "GROUP BY kind, target_id HAVING count(*) > 1")).all()
    for kind, target_id in groups:
        rows = conn.execute(sql("SELECT id, chat FROM build_drafts WHERE kind = :k AND target_id = :t "
                                "ORDER BY updated_at DESC, id DESC"), {"k": kind, "t": target_id}).all()
        keep_id, chat = rows[0][0], list(rows[0][1] or [])
        for _id, other in rows[1:]:
            chat = merge_chat(list(other or []), chat)
        conn.execute(sql("UPDATE build_drafts SET chat = CAST(:c AS json) WHERE id = :i"),
                     {"c": json.dumps(_chat(chat)), "i": keep_id})
        conn.execute(sql("DELETE FROM build_drafts WHERE kind = :k AND target_id = :t AND id <> :i"),
                     {"k": kind, "t": target_id, "i": keep_id})
