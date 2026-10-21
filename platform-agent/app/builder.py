"""The Builder's agent (PLATFORM_PLAN.md §24, D116): a turn beside an editor,
run as a loop the code drives rather than one the model does.

A turn beside the Builder used to be the chat agent with build tools (D107,
D114): the model chose every step -- read, edit, check, propose -- and a real
model (Kimi, asked to add IoT's jobs and rules) read the draft again and
again, missed its find-and-replace edits, said "I need to add the outputs
first" and stopped, turn after turn. Each of those is a decision the model no
longer makes:

1. **Plan** -- one model call, one JSON object: answer a question, or say what
   will change and what it needs to read first (AWS operations, examples).
2. **Read** -- the code reads them (describe_aws_operation, read_definition):
   the reply's real fields, not a guess.
3. **Change** -- one model call: the changes as paths and plain data
   (change_definition, yaml_edit.py), never text to find.
4. **Check and repair** -- the code applies them and checks the draft; a
   problem, or a change that couldn't be made, goes back to the model with the
   draft as it now is, up to `rounds` times.
5. **Propose** -- clean, the draft goes in the editor. Out of rounds, it goes
   there anyway with its problems named, so the next turn ("carry on") starts
   from the work rather than from nothing.

The model never decides when to stop, so it can't stop halfway; it never
copies text, so an edit can't miss; and every change is all-or-none and
checked, so it can't leave a draft that names an output it hasn't declared.
Every call acts as the user, through the same MCP tools and token as any
turn (nothing here reaches the platform another way).
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any, AsyncIterator, Optional

from langchain_core.messages import HumanMessage, SystemMessage, ToolMessage

from .text import CLOSE

logger = logging.getLogger(__name__)

MAX_LOOKUPS = 6
MAX_EXAMPLES = 2
# How often a reply that isn't the JSON asked for is asked for again.
JSON_RETRIES = 2
HISTORY_MESSAGES = 8
HISTORY_CHARS = 1_500

SYSTEM = """\
You are the platform's Builder. You change one {noun} definition -- YAML, in \
the user's editor -- to do what they ask. Every reply of yours is ONE JSON \
object, exactly the shape asked for, and nothing else: no prose before or \
after it, no code fence needed.

What a definition may say is the reference below: use only the fields, \
handlers, live functions, input types and renders it lists. Never invent one; \
if what's asked needs something that doesn't exist, say so instead of \
changing anything.
"""

PANE_RULES = """\
Pane types:
- A pane's action is a request (an HTTP GET on an HTTP connection, or with \
`service` and `operation` any AWS read API on an AWS connection), a handler \
from the reference's list, or a live function. A pane for an AWS service no \
handler covers is an AWS request -- never say it can't be built.
- An AWS request's `rows.at` and its columns name fields of the operation's \
reply: read them from describe_aws_operation, never guess.
- A pane with more than one request gives each its own `output` (the output \
its rows go to), declared in `outputs` (render table); without it they all \
write `rows` and running one clears the others.
- A new list in a pane needs three things, in the same set of changes: its \
action, its output, and a layout item showing it (with a toolbar holding the \
action's button). Never one without the others.
- A pane with modes (a choice input) whose button does something different per \
mode: add a choice per mode, one action per mode with `main: {input: <mode>, \
equals: <value>}` (the existing one may stay `main: true` for the rest), and \
each button shown with `when` for its mode. Actions have no `when`; layout \
items do.
- Rows that open to show more of one row: the table's `config.detail` names a \
row action (an action with `args` read from the row, its own request) and \
`config.expand` a view key declared in `views` -- as the reference's `rows \
that open (example)` does. A config key the reference's `output config` \
doesn't list does nothing.
- A column's path is not JMESPath: a list item is picked by a field, \
Tags[Key=Name].Value.
- A Clear button is the card's `clear: [output keys]` (the results it \
empties), shown while one holds something -- never an action.
- Code (where a request can't do it: joining two calls, working something \
out) is a Python file beside the YAML, written with {"op": "file"}, and the \
action names it: `code: {file: health.py}`. Never Python inside a YAML string.
- Keep what already works. Change or add what's asked; never replace a \
working action, input or card with another.
"""

STEP_RULES = """\
Step types:
- A step type is a request (an HTTP call on a connection input of an HTTP \
connection_type, its path, query, headers and body templated from \
inputs.<key>) or steps (a workflow's steps, reading inputs.<key> where a \
workflow reads params), never both; `outputs` says what steps hand on.
- Anything but a GET changes something: a workflow asks a person first.
- Or code: a Python file beside the YAML (written with {"op": "file"}) that \
`code: {file: x.py}` names; `changes: true` when it changes something.
"""

PLAN = """\
First, decide. Reply with:
{{
  "change": true or false,
  "answer": "if change is false: your answer to the user -- they asked a question, or what they want can't be built and why",
  "plan": "if change is true: one to three sentences on what you will change",
  "lookups": [{{"service": "iot", "operation": "ListJobs"}}],
  "examples": ["iot"]
}}
`lookups`: the AWS operations whose params and reply you need to write requests (at most {lookups}; an \
operation left out lists the service's read operations). `examples`: existing definitions whose YAML to read \
first, from the reference's examples (at most {examples}). Both [] when you need none.
"""

CHANGES = """\
Now write the change. Reply with:
{{
  "summary": "one or two sentences for the user: what changed",
  "changes": [
    {{"op": "set", "path": "label", "value": "IoT, jobs and rules"}},
    {{"op": "add", "path": "outputs", "value": {{"key": "jobs", "render": "table"}}}},
    {{"op": "add", "path": "layout", "value": {{"title": "Jobs", "items": [{{"output": "jobs"}}]}}, "before": "Results"}},
    {{"op": "set", "path": "actions/list_jobs/request/rows/at", "value": "jobs"}},
    {{"op": "remove", "path": "layout/Results/items/output=certResults"}}
  ]
}}
Each change: `op` set (replace or add a key), add (append an item to a list -- made if missing -- or insert it \
`before` an item) or remove (a key or an item); `path` where, its parts separated by "/": mapping keys, and list \
items named by their key, id or title (or field=value, or their index); `value` plain data, written as it would \
be in YAML. Paths name the draft as it is now. Make all of the change in this one reply.
Or by line, when that's plainer (stray lines, a block to rewrite): {{"op": "lines", "from": 72, "to": 74, \
"text": "what goes there"}} -- the draft's lines as numbered below, both kept in, `text` empty to delete them.
Python goes in a file beside the YAML: {{"op": "file", "name": "health.py", "text": "the whole file"}} writes it \
(`"remove": true` removes it); {{"op": "lines", "file": "health.py", "from": 3, "to": 5, "text": "..."}} changes \
its lines as numbered below. The YAML names it: `code: {{"file": "health.py"}}`.
If you must read something first, reply {{"lookups": [...], "examples": [...]}} with no changes. If it can't be \
done with what the reference lists, reply {{"give_up": "why, for the user"}}.
""".format()  # Its braces doubled like PLAN's: sent as they were, the model read {{"op": …}} and made up its own.

REPAIR = """\
{what}

Reply with the changes that fix this, in the same shape as before ({{"summary", "changes"}}), against the draft \
as it is now (below). Fix the cause, not the symptom: an item named but not declared is declared; a field the \
reply doesn't have is replaced with one it does.
"""

# Said again whenever changes couldn't be made at all: a model that wrote
# {"path", "old", "new"} was told only that its op was wrong, and wrote the
# same three rounds running.
SHAPE = """\
Each change is exactly {"op": "set" | "add" | "remove", "path": "where", "value": the data} -- `value` is the \
YAML's data as JSON (a list as [..], a mapping as {..}), never text holding YAML; `add` appends to the list at \
`path`; `remove` has no value -- or by line, {"op": "lines", "from": 72, "to": 74, "text": "new lines, or empty \
to delete"} -- or a Python file, {"op": "file", "name": "health.py", "text": "the whole file"} (`"file"` on a \
"lines" change edits that file's lines). Nothing else goes in a change."""


def _noun(kind: str) -> str:
    return {"pane": "pane type", "step": "step type"}.get(kind, "workflow")


def _text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(b.get("text", "") if isinstance(b, dict) else str(b) for b in content)
    return ""


def parse_json(text: str) -> dict:
    """The one JSON object in a reply: after any reasoning (`…</think>`),
    inside a ```json fence or not. ValueError when there isn't one."""
    if CLOSE in text:
        text = text.rsplit(CLOSE, 1)[1]
    fenced = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, re.S)
    if fenced:
        text = fenced.group(1)
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("there is no JSON object in it")
    body = text[start:end + 1]
    try:
        value = json.loads(body)
    except ValueError as e:
        # A trailing comma is the slip models make most; anything else is
        # asked for again.
        try:
            value = json.loads(re.sub(r",(\s*[}\]])", r"\1", body))
        except ValueError:
            raise ValueError(f"it isn't valid JSON ({e})") from None
    if not isinstance(value, dict):
        raise ValueError("it isn't a JSON object")
    return value


def _numbered(source: str) -> str:
    lines = source.splitlines()
    return "\n".join(f"{n}: {line}" for n, line in enumerate(lines, 1)) if lines else "(empty)"


def _place(e: dict) -> str:
    """"health.py, line 4: " / "line 4: " -- where a problem is."""
    if e.get("file") and e.get("line"):
        return f"{e['file']}, line {e['line']}: "
    if e.get("file"):
        return f"{e['file']}: "
    return f"line {e['line']}: " if e.get("line") else ""


def _history(messages: list[dict]) -> str:
    """The conversation before this request, briefly: what was asked and
    answered, for "now make it…" to mean something."""
    earlier = messages[:-1][-HISTORY_MESSAGES:]
    if not earlier:
        return ""
    lines = []
    for m in earlier:
        content = (m.get("content") or "").strip()
        if len(content) > HISTORY_CHARS:
            content = content[:HISTORY_CHARS] + "…"
        lines.append(f"{'User' if m['role'] == 'user' else 'You'}: {content}")
    return "Earlier in this conversation:\n" + "\n".join(lines) + "\n\n"


def _compact(text: str) -> str:
    try:
        return json.dumps(json.loads(text), separators=(",", ":"), ensure_ascii=False)
    except ValueError:
        return text


class Builder:
    """One build turn: its tools, its model, and the events it yields."""

    def __init__(self, tools: dict, model: Any, focus: dict, messages: list[dict], rounds: int):
        self.tools = tools
        self.model = model
        self.focus = focus
        self.kind = focus["what"]
        self.messages = messages
        self.rounds = rounds
        self.events: list[dict] = []
        self.steps = 0
        self.reference = ""
        self.read: list[str] = []  # what the lookups and examples returned, for the model
        # The Python files beside the draft (D139), as they are now.
        self.files: dict[str, str] = dict(focus.get("files") or {})

    # ------------------------------------------------------------ tools

    async def call(self, name: str, args: dict, shown: bool = True) -> tuple[bool, str]:
        """A tool, as the user, reported as a step when `shown` (marked a
        preamble: the platform's own step, never replayed as the model's)."""
        tool = self.tools.get(name)
        if tool is None:
            return False, f"The platform has no tool {name}."
        self.steps += 1
        step_id = f"build-{self.steps}"
        if shown:
            self.events.append({"type": "tool_call", "id": step_id, "name": name, "args": args, "preamble": True})
        try:
            result = await tool.ainvoke({"name": name, "args": args, "id": step_id, "type": "tool_call"})
            output = _text(result.content if isinstance(result, ToolMessage) else result)
            ok = not (isinstance(result, ToolMessage) and result.status == "error")
        except Exception as e:  # noqa: BLE001 -- a failed step is fed back, not raised
            output, ok = str(e) or type(e).__name__, False
        if shown:
            event: dict[str, Any] = {"type": "tool_result", "id": step_id, "name": name, "ok": ok,
                                     "summary": output[:400] + ("…" if len(output) > 400 else "")}
            if name == "change_definition" and ok and _json(output).get("ok") is False:
                # Made, and not checking clean: shown as a step to fix.
                event["ok"] = False
            propose = _propose(output) if name == "propose_definition" else None
            if propose:
                event["propose"] = propose
            self.events.append(event)
        return ok, output

    # ------------------------------------------------------------ the model

    async def ask(self, label: str, instructions: str, context: str) -> dict:
        """One model call for one JSON object, shown as a step; asked again
        (JSON_RETRIES) when the reply isn't one."""
        self.steps += 1
        step_id = f"build-{self.steps}"
        self.events.append({"type": "tool_call", "id": step_id, "name": label, "args": {}, "preamble": True})
        system = SYSTEM.format(noun=_noun(self.kind)) + {"pane": PANE_RULES, "step": STEP_RULES}.get(self.kind, "")
        conversation = [SystemMessage(content=system), HumanMessage(content=context + "\n\n" + instructions)]
        problem = ""
        for _ in range(JSON_RETRIES + 1):
            try:
                reply = await self.model.ainvoke(conversation)
            except Exception as e:  # noqa: BLE001 -- said as the turn's failure
                self.events.append({"type": "tool_result", "id": step_id, "name": label, "ok": False,
                                    "summary": str(e)[:400]})
                raise BuildFailed(f"The model couldn't be reached: {str(e)[:300]}") from None
            text = _text(reply.content)
            try:
                value = parse_json(text)
            except ValueError as e:
                problem = str(e)
                conversation += [reply, HumanMessage(content=(
                    f"(From the platform: that reply wasn't the JSON object asked for -- {problem}. Reply with the "
                    "JSON object alone.)"))]
                continue
            summary = value.get("plan") or value.get("summary") or value.get("answer") or value.get("give_up") or ""
            self.events.append({"type": "tool_result", "id": step_id, "name": label, "ok": True,
                                "summary": str(summary)[:400]})
            return value
        self.events.append({"type": "tool_result", "id": step_id, "name": label, "ok": False,
                            "summary": f"No JSON in the reply: {problem}"})
        raise BuildFailed("The model didn't answer in the shape the Builder needs, after being asked again. "
                          "Try again, or try a different model for building (agent.builder.model).")

    # ------------------------------------------------------------ the turn

    def context(self, draft: str, plan: str = "") -> str:
        parts = [f"The reference (what a {_noun(self.kind)} may say):\n{self.reference}"]
        parts += self.read
        if plan:
            parts.append(f"Your plan: {plan}")
        parts.append(f"The draft now, with line numbers:\n{_numbered(draft)}")
        for name, text in sorted(self.files.items()):
            parts.append(f"The file {name} beside it, with line numbers:\n{_numbered(text)}")
        parts.append(_history(self.messages) + f"The user's request: {self.messages[-1]['content']}")
        return "\n\n".join(parts)

    async def lookups(self, value: dict) -> int:
        done = 0
        for item in (value.get("lookups") or [])[:MAX_LOOKUPS]:
            if self.kind != "pane" or not isinstance(item, dict) or not item.get("service"):
                continue
            args = {"service": str(item["service"])}
            if item.get("operation"):
                args["operation"] = str(item["operation"])
            ok, out = await self.call("describe_aws_operation", args)
            what = f"{args['service']} {args.get('operation', '')}".strip()
            self.read.append(f"describe_aws_operation {what}:\n{_compact(out) if ok else 'Failed: ' + out}")
            done += 1
        for example in (value.get("examples") or [])[:MAX_EXAMPLES]:
            if not isinstance(example, str):
                continue
            ok, out = await self.call("read_definition", {"kind": self.kind, "definition_id": example})
            files: dict = {}
            if ok:
                try:
                    found = json.loads(out)
                    out, files = found.get("source", out), found.get("files") or {}
                except (ValueError, AttributeError):
                    pass
            self.read.append(f"The YAML of {example}:\n{out}" if ok else f"read_definition {example} failed: {out}")
            for name, text in sorted(files.items()):
                self.read.append(f"{example}'s file {name}:\n{text}")
            done += 1
        return done

    async def _read(self, args: dict) -> Optional[dict]:
        ok, out = await self.call("read_draft", args, shown=False)
        if not ok:
            return None
        try:
            value = json.loads(out)
        except ValueError:
            return None
        return value if isinstance(value, dict) else None

    async def draft(self) -> str:
        """The draft as it is now, and its files with it (self.files)."""
        value = await self._read({})
        if value is None:
            return self.focus.get("source") or ""
        files = {}
        for name in value.get("files") or {}:
            read = await self._read({"file": name})
            if read is not None:
                files[name] = _unnumbered(read.get("text", "")) + "\n"
        self.files = files
        # read_draft numbers its lines; the context numbers them again.
        return _unnumbered(value.get("text", ""))

    async def run(self) -> AsyncIterator[dict]:
        ok, reference = await self.call("build_reference", {"kind": self.kind})
        if not ok:
            raise BuildFailed(f"The Builder's reference couldn't be read: {reference[:300]}")
        self.reference = _compact(reference)
        for event in self.flush():
            yield event
        draft = self.focus.get("source") or ""

        decided = await self.ask("plan_change", PLAN.format(lookups=MAX_LOOKUPS, examples=MAX_EXAMPLES),
                                 self.context(draft))
        for event in self.flush():
            yield event
        if not decided.get("change"):
            yield {"type": "text", "delta": str(decided.get("answer") or "There's nothing to change.")}
            return
        plan = str(decided.get("plan") or "")
        await self.lookups(decided)
        for event in self.flush():
            yield event

        instructions = CHANGES
        summary = plan
        problems = ""
        applied = False
        fixed = 0
        for _ in range(self.rounds):
            value = await self.ask("write_changes", instructions, self.context(draft, plan))
            for event in self.flush():
                yield event
            if value.get("give_up"):
                yield {"type": "text", "delta": str(value["give_up"])}
                return
            changes = value.get("changes")
            if not changes:
                if await self.lookups(value):
                    for event in self.flush():
                        yield event
                    instructions = CHANGES
                    continue
                problems = "the model's reply had no changes"
                instructions = REPAIR.format(what="That reply had no changes.")
                continue
            if not applied:
                # The first change's summary says what was built; a repair's
                # only what it fixed.
                summary = str(value.get("summary") or summary)
            ok, out = await self.call("change_definition", {"changes": changes})
            for event in self.flush():
                yield event
            if not ok:
                again = " You sent changes that couldn't be made before, the same way: write them as below." if out == problems else ""
                problems = out
                example = _reshaped(changes)
                instructions = REPAIR.format(what=f"Your changes couldn't be made, so none were: {out}{again}\n\n"
                                                  f"{SHAPE}" + (f"\nYour first change, written that way: {example}"
                                                                if example else ""))
                continue
            applied = True
            result = _json(out)
            draft = await self.draft()
            if result.get("ok"):
                ok, out = await self.call("propose_definition", {"summary": summary})
                for event in self.flush():
                    yield event
                if ok:
                    caught = f" The check caught {fixed} problem{'s' if fixed > 1 else ''} on the way, fixed." if fixed else ""
                    yield {"type": "text", "delta": f"{summary}{caught}\n\nIt's in the editor, not saved yet: look it "
                                                    "over, preview it and save."}
                    return
                problems = out
            else:
                problems = "; ".join(f"{_place(e)}{e.get('message')}" for e in result.get("errors") or [])
            fixed += 1
            instructions = REPAIR.format(what=f"Your changes were made, and the draft now has these problems: "
                                              f"{problems}")
        if not applied:
            yield {"type": "text", "delta": f"I couldn't make the change: {problems[:600]}"}
            return
        # Out of rounds: the work so far goes in the editor, named for what it is.
        ok, out = await self.call("propose_definition", {"summary": summary, "even_with_problems": True})
        for event in self.flush():
            yield event
        if ok:
            yield {"type": "text", "delta": f"{summary}\n\nIt's in the editor, but it doesn't check clean yet -- "
                                            f"the editor's Check lists what's left. Ask me to carry on and I'll "
                                            f"start from there."}
            yield {"type": "notice", "message": f"The draft still has problems: {problems[:600]}"}
        else:
            yield {"type": "text", "delta": f"I couldn't get the change to check clean: {problems[:600]}"}

    def flush(self) -> list[dict]:
        events, self.events = self.events, []
        return events


class BuildFailed(Exception):
    """A turn the Builder can't carry on with; the message is the user's."""


def _reshaped(changes: Any) -> str:
    """The model's first change in the shape asked for, as far as it can be
    read -- an example in its own terms beats a rule restated."""
    first = changes[0] if isinstance(changes, list) and changes else None
    if not isinstance(first, dict) or not first.get("path"):
        return ""
    path = str(first["path"])
    value = next((first[k] for k in ("value", "new", "new_value") if k in first), None)
    op = "add" if path.endswith("/-") else ("remove" if value is None else "set")
    out: dict[str, Any] = {"op": op, "path": path.removesuffix("/-")}
    if op != "remove":
        out["value"] = value
    return json.dumps(out, ensure_ascii=False)[:400]


def _json(text: str) -> dict:
    try:
        value = json.loads(text)
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


def _unnumbered(text: str) -> str:
    return "\n".join(re.sub(r"^\d+: ", "", line, count=1) for line in text.splitlines())


def _propose(output: str) -> Optional[dict]:
    propose = _json(output).get("propose")
    if not (isinstance(propose, dict) and isinstance(propose.get("source"), str)):
        return None
    out: dict[str, Any] = {k: propose[k] for k in ("kind", "source", "summary") if isinstance(propose.get(k), str)}
    if isinstance(propose.get("files"), dict):
        out["files"] = {str(k): str(v) for k, v in propose["files"].items()}
    return out


async def run_build(tools: list, model: Any, focus: dict, messages: list[dict], rounds: int) -> AsyncIterator[dict]:
    """The turn's events (agent.py's stream), ending in done or an error."""
    builder = Builder({t.name: t for t in tools}, model, focus, messages, rounds)
    try:
        async for event in builder.run():
            yield event
    except BuildFailed as e:
        for event in builder.flush():
            yield event
        yield {"type": "error", "message": str(e)}
        return
    yield {"type": "done"}
