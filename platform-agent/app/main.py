"""The platform agent's HTTP surface: POST /chat, streamed, and /health.

Only the backend calls this. The browser talks to the backend (which knows
who the user is), and the backend calls here with the conversation and the
turn's token; this container never sees a user's cookie and has no database.
"""

import asyncio
import json
import logging
import secrets
from typing import AsyncIterator, Literal, Optional

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from . import config
from .agent import run_turn

logging.basicConfig(level=logging.INFO)

settings = config.load()
app = FastAPI(title="Platform agent")

# Well inside the 60s idle timeouts of the nginx proxies between here and the
# browser: a turn waiting a minute on a CloudWatch query would otherwise have
# its stream cut halfway.
HEARTBEAT_SECONDS = 15.0

MAX_MESSAGES = 60
# The backend's own limit: a question with the rows it's about attached.
MAX_MESSAGE_CHARS = 60_000


class HistoryStep(BaseModel):
    """A tool an earlier answer used, as the browser kept it: what was
    called, whether it worked, and the start of what it returned."""

    id: Optional[str] = Field(default=None, max_length=100)
    name: str = Field(max_length=100)
    args: dict = Field(default_factory=dict)
    ok: bool = True
    summary: str = Field(default="", max_length=2_000)


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=MAX_MESSAGE_CHARS)
    # An assistant message's tool steps, so the model sees what it actually
    # ran (and for whom) rather than only what it said.
    steps: Optional[list[HistoryStep]] = Field(default=None, max_length=40)


class Focus(BaseModel):
    """The session a session-scoped chat belongs to."""

    session_id: str = Field(max_length=64)
    title: str = Field(max_length=200)


class ChatRequest(BaseModel):
    messages: list[ChatMessage] = Field(min_length=1, max_length=MAX_MESSAGES)
    focus: Optional[Focus] = None


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "model_configured": settings.configured}


def _check_service_key(authorization: Optional[str]) -> None:
    if not settings.service_key:
        return
    scheme, _, key = (authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not secrets.compare_digest(key.strip(), settings.service_key):
        raise HTTPException(status_code=401, detail="This endpoint is for the platform's backend only.")


@app.post("/chat")
async def chat(
    payload: ChatRequest,
    authorization: Optional[str] = Header(default=None),
    x_platform_token: Optional[str] = Header(default=None),
) -> StreamingResponse:
    _check_service_key(authorization)
    if not x_platform_token:
        raise HTTPException(status_code=400, detail="A turn needs the user's platform token (X-Platform-Token).")
    if payload.messages[-1].role != "user":
        raise HTTPException(status_code=400, detail="The last message of a turn has to be the user's.")
    if not settings.configured:
        raise HTTPException(
            status_code=503,
            detail="The agent has no model configured: set LITELLM_BASE_URL, LITELLM_API_KEY and AGENT_MODEL "
            "(or LITELLM_MODEL).",
        )
    events = run_turn(
        settings,
        [m.model_dump(exclude_none=True) for m in payload.messages],
        x_platform_token,
        focus=payload.focus.model_dump() if payload.focus else None,
    )
    return StreamingResponse(
        sse(events),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


async def sse(events: AsyncIterator[dict]) -> AsyncIterator[str]:
    """The turn's events as server-sent events, with a comment line whenever
    it has been quiet for a while so no proxy on the way decides it's dead."""
    queue: asyncio.Queue = asyncio.Queue()
    finished = object()

    async def pump() -> None:
        try:
            async for event in events:
                await queue.put(event)
        except Exception as e:  # noqa: BLE001 -- run_turn reports its own; this is the backstop
            await queue.put({"type": "error", "message": f"The agent stopped with an error: {e}"})
        finally:
            await queue.put(finished)

    task = asyncio.create_task(pump())
    try:
        while True:
            try:
                event = await asyncio.wait_for(queue.get(), timeout=HEARTBEAT_SECONDS)
            except asyncio.TimeoutError:
                yield ": heartbeat\n\n"
                continue
            if event is finished:
                return
            yield f"data: {json.dumps(event)}\n\n"
    finally:
        # The browser left (or the turn ended): stop the model and the tools
        # rather than letting them run on for no one.
        task.cancel()
