"""/api/agent: who may talk to the agent, and the relay to its container.

The agent itself is stood in for by a small HTTP server that records what it
was sent and streams back a canned turn -- what's under test is this side:
the per-turn token (sent to the agent, never to the browser, gone when the
turn ends however it ends), the events passed through as they are, and a
readable error when the agent can't be reached."""

import json
import socket
import threading
import time

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse
from fastapi.testclient import TestClient

from app import models
from app.db import SessionLocal
from app.main import app
from app.platform_tools import tokens
from tests.conftest import client

received: list[dict] = []
stub = FastAPI()


@stub.post("/chat")
async def stub_chat(request: Request):
    body = await request.json()
    token = request.headers.get("x-platform-token")
    db = SessionLocal()
    try:
        caller = tokens.resolve(db, token) if token else None
    finally:
        db.close()
    received.append(
        {
            "body": body,
            "authorization": request.headers.get("authorization"),
            "token_valid": caller is not None,
            "timezone": caller.timezone if caller else None,
            "viewing": caller.viewing_session_id if caller else None,
        }
    )

    async def stream():
        yield 'data: {"type": "tool_call", "id": "c1", "name": "get_context", "args": {}}\n\n'
        yield ": heartbeat\n\n"
        yield 'data: {"type": "text", "delta": "Hello"}\n\n'
        yield 'data: {"type": "done"}\n\n'

    return StreamingResponse(stream(), media_type="text/event-stream")


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


_port = _free_port()
_server = uvicorn.Server(uvicorn.Config(stub, host="127.0.0.1", port=_port, log_level="warning"))
threading.Thread(target=_server.run, daemon=True).start()
while not _server.started:
    time.sleep(0.05)


def _events(text: str) -> list:
    out = []
    for block in text.split("\n\n"):
        block = block.strip()
        if block.startswith("data: "):
            out.append(json.loads(block[len("data: ") :]))
        elif block:
            out.append(block)
    return out


def _tokens_left() -> int:
    db = SessionLocal()
    try:
        return db.query(models.AgentToken).count()
    finally:
        db.close()


ASK = {"messages": [{"role": "user", "content": "hi"}], "viewing_session_id": "s-on-screen", "timezone": "Asia/Jerusalem"}


def test_status_says_whether_the_agent_runs_and_whether_you_may_use_it(monkeypatch):
    monkeypatch.delenv("AGENT_URL", raising=False)
    assert client.get("/api/agent/status").json() == {"available": False, "enabled": True}
    monkeypatch.setenv("AGENT_URL", f"http://127.0.0.1:{_port}")
    assert client.get("/api/agent/status").json() == {"available": True, "enabled": True}


def test_a_turn_is_relayed_with_a_token_that_is_gone_when_it_ends(monkeypatch):
    monkeypatch.setenv("AGENT_URL", f"http://127.0.0.1:{_port}")
    monkeypatch.setenv("AGENT_SERVICE_KEY", "svc-key")
    received.clear()
    resp = client.post("/api/agent/chat", json=ASK)
    assert resp.status_code == 200
    assert resp.headers["x-accel-buffering"] == "no"
    events = _events(resp.text)
    assert events == [
        {"type": "tool_call", "id": "c1", "name": "get_context", "args": {}},
        ": heartbeat",
        {"type": "text", "delta": "Hello"},
        {"type": "done"},
    ]

    sent = received[0]
    # The agent got a live token standing for this user, with where they are...
    assert sent["token_valid"] and sent["timezone"] == "Asia/Jerusalem" and sent["viewing"] == "s-on-screen"
    assert sent["authorization"] == "Bearer svc-key"
    assert sent["body"] == {"messages": [{"role": "user", "content": "hi"}]}
    # ...which the browser never saw, and which is revoked now the turn is over.
    assert "token" not in resp.text.lower()
    assert _tokens_left() == 0


def test_an_earlier_answers_steps_are_relayed_with_it(monkeypatch):
    # So the agent sees which tools an answer came from, not only its words.
    monkeypatch.setenv("AGENT_URL", f"http://127.0.0.1:{_port}")
    received.clear()
    step = {"name": "run_pane", "args": {"pane_id": "iot"}, "ok": False, "summary": "Environment 9 is not configured"}
    messages = [
        {"role": "user", "content": "search prod"},
        {"role": "assistant", "content": "That failed.", "steps": [step]},
        {"role": "user", "content": "again"},
    ]
    assert client.post("/api/agent/chat", json={**ASK, "messages": messages}).status_code == 200
    assert received[0]["body"]["messages"] == messages


def test_an_unreachable_agent_is_a_readable_error_and_still_revokes_the_token(monkeypatch):
    monkeypatch.setenv("AGENT_URL", f"http://127.0.0.1:{_free_port()}")
    resp = client.post("/api/agent/chat", json=ASK)
    assert resp.status_code == 200
    [event] = _events(resp.text)
    assert event["type"] == "error" and "couldn't be reached" in event["message"]
    assert _tokens_left() == 0


def test_who_may_ask(monkeypatch):
    monkeypatch.delenv("AGENT_URL", raising=False)
    assert client.post("/api/agent/chat", json=ASK).status_code == 503

    monkeypatch.setenv("AGENT_URL", f"http://127.0.0.1:{_port}")
    assistant_last = {"messages": [{"role": "user", "content": "a"}, {"role": "assistant", "content": "b"}]}
    assert client.post("/api/agent/chat", json=assistant_last).status_code == 400

    group = client.post("/api/user-groups", json={"name": "No agent"}).json()
    client.post("/api/users", json={"username": "carol", "password": "pw-123456", "group_id": group["id"]})
    client.post("/api/auth/login", json={"username": "carol", "password": "pw-123456"})
    resp = client.post("/api/agent/chat", json=ASK)
    assert resp.status_code == 403 and "admin" in resp.json()["detail"]
    assert client.get("/api/agent/status").json()["enabled"] is False
    assert _tokens_left() == 0


def test_a_session_chat_tells_the_agent_which_session_it_is_about(monkeypatch):
    monkeypatch.setenv("AGENT_URL", f"http://127.0.0.1:{_port}")
    resp = client.put("/api/live-sessions/s-chat", json={"type": "aggregator", "title": "Checkout", "state": {}})
    assert resp.status_code == 200
    received.clear()
    ask = {**ASK, "viewing_session_id": "s-chat", "scope": "session"}
    assert client.post("/api/agent/chat", json=ask).status_code == 200
    assert received[0]["body"]["focus"] == {"session_id": "s-chat", "title": "Checkout"}
    assert received[0]["viewing"] == "s-chat"

    # The global chat carries no focus, even with a session on screen.
    received.clear()
    client.post("/api/agent/chat", json={**ASK, "viewing_session_id": "s-chat"})
    assert "focus" not in received[0]["body"]


def test_a_session_chat_for_a_session_that_is_gone_is_refused(monkeypatch):
    monkeypatch.setenv("AGENT_URL", f"http://127.0.0.1:{_port}")
    resp = client.post("/api/agent/chat", json={**ASK, "viewing_session_id": "nope", "scope": "session"})
    assert resp.status_code == 404
    assert _tokens_left() == 0


def _login_as(username: str, password: str) -> TestClient:
    c = TestClient(app)
    resp = c.post("/api/auth/login", json={"username": username, "password": password})
    assert resp.status_code == 200, resp.text
    return c


def test_an_invited_member_can_also_talk_about_a_shared_session(monkeypatch):
    # Talking about it is reachable the same way the session itself is
    # (routers/live_sessions.py's _reachable) -- the agent's own tools still
    # can't act on it for anyone but the owner, only this initial gate.
    monkeypatch.setenv("AGENT_URL", f"http://127.0.0.1:{_port}")
    resp = client.put("/api/live-sessions/s-shared", json={"type": "aggregator", "title": "Shared", "state": {}})
    assert resp.status_code == 200

    group = client.post("/api/user-groups", json={"name": "chat-invitees", "role_name": "R", "agent_enabled": True})
    assert group.status_code == 201, group.text
    user = client.post(
        "/api/users", json={"username": "chatbob", "password": "pw-123456", "group_id": group.json()["id"]}
    )
    assert user.status_code == 201, user.text
    invite = client.post("/api/live-sessions/s-shared/members", json={"username": "chatbob", "permission": "viewer"})
    assert invite.status_code == 201, invite.text
    bob = _login_as("chatbob", "pw-123456")

    received.clear()
    ask = {**ASK, "viewing_session_id": "s-shared", "scope": "session"}
    resp = bob.post("/api/agent/chat", json=ask)
    assert resp.status_code == 200, resp.text
    assert received[0]["body"]["focus"] == {"session_id": "s-shared", "title": "Shared"}


def test_a_question_can_carry_its_attached_rows(monkeypatch):
    monkeypatch.setenv("AGENT_URL", f"http://127.0.0.1:{_port}")
    received.clear()
    big = "x" * 45_000
    resp = client.post("/api/agent/chat", json={"messages": [{"role": "user", "content": big}]})
    assert resp.status_code == 200 and received[0]["body"]["messages"][0]["content"] == big
