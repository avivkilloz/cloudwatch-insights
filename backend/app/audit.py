"""The audit log's one write path. The caller commits, so the record lands in
the same transaction as the change it describes -- never one without the
other."""

from typing import Any, Optional

from sqlalchemy.orm import Session

from . import models


def record(
    db: Session,
    *,
    actor: Optional[models.User],
    action: str,
    object_type: str,
    object_id: Any,
    group_id: Optional[int] = None,
    detail: Optional[dict] = None,
    actor_kind: Optional[str] = None,
) -> None:
    db.add(
        models.AuditEvent(
            actor_user_id=actor.id if actor else None,
            actor_name=actor.username if actor else None,
            actor_kind=actor_kind or ("user" if actor else "system"),
            action=action,
            object_type=object_type,
            object_id=str(object_id),
            group_id=group_id,
            detail=detail or {},
        )
    )
