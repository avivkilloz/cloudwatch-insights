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
- "break"          -- a tool call that fails, and the model saying so.
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

STEP_DELAY = float(os.environ.get("FAKE_LLM_STEP_DELAY", "0"))

# The last few requests, newest last, for tests to read what the agent sent.
REQUESTS: list[dict] = []


def _turn(messages: list[dict]) -> tuple[str, list[tuple[str, Any]]]:
    """The user's latest message, and the (tool name, parsed result) of every
    tool call made since it, in order."""
    last_user = max(i for i, m in enumerate(messages) if m.get("role") == "user")
    text = messages[last_user].get("content")
    if isinstance(text, list):
        text = "".join(b.get("text", "") for b in text if isinstance(b, dict))
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


def _next(text: str, results: list[tuple[str, Any]]) -> dict:
    step = len(results)
    lowered = text.lower()
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
    if lowered.startswith("break"):
        if step == 0:
            return _call("run_pane", session_id="no-such-session", pane_id="nope")
        return _say(f"That didn't work: {results[0][1]}")
    return _say("I'm the development stand-in model. Try: encode <text>, dashboard, here, break, rows, or query <text>.")


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
    model = body.get("model", "fake")
    text, results = _turn(body.get("messages") or [])
    step = _next(text, results)
    if STEP_DELAY:
        await asyncio.sleep(STEP_DELAY)
    call_id = f"call_{uuid.uuid4().hex[:8]}"

    if not body.get("stream"):
        if "tool" in step:
            message = {
                "role": "assistant",
                "content": None,
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
            words = step["text"].split(" ")
            for i, word in enumerate(words):
                yield _chunk(model, {"content": word + (" " if i < len(words) - 1 else "")})
                await asyncio.sleep(0.02)
            yield _chunk(model, {}, "stop")
        yield "data: [DONE]\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")
