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
- "invent"         -- a table of results that no tool ever returned; told
                      so, it owns up. "invent stubborn" does it again.
- "whoami"         -- answers with the user and environments in the context
                      the turn was started with (the reads after the message).
- "garble"         -- a tool call whose name is the provider's failed parse of
                      the model's markup (`h3_0 <|tool_call_argument_begin|>
                      {...}`), then says whether it went through.
- "garble run"     -- the same, but the markup names a real tool
                      (`functions.run_pane:0...`), so it can be recovered.
- "announce"       -- ends its step on "Let me search now:" without calling
                      anything; asked to carry on, it runs the pane.
                      "announce plain" ends on a period instead ("Let me
                      search now.").
- "pretend connect" -- fills a pane in and says it's connected, without
                      running it; told by the answer check, it runs the pane.
                      "pretend connect stubborn" says it again regardless.
- "fumble"         -- a tool call that fails, then nothing; told what failed,
                      it calls again with a good input and answers. "fumble
                      silent" stays silent however it's asked.
- "silent"         -- says nothing at all, however it's asked.
- "rows"           -- (a session's chat) says how many checked rows came
                      attached to the question, and from which panes.
- "query <text>"   -- (a session's chat) writes <text> as the query of the
                      session's first pane that takes one.
- anything else    -- a short reply, no tools.

Beside an editor, the Builder's loop (app/builder.py, D116) asks for one JSON
object per call; it is answered by the user's request, from the Builder's own
prompts (`_builder`):
- "build <label>" / "rename <label>" -- the label set, by path.
- "add jobs and rules" -- reads iot ListJobs and ListTopicRules, then adds both
                      lists (action, output, card each) with the jobs' rows
                      at a path the reply doesn't have; told so by the
                      check, it sets the right one.
- "add modes for jobs and rules" -- the same, as two more choices of IoT's
                      "Search for", each its own main action (D119), written
                      the way a real model wrote them: {"path", "old", "new"},
                      "actions/-", values as text -- and one with a `when` an
                      action can't have, which the check names and it removes.
- "add a clear button" -- an action with nothing to run, as a real model
                      wrote; told a Clear is a card's, it deletes that line
                      (a change by line) and sets `layout[0]/clear: [rows]`.
- "bad op …"       -- an op that isn't one, until it's shown the shape.
- "use code …"     -- the list action's code written as a file beside the
                      YAML (shaped.py, D139) with a line that doesn't parse;
                      told its file and line, it changes that line.
- "never clean"    -- a change that names an output never declared, every
                      round: the draft goes in the editor with its problems.
- "explain …"      -- a question: answered, nothing changed.
- "impossible …"   -- gives up, saying why.
- "garbled …"      -- prose instead of JSON first; asked again, the label.
- "long …"         -- its change cut off at the length limit (finish_reason
                      "length"), until it's told so; then the label.
- "lost …"         -- a change that doesn't check clean, then prose every
                      time after: the work so far still goes in the editor.

It also stands in for the answer check (app/check.py), which it knows by its
instructions: an answer saying "connected and/now" is unsupported unless a session
afterwards shows a run "running", and a request to connect is not done
unless run_pane was called. Everything else passes.

FAKE_LLM_STEP_DELAY (seconds, default 0) pauses before each reply, so a test
can watch a turn happen rather than only see its end; a question starting
"slow " does the same for its own turn only.
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
CHECK_MARK = "You check an AI agent's answer against what it actually did."
BUILDER_MARK = "You are the platform's Builder."

STEP_DELAY = float(os.environ.get("FAKE_LLM_STEP_DELAY", "0"))
SLOW_STEP_SECONDS = 2.5

# The last few requests, newest last, for tests to read what the agent sent;
# the answer checks apart.
REQUESTS: list[dict] = []
CHECKS: list[dict] = []


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


def _nudged(messages: list[dict]) -> str:
    """The platform's nudge, when it is the last thing sent; else ""."""
    if messages and messages[-1].get("role") == "user" and _content(messages[-1]).startswith(NUDGE_MARK):
        return _content(messages[-1])
    return ""


def _next(text: str, results: list[tuple[str, Any]], reads: str = "", nudged: str = "") -> dict:
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
        if nudged and not lowered.startswith("invent stubborn"):
            return _say("I haven't run a search this turn, so I have no results to show yet.")
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
    if lowered.startswith("research"):
        # Looks something up, then says what it will do next and stops -- as a
        # real model did after reading a workflow it was asked to run.
        if step == 0:
            return _call("get_context")
        if step == 1:
            if nudged:
                return _call("run_pane", session_id="s1", pane_id="iot")
            return _say("I found the session you meant. Now let me run its IoT pane.")
        return _say(f"Ran it: {results[1][1]}")
    if lowered.startswith("stepwise"):
        # Announces each of three steps and stops, every time -- carried on
        # when nudged. Two nudges a turn ran out on the third.
        if step >= 3:
            return _say(f"Done all three: {len(results)} steps ran.")
        if nudged:
            return _call("run_pane", session_id="s1", pane_id="iot")
        return _say(f"Now let me run step {step + 1}.")
    if lowered.startswith("stuck"):
        # Says what it will do and never does it, however it's asked.
        return _say("Let me put the corrected version in your editor now:")
    if lowered.startswith("announce"):
        if step >= 1:
            return _say(f"Searched: {results[0][1]}")
        if nudged:
            return _call("run_pane", session_id="s1", pane_id="iot")
        return _say("Let me search now." if lowered.startswith("announce plain") else "Let me search now:")
    if lowered.startswith("pretend connect"):
        # In a session's chat, its first MQTT tester; in the tests, s1's.
        found = re.search(r"get_session \(this chat's session\):\n(\{.*\})", reads)
        session = json.loads(found.group(1)) if found else {}
        pane = next((p["pane_id"] for p in session.get("panes", []) if p.get("kind") == "tool-mqtt"), "mqtt")
        where = {"session_id": session.get("session_id", "s1"), "pane_id": pane}
        if step == 0:
            return _call("set_pane_inputs", **where, inputs={"topics": ["a/#"]})
        if "check of your answer" in nudged and not lowered.startswith("pretend connect stubborn"):
            return _call("run_pane", **where)
        if step >= 2:
            return _say("Connected now, listening to a/#.")
        return _say("Done: the MQTT tester is connected and listening to a/#.")
    if lowered.startswith("fumble"):
        if step == 0:
            return _call("run_pane", session_id="no-such-session", pane_id="iot")
        if step >= 2:
            return _say(f"Ran it on s1 instead: {results[-1][1]}")
        if "failed" in nudged and not lowered.startswith("fumble silent"):
            return _call("run_pane", session_id="s1", pane_id="iot")
        return _say("")
    if lowered.startswith("silent"):
        return _say("")
    if lowered.startswith("whoami"):
        found = re.search(r'get_context:\n(\{.*\})', reads)
        if not found:
            return _say("I wasn't given a context this turn.")
        context = json.loads(found.group(1))
        names = ", ".join(e["name"] for e in context.get("environments", []))
        return _say(f"You're {context.get('user')}, and you can reach: {names or 'nothing'}.")
    if lowered.startswith("show workflow "):
        if step == 0:
            return _call("open_workflow", workflow_id=text[len("show workflow "):].strip())
        return _say(f"It's on the Workflows page: {results[0][1].get('shown')}.")
    if lowered.startswith("build "):
        # Beside an editor (D107): the editor's text, its label changed --
        # checked, then put in the editor, as the prompt asks.
        found = re.search(r"The editor's text now \((\w+)\):\n```yaml\n(.*?)\n```", reads, re.S)
        if not found:
            return _say("I wasn't given an editor this turn.")
        kind, source = found.group(1), found.group(2).rstrip("\n") + "\n"
        label = text[len("build "):].strip()
        source = re.sub(r"^label: .*$", f"label: {label}", source, count=1, flags=re.M)
        if step == 0:
            return _call("check_definition", kind=kind, source=source)
        if step == 1:
            if not results[0][1].get("ok"):
                return _say(f"It doesn't check: {results[0][1].get('errors')}")
            return _call("propose_definition", kind=kind, source=source, summary=f"Renamed it {label}.")
        return _say(f"It's in the editor, called {label}: check it and save.")
    if lowered.startswith("rename "):
        # Beside an editor, the label changed with one small edit to the
        # turn's draft, then the draft proposed -- nothing written whole (D114).
        found = re.search(r"^label: (.*)$", reads, re.M)
        if not found:
            return _say("I wasn't given an editor this turn.")
        label = text[len("rename "):].strip()
        if step == 0:
            return _call("edit_definition", edits=[{"find": f"label: {found.group(1)}", "replace": f"label: {label}"}])
        if step == 1:
            return _call("propose_definition", summary=f"Renamed it {label}.")
        return _say(f"It's in the editor, called {label}, changed with one edit.")
    if "which run" in lowered:  # a run's chat prefixes who asked
        found = re.search(r"get_workflow_run \(this chat's run\):\n(\{.*\})", reads)
        if not found:
            return _say("I wasn't given a run this turn.")
        run = json.loads(found.group(1))
        return _say(f"This is {run.get('workflow_label')} #{run.get('number')}, and it {run.get('status')}.")
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


def _section(text: str, start: str, end: Optional[str]) -> str:
    part = text.split(start, 1)[1] if start in text else ""
    return part.split(end, 1)[0] if end and end in part else part


def _check(evidence: str) -> dict:
    """The answer check's verdict, by two rules -- enough to drive a redo."""
    request = _section(evidence, "Request:\n", "\n\nWhat ran this turn:").lower()
    steps = _section(evidence, "What ran this turn:\n", "\n\nSessions it touched")
    sessions = _section(evidence, "Sessions it touched, as they are now:\n", "\n\nThe answer:")
    answer = _section(evidence, "The answer:\n", None).lower()
    running = re.search(r'"status":\s*"running"', sessions) is not None
    if re.search(r"\bconnected (and|now)\b", answer) and not running:
        return {"verdict": "unsupported", "problems": ["The answer says it's connected, but the pane's run isn't running."]}
    if "connect" in request and "called run_pane" not in steps:
        return {"verdict": "not_done", "problems": ["Asked to connect, but run_pane was never called."]}
    return {"verdict": "ok", "problems": []}


JOBS = {
    "id": "list_jobs", "run_label": "List jobs",
    "request": {"connection": "connections", "service": "iot", "operation": "ListJobs", "paginate": True,
                "output": "jobs",
                "rows": {"at": "jobs.items", "columns": {"Job": "jobId", "Status": "status",
                                                         "Created": {"from": "createdAt", "as": "time"}}}},
}
RULES = {
    "id": "list_rules", "run_label": "List rules",
    "request": {"connection": "connections", "service": "iot", "operation": "ListTopicRules", "paginate": True,
                "output": "rules",
                "rows": {"at": "rules", "columns": {"Rule": "ruleName", "Topic": "topicPattern",
                                                    "Disabled": "ruleDisabled"}}},
}


def _mode(mode: str) -> dict:
    return {"input": "searchMode", "equals": mode}


# As a real model wrote them (the user's chat): no op, `new` (or `old`/`new`),
# "/-" for the end of a list, lists and mappings as text.
MODES = [
    {"path": "label", "new": "IoT, with rules and jobs"},
    {"path": "inputs/searchMode/choices", "old": "[things, certificates]", "new": "[things, certificates, rules, jobs]"},
    {"path": "inputs/searchMode/choice_labels", "old": "{things: Things, certificates: Certificates}",
     "new": "{things: Things, certificates: Certificates, rules: Rules, jobs: Jobs}"},
    {"path": "actions/-", "new": str({
        "id": "list_rules", "run_label": "Search", "main": _mode("rules"), "when": _mode("rules"),
        "request": {"connection": "connections", "service": "iot", "operation": "ListTopicRules", "paginate": True,
                    "output": "rules", "rows": {"at": "rules", "columns": {"Rule": "ruleName", "Topic": "topicPattern"}}},
    })},
    {"path": "actions/-", "new": str({
        "id": "list_jobs", "run_label": "Search", "main": _mode("jobs"),
        "request": {"connection": "connections", "service": "iot", "operation": "ListJobs", "paginate": True,
                    "output": "jobs", "rows": {"at": "jobs", "columns": {"Job": "jobId", "Status": "status"}}},
    })},
    {"path": "outputs/-", "new": "{'key': 'rules', 'render': 'table'}"},
    {"path": "outputs/-", "new": "{'key': 'jobs', 'render': 'table'}"},
    {"path": "layout/2. Search/items/input=queryString/when", "new": {"input": "searchMode", "not_in": ["rules", "jobs"]}},
    {"path": "layout/2. Search/items/-1/toolbar/action=search/when", "new": {"input": "searchMode", "not_in": ["rules", "jobs"]}},
    {"path": "layout/2. Search/items/-1/toolbar/-", "new": {"action": "list_rules", "when": _mode("rules")}},
    {"path": "layout/2. Search/items/-1/toolbar/-", "new": {"action": "list_jobs", "when": _mode("jobs")}},
    {"path": "layout/3. Results/clear", "old": "[thingResults, certResults]", "new": "[thingResults, certResults, rules, jobs]"},
    {"path": "layout/3. Results/items/-", "new": {"output": "rules", "when": _mode("rules")}},
    {"path": "layout/3. Results/items/-", "new": {"output": "jobs", "when": _mode("jobs")}},
]


def _card(title: str, action: str, output: str) -> dict:
    return {"title": title, "items": [{"toolbar": [{"action": action}]}, {"output": output}]}


# "use code": a file whose third line doesn't parse.
SHAPED = ("def run(inputs, ctx):\n    items = ctx.http(inputs['connection'], '/devices').json()['items']\n"
          "    rows = sorted(items, key=lambda d: d['id']\n    ctx.log('sorted', len(rows))\n    return {'rows': rows}\n")


def _builder(messages: list[dict]) -> str:
    """The Builder's loop (app/builder.py), one JSON object per call."""
    asked = next(_content(m) for m in reversed(messages) if m.get("role") == "user" and "The user's request: " in _content(m))
    request = asked.rsplit("The user's request: ", 1)[1].split("\n\n", 1)[0].strip()
    lowered = request.lower()
    retried = _content(messages[-1]).startswith("(From the platform: that reply wasn't")
    phase = "plan" if "First, decide." in asked else ("repair" if "Reply with the changes that fix this" in asked else "change")
    label = request.split(" ", 1)[1] if " " in request else request
    if lowered.startswith("garbled") and phase == "plan" and not retried:
        return "Sure! I'll rename it for you."
    if lowered.startswith("long") and phase == "change" and "cut off at your length limit" not in _content(messages[-1]):
        BUILD_FINISH[0] = "length"
        return '{"summary": "Renamed it.", "changes": [{"op": "file", "name": "big.py", "text": "def run(inputs, ctx'
    if lowered.startswith("lost") and phase == "repair":
        return "I'm not sure what to change now."
    if lowered.startswith("explain"):
        return json.dumps({"change": False, "answer": "rows.at says where the reply keeps its list.", "lookups": []})
    if phase == "plan":
        lookups = []
        if "jobs and rules" in lowered and not lowered.startswith("add modes"):
            lookups = [{"service": "iot", "operation": "ListJobs"}, {"service": "iot", "operation": "ListTopicRules"}]
        start = "recipe:invoices" if lowered.startswith("start from recipe invoices") else None
        return json.dumps({"change": True, "plan": f"Do this: {request}.", "lookups": lookups, "examples": [],
                           "start_from": start})
    if lowered.startswith("impossible"):
        return json.dumps({"give_up": "That needs a handler the platform doesn't have."})
    if lowered.startswith("add modes for jobs and rules"):
        if phase == "repair":
            # Told an action has no `when`, it takes the stray one off.
            return json.dumps({"summary": "Took off a when.", "changes": [{"op": "delete", "path": "actions/list_rules/when"}]})
        return json.dumps({"summary": "Rules and jobs are two more choices of Search for, each searched by its own "
                                      "request.", "changes": MODES})
    if lowered.startswith("bad op"):
        label = request[len("bad op"):].strip()
        if "Your first change, written that way" in asked:
            return json.dumps({"summary": f"Renamed it {label}.", "changes": [{"op": "set", "path": "label", "value": label}]})
        return json.dumps({"summary": "x", "changes": [{"op": "patch", "path": "label", "value": label}]})
    if "jobs and rules" in lowered:
        if phase == "repair":
            # Told where ListJobs keeps its list (the check names it).
            fix = "jobs" if "lists are at: jobs" in asked else "jobs.items"
            return json.dumps({"summary": "Added the jobs and rules lists.", "changes": [
                {"op": "set", "path": "actions/list_jobs/request/rows/at", "value": fix}]})
        return json.dumps({"summary": "Added the jobs and rules lists, each with its own card.", "changes": [
            {"op": "set", "path": "label", "value": "IoT, jobs and rules"},
            {"op": "add", "path": "actions", "value": JOBS},
            {"op": "add", "path": "actions", "value": RULES},
            {"op": "add", "path": "outputs", "value": {"key": "jobs", "render": "table"}},
            {"op": "add", "path": "outputs", "value": {"key": "rules", "render": "table"}},
            {"op": "add", "path": "layout", "value": _card("Jobs", "list_jobs", "jobs")},
            {"op": "add", "path": "layout", "value": _card("Rules", "list_rules", "rules")},
        ]})
    if lowered.startswith("add a clear button"):
        # As a real model did (D126): first an action with nothing to run;
        # told a Clear is the card's, it drops the action by its lines and
        # sets the card's `clear` through an item in brackets.
        if phase == "repair" and "it's the card's `clear: [output keys]`" in asked:
            shown = asked.split("with line numbers:\n", 1)[-1].splitlines()
            at = next((int(m.group(1)) for line in shown if (m := re.match(r"(\d+): .*id: clear", line))), None)
            changes: list[dict] = [{"op": "set", "path": "layout[0]/clear", "value": ["rows"]}]
            if at is not None:
                # The item's lines: its `- id` and the deeper ones under it.
                end = at
                while end < len(shown) and re.match(r"\d+: {5,}\S", shown[end]):
                    end += 1
                changes.insert(0, {"op": "lines", "from": at, "to": end, "text": ""})
            return json.dumps({"summary": "A Clear on the results' card.", "changes": changes})
        return json.dumps({"summary": "Added a clear action.", "changes": [
            {"op": "add", "path": "actions", "value": {"id": "clear", "run_label": "Clear"}}]})
    if lowered.startswith("use code"):
        # Code as a file beside the YAML (D139), with a line that doesn't
        # parse; told its file and line, it changes that line.
        if phase == "repair":
            m = re.search(r"shaped\.py, line (\d+)", asked)
            at = int(m.group(1)) if m else 3
            return json.dumps({"summary": "Closed the sort's bracket.", "changes": [
                {"op": "lines", "file": "shaped.py", "from": at, "to": at,
                 "text": "    rows = sorted(items, key=lambda d: d['id'])"}]})
        return json.dumps({"summary": "The list is code now, in shaped.py: devices sorted by id.", "changes": [
            {"op": "file", "name": "shaped.py", "text": SHAPED},
            {"op": "set", "path": "actions/list/code", "value": {"file": "shaped.py"}}]})
    if lowered.startswith("open jobs") or "run as its user will" in asked:
        # D153: rows that open, its row action reading the column by the
        # field's name; told what trying it found, it reads the column the
        # rows have.
        if phase == "repair" and "got nothing for job_id" in asked:
            return json.dumps({"summary": "The row action reads the Job ID column.", "changes": [
                {"op": "set", "path": "actions/job/args/job_id", "value": "row.Job ID"}]})
        return json.dumps({"summary": "Jobs open onto their detail.", "changes": [
            {"op": "add", "path": "actions", "value": {"id": "job", "args": {"connection": "row.Environment",
                                                                           "job_id": "row.jobId"},
                                                       "code": {"file": "job.py"}}}]})
    if lowered.startswith("never clean") or lowered.startswith("lost"):
        return json.dumps({"summary": "Added a card.", "changes": [
            {"op": "add", "path": "layout", "value": {"title": f"Card {len(messages)}", "items": [{"output": "nothing"}]}}]})
    return json.dumps({"summary": f"Renamed it {label}.", "changes": [{"op": "set", "path": "label", "value": label}]})


BUILDS: list[dict] = []
# How the next build reply ended ("length": cut off), reset after each.
BUILD_FINISH = ["stop"]


@app.post("/chat/completions")
@app.post("/v1/chat/completions")
async def completions(request: Request):
    body = await request.json()
    sent = body.get("messages") or []
    if sent and sent[0].get("role") == "system" and _content(sent[0]).startswith(CHECK_MARK):
        CHECKS.append(body)
        del CHECKS[:-20]
        verdict = json.dumps(_check(_content(sent[-1])))
        return JSONResponse(
            {
                "id": "chatcmpl-fake-check",
                "object": "chat.completion",
                "created": int(time.time()),
                "model": body.get("model", "fake"),
                "choices": [{"index": 0, "message": {"role": "assistant", "content": verdict}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
            }
        )
    if sent and sent[0].get("role") == "system" and _content(sent[0]).startswith(BUILDER_MARK):
        BUILDS.append(body)
        del BUILDS[:-40]
        content = _builder(sent)
        finish, BUILD_FINISH[0] = BUILD_FINISH[0], "stop"
        return JSONResponse(
            {
                "id": "chatcmpl-fake-build",
                "object": "chat.completion",
                "created": int(time.time()),
                "model": body.get("model", "fake"),
                "choices": [{"index": 0, "message": {"role": "assistant", "content": content},
                             "finish_reason": finish}],
                "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
            }
        )
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
    # "slow <anything>": that turn, with a pause before each reply -- the
    # quiet while a reasoning model works out its next step, for a test to
    # watch the chat say it's still working (smoke76). In a shared session's
    # chat it comes as "<name>: @platform-agent slow …", and runs as the rest.
    slow_match = re.match(r"(?:[\w.-]+: )?(?:@platform-agent )?slow (.*)", text, re.I | re.S)
    slow = slow_match is not None
    if slow_match:
        text = slow_match.group(1)
    step = _next(text, results, _reads(messages), _nudged(messages))
    if STEP_DELAY or slow:
        await asyncio.sleep(max(STEP_DELAY, SLOW_STEP_SECONDS if slow else 0))
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
