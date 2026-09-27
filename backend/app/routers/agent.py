"""The browser's way to the platform agent.

The agent runs in its own container, reachable only inside the cluster. A
chat turn comes here first, with the user's session cookie, and this is where
it's decided whether they may use the agent at all; then a token is minted
for the turn (platform_tools/tokens.py), the turn is relayed to the agent
container, and its event stream is passed back to the browser as it arrives.
The token is revoked the moment the stream ends, however it ends -- finished,
failed, or the browser gone.
"""

import json
import os
from typing import AsyncIterator, Literal, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .. import auth, models
from ..db import SessionLocal, get_db
from ..platform_tools import tokens

router = APIRouter(prefix="/api/agent", tags=["agent"])

# The agent's reads are bounded by its own heartbeats (every 15s) rather
# than by how long a turn takes, so this is "the agent has gone silent", not
# "the turn is slow".
READ_TIMEOUT_SECONDS = 60.0


def _agent_url() -> Optional[str]:
    return os.environ.get("AGENT_URL") or None


def _allowed(user: models.User) -> bool:
    return bool(user.group and user.group.agent_enabled)


class AgentStatus(BaseModel):
    # Whether this deployment runs an agent at all.
    available: bool
    # Whether the caller's group may use it.
    enabled: bool


@router.get("/status", response_model=AgentStatus)
def agent_status(current_user: models.User = Depends(auth.get_current_user)):
    return AgentStatus(available=_agent_url() is not None, enabled=_allowed(current_user))


class AgentMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=20_000)


class AgentChatRequest(BaseModel):
    # The conversation so far, the new message last. The browser holds the
    # conversation for now; each turn stands alone on the agent's side.
    messages: list[AgentMessage] = Field(min_length=1, max_length=60)
    # What the agent should know about where the user is: the session on
    # screen ("add a pane here") and their time zone ("since 9am").
    viewing_session_id: Optional[str] = Field(default=None, max_length=64)
    timezone: Optional[str] = Field(default=None, max_length=64)


def _event(payload: dict) -> str:
    return f"data: {json.dumps(payload)}\n\n"


@router.post("/chat")
async def agent_chat(
    payload: AgentChatRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    url = _agent_url()
    if url is None:
        raise HTTPException(status_code=503, detail="This deployment doesn't run the platform agent (AGENT_URL is unset).")
    if not _allowed(current_user):
        raise HTTPException(
            status_code=403,
            detail="The agent isn't turned on for your group. An admin can turn it on in Settings, under User groups.",
        )
    if payload.messages[-1].role != "user":
        raise HTTPException(status_code=400, detail="The last message has to be yours.")

    token = tokens.mint(db, current_user, timezone=payload.timezone, viewing_session_id=payload.viewing_session_id)
    # The stream can run for minutes; it needs nothing more from this
    # request's database session (revoking opens its own).
    db.close()
    headers = {"X-Platform-Token": token}
    service_key = os.environ.get("AGENT_SERVICE_KEY")
    if service_key:
        headers["Authorization"] = f"Bearer {service_key}"
    body = {"messages": [m.model_dump() for m in payload.messages]}

    async def relay() -> AsyncIterator[str]:
        try:
            timeout = httpx.Timeout(10.0, read=READ_TIMEOUT_SECONDS)
            async with httpx.AsyncClient(timeout=timeout) as client:
                async with client.stream("POST", f"{url.rstrip('/')}/chat", json=body, headers=headers) as response:
                    if response.status_code != 200:
                        detail = (await response.aread()).decode("utf-8", "replace")
                        try:
                            detail = json.loads(detail).get("detail", detail)
                        except (ValueError, AttributeError):
                            pass
                        yield _event({"type": "error", "message": f"The agent refused the request: {detail}"})
                        return
                    # Passed through line by line, heartbeats included, so the
                    # browser sees each step the moment the agent takes it.
                    async for line in response.aiter_lines():
                        yield line + "\n"
        except httpx.HTTPError as e:
            yield _event({"type": "error", "message": f"The agent couldn't be reached ({type(e).__name__})."})
        finally:
            revoking = SessionLocal()
            try:
                tokens.revoke(revoking, token)
            finally:
                revoking.close()

    return StreamingResponse(
        relay(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
