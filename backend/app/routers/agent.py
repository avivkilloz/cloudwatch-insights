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

from .. import auth, live_store, models
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


# What each kind of editor is called, for a new one's title.
NOUNS = {"pane": "pane type", "workflow": "workflow", "step": "step type"}


class AgentStatus(BaseModel):
    # Whether this deployment runs an agent at all.
    available: bool
    # Whether the caller's group may use it.
    enabled: bool


@router.get("/status", response_model=AgentStatus)
def agent_status(current_user: models.User = Depends(auth.get_current_user)):
    return AgentStatus(available=_agent_url() is not None, enabled=_allowed(current_user))


# Room for a question with the rows it's about attached (the browser caps
# what it attaches well below this).
MAX_MESSAGE_CHARS = 60_000


class AgentHistoryStep(BaseModel):
    """A tool an earlier answer used -- relayed so the agent sees what it
    actually ran, not only what it said it ran."""

    # The provider's own id for the call, replayed as it was (see the agent's
    # conversation()).
    id: Optional[str] = Field(default=None, max_length=100)
    name: str = Field(max_length=100)
    args: dict = Field(default_factory=dict)
    ok: bool = True
    summary: str = Field(default="", max_length=2_000)


class AgentMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=MAX_MESSAGE_CHARS)
    steps: Optional[list[AgentHistoryStep]] = Field(default=None, max_length=40)


class BuildFocus(BaseModel):
    """The editor a "build" chat sits beside: what it holds (a pane type or
    a workflow), its id once saved, and its text as it is now -- unsaved,
    the user's, and newer than anything the store has."""

    kind: Literal["pane", "workflow", "step"]
    id: Optional[str] = Field(default=None, max_length=200)
    title: str = Field(default="", max_length=200)
    source: str = Field(default="", max_length=MAX_MESSAGE_CHARS)
    # The files beside it (D136): a pane's or a step's Python.
    files: dict[str, str] = {}
    # The environment its builder chose to try a pane type on (D153), and
    # whether this turn is that choice: the Builder then tries it at once.
    try_on: Optional[str] = Field(default=None, max_length=200)
    try_now: bool = False
    # "Fix what's left": the Builder reads what's left from the draft itself.
    fix_now: bool = False


class AgentChatRequest(BaseModel):
    # The conversation so far, the new message last. The browser holds the
    # conversation for now; each turn stands alone on the agent's side.
    messages: list[AgentMessage] = Field(min_length=1, max_length=60)
    # What the agent should know about where the user is: the session on
    # screen ("add a pane here") and their time zone ("since 9am").
    viewing_session_id: Optional[str] = Field(default=None, max_length=64)
    timezone: Optional[str] = Field(default=None, max_length=64)
    # "global": the platform-wide chat, free to create and change any
    # session. "session": the chat of the session in viewing_session_id,
    # which the agent is told to keep to. "run": a workflow run's own chat
    # (D98), about the run in run_id. "build": beside an editor (D107),
    # about the definition in `build`.
    scope: Literal["global", "session", "run", "build"] = "global"
    run_id: Optional[int] = None
    build: Optional[BuildFocus] = None


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
    focus = None
    scope_id = None
    if payload.scope == "session":
        # Reachable, not just owned -- an invited member can talk about a
        # session shared with them the same as its owner can, and the
        # agent's tools act on it for them within their own permission.
        row, _ = (
            live_store.reachable(db, current_user.id, payload.viewing_session_id)
            if payload.viewing_session_id
            else (None, None)
        )
        if row is None:
            raise HTTPException(status_code=404, detail="That session doesn't exist any more, so there's nothing to talk about.")
        focus = {"session_id": row.client_id, "title": row.title}
        scope_id = row.id
    elif payload.scope == "run":
        # Its readers' only (D84): the turn reads the run's outputs.
        from .. import workflows

        run = db.get(models.WorkflowRun, payload.run_id) if payload.run_id else None
        workflow = db.get(models.Workflow, run.workflow_id) if run else None
        if run is None or workflow is None or not workflows.can_read(current_user, run):
            raise HTTPException(status_code=404, detail="That run isn't there for you, so there's nothing to talk about.")
        focus = {"kind": "run", "run_id": run.id, "title": f"{workflow.label} #{run.number}"}
    elif payload.scope == "build":
        # Whoever may edit it, as on its page: the agent's build tools check
        # the same again for every call.
        from .. import builder

        build = payload.build
        if build is None:
            raise HTTPException(status_code=400, detail="A build chat needs the editor it's about.")
        if build.kind == "workflow":
            # As its editor (D121): a new one is any builder's or admin's; an
            # existing one, an admin's or its group's builders'.
            from .. import workflows

            existing = db.get(models.Workflow, build.id) if build.id else None
            allowed = workflows.can_edit(current_user, existing)
        else:
            allowed = builder.can_build(current_user)
        if not allowed:
            raise HTTPException(
                status_code=403,
                detail="Only an admin, or a builder of the group that made it, edits this workflow."
                if build.kind == "workflow" else "Building pane types and steps isn't turned on for your group.",
            )
        focus = {
            "kind": "build",
            "what": build.kind,
            "title": build.title or build.id or f"New {NOUNS[build.kind]}",
            "source": build.source,
            "files": build.files,
            **({"id": build.id} if build.id else {}),
            **({"try_on": build.try_on} if build.try_on else {}),
            **({"try_now": True} if build.try_now else {}),
            **({"fix_now": True} if build.fix_now else {}),
        }

    token = tokens.mint(
        db,
        current_user,
        timezone=payload.timezone,
        viewing_session_id=payload.viewing_session_id,
        session_scope_id=scope_id,
        build={"kind": payload.build.kind, "id": payload.build.id, "source": payload.build.source,
               "files": payload.build.files}
        if payload.scope == "build" and payload.build is not None
        else None,
    )
    # The stream can run for minutes; it needs nothing more from this
    # request's database session (revoking opens its own).
    db.close()
    if payload.scope == "build":
        # The Builder may run as an agent of its own (D116: Helm's
        # agent.builder.deployment), with its own model and replicas; the same
        # image, the same token, the same tools.
        url = os.environ.get("AGENT_BUILDER_URL") or url
    headers = {"X-Platform-Token": token}
    service_key = os.environ.get("AGENT_SERVICE_KEY")
    if service_key:
        headers["Authorization"] = f"Bearer {service_key}"
    body: dict = {"messages": [m.model_dump(exclude_none=True) for m in payload.messages]}
    if focus:
        body["focus"] = focus

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
