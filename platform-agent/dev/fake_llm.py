"""A scripted stand-in for the model, for development and the browser suites.

It speaks just enough of the OpenAI chat-completions API (streamed and not,
with tool calls) for the agent to run against it, and follows a fixed script
chosen by the user's message -- so the whole path (browser, backend, agent,
MCP tools, live sync back into the panes) can be driven end to end without a
real model or its cost, and deterministically enough to test.

    uvicorn dev.fake_llm:app --port 4010
    LITELLM_BASE_URL=http://localhost:4010 LITELLM_API_KEY=x AGENT_MODEL=fake ...

Scripts (the user's message decides):
- "encode <text>"  -- a new session with a Base64 pane, filled in and run.
- "dashboard"      -- a new session of three panes, arranged as a dashboard.
- "here"           -- a Diff pane added to the session the user is looking at.
- "add <kind>"     -- a pane of the kind whose name starts with <kind> (e.g.
                      "add mqtt") added to the session being looked at.
- "break"          -- a tool call that fails, and the model saying so.
- "markdown"       -- a reply mixing a table and a heading straight into
                      surrounding prose, no blank line either side -- what a
                      real model sends often enough that the renderer has to
                      cope with it, not just the tidy blank-line-delimited shape.
- "think"          -- reasons first the way a reasoning model behind a proxy
                      does (no opening <think>, then "</think>", then the
                      answer), before a tool call and before its answer.
- "loop"           -- the same few sentences of plan, over and over, never
                      calling anything: what a reasoning model at
                      temperature 0 was seen doing.
- "invent"         -- a table of results that no tool ever returned.
- "whoami"         -- answers with the user and environments in the context
                      the turn was started with (the reads after the message).
- "garble"         -- a tool call whose name is the provider's failed parse of
                      the model's markup (`h3_0 <|tool_call_argument_begin|>
                      {...}`), then says whether it went through.
- "garble run"     -- the same, but the markup names a real tool
                      (`functions.run_pane:0...`), so it can be recovered.
- "announce"       -- ends its step on "Let me search now:" without calling
                      anything; asked to carry on, it runs the pane.
- "silent"         -- says nothing at all, however it's asked.
- "rows"           -- (a session's chat) says how many checked rows came
                      attached to the question, and from which panes.
- "query <text>"   -- (a session's chat) writes <text> as the query of the
                      session's first pane that takes one.
- anything else    -- a short reply, no tools.

FAKE_LLM_STEP_DELAY (seconds, default 0) pauses before each reply, so a test
can watch a turn happen rather than only see its end.
"""

import asyncio
import json
import os
import re
import time
import uuid
from typing import Any, Optional

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

app = FastAPI(title="Fake model")

# How the agent's reads and its one nudge are told apart from the user's own
# words (app/prompt.py, app/repair.py).
READS_MARK = "\n\n---\n[Read by the platform for this message"
NUDGE_MARK = "(From the platform, not the user:"

STEP_DELAY = float(os.environ.get("FAKE_LLM_STEP_DELAY", "0"))

# The last few requests, newest last, for tests to read what the agent sent.
REQUESTS: list[dict] = []


def _content(message: dict) -> str:
    text = message.get("content")
    if isinstance(text, list):
        text = "".join(b.get("text", "") for b in text if isinstance(b, dict))
    return text or ""


def _turn(messages: list[dict]) -> tuple[str, list[tuple[str, Any]]]:
    """The user's latest message (without the reads the agent attached, or
    its nudge), and the (tool name, parsed result) of every tool call made
    since it, in order."""
    last_user = max(
        i for i, m in enumerate(messages) if m.get("role") == "user" and not _content(m).startswith(NUDGE_MARK)
    )
    text = _content(messages[last_user]).split(READS_MARK, 1)[0]
    names: dict[str, str] = {}
    results: list[tuple[str, Any]] = []
    for m in messages[last_user + 1 :]:
        for call in m.get("tool_calls") or []:
            names[call["id"]] = call["function"]["name"]
        if m.get("role") == "tool":
            content = m.get("content")
            if isinstance(content, list):
                content = "".join(b.get("text", "") for b in content if isinstance(b, dict))
            try:
                parsed: Any = json.loads(content)
            except (TypeError, ValueError):
                parsed = content
            results.append((names.get(m.get("tool_call_id"), ""), parsed))
    return (text or "").strip(), results


def _call(name: str, **args: Any) -> dict:
    return {"tool": name, "args": args}


def _say(text: str) -> dict:
    return {"text": text}


LOOP = (
    "I need to search for things with deviceType:0x65 in their shadow. Let me configure the IoT pane to search "
    "with shadow filters. I need to search for things with a specific shadow attribute. Let me set up the IoT pane "
    "to filter by shadow values. "
)


def _reads(messages: list[dict]) -> str:
    """What the agent read for the latest message, attached after it."""
    for m in reversed(messages):
        if m.get("role") == "user" and READS_MARK in _content(m):
            return _content(m).split(READS_MARK, 1)[1]
    return ""


def _nudged(messages: list[dict]) -> bool:
    return bool(messages) and messages[-1].get("role") == "user" and _content(messages[-1]).startswith(NUDGE_MARK)


def _next(text: str, results: list[tuple[str, Any]], reads: str = "", nudged: bool = False) -> dict:
    step = len(results)
    lowered = text.lower()
    if lowered.startswith("think"):
        if step == 0:
            return {"text": "The user wants a session. I should create one first.\n</think>\n\nCreating it now.", **_call(
                "create_session", title="Thought", panes=[{"kind": "tool-base64"}]
            )}
        return _say("They want to know it's done. I'll say so briefly.</think>\n\nDone: the Thought session is open.")
    if lowered.startswith("loop"):
        return _say(LOOP * 30)
    if lowered.startswith("invent"):
        return _say(
            "The search completed. The IoT pane shows these things:\n"
            "| Thing Name |\n|------------|\n"
            "| `test-device-001` |\n| `test-sensor-temp-01` |\n| `test-actuator-pump-01` |\n| `test-gateway-alpha` |"
        )
    if lowered.startswith("garble"):
        if step == 0:
            name = 'h3_0 <|tool_call_argument_begin|> {"session_id": "s1", "pane_id": "iot"}'
            if lowered.startswith("garble run"):
                name = 'functions.run_pane:0<|tool_call_argument_begin|>{"session_id": "s1", "pane_id": "iot"}'
            return {"tool": name, "args": {}}
        return _say(f"Tried it: {results[0][1]}")
    if lowered.startswith("announce"):
        if step >= 1:
            return _say(f"Searched: {results[0][1]}")
        if nudged:
            return _call("run_pane", session_id="s1", pane_id="iot")
        return _say("Let me search now:")
    if lowered.startswith("silent"):
        return _say("")
    if lowered.startswith("whoami"):
        found = re.search(r'get_context:\n(\{.*\})', reads)
        if not found:
            return _say("I wasn't given a context this turn.")
        context = json.loads(found.group(1))
        names = ", ".join(e["name"] for e in context.get("environments", []))
        return _say(f"You're {context.get('user')}, and you can reach: {names or 'nothing'}.")
    if lowered.startswith("encode "):
        plain = text[len("encode ") :]
        if step == 0:
            return _call("get_context")
        if step == 1:
            return _call("create_session", title="Base64", panes=[{"kind": "tool-base64"}])
        if step == 2:
            session = results[1][1]["session_id"]
            return _call("run_pane", session_id=session, pane_id="tool-base64", inputs={"input": plain})
        output = results[2][1].get("output") if isinstance(results[2][1], dict) else None
        return _say(f"Encoded it: `{output}`. It's in the Base64 pane of the new Base64 session.")
    if lowered.startswith("dashboard"):
        if step == 0:
            return _call(
                "create_session",
                title="Dashboard",
                panes=[{"kind": "tool-base64"}, {"kind": "tool-diff"}, {"kind": "tool-base64", "title": "Second"}],
            )
        if step == 1:
            session = results[0][1]["session_id"]
            return _call(
                "arrange_dashboard",
                session_id=session,
                rows=[
                    {"height": 340, "panes": [{"pane_id": "tool-base64", "width": 6}, {"pane_id": "tool-diff", "width": 6}]},
                    {"height": 300, "panes": [{"pane_id": "tool-base64~2", "width": 12}]},
                ],
            )
        return _say("Done: three panes on a dashboard, two side by side and one full width below.")
    if lowered.startswith("here"):
        if step == 0:
            return _call("get_context")
        viewing = results[0][1].get("viewing_session") if isinstance(results[0][1], dict) else None
        if not viewing:
            return _say("You aren't looking at a session, so there's nowhere to put it.")
        if step == 1:
            return _call("add_pane", session_id=viewing["session_id"], kind="tool-diff", title="Agent diff")
        if step == 2:
            pane = results[1][1]["pane_id"]
            return _call(
                "set_pane_inputs",
                session_id=viewing["session_id"],
                pane_id=pane,
                inputs={"left": "one\ntwo", "right": "one\nthree"},
            )
        return _say(f"Added a Diff pane to {viewing['title']} and filled both sides in.")
    if lowered.startswith("add "):
        wanted = lowered[len("add ") :].strip()
        if step == 0:
            return _call("get_context")
        context = results[0][1] if isinstance(results[0][1], dict) else {}
        viewing = context.get("viewing_session")
        if not viewing:
            return _say("You aren't looking at a session, so there's nowhere to put it.")
        kind = next((k for k in context.get("pane_kinds", []) if k["label"].lower().startswith(wanted)), None)
        if kind is None:
            return _say(f"There's no pane kind called {wanted}.")
        if step == 1:
            return _call("add_pane", session_id=viewing["session_id"], kind=kind["kind"])
        return _say(f"Added a {kind['label']} pane to {viewing['title']}.")
    if lowered.startswith("rows"):
        attached = re.search(r"Checked rows attached \((\d+), from ([^)]*)\)", text)
        if not attached:
            return _say("No rows came with that question.")
        return _say(f"You attached {attached.group(1)} rows, from {attached.group(2)}.")
    if lowered.startswith("query "):
        wanted = text[len("query ") :].split("\n", 1)[0]
        if step == 0:
            return _call("get_context")
        viewing = results[0][1].get("viewing_session") if isinstance(results[0][1], dict) else None
        if not viewing:
            return _say("You aren't looking at a session, so there's no pane to write it into.")
        takes_query = [p for p in viewing["panes"] if p["kind"] in ("logs-cloudwatch", "logs-opensearch", "iot", "tables", "cognito")]
        if not takes_query:
            return _say("This session has no pane that takes a query.")
        if step == 1:
            return _call(
                "set_pane_inputs",
                session_id=viewing["session_id"],
                pane_id=takes_query[0]["pane_id"],
                inputs={"queryString": wanted},
            )
        return _say(f"Wrote the query into {takes_query[0]['title']}.")
    if lowered.startswith("markdown"):
        return _say(
            "Here are the things I found:\n"
            " Thing Name | Connected |\n"
            "|------------|-----------|\n"
            "| Z3563HMR | No |\n"
            "| J2354KNC | Yes |\n"
            "### Summary\n"
            "One of two is connected."
        )
    if lowered.startswith("break"):
        if step == 0:
            return _call("run_pane", session_id="no-such-session", pane_id="nope")
        return _say(f"That didn't work: {results[0][1]}")
    return _say("I'm the development stand-in model. Try: encode <text>, dashboard, here, add <kind>, break, rows, or query <text>.")


def _chunk(model: str, delta: dict, finish: Optional[str] = None) -> str:
    body = {
        "id": "chatcmpl-fake",
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": model,
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
    }
    return f"data: {json.dumps(body)}\n\n"


@app.post("/chat/completions")
@app.post("/v1/chat/completions")
async def completions(request: Request):
    body = await request.json()
    REQUESTS.append(body)
    del REQUESTS[:-20]
    # As Bedrock does: a tool name outside [a-zA-Z0-9_-]+ anywhere in the
    # conversation fails the whole request.
    for m in body.get("messages") or []:
        for call in m.get("tool_calls") or []:
            if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", call["function"]["name"]):
                return JSONResponse(
                    {"error": {"message": "Value at 'toolUse.name' failed to satisfy constraint: [a-zA-Z0-9_-]+"}},
                    status_code=400,
                )
    model = body.get("model", "fake")
    text, results = _turn(body.get("messages") or [])
    messages = body.get("messages") or []
    step = _next(text, results, _reads(messages), _nudged(messages))
    if STEP_DELAY:
        await asyncio.sleep(STEP_DELAY)
    call_id = f"call_{uuid.uuid4().hex[:8]}"

    if not body.get("stream"):
        if "tool" in step:
            message = {
                "role": "assistant",
                "content": step.get("text"),
                "tool_calls": [
                    {"id": call_id, "type": "function", "function": {"name": step["tool"], "arguments": json.dumps(step["args"])}}
                ],
            }
            finish = "tool_calls"
        else:
            message, finish = {"role": "assistant", "content": step["text"]}, "stop"
        return JSONResponse(
            {
                "id": "chatcmpl-fake",
                "object": "chat.completion",
                "created": int(time.time()),
                "model": model,
                "choices": [{"index": 0, "message": message, "finish_reason": finish}],
                "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
            }
        )

    async def stream():
        yield _chunk(model, {"role": "assistant", "content": ""})
        if "text" in step:
            # Uneven pieces, the way a real stream cuts them -- a tag can
            # arrive split across two chunks.
            text = step["text"]
            for i in range(0, len(text), 7):
                yield _chunk(model, {"content": text[i : i + 7]})
                await asyncio.sleep(0.005)
        if "tool" in step:
            yield _chunk(
                model,
                {
                    "tool_calls": [
                        {
                            "index": 0,
                            "id": call_id,
                            "type": "function",
                            "function": {"name": step["tool"], "arguments": json.dumps(step["args"])},
                        }
                    ]
                },
            )
            yield _chunk(model, {}, "tool_calls")
        else:
            yield _chunk(model, {}, "stop")
        yield "data: [DONE]\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")
