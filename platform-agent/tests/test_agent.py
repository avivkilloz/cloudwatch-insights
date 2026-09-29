"""The agent container, driven for real: LangChain's agent, the MCP adapter
and the streamed events, against a stub MCP server and the scripted model in
dev/fake_llm.py -- both served over HTTP in-process, so nothing here is
mocked below the network.

The backend's own MCP tools are tested in backend/tests; what matters here is
the turn: that the user's token reaches the tools, that tool calls and
results come out as the events the browser draws, that a failing tool is
reported to the model rather than ending the turn, and that the stream stays
alive through a slow step."""

import asyncio
import json
import socket
import threading
import time

import pytest
import uvicorn
from fastapi.testclient import TestClient
from mcp.server.fastmcp import Context, FastMCP
from mcp.server.fastmcp.exceptions import ToolError

from app import main as agent_main
from app.agent import run_turn
from app.config import Settings
from dev import fake_llm

TOKEN = "turn-token-123"
seen_auth: list[str] = []

stub = FastMCP("stub", stateless_http=True, json_response=True)


def _auth(ctx: Context) -> None:
    seen_auth.append(ctx.request_context.request.headers.get("authorization", ""))


# Who the stub says is asking -- a test changes it to play a second person
# in a shared chat.
CONTEXT = {"user": "admin", "environments": [{"id": 1, "name": "IoT Test"}], "viewing_session": None}


@stub.tool()
async def get_context(ctx: Context) -> dict:
    _auth(ctx)
    return CONTEXT


@stub.tool()
async def get_session(session_id: str, ctx: Context) -> dict:
    _auth(ctx)
    return {"session_id": session_id, "title": "Checkout", "panes": [{"pane_id": "iot", "kind": "iot"}]}


@stub.tool()
async def create_session(title: str, panes: list[dict], ctx: Context) -> dict:
    _auth(ctx)
    return {"session_id": "s-new", "title": title, "panes": panes}


@stub.tool()
async def run_pane(session_id: str, pane_id: str, ctx: Context, inputs: dict | None = None) -> dict:
    _auth(ctx)
    if session_id == "no-such-session":
        raise ToolError("There is no session with id 'no-such-session'.")
    return {"session_id": session_id, "pane_id": pane_id, "output": "aGk="}


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _serve(app) -> tuple[uvicorn.Server, int]:
    port = _free_port()
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    threading.Thread(target=server.run, daemon=True).start()
    deadline = time.time() + 10
    while not server.started:
        if time.time() > deadline:
            raise RuntimeError("test server didn't start")
        time.sleep(0.05)
    return server, port


@pytest.fixture(scope="module")
def settings():
    mcp_server, mcp_port = _serve(stub.streamable_http_app())
    llm_server, llm_port = _serve(fake_llm.app)
    yield Settings(
        llm_base_url=f"http://127.0.0.1:{llm_port}",
        llm_api_key="dev",
        model="fake",
        mcp_url=f"http://127.0.0.1:{mcp_port}/mcp",
        service_key=None,
        max_steps=20,
    )
    mcp_server.should_exit = True
    llm_server.should_exit = True


def _events(settings: Settings, text: str, focus: dict | None = None, earlier: list[dict] | None = None) -> list[dict]:
    messages = [*(earlier or []), {"role": "user", "content": text}]

    async def collect():
        return [e async for e in run_turn(settings, messages, TOKEN, focus=focus)]

    return asyncio.run(collect())


def _answer(events: list[dict]) -> str:
    """The answer as the browser ends up holding it: text deltas appended,
    retracts taking characters back off the end."""
    answer = ""
    for e in events:
        if e["type"] == "text":
            answer += e["delta"]
        elif e["type"] == "retract":
            answer = answer[: len(answer) - e["chars"]]
    return answer


def test_a_turn_calls_the_tools_with_the_users_token_and_streams_what_happened(settings):
    seen_auth.clear()
    events = _events(settings, "encode hi")

    # Every turn opens with a fresh read of the context, before the model
    # says anything; then the model's own calls.
    assert events[0] == {"type": "tool_call", "id": "turn-context", "name": "get_context", "args": {}, "preamble": True}
    calls = [e["name"] for e in events if e["type"] == "tool_call" and not e.get("preamble")]
    assert calls == ["get_context", "create_session", "run_pane"]
    results = [e for e in events if e["type"] == "tool_result"]
    assert all(r["ok"] for r in results)
    # The session a tool touched rides on its result, for the browser to follow.
    assert [r.get("session_id") for r in results] == [None, None, "s-new", "s-new"]
    text = "".join(e["delta"] for e in events if e["type"] == "text")
    assert "aGk=" in text
    # Streamed as it came, not in one piece.
    assert len([e for e in events if e["type"] == "text"]) > 3
    assert events[-1] == {"type": "done"}
    assert seen_auth and all(a == f"Bearer {TOKEN}" for a in seen_auth)


def test_a_failing_tool_is_told_to_the_model_rather_than_ending_the_turn(settings):
    events = _events(settings, "break")
    result = next(e for e in events if e["type"] == "tool_result" and e["id"] != "turn-context")
    assert result["ok"] is False and "no-such-session" in result["summary"]
    assert "session_id" not in result
    text = "".join(e["delta"] for e in events if e["type"] == "text")
    assert "didn't work" in text and "no-such-session" in text
    assert events[-1] == {"type": "done"}


def test_tools_that_cannot_be_reached_end_the_turn_with_a_readable_error(settings):
    unreachable = Settings(**{**settings.__dict__, "mcp_url": f"http://127.0.0.1:{_free_port()}/mcp"})
    events = _events(unreachable, "encode hi")
    assert len(events) == 1 and events[0]["type"] == "error"
    assert "couldn't reach the platform's tools" in events[0]["message"]
    # The token is a credential: it never appears in anything the user sees.
    assert TOKEN not in json.dumps(events)


def test_the_stream_sends_heartbeats_through_a_slow_step(monkeypatch):
    monkeypatch.setattr(agent_main, "HEARTBEAT_SECONDS", 0.05)

    async def slow():
        await asyncio.sleep(0.2)
        yield {"type": "done"}

    async def collect():
        return [line async for line in agent_main.sse(slow())]

    lines = asyncio.run(collect())
    assert lines[0] == ": heartbeat\n\n"
    assert lines[-1] == 'data: {"type": "done"}\n\n'


def test_chat_checks_its_caller_and_its_input(monkeypatch):
    configured = Settings(
        llm_base_url="http://x", llm_api_key="k", model="m", mcp_url="http://x/mcp", service_key="svc", max_steps=5
    )
    monkeypatch.setattr(agent_main, "settings", configured)
    client = TestClient(agent_main.app)
    body = {"messages": [{"role": "user", "content": "hi"}]}

    assert client.post("/chat", json=body, headers={"X-Platform-Token": "t"}).status_code == 401
    ok_key = {"Authorization": "Bearer svc"}
    assert client.post("/chat", json=body, headers=ok_key).status_code == 400
    assistant_last = {"messages": [{"role": "user", "content": "a"}, {"role": "assistant", "content": "b"}]}
    resp = client.post("/chat", json=assistant_last, headers={**ok_key, "X-Platform-Token": "t"})
    assert resp.status_code == 400

    monkeypatch.setattr(agent_main, "settings", Settings(**{**configured.__dict__, "model": None}))
    resp = client.post("/chat", json=body, headers={**ok_key, "X-Platform-Token": "t"})
    assert resp.status_code == 503 and "AGENT_MODEL" in resp.json()["detail"]


def test_a_session_chat_tells_the_model_which_session_it_is_about(settings):
    fake_llm.REQUESTS.clear()
    events = _events(settings, "rows\n\n---\nChecked rows attached (2, from CloudWatch):\n[]", focus={"session_id": "s1", "title": "Checkout"})
    system = fake_llm.REQUESTS[0]["messages"][0]
    assert system["role"] == "system"
    assert 'chat of one session: "Checkout" (session_id s1)' in system["content"]
    text = "".join(e["delta"] for e in events if e["type"] == "text")
    assert "You attached 2 rows, from CloudWatch" in text

    # The global chat's prompt says nothing of a session.
    fake_llm.REQUESTS.clear()
    _events(settings, "hello")
    assert "chat of one session" not in fake_llm.REQUESTS[0]["messages"][0]["content"]


def test_a_session_chat_starts_from_the_session_as_it_is_now(settings):
    fake_llm.REQUESTS.clear()
    events = _events(settings, "hello", focus={"session_id": "s1", "title": "Checkout"})
    reads = [e for e in events if e["type"] == "tool_call" and e.get("preamble")]
    assert [(r["name"], r["args"]) for r in reads] == [("get_context", {}), ("get_session", {"session_id": "s1"})]
    system = fake_llm.REQUESTS[0]["messages"][0]["content"]
    assert "get_session (this chat's session):" in system and '"pane_id":"iot"' in system


def test_the_context_is_whoever_asked_this_turn_not_what_an_earlier_answer_said(settings, monkeypatch):
    # A shared chat: someone without IoT Prod asked first and was told there
    # isn't one. When someone who has it asks, the turn's own read is theirs.
    earlier = [
        {"role": "user", "content": "avivil-backend: search iot prod"},
        {
            "role": "assistant",
            "content": "There is no IoT Prod environment available.",
            "steps": [{"name": "get_context", "args": {}, "ok": True, "summary": '{"user": "avivil-backend"}'}],
        },
    ]
    monkeypatch.setitem(CONTEXT, "user", "avivil")
    monkeypatch.setitem(CONTEXT, "environments", [{"id": 1, "name": "IoT Test"}, {"id": 9, "name": "IoT Prod"}])
    fake_llm.REQUESTS.clear()
    events = _events(settings, "whoami", earlier=earlier)
    assert "You're avivil, and you can reach: IoT Test, IoT Prod." in _answer(events)

    # And the earlier answer went back to the model with the call behind it,
    # not as bare words.
    sent = fake_llm.REQUESTS[0]["messages"]
    calls = [m for m in sent if m.get("tool_calls")]
    assert calls and calls[0]["tool_calls"][0]["function"]["name"] == "get_context"
    tool = next(m for m in sent if m.get("role") == "tool")
    assert "avivil-backend" in tool["content"]
    assert sent[-2] == {"role": "assistant", "content": "There is no IoT Prod environment available."}


def test_reasoning_is_kept_apart_from_the_answer(settings):
    events = _events(settings, "think")
    answer = _answer(events)
    assert "</think>" not in answer and "<think>" not in answer
    assert answer == "Creating it now.\n\nDone: the Thought session is open."
    thinking = "".join(e["delta"] for e in events if e["type"] == "thinking")
    assert "I should create one first." in thinking and "I'll say so briefly." in thinking
    assert "</think>" not in thinking
    # Still a real turn: the call between the two steps happened.
    assert [e["name"] for e in events if e["type"] == "tool_call" and not e.get("preamble")] == ["create_session"]
    assert events[-1] == {"type": "done"}


def test_a_step_going_round_in_circles_is_stopped(settings):
    started = time.monotonic()
    events = _events(settings, "loop")
    assert events[-1]["type"] == "error" and "repeating itself" in events[-1]["message"]
    # Stopped early, not after all thirty rounds -- and the rounds shown are
    # taken back, so the chat isn't left holding a wall of them.
    assert time.monotonic() - started < 10
    assert _answer(events) == ""


def test_an_answer_with_rows_no_tool_returned_carries_a_notice(settings):
    events = _events(settings, "invent")
    notice = next(e for e in events if e["type"] == "notice")
    assert "test-device-001" in notice["message"]
    assert events[-1] == {"type": "done"}

    # One built from what the tools did return carries none.
    events = _events(settings, "encode hi")
    assert not [e for e in events if e["type"] == "notice"]
