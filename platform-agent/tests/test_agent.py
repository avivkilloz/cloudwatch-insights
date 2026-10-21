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
import re
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


# Sessions whose pane run_pane started -- what the answer check reads back.
RUNNING: set[str] = set()


@stub.tool()
async def get_session(session_id: str, ctx: Context) -> dict:
    _auth(ctx)
    run = {"status": "running"} if session_id in RUNNING else {"status": "not running"}
    return {"session_id": session_id, "title": "Checkout", "panes": [{"pane_id": "iot", "kind": "iot", "run": run}]}


@stub.tool()
async def get_workflow_run(run_id: int, ctx: Context) -> dict:
    _auth(ctx)
    return {"id": run_id, "number": 3, "status": "failed", "steps": [{"id": "scan", "status": "failed", "error": "Throttled"}]}


@stub.tool()
async def set_pane_inputs(session_id: str, pane_id: str, inputs: dict, ctx: Context) -> dict:
    _auth(ctx)
    return {"session_id": session_id, "pane": {"pane_id": pane_id, "inputs": inputs}, "note": "Only the inputs changed; nothing ran."}


@stub.tool()
async def create_session(title: str, panes: list[dict], ctx: Context) -> dict:
    _auth(ctx)
    return {"session_id": "s-new", "title": title, "panes": panes}


@stub.tool()
async def run_pane(session_id: str, pane_id: str, ctx: Context, inputs: dict | None = None) -> dict:
    _auth(ctx)
    if session_id == "no-such-session":
        raise ToolError("There is no session with id 'no-such-session'.")
    RUNNING.add(session_id)
    return {"session_id": session_id, "pane_id": pane_id, "output": "aGk="}


@stub.tool()
async def build_reference(kind: str, ctx: Context) -> dict:
    _auth(ctx)
    return {"kind": kind, "manifest": {"label": "str (required)"}, "live_functions": ["base64.convert"]}


@stub.tool()
async def check_definition(kind: str, source: str, ctx: Context, definition_id: str | None = None) -> dict:
    _auth(ctx)
    return {"ok": source.startswith("label: "), "errors": []}


# The turn's working draft, as the backend keeps it on the token (D114); the
# stub's changes go by path over plain data, its check is two rules of the
# real one -- enough for the Builder's loop to meet a problem and fix it.
DRAFT: dict = {"source": "", "files": {}}


def _stub_problems(data: dict) -> list[dict]:
    outputs = {o.get("key") for o in data.get("outputs") or []}
    errors = []
    for card in data.get("layout") or []:
        for item in card.get("items") or []:
            if item.get("output") and item["output"] not in outputs:
                errors.append({"line": 3, "message": f"the layout names an output {item['output']} that isn't declared"})
    for action in data.get("actions") or []:
        request = action.get("request") or {}
        if request.get("operation") == "ListJobs" and (request.get("rows") or {}).get("at") != "jobs":
            errors.append({"line": 7, "message": "ListJobs's reply: there is no items at jobs. Its lists are at: jobs."})
    return errors


def _stub_at(node, part: str):
    if isinstance(node, list):
        return next(i for i, x in enumerate(node) if isinstance(x, dict) and part in (x.get("key"), x.get("id"), x.get("title")))
    return part


@stub.tool()
async def read_draft(ctx: Context, start_line: int = 1, end_line: int | None = None, file: str | None = None) -> dict:
    _auth(ctx)
    lines = (DRAFT["files"][file] if file else DRAFT["source"]).splitlines()
    return {"lines": len(lines), "text": "\n".join(f"{n}: {line}" for n, line in enumerate(lines, 1)),
            "files": {name: len(text.splitlines()) for name, text in DRAFT["files"].items()}}


def _stub_file_problems() -> list[dict]:
    errors = []
    for name, text in DRAFT["files"].items():
        try:
            compile(text, name, "exec")
        except SyntaxError as e:
            errors.append({"file": name, "line": e.lineno, "message": f"It isn't valid Python: {e.msg}."})
    return errors


@stub.tool()
async def change_definition(changes: list[dict], ctx: Context, kind: str | None = None) -> dict:
    import yaml

    _auth(ctx)
    data = yaml.safe_load(DRAFT["source"]) or {}
    for change in changes:
        if change["op"] == "file":
            DRAFT["files"][change["name"]] = change["text"]
            continue
        if change["op"] == "lines" and change.get("file"):
            lines = DRAFT["files"][change["file"]].splitlines()
            lines[change["from"] - 1:change["to"]] = change["text"].splitlines()
            DRAFT["files"][change["file"]] = "\n".join(lines) + "\n"
            continue
        parts = change["path"].split("/")
        node = data
        try:
            for part in parts[:-1]:
                node = node[_stub_at(node, part)] if isinstance(node, list) else node.setdefault(part, {})
        except StopIteration:
            raise ToolError(f"{change['path']}: there is no such item. Nothing was changed.") from None
        last = parts[-1]
        if change["op"] == "set":
            node[_stub_at(node, last) if isinstance(node, list) else last] = change["value"]
        elif change["op"] == "add":
            node.setdefault(last, []).append(change["value"])
        elif change["op"] == "remove":
            del node[_stub_at(node, last) if isinstance(node, list) else last]
        else:
            raise ToolError(f"Change 1: A change's op is \"set\", \"add\" or \"remove\", not {change['op']!r}. Nothing was changed.")
    DRAFT["source"] = yaml.safe_dump(data, sort_keys=False)
    errors = _stub_problems(data) + _stub_file_problems()
    return {"ok": not errors, "errors": errors, "changed": len(changes)}


@stub.tool()
async def describe_aws_operation(service: str, ctx: Context, operation: str | None = None) -> dict:
    _auth(ctx)
    return {"service": service, "operation": operation, "reply": {"jobs": [{"jobId": "string"}]}, "lists": ["jobs"]}


@stub.tool()
async def propose_definition(summary: str, ctx: Context, kind: str | None = None, source: str | None = None,
                             definition_id: str | None = None, even_with_problems: bool = False) -> dict:
    import yaml

    _auth(ctx)
    text = source if source is not None else DRAFT["source"]
    errors = _stub_problems(yaml.safe_load(text) or {})
    if errors and not even_with_problems:
        raise ToolError("Nothing was put in the editor; fix these: " + "; ".join(e["message"] for e in errors))
    out = {"ok": not errors, "propose": {"kind": kind or "pane", "source": text, "summary": summary,
                                         "files": dict(DRAFT["files"])}}
    return {**out, "problems": "; ".join(e["message"] for e in errors)} if errors else out


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
    results = [e for e in events if e["type"] == "tool_result" and e["name"] != "check_answer"]
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
    reads = [e for e in events if e["type"] == "tool_call" and e.get("preamble") and e["name"] != "check_answer"]
    assert [(r["name"], r["args"]) for r in reads] == [("get_context", {}), ("get_session", {"session_id": "s1"})]
    # With the message they were read for, not in the system prompt.
    sent = fake_llm.REQUESTS[0]["messages"]
    assert sent[-1]["role"] == "user" and sent[-1]["content"].startswith("hello")
    assert "get_session (this chat's session):" in sent[-1]["content"] and '"pane_id":"iot"' in sent[-1]["content"]
    assert "get_session (this chat's session):" not in sent[0]["content"]


def test_a_runs_chat_starts_from_the_run_as_it_is_now(settings):
    """This run (D98): the turn reads the run, not a session, and the prompt
    keeps to it."""
    fake_llm.REQUESTS.clear()
    events = _events(settings, "why did it fail?", focus={"kind": "run", "run_id": 12, "title": "Table check #3"})
    reads = [e for e in events if e["type"] == "tool_call" and e.get("preamble") and e["name"] != "check_answer"]
    assert [(r["name"], r["args"]) for r in reads] == [("get_context", {}), ("get_workflow_run", {"run_id": 12})]
    sent = fake_llm.REQUESTS[0]["messages"]
    assert "chat of one workflow run" in sent[0]["content"] and "Table check #3" in sent[0]["content"]
    assert "get_workflow_run (this chat's run):" in sent[-1]["content"] and "Throttled" in sent[-1]["content"]


def test_the_context_is_whoever_asked_this_turn_not_what_an_earlier_answer_said(settings, monkeypatch):
    # A shared chat: someone without IoT Prod asked first and was told there
    # isn't one. When someone who has it asks, the turn's own read is theirs.
    earlier = [
        {"role": "user", "content": "avivil-backend: search iot prod"},
        {
            "role": "assistant",
            "content": "There is no IoT Prod environment available.",
            "steps": [
                {"id": "call_1a2b", "name": "get_context", "args": {}, "ok": True, "summary": '{"user": "avivil-backend"}'}
            ],
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
    assert calls[0]["tool_calls"][0]["id"] == "call_1a2b"
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


def test_an_answer_with_rows_no_tool_returned_is_taken_back_and_redone(settings):
    # A member without IoT Prod was shown another person's earlier rows as
    # "Found 20 things in IoT Prod", nothing run. The answer is taken back
    # out of the chat and the model asked once to run the tool or say so.
    fake_llm.REQUESTS.clear()
    events = _events(settings, "invent")
    assert _answer(events) == "I haven't run a search this turn, so I have no results to show yet."
    assert any(e["type"] == "retract" for e in events)
    assert not [e for e in events if e["type"] == "notice"]
    assert len(fake_llm.REQUESTS) == 2 and "nothing this turn returned" in fake_llm.REQUESTS[1]["messages"][-1]["content"]
    assert events[-1] == {"type": "done"}


def test_an_answer_that_still_invents_rows_carries_a_notice(settings):
    events = _events(settings, "invent stubborn")
    assert "test-device-001" in _answer(events)
    notice = next(e for e in events if e["type"] == "notice")
    assert "test-device-001" in notice["message"]
    assert events[-1] == {"type": "done"}

    # One built from what the tools did return carries none.
    events = _events(settings, "encode hi")
    assert not [e for e in events if e["type"] == "notice"]


def _names_sent() -> list[str]:
    return [
        call["function"]["name"]
        for request in fake_llm.REQUESTS
        for m in request["messages"]
        for call in m.get("tool_calls") or []
    ]


def test_a_tool_call_with_a_garbled_name_never_goes_back_to_the_provider(settings):
    # The provider's failed parse of the model's markup came back as a tool
    # "name". Sent back as it was, Bedrock refused the whole request (names
    # must match [a-zA-Z0-9_-]+) and the turn died. It is answered as a call
    # to no tool instead, so the model can try again.
    fake_llm.REQUESTS.clear()
    events = _events(settings, "garble")
    calls = [e for e in events if e["type"] == "tool_call" and not e.get("preamble")]
    assert [c["name"] for c in calls] == ["unreadable_tool_call"]
    result = next(e for e in events if e["type"] == "tool_result" and e["id"] == calls[0]["id"])
    assert not result["ok"] and "not a valid tool" in result["summary"]
    assert "not a valid tool" in _answer(events) and events[-1] == {"type": "done"}
    assert _names_sent() and all(re.fullmatch(r"[A-Za-z0-9_-]+", n) for n in _names_sent())


def test_a_garbled_call_that_names_a_real_tool_is_made(settings):
    events = _events(settings, "garble run")
    calls = [e for e in events if e["type"] == "tool_call" and not e.get("preamble")]
    assert [(c["name"], c["args"]) for c in calls] == [("run_pane", {"session_id": "s1", "pane_id": "iot"})]
    assert next(e for e in events if e["type"] == "tool_result" and e["id"] == calls[0]["id"])["ok"]


def test_earlier_steps_go_back_only_with_the_providers_own_ids(settings):
    # Ids made up here ("h25_0") were copied by the model as a tool's name.
    # A step without the provider's id, or kept with a garbled name, is left
    # out; the answer's words still go.
    earlier = [
        {"role": "user", "content": "run it"},
        {
            "role": "assistant",
            "content": "Ran it.",
            "steps": [
                {"name": "get_context", "args": {}, "ok": True, "summary": "{}"},
                {"id": "call_x1", "name": "run_pane", "args": {"session_id": "s1", "pane_id": "iot"}, "ok": True},
                {"id": "call_x2", "name": 'h25_0 <|tool_call_argument_begin|> {"session_id"', "args": {}, "ok": False},
                {"id": "call_x3", "name": "no_such_tool", "args": {}, "ok": True},
            ],
        },
    ]
    fake_llm.REQUESTS.clear()
    _events(settings, "hello", earlier=earlier)
    sent = fake_llm.REQUESTS[0]["messages"]
    calls = [c for m in sent for c in m.get("tool_calls") or []]
    assert [(c["id"], c["function"]["name"]) for c in calls] == [("call_x1", "run_pane")]
    assert {"role": "assistant", "content": "Ran it."} in sent


def test_a_step_that_announces_a_run_and_stops_is_asked_to_carry_on(settings):
    events = _events(settings, "announce")
    calls = [e for e in events if e["type"] == "tool_call" and not e.get("preamble")]
    assert [c["name"] for c in calls] == ["run_pane"]
    assert _answer(events).startswith("Let me search now:") and "Searched:" in _answer(events)
    assert events[-1] == {"type": "done"}


def test_a_step_that_announces_its_next_call_after_research_is_asked_to_carry_on(settings):
    # A real turn read the workflows, said "Now let me run it." and stopped;
    # the user had to tell it it had stopped. Having called something no
    # longer lets the announcement through.
    fake_llm.REQUESTS.clear()
    events = _events(settings, "research")
    calls = [e["name"] for e in events if e["type"] == "tool_call" and not e.get("preamble")]
    assert calls == ["get_context", "run_pane"]
    nudges = [r["messages"][-1]["content"] for r in fake_llm.REQUESTS if str(r["messages"][-1].get("content")).startswith(fake_llm.NUDGE_MARK)]
    assert len(nudges) == 1 and "Now let me run its IoT pane." in nudges[0]
    assert "Ran it:" in _answer(events) and events[-1] == {"type": "done"}


def test_what_counts_as_announcing_after_a_call():
    from app.repair import announced

    assert announced("Found it. Now let me run the workflow.", acted=True) == "Now let me run the workflow."
    assert announced("Next, I'll open the run page.", acted=True) == "Next, I'll open the run page."
    # Reports and courtesies aren't steps left to take.
    assert announced("It's running; I'll keep it running.", acted=True) is None
    assert announced("Done. Let me know if you want more.", acted=True) is None


def test_a_reply_cut_off_at_the_length_limit_is_carried_on():
    from langchain_core.messages import AIMessage

    from app.repair import CUT_OFF, nudge_for, stopped_short

    cut = AIMessage(content="The errors come from the", response_metadata={"finish_reason": "length"})
    assert stopped_short(cut, []) and nudge_for(cut, []) == CUT_OFF
    assert not stopped_short(AIMessage(content="The errors come from the API.", response_metadata={"finish_reason": "stop"}), [])


def test_a_turn_that_says_nothing_ends_with_a_readable_error(settings):
    fake_llm.REQUESTS.clear()
    events = _events(settings, "silent")
    assert events[-1]["type"] == "error" and "stopped without answering" in events[-1]["message"]
    # Asked once to carry on, not more.
    assert len(fake_llm.REQUESTS) == 2


def test_a_step_that_announces_a_run_with_a_period_and_stops_is_asked_to_carry_on(settings):
    # "Let me reconnect to IoT Test and subscribe to the topic again." -- and
    # the turn stopped; the user had to ask "did you do it?".
    fake_llm.REQUESTS.clear()
    events = _events(settings, "announce plain")
    calls = [e for e in events if e["type"] == "tool_call" and not e.get("preamble")]
    assert [c["name"] for c in calls] == ["run_pane"]
    nudge = fake_llm.REQUESTS[1]["messages"][-1]["content"]
    assert "Let me search now." in nudge and "didn't make that call" in nudge
    assert "Searched:" in _answer(events) and events[-1] == {"type": "done"}


def test_after_a_failed_call_the_model_is_told_what_failed(settings):
    # Refused a `query: []`, a model said nothing, twice, and the turn ended
    # "ran the steps above but didn't write an answer".
    fake_llm.REQUESTS.clear()
    events = _events(settings, "fumble")
    calls = [e for e in events if e["type"] == "tool_call" and not e.get("preamble")]
    assert [c["args"]["session_id"] for c in calls] == ["no-such-session", "s1"]
    nudges = [r["messages"][-1]["content"] for r in fake_llm.REQUESTS if str(r["messages"][-1].get("content")).startswith(fake_llm.NUDGE_MARK)]
    assert len(nudges) == 1 and "failed" in nudges[0] and "no-such-session" in nudges[0]
    assert "Ran it on s1 instead" in _answer(events) and events[-1] == {"type": "done"}


def test_a_turn_that_stops_after_a_failure_says_what_failed(settings):
    events = _events(settings, "fumble silent")
    notice = next(e for e in events if e["type"] == "notice")
    assert "failed" in notice["message"] and "no-such-session" in notice["message"]


def test_an_answer_claiming_what_nothing_did_is_checked_and_redone(settings):
    # Asked to connect, an agent filled the topics in and said "connected and
    # listening" -- three turns running, until the user pointed at the pane.
    RUNNING.clear()
    fake_llm.CHECKS.clear()
    events = _events(settings, "pretend connect")
    checks = [e for e in events if e["type"] == "tool_result" and e["name"] == "check_answer"]
    assert [c["ok"] for c in checks] == [False, True]
    # Each its own step: the browser matches a result to its call by id.
    assert len({c["id"] for c in checks}) == 2
    assert "isn't running" in checks[0]["summary"]
    # Shown as steps of the platform's own, not the agent's.
    assert all(e.get("preamble") for e in events if e["type"] == "tool_call" and e["name"] == "check_answer")
    calls = [e["name"] for e in events if e["type"] == "tool_call" and not e.get("preamble")]
    assert calls == ["set_pane_inputs", "run_pane"]
    answer = _answer(events)
    assert "Connected now" in answer and "is connected and listening" not in answer
    assert not [e for e in events if e["type"] == "notice"] and events[-1] == {"type": "done"}
    # The check saw what ran and the session afterwards, not the agent's words alone.
    evidence = fake_llm.CHECKS[-1]["messages"][-1]["content"]
    assert "called run_pane" in evidence and '"status": "running"' in evidence.replace('":"', '": "')


def test_an_answer_that_still_claims_it_after_the_redo_carries_what_the_check_found(settings):
    RUNNING.clear()
    events = _events(settings, "pretend connect stubborn")
    notice = next(e for e in events if e["type"] == "notice")
    assert "check" in notice["message"] and "isn't running" in notice["message"]
    # One redo, not more.
    assert len([e for e in events if e["type"] == "tool_result" and e["name"] == "check_answer"]) == 2


def test_the_check_can_be_turned_off(settings):
    fake_llm.CHECKS.clear()
    events = _events(Settings(**{**settings.__dict__, "check": False}), "pretend connect")
    assert not fake_llm.CHECKS and not [e for e in events if e.get("name") == "check_answer"]


def test_a_build_chat_reads_the_reference_and_the_editor_and_proposes(settings):
    """Building (D107) as the chat agent with build tools (AGENT_BUILDER=agent):
    the turn reads what a definition can say and the editor's text, and a
    proposal is passed on for the browser to put in the editor -- never saved
    by the agent."""
    fake_llm.REQUESTS.clear()
    focus = {"kind": "build", "what": "pane", "title": "New pane type", "source": "label: Old\ndescription: x\n"}
    events = _events(Settings(**{**settings.__dict__, "builder": "agent"}), "build Loud encoder", focus=focus)
    reads = [e for e in events if e["type"] == "tool_call" and e.get("preamble") and e["name"] != "check_answer"]
    assert [(r["name"], r["args"]) for r in reads] == [("get_context", {}), ("build_reference", {"kind": "pane"})]
    sent = fake_llm.REQUESTS[0]["messages"]
    assert "beside an editor" in sent[0]["content"] and "propose_definition" in sent[0]["content"]
    assert "build_reference:" in sent[-1]["content"] and "The editor's text now (pane):" in sent[-1]["content"]
    [proposed] = [e for e in events if e["type"] == "tool_result" and e.get("propose")]
    assert proposed["propose"] == {
        "kind": "pane", "source": "label: Loud encoder\ndescription: x\n", "summary": "Renamed it Loud encoder.",
    }
    assert [e["name"] for e in events if e["type"] == "tool_call" and not e.get("preamble")] == [
        "check_definition", "propose_definition",
    ]
    assert "in the editor, called Loud encoder" in _answer(events)


def test_each_stretch_between_tools_may_be_nudged_and_a_stuck_turn_says_so(settings):
    """A long turn announced its next step a dozen times; two nudges a turn
    were spent early, and its last "Let me put it in your editor now:" ended
    the turn with nothing to say why."""
    events = _events(settings, "stepwise")
    ran = [e for e in events if e["type"] == "tool_call" and e["name"] == "run_pane"]
    assert len(ran) == 3, [e.get("name") for e in events if e["type"] == "tool_call"]
    assert "Done all three" in _answer(events)

    stuck = _events(settings, "stuck")
    notices = [e["message"] for e in stuck if e["type"] == "notice"]
    assert any("stopped without doing it" in n for n in notices), notices


# ---------------------------------------------------------------- the Builder's loop (D116)

IOT = "label: IoT\ndescription: Things.\nactions: []\noutputs: []\nlayout: []\n"


def _build(settings: Settings, text: str, source: str, files: dict | None = None, **overrides) -> list[dict]:
    DRAFT["source"], DRAFT["files"] = source, dict(files or {})  # what the backend mints the token with
    focus = {"kind": "build", "what": "pane", "title": "IoT", "source": source, "files": dict(files or {})}
    return _events(Settings(**{**settings.__dict__, **overrides}), text, focus=focus)


def _steps(events: list[dict]) -> list[str]:
    return [e["name"] for e in events if e["type"] == "tool_call"]


def test_beside_an_editor_the_code_runs_the_steps_and_the_model_only_says_what_to_change(settings):
    """A model that chose its own steps read the draft over and over, missed
    its find-and-replace edits and stopped halfway (the IoT jobs and rules
    chat). Now every step is the code's: the model is asked for a plan and
    for changes by path, each one JSON object, and the draft is proposed."""
    fake_llm.BUILDS.clear()
    events = _build(settings, "rename Loud encoder", "label: Old\ndescription: x\n")
    assert _steps(events) == ["build_reference", "plan_change", "write_changes", "change_definition",
                              "propose_definition"]
    assert all(e.get("preamble") for e in events if e["type"] == "tool_call"), "the platform's steps, never replayed"
    [proposed] = [e for e in events if e.get("propose")]
    assert proposed["propose"]["source"].startswith("label: Loud encoder\n")
    assert "Renamed it Loud encoder." in _answer(events) and "not saved yet" in _answer(events)
    assert events[-1]["type"] == "done"
    assert len(fake_llm.BUILDS) == 2 and not any(b.get("tools") for b in fake_llm.BUILDS), "no tools offered to it"


def test_a_problem_goes_back_to_the_model_with_the_draft_as_it_is_and_is_fixed(settings):
    """Asked for IoT's jobs and rules, it reads both operations first, makes
    every part of both lists in one set of changes, and when the check says
    the jobs' rows aren't where it said, it's told so and fixes that."""
    fake_llm.BUILDS.clear()
    events = _build(settings, "add jobs and rules", IOT)
    assert _steps(events) == [
        "build_reference", "plan_change", "describe_aws_operation", "describe_aws_operation", "write_changes",
        "change_definition", "write_changes", "change_definition", "propose_definition",
    ]
    first, second = [e for e in events if e["type"] == "tool_result" and e["name"] == "change_definition"]
    assert not json.loads(first["summary"])["ok"] and json.loads(second["summary"])["ok"]
    repair = fake_llm.BUILDS[-1]["messages"][-1]["content"]
    assert "Reply with the changes that fix this" in repair and "Its lists are at: jobs" in repair
    assert "describe_aws_operation iot ListJobs" in repair, "what it read stays in front of it"
    [proposed] = [e for e in events if e.get("propose")]
    assert "at: jobs\n" in proposed["propose"]["source"] and "key: rules" in proposed["propose"]["source"]
    assert "each with its own card. The check caught 1 problem on the way, fixed." in _answer(events)


def test_code_is_written_as_a_file_and_fixed_by_its_lines(settings):
    """D139: a model asked for code wrote it into the YAML as one quoted line.
    The loop shows it the files beside the draft, numbered, and it writes
    one -- here with a line that doesn't parse, which the check names by file
    and line, and it changes that line."""
    fake_llm.BUILDS.clear()
    source = "label: Devices\nactions:\n- id: list\n  main: true\n  code:\n    file: devices.py\n"
    events = _build(settings, "use code sorted by id", source, files={"devices.py": "def run(inputs, ctx):\n    return {}\n"})
    assert _steps(events).count("change_definition") == 2
    first = fake_llm.BUILDS[1]["messages"][-1]["content"]
    assert "The file devices.py beside it, with line numbers:\n1: def run(inputs, ctx):" in first
    assert '{"op": "file", "name": "health.py"' in first, "it's told how a file is written"
    repair = fake_llm.BUILDS[-1]["messages"][-1]["content"]
    assert "shaped.py, line 3: It isn't valid Python" in repair
    assert "The file shaped.py beside it, with line numbers:" in repair
    [proposed] = [e for e in events if e.get("propose")]
    assert "file: shaped.py" in proposed["propose"]["source"]
    assert "    rows = sorted(items, key=lambda d: d['id'])\n" in proposed["propose"]["files"]["shaped.py"]
    assert "devices.py" in proposed["propose"]["files"]


def test_out_of_rounds_the_work_so_far_goes_in_the_editor_with_its_problems_named(settings):
    events = _build(settings, "never clean", IOT, builder_rounds=2)
    assert _steps(events).count("write_changes") == 2
    [proposed] = [e for e in events if e.get("propose")]
    assert "Card" in proposed["propose"]["source"]
    notices = [e["message"] for e in events if e["type"] == "notice"]
    assert notices and "isn't declared" in notices[0]
    assert "Ask me to carry on" in _answer(events)


def test_a_question_is_answered_and_a_change_that_cant_be_made_is_said(settings):
    asked = _build(settings, "explain rows.at", IOT)
    assert _steps(asked) == ["build_reference", "plan_change"] and "where the reply keeps its list" in _answer(asked)
    refused = _build(settings, "impossible thing", IOT)
    assert "change_definition" not in _steps(refused) and "doesn't have" in _answer(refused)
    assert not [e for e in refused if e.get("propose")]


def test_a_reply_that_isnt_json_is_asked_for_again(settings):
    fake_llm.BUILDS.clear()
    events = _build(settings, "garbled Neat", "label: Old\n")
    assert len(fake_llm.BUILDS) == 3, "the plan asked twice, then the change"
    assert "wasn't the JSON object asked for" in fake_llm.BUILDS[1]["messages"][-1]["content"]
    [proposed] = [e for e in events if e.get("propose")]
    assert proposed["propose"]["source"] == "label: Neat\n"


def test_the_change_prompt_is_sent_as_it_reads(settings):
    """Its JSON was sent with doubled braces ({{"op": …}}), and a real model
    wrote changes in a shape of its own."""
    fake_llm.BUILDS.clear()
    _build(settings, "rename Neat", "label: Old\n")
    sent = fake_llm.BUILDS[1]["messages"][-1]["content"]
    assert "Now write the change." in sent and '{"op": "set", "path": "label"' in sent and "{{" not in sent


def test_changes_that_cant_be_made_come_back_with_the_shape_and_their_own_change_in_it(settings):
    fake_llm.BUILDS.clear()
    events = _build(settings, "bad op Tidy", "label: Old\n")
    assert _steps(events) == ["build_reference", "plan_change", "write_changes", "change_definition", "write_changes",
                              "change_definition", "propose_definition"]
    told = fake_llm.BUILDS[-1]["messages"][-1]["content"]
    assert 'Each change is exactly {"op": "set" | "add" | "remove"' in told
    assert 'Your first change, written that way: {"op": "set", "path": "label", "value": "Tidy"}' in told
    [proposed] = [e for e in events if e.get("propose")]
    assert proposed["propose"]["source"] == "label: Tidy\n"
