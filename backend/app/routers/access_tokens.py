"""Personal access tokens (D156): how a user's own MCP client -- Claude Code
in their terminal -- calls the platform's tools as them, at /api/mcp.

Made by their user, for the user's own use: the token is in the reply to the
create and nowhere else, ever (only its hash is kept). Making one needs the
agent for the user's group, as a chat turn does -- the tools are the agent's
-- and every call through one checks that again. A user lists and revokes
their own; an admin sees and revokes everyone's, never the tokens themselves.
Both are audited."""

import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .. import audit, auth, models
from ..db import get_db
from ..platform_tools import tokens

router = APIRouter(prefix="/api/access-tokens", tags=["access-tokens"])

# Enough for a laptop, a desktop and a few experiments; a list past this is a
# leak waiting to happen, not a need.
MAX_ACTIVE = 20
# A year at most: a token that never expires is one nobody remembers making.
MAX_DAYS = 365


class TokenIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    # Days until it stops working; 0 for the longest allowed.
    days: int = Field(default=90, ge=0, le=MAX_DAYS)


class TokenOut(BaseModel):
    id: int
    name: str
    prefix: str
    created_at: datetime.datetime
    expires_at: Optional[datetime.datetime] = None
    last_used_at: Optional[datetime.datetime] = None
    revoked_at: Optional[datetime.datetime] = None
    # Whose it is -- in the admin's list.
    username: Optional[str] = None


class TokenMade(TokenOut):
    # The token itself: in this reply only.
    token: str


def _out(db: Session, row: models.AccessToken, with_user: bool = False) -> dict:
    user = db.get(models.User, row.user_id) if with_user else None
    return {"id": row.id, "name": row.name, "prefix": row.prefix, "created_at": row.created_at,
            "expires_at": row.expires_at, "last_used_at": row.last_used_at, "revoked_at": row.revoked_at,
            **({"username": user.username if user else None} if with_user else {})}


def _active(db: Session, user_id: int):
    now = datetime.datetime.utcnow()
    return (db.query(models.AccessToken)
            .filter(models.AccessToken.user_id == user_id, models.AccessToken.revoked_at.is_(None))
            .filter((models.AccessToken.expires_at.is_(None)) | (models.AccessToken.expires_at > now)))


@router.get("", response_model=list[TokenOut])
def list_mine(db: Session = Depends(get_db), user: models.User = Depends(auth.get_current_user)):
    rows = (db.query(models.AccessToken).filter_by(user_id=user.id)
            .order_by(models.AccessToken.created_at.desc()).all())
    return [_out(db, r) for r in rows]


@router.get("/all", response_model=list[TokenOut])
def list_all(db: Session = Depends(get_db), _admin: models.User = Depends(auth.require_admin)):
    rows = db.query(models.AccessToken).order_by(models.AccessToken.created_at.desc()).all()
    return [_out(db, r, with_user=True) for r in rows]


@router.post("", response_model=TokenMade, status_code=201)
def make(payload: TokenIn, db: Session = Depends(get_db), user: models.User = Depends(auth.get_current_user)):
    if not (user.group and user.group.agent_enabled):
        raise HTTPException(status_code=403, detail="Access tokens call the agent's tools, and the agent isn't "
                            "turned on for your group. Ask an admin to turn it on.")
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Give the token a name, so you know where it's used.")
    if _active(db, user.id).count() >= MAX_ACTIVE:
        raise HTTPException(status_code=400, detail=f"You have {MAX_ACTIVE} tokens that still work; revoke one "
                            "you no longer use first.")
    days = payload.days or MAX_DAYS
    row, token = tokens.mint_personal(db, user, name, datetime.datetime.utcnow() + datetime.timedelta(days=days))
    db.flush()
    audit.record(db, actor=user, action="access_token.create", object_type="access_token", object_id=row.id,
                 group_id=user.group_id, detail={"name": name, "days": days})
    db.commit()
    return {**_out(db, row), "token": token}


@router.delete("/{token_id}", status_code=204)
def revoke(token_id: int, db: Session = Depends(get_db), user: models.User = Depends(auth.get_current_user)):
    row = db.get(models.AccessToken, token_id)
    if row is None or (row.user_id != user.id and not (user.group and user.group.is_admin)):
        raise HTTPException(status_code=404, detail="There is no such token of yours.")
    if row.revoked_at is None:
        row.revoked_at = datetime.datetime.utcnow()
        owner = db.get(models.User, row.user_id)
        audit.record(db, actor=user, action="access_token.revoke", object_type="access_token", object_id=row.id,
                     group_id=owner.group_id if owner else None, detail={"name": row.name,
                                                                          "owner": owner.username if owner else None})
        db.commit()
    return None
