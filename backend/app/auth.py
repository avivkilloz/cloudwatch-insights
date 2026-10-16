import datetime
import secrets

import bcrypt
from fastapi import Cookie, Depends, HTTPException
from sqlalchemy.orm import Session as DbSession

from . import models, schemas
from .db import get_db

SESSION_COOKIE_NAME = "cw_session"
SESSION_TTL = datetime.timedelta(days=7)


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))
    except ValueError:
        # A malformed/foreign hash (shouldn't happen, but bcrypt raises
        # rather than just returning False for one) -- treat as no match.
        return False


def create_session(db: DbSession, user: models.User) -> models.Session:
    session = models.Session(
        id=secrets.token_urlsafe(32),
        user_id=user.id,
        expires_at=datetime.datetime.utcnow() + SESSION_TTL,
    )
    db.add(session)
    db.commit()
    return session


def delete_session(db: DbSession, session_id: str) -> None:
    session = db.get(models.Session, session_id)
    if session:
        db.delete(session)
        db.commit()


def get_current_user(
    db: DbSession = Depends(get_db),
    session_id: str | None = Cookie(default=None, alias=SESSION_COOKIE_NAME),
) -> models.User:
    if not session_id:
        raise HTTPException(status_code=401, detail="Not logged in")
    session = db.get(models.Session, session_id)
    if not session or session.expires_at < datetime.datetime.utcnow():
        raise HTTPException(status_code=401, detail="Session expired or invalid")
    user = db.get(models.User, session.user_id)
    if not user:
        raise HTTPException(status_code=401, detail="Session expired or invalid")
    return user


def require_admin(current_user: models.User = Depends(get_current_user)) -> models.User:
    if not current_user.group or not current_user.group.is_admin:
        raise HTTPException(status_code=403, detail="Admin access required")
    return current_user


def user_out(user: models.User) -> schemas.UserOut:
    from . import pane_access

    group = user.group
    # The old per-page booleans, as the grants say them (D65).
    flags = pane_access.legacy_flags(group) if group else {}
    return schemas.UserOut(
        id=user.id,
        username=user.username,
        group_id=user.group_id,
        group_name=group.name if group else "",
        is_admin=bool(group and group.is_admin),
        avatar_url=user.avatar_url,
        logs_enabled=flags.get("logs_enabled", False),
        opensearch_enabled=flags.get("opensearch_enabled", False),
        iot_enabled=flags.get("iot_enabled", False),
        tables_enabled=flags.get("tables_enabled", False),
        buckets_enabled=flags.get("buckets_enabled", False),
        cognito_enabled=flags.get("cognito_enabled", False),
        aggregator_enabled=group.aggregator_enabled if group else False,
        tools_enabled=flags.get("tools_enabled", False),
        agent_enabled=group.agent_enabled if group else False,
        pane_types=sorted(pane_access.granted(group)),
    )
