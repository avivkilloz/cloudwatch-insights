"""Who may make and change credential and connection types (D158).

A type is a shape -- fields, which are secret, how a request is signed -- and
building a pane, a step or a workflow often needs one the platform doesn't
have yet, so builders make them, in the Builder as admins do in Settings.
What a builder makes is their group's: its builders change and delete it,
admins change anything but the built-ins.

The line is the secrets. A credential type that credentials use is what
their stored secrets are shaped by -- changing its fields re-encrypts them,
its `inject` and `http_test` say where a secret is sent -- and credentials are
admins' alone (D24), so once one uses it, only an admin changes it. A
connection type holds no secret (its fields are plain, a removal is refused
while a connection holds a value), so its group's builders keep changing it.
"""

from typing import Optional

from sqlalchemy.orm import Session

from . import builder, models

CREDENTIAL = "credential_type"
CONNECTION = "connection_type"


def is_admin(user: models.User) -> bool:
    return bool(user.group and user.group.is_admin)


def may_make(user: models.User) -> bool:
    return builder.can_build(user)


def owner_for(user: models.User) -> Optional[int]:
    """The group a type made by `user` belongs to: none for an admin's."""
    return None if is_admin(user) else user.group_id


def owner_name(db: Session, row) -> Optional[str]:
    group = db.get(models.UserGroup, row.owner_group_id) if getattr(row, "owner_group_id", None) else None
    return group.name if group else None


def _in_use(db: Session, kind: str, row) -> int:
    if kind == CREDENTIAL:
        return db.query(models.Credential).filter(models.Credential.type_id == row.id).count()
    return 0


def why_locked(db: Session, user: models.User, kind: str, row) -> Optional[str]:
    """Why `user` can't change this type, in a sentence -- or None if they can."""
    if row.builtin:
        return "Built in: it can't be changed. Copy it to make your own."
    if is_admin(user):
        return None
    if not may_make(user):
        return "Making and changing types is for admins and builders."
    if row.owner_group_id is None or row.owner_group_id != user.group_id:
        owner = owner_name(db, row)
        return f"Made by {owner + ' builders' if owner else 'an admin'}: only they, or an admin, change it."
    used = _in_use(db, kind, row)
    if used:
        return (f"{used} credential{'s use' if used != 1 else ' uses'} it, so it shapes their secrets: an admin "
                "changes it now.")
    return None
