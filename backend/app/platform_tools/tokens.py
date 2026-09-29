"""The per-turn credential the platform agent calls the MCP tools with.

A chat turn arrives from the browser with the user's session cookie. The
backend mints one of these for the turn, hands it to the agent container, and
revokes it when the turn ends; the agent sends it back as a bearer token on
every MCP call, and that is how a tool knows whose sessions, environments and
IAM role it is acting with. The browser never sees it and the agent never
sees the cookie, so neither can be used to stand in for the other.
"""

import datetime
import hashlib
import secrets
from dataclasses import dataclass
from typing import Optional

from sqlalchemy.orm import Session as DbSession

from .. import models

# Long enough for a turn that runs several slow queries back to back, short
# enough that a token leaked from a crashed turn is soon worthless. A turn
# that ends cleanly revokes its token straight away.
TOKEN_TTL = datetime.timedelta(minutes=15)


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def mint(
    db: DbSession,
    user: models.User,
    timezone: Optional[str] = None,
    viewing_session_id: Optional[str] = None,
    session_scope_id: Optional[int] = None,
) -> str:
    now = datetime.datetime.utcnow()
    # Expired tokens of turns that never ended cleanly go whenever a new one
    # is made, so the table never grows past the turns in flight.
    db.query(models.AgentToken).filter(models.AgentToken.expires_at < now).delete()
    token = secrets.token_urlsafe(32)
    db.add(
        models.AgentToken(
            token_hash=_hash(token),
            user_id=user.id,
            expires_at=now + TOKEN_TTL,
            timezone=timezone[:64] if timezone else None,
            viewing_session_id=viewing_session_id[:64] if viewing_session_id else None,
            session_scope_id=session_scope_id,
        )
    )
    db.commit()
    return token


@dataclass(frozen=True)
class Caller:
    """Who an MCP call is acting for, and what their turn knows about them."""

    user_id: int
    timezone: Optional[str]
    viewing_session_id: Optional[str]
    # The row id of the session a session chat's turn is held to; None for a
    # Global turn, which may work in any session the user can reach.
    session_scope_id: Optional[int] = None


def resolve(db: DbSession, token: str) -> Optional[Caller]:
    """The caller a token stands for, or None if it is unknown, expired, or
    its user's group no longer has the agent. The flag is checked on every
    call, not only when the turn starts, so turning the agent off for a group
    stops a turn that is already running."""
    row = db.get(models.AgentToken, _hash(token))
    if row is None or row.expires_at < datetime.datetime.utcnow():
        return None
    user = db.get(models.User, row.user_id)
    if user is None or user.group is None or not user.group.agent_enabled:
        return None
    return Caller(
        user_id=user.id,
        timezone=row.timezone,
        viewing_session_id=row.viewing_session_id,
        session_scope_id=row.session_scope_id,
    )


def revoke(db: DbSession, token: str) -> None:
    db.query(models.AgentToken).filter(models.AgentToken.token_hash == _hash(token)).delete()
    db.commit()
