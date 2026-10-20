"""Drafts of what's being built (D125): a pane type, a step type or a
workflow as its builder left it, saved as they type, with their Building chat
about it. Leaving the page used to lose all of it.

A draft is its builder's own -- nobody else lists, reads or changes it -- and
deployment state, never the store's. Making one needs the right to make that
kind of thing; a draft of an existing one, the right to change it. Create or
Save leaves only its chat (the browser, which knows the save went through,
writes the saved text into it -- a new one's draft becoming the created
one's); deleting the thing removes everyone's drafts of it."""

import datetime
import json
from typing import Any, Optional

import yaml
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from . import builder, models, step_types, workflows

KINDS = ("pane", "step", "workflow")
NOUNS = {"pane": "pane type", "step": "step type", "workflow": "workflow"}

# A definition is a page or two of YAML; a chat is kept to its newest turns.
MAX_SOURCE = 200_000
MAX_CHAT_BYTES = 1_000_000


class DraftError(ValueError):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def may_make(user: models.User, kind: str) -> bool:
    if kind == "workflow":
        return workflows.can_create(user)
    if kind == "step":
        return step_types.can_edit(user)
    return builder.can_build(user)


def _target(db: Session, user: models.User, kind: str, target_id: str) -> Any:
    """The thing a draft changes, if it's there and theirs to change."""
    if kind == "workflow":
        row = db.get(models.Workflow, target_id)
        ok = row is not None and workflows.can_edit(user, row)
    elif kind == "step":
        row = db.get(models.BuiltStepType, target_id)
        ok = row is not None and step_types.can_edit(user, row)
    else:
        row = db.get(models.BuiltPaneType, target_id)
        ok = row is not None and builder.can_build(user)
    if not ok:
        raise DraftError(f"There is no {NOUNS[kind]} {target_id} you can change.", 404)
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


_MODELS = {"pane": models.BuiltPaneType, "step": models.BuiltStepType, "workflow": models.Workflow}


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
        "changed": saved is None or saved.source != row.source,
        **({"source": row.source, "chat": row.chat or []} if full else {}),
    }


def listed(db: Session, user: models.User, kind: Optional[str] = None) -> list[models.BuildDraft]:
    q = db.query(models.BuildDraft).filter_by(user_id=user.id)
    if kind:
        q = q.filter_by(kind=kind)
    return q.order_by(models.BuildDraft.updated_at.desc()).all()


def mine(db: Session, user: models.User, draft_id: int) -> models.BuildDraft:
    row = db.get(models.BuildDraft, draft_id)
    if row is None or row.user_id != user.id:
        raise DraftError("There is no such draft of yours.", 404)
    return row


def _apply(row: models.BuildDraft, source: Optional[str], new_id: Optional[str], chat: Any) -> None:
    if source is not None:
        if len(source) > MAX_SOURCE:
            raise DraftError("That definition is too long to keep as a draft.")
        row.source = source
    if new_id is not None:
        row.new_id = new_id.strip()[:64]
    if chat is not None:
        row.chat = _chat(chat)
    row.updated_at = datetime.datetime.utcnow()


def save(db: Session, user: models.User, kind: str, target_id: Optional[str], source: Optional[str],
         new_id: Optional[str] = None, chat: Any = None) -> models.BuildDraft:
    """A new draft -- or, of an existing one, the draft this person already
    has of it, changed: one each, whichever tab saves first."""
    if kind not in KINDS:
        raise DraftError(f"A draft is of a {', '.join(KINDS)}.")
    if not may_make(user, kind):
        raise DraftError(f"You can't build a {NOUNS[kind]}.", 403)
    row = None
    if target_id:
        _target(db, user, kind, target_id)
        row = db.query(models.BuildDraft).filter_by(user_id=user.id, kind=kind, target_id=target_id).first()
    if row is None:
        row = models.BuildDraft(user_id=user.id, kind=kind, target_id=target_id or None, source="", chat=[])
        db.add(row)
    _apply(row, source if source is not None else (row.source or ""), None if target_id else new_id, chat)
    try:
        db.commit()
    except IntegrityError:
        # Another tab's first save of the same one won: change that one.
        db.rollback()
        row = db.query(models.BuildDraft).filter_by(user_id=user.id, kind=kind, target_id=target_id).one()
        _apply(row, source, None, chat)
        db.commit()
    return row


def update(db: Session, user: models.User, row: models.BuildDraft, source: Optional[str], new_id: Optional[str],
           chat: Any, target_id: Optional[str] = None) -> models.BuildDraft:
    if not may_make(user, row.kind):
        raise DraftError(f"You can't build a {NOUNS[row.kind]}.", 403)
    if target_id and row.target_id != target_id:
        # A new one just created: its draft goes on as that one's -- its chat
        # with it -- in place of any this person had of it.
        if row.target_id is not None:
            raise DraftError("This draft already belongs to another one.")
        _target(db, user, row.kind, target_id)
        db.query(models.BuildDraft).filter(models.BuildDraft.user_id == user.id, models.BuildDraft.kind == row.kind,
                                           models.BuildDraft.target_id == target_id,
                                           models.BuildDraft.id != row.id).delete()
        row.target_id, row.new_id = target_id, ""
    _apply(row, source, None if row.target_id else new_id, chat)
    db.commit()
    return row


def forget(db: Session, kind: str, target_id: str) -> None:
    """Everyone's drafts of something deleted: nothing left to change. The
    caller commits, with the delete."""
    db.query(models.BuildDraft).filter_by(kind=kind, target_id=target_id).delete()
