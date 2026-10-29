"""What a browser tab has on screen (D157), told by the tab itself: how Claude
Code, calling the MCP tools with a personal access token, knows which session
"here" is and which Builder editor it's helping with. Each tab says so when
its view changes and every half minute while it's open; nothing else reads
or shows it."""

from typing import Literal, Optional

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .. import auth, models, presence
from ..db import get_db

router = APIRouter(prefix="/api/screen", tags=["presence"])


class ScreenIn(BaseModel):
    view: Literal["home", "session", "builder", "workflows", "settings", "chat", "code", "other"]
    session_id: Optional[str] = Field(default=None, max_length=64)
    build_kind: Optional[Literal["pane", "workflow", "step", "credential", "connection"]] = None
    target_id: Optional[str] = Field(default=None, max_length=200)
    draft_id: Optional[int] = None
    timezone: Optional[str] = Field(default=None, max_length=64)
    visible: bool = True


@router.put("", status_code=204)
def show(payload: ScreenIn, db: Session = Depends(get_db), user: models.User = Depends(auth.get_current_user),
         origin: Optional[str] = Header(default=None, alias="X-Sync-Origin", max_length=64)):
    if not origin:
        raise HTTPException(status_code=400, detail="Say which tab this is (X-Sync-Origin).")
    presence.show(db, user.id, origin, payload.view, payload.session_id if payload.view == "session" else None,
                  payload.build_kind if payload.view == "builder" else None,
                  payload.target_id if payload.view == "builder" else None,
                  payload.draft_id if payload.view == "builder" else None, payload.timezone, payload.visible)
    return None
