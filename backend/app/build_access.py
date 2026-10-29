"""Who may change what's built (D161): a pane type, a step type, a workflow, a
credential or connection type.

Using them is everyone's (D160) -- what a person reaches is their group's
environments and identities, which every run checks -- so what's left to
decide is who changes one. An admin, any; then its owner, a person (who made
it, unless an admin handed it on); then its members, people the owner or an
admin added, as a session's (§sharing). Making something new is a group's
Builder (`builder_enabled`); being added to something is the grant to change
it, Builder or not.

Members are kept by (kind, target): a saved one's id, or `draft:<id>` for
one still being made, moved onto the saved id when it's created
(`adopt`). Its draft is the one everyone who may change it works in
(build_drafts, D161), its chat theirs to talk in.

One line no membership crosses: a credential type that credentials use shapes
their stored secrets (changing its fields re-encrypts them; its `inject` and
`http_test` decide where a secret is sent), and credentials are admins' alone
(D24) -- so once one uses it, only an admin changes it.
"""

import datetime
from typing import Any, Optional

from sqlalchemy.orm import Session

from . import models

KINDS = ("pane", "step", "workflow", "credential", "connection")
NOUNS = {"pane": "pane type", "step": "step type", "workflow": "workflow", "credential": "credential type",
         "connection": "connection type"}
MODELS = {"pane": models.BuiltPaneType, "step": models.BuiltStepType, "workflow": models.Workflow,
          "credential": models.CredentialType, "connection": models.ConnectionType}


class AccessError(ValueError):
    def __init__(self, message: str, status: int = 403):
        super().__init__(message)
        self.status = status


def is_admin(user: Optional[models.User]) -> bool:
    return bool(user is not None and user.group and user.group.is_admin)


def can_create(user: models.User) -> bool:
    """Making something new: an admin, or a group with the Builder."""
    return bool(user.group and (user.group.is_admin or user.group.builder_enabled))


def draft_target(draft_id: int) -> str:
    return f"draft:{draft_id}"


def member_ids(db: Session, kind: str, target: str) -> set[int]:
    return {m.user_id for m in db.query(models.BuildMember.user_id).filter_by(kind=kind, target_id=target)}


def is_member(db: Session, user: models.User, kind: str, target: str) -> bool:
    return db.query(models.BuildMember.id).filter_by(kind=kind, target_id=target, user_id=user.id).first() is not None


def _in_use(db: Session, kind: str, row: Any) -> int:
    if kind == "credential":
        return db.query(models.Credential).filter(models.Credential.type_id == row.id).count()
    return 0


def why_locked(db: Session, user: models.User, kind: str, row: Any) -> Optional[str]:
    """Why `user` can't change this one, in a sentence -- or None if they can."""
    if getattr(row, "builtin", False):
        return "Built in: it can't be changed. Copy it to make your own."
    used = _in_use(db, kind, row)
    if is_admin(user):
        return None
    if used:
        return (f"{used} credential{'s use' if used != 1 else ' uses'} it, so it shapes their secrets: an admin "
                "changes it now.")
    if row.owner_id is not None and row.owner_id == user.id:
        return None
    if is_member(db, user, kind, row.id):
        return None
    owner = db.get(models.User, row.owner_id) if row.owner_id else None
    who = f"{owner.username}, its members" if owner else "its members"
    return f"Made by {owner.username if owner else 'an admin'}: only {who} or an admin change it."


def can_edit(db: Session, user: models.User, kind: str, row: Any) -> bool:
    return why_locked(db, user, kind, row) is None


def can_manage(db: Session, user: models.User, kind: str, row: Any = None, draft: Any = None) -> bool:
    """Adding and removing members, handing it on: its owner's and admins'.
    A draft of something new is its starter's."""
    if is_admin(user):
        return True
    if row is not None:
        return row.owner_id is not None and row.owner_id == user.id
    return draft is not None and draft.user_id == user.id


def owner_name(db: Session, row: Any) -> Optional[str]:
    owner = db.get(models.User, row.owner_id) if getattr(row, "owner_id", None) else None
    return owner.username if owner else None


def person(user: Optional[models.User]) -> Optional[dict]:
    return {"id": user.id, "username": user.username, "avatar_url": user.avatar_url} if user else None


def add(db: Session, actor: models.User, kind: str, target: str, username: str) -> models.User:
    """Adds a member by username; the caller has checked `can_manage` and commits."""
    who = db.query(models.User).filter(models.User.username == username.strip()).first()
    if who is None:
        raise AccessError(f"There is no user {username.strip()}.", 404)
    if is_member(db, who, kind, target):
        raise AccessError(f"{who.username} is already a member.", 409)
    db.add(models.BuildMember(kind=kind, target_id=target, user_id=who.id, added_by_id=actor.id,
                              created_at=datetime.datetime.utcnow()))
    return who


def remove(db: Session, kind: str, target: str, user_id: int) -> None:
    db.query(models.BuildMember).filter_by(kind=kind, target_id=target, user_id=user_id).delete()


def adopt(db: Session, kind: str, draft_id: int, target_id: str, starter_id: int, owner_id: Optional[int]) -> None:
    """A new one just created from a draft: the draft's members are the saved
    one's now, and so is whoever started the draft, if it wasn't them who
    pressed Create. The caller commits."""
    existing = member_ids(db, kind, target_id)
    for m in db.query(models.BuildMember).filter_by(kind=kind, target_id=draft_target(draft_id)).all():
        if m.user_id in existing or m.user_id == owner_id:
            db.delete(m)
        else:
            m.target_id = target_id
            existing.add(m.user_id)
    if starter_id != owner_id and starter_id not in existing:
        db.add(models.BuildMember(kind=kind, target_id=target_id, user_id=starter_id,
                                  created_at=datetime.datetime.utcnow()))


def forget(db: Session, kind: str, target: str) -> None:
    """Something deleted: nobody is a member of it any more. The caller commits."""
    db.query(models.BuildMember).filter_by(kind=kind, target_id=target).delete()


def participants(db: Session, kind: str, target: Optional[str], draft: Any = None) -> set[int]:
    """Everyone who works on it: its owner, its members, whoever started its
    draft -- who a change to its draft is announced to."""
    out: set[int] = set()
    if target and not target.startswith("draft:"):
        row = db.get(MODELS[kind], target)
        if row is not None and row.owner_id:
            out.add(row.owner_id)
        out |= member_ids(db, kind, target)
    if draft is not None:
        out.add(draft.user_id)
        out |= member_ids(db, kind, draft_target(draft.id))
    return out
