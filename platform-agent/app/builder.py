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

from .repair import cut_off
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
- A row action's `args` read the row by its columns as the rows name them: \
`row.Job ID` when the columns say `Job ID: jobId` (`row.Environment` for a \
fan-out's environment). A detail's templates read `d`, what the row action \
returns: an AWS request's reply as describe_aws_operation shows it \
(`d.job.status`), code's the mapping its run returns.
- A value each row needs that only another call returns (a count, a status, \
something from a Describe per row) makes the action that lists the rows code: \
it lists them, makes that call for each and returns the rows with those \
columns -- the table, its export and CSV are the rows as they are. Another \
action can't add columns to rows already listed.
- A column's path is not JMESPath: a list item is picked by a field, \
Tags[Key=Name].Value.
- A Clear button is the card's `clear: [output keys]` (the results it \
empties), shown while one holds something -- never an action.
- Code (where a request can't do it: joining two calls, working something \
out) is a Python file beside the YAML, written with {"op": "file"}, and the \
action names it: `code: {file: health.py}`. Never Python inside a YAML string.
- Code sees only its inputs and ctx (http, aws, name, log): a row action's \
inputs are its args, read from the row. It never sees the pane's outputs or \
the selected rows, and reaches only the user's connections, never a URL.
- Exporting rows with their detail is built in: the table's \
`config.detail.include` labels a checkbox beside Export, and `merge` lists \
the detail's fields added to each exported row. Never an export action.
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

TYPE_RULES = """\
Credential and connection types (D159):
- A type is a shape, never a value: no secret, no URL of a real system, goes \
in it. A credential type's fields are what a credential of it holds, each \
secret: true when it's a key, a token or a password.
- A credential type that signs HTTP requests says how in `inject` (header, \
query or basic), its values CEL over the field keys: '"Bearer " + token'.
- A connection type's fields are plain settings beside the Base URL every one \
has; a pane reaches it by its id, as an input's connection_type.
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
first, from the reference's examples, or recipes (recipe:<name>: whole working panes, their comments saying why \
they're built so -- read the one closest to what's asked) (at most {examples}). Both [] when you need none.
"""

START = """
The editor holds no pane yet. Also say what to start from: "start_from": "recipe:<name>" -- the reference's \
recipes are whole working panes, each saying what it shows; take the one closest to what's asked -- or an \
example's id, or null when none is close. The draft becomes that pane, and your changes adapt it.
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



# In a shared draft's chat (D163) the Builder answers only @builder, and the
# message comes as "<who>: @builder <what>": the request is what follows,
# said with who asked. Without the mention it's an unshared chat's, as typed.
_SPEAKER = re.compile(r"^([\w.@-]{1,64}): (.*)$", re.S)
_MENTION = re.compile(r"@builder\b[,:]?\s*", re.I)


def _request(content: str) -> str:
    if not _MENTION.search(content):
        return content
    found = _SPEAKER.match(content)
    who, said = (found.group(1), found.group(2)) if found else (None, content)
    said = _MENTION.sub("", said).strip()
    return f"{said}\n\n(Asked by {who}, in the draft's shared chat.)" if who else said

def _noun(kind: str) -> str:
    return {"pane": "pane type", "step": "step type", "credential": "credential type",
            "connection": "connection type"}.get(kind, "workflow")


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
        # Trying the draft (D153): the environment the user chose to try it
        # on, and whether this turn is that choice (try it, nothing to plan).
        self.try_on: Optional[str] = focus.get("try_on") or None
        self.try_now = bool(focus.get("try_now"))
        # "Fix what's left": nothing to plan either -- what's left is read
        # from the draft, not from the words of the last turn's notice, which
        # may name a change that couldn't be made rather than a problem.
        self.fix_now = bool(focus.get("fix_now"))
        # A pane with nothing built yet (empty, or only the starter): the turn
        # starts from the closest working pane, chosen by the model or, when
        # it names none, by the code (D155).
        self.blank = self.kind == "pane" and bool(focus.get("blank"))
        self.reference_data: dict = {}
        self.started = ""
        self.can_try = self.kind == "pane" and "try_definition" in tools
        # What's done before saving: a pane is previewed; a type (D159) is only read.
        self.review = "preview it" if self.kind == "pane" else "check it"

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
            if name == "try_definition" and ok and _json(output).get("problems"):
                event["ok"] = False  # ran, and showed nothing where it should
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
        system = SYSTEM.format(noun=_noun(self.kind)) + {"pane": PANE_RULES, "step": STEP_RULES,
                                                         "credential": TYPE_RULES, "connection": TYPE_RULES}.get(self.kind, "")
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
                if cut_off(reply):
                    # Asked again the same way, a long reply is cut at the
                    # same place: a turn that wrote two whole files and the
                    # YAML into one change ended "didn't answer in the shape".
                    problem = "it was cut off at the model's length limit"
                    conversation += [HumanMessage(content=(
                        "(From the platform: that reply was cut off at your length limit, so it isn't valid JSON. "
                        "Send less in this reply -- the most important changes; the rest can come next round -- "
                        "and change a file by its lines rather than writing it whole.)"))]
                else:
                    problem = str(e)
                    conversation += [reply, HumanMessage(content=(
                        f"(From the platform: that reply wasn't the JSON object asked for -- {problem}. Reply with "
                        "the JSON object alone.)"))]
                continue
            summary = value.get("plan") or value.get("summary") or value.get("answer") or value.get("give_up") or ""
            self.events.append({"type": "tool_result", "id": step_id, "name": label, "ok": True,
                                "summary": str(summary)[:400]})
            return value
        self.events.append({"type": "tool_result", "id": step_id, "name": label, "ok": False,
                            "summary": f"No JSON in the reply: {problem}"})
        reason = ("its replies were cut off at its length limit (agent.builder.maxTokens)" if "cut off" in problem
                  else "it didn't answer in the shape the Builder needs, after being asked again")
        raise BuildFailed(f"The model couldn't write this: {reason}. Try again, ask for a smaller change, or try a "
                          "different model for building (agent.builder.model).")

    # ------------------------------------------------------------ the turn

    def context(self, draft: str, plan: str = "") -> str:
        parts = [f"The reference (what a {_noun(self.kind)} may say):\n{self.reference}"]
        parts += self.read
        if plan:
            parts.append(f"Your plan: {plan}")
        if self.files:
            # Said before the draft, not only shown after it: with files right
            # there, a model still wrote code into the YAML, or a second file
            # doing what one already did.
            parts.append(f"Files beside the YAML already: {', '.join(sorted(self.files))}. Code lives in these "
                         "files -- change them ({\"op\": \"lines\", \"file\": ...} or {\"op\": \"file\"}); the "
                         "YAML only names them (`code: {file: x.py}`). Never put Python in the YAML.")
        parts.append(f"The draft now, with line numbers:\n{_numbered(draft)}")
        for name, text in sorted(self.files.items()):
            parts.append(f"The file {name} beside it, with line numbers:\n{_numbered(text)}")
        parts.append(_history(self.messages) + f"The user's request: {_request(self.messages[-1]['content'])}")
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

    async def start_from(self, chosen: Any, plan: str) -> Optional[str]:
        """What a blank draft starts from: the recipe or example the model
        named, else the recipe whose notes share the most with what was asked
        -- a plain request ("how many devices succeeded, per job") never says
        "per-row values", and a model left to choose read none and wrote the
        pane from nothing, the hard parts wrong."""
        known = set((self.reference_data.get("recipes") or {})) | set(self.reference_data.get("examples") or [])
        if isinstance(chosen, str) and chosen.strip() in known:
            return chosen.strip()
        wanted = _words(f"{_request(self.messages[-1]['content'])} {plan}")
        best, score, tied = None, 0, False
        for name in sorted(self.reference_data.get("recipes") or {}):
            ok, out = await self.call("read_definition", {"kind": self.kind, "definition_id": name}, shown=False)
            if not ok:
                continue
            notes = "\n".join(line for line in str(_json(out).get("source") or "").splitlines() if line.startswith("#"))
            shared = len(wanted & _words(notes))
            if shared > score:
                best, score, tied = name, shared, False
            elif shared == score:
                tied = True  # two as close: neither is the one
        return best if score >= MIN_SHARED and not tied else None

    async def seed(self, start: str, draft: str) -> str:
        """The draft made the pane it starts from -- its YAML without the
        notes at its head (they go in front of the model instead) and its
        files -- for the changes to adapt, rather than written from nothing."""
        ok, out = await self.call("read_definition", {"kind": self.kind, "definition_id": start})
        found = _json(out) if ok else {}
        source = str(found.get("source") or "")
        if not source:
            return draft
        lines = source.splitlines()
        head = 0
        while head < len(lines) and (lines[head].startswith("#") or not lines[head].strip()):
            head += 1
        notes, body = "\n".join(lines[:head]).strip(), "\n".join(lines[head:]) + "\n"
        changes: list[dict] = [{"op": "lines", "from": 1, "to": max(1, len(draft.splitlines())), "text": body}]
        changes += [{"op": "file", "name": name, "text": text} for name, text in sorted((found.get("files") or {}).items())]
        ok, out = await self.call("change_definition", {"changes": changes})
        if not ok:
            self.read.append(f"The YAML of {start}:\n{source}")
            return draft
        self.started = f"I started from {start}, a working pane close to what you asked, and changed it to fit. "
        self.read.append(f"The draft below started as {start}, a working pane close to what's asked: adapt it -- "
                         f"change, add and remove what the request needs. Why it's built so:\n{notes}")
        return await self.draft()

    async def left(self) -> tuple[list[str], dict, str]:
        """What's wrong with the draft as it is now: Check's problems, else
        what trying it found -- with the words to ask for their fix."""
        ok, out = await self.call("check_definition", {})
        checked = _json(out)
        if not (ok and checked.get("ok")):
            left = [f"{_place(e)}{e.get('message')}" for e in checked.get("errors") or []] or [out[:600]]
            return left, {}, f"The draft has these problems: {'; '.join(left)}"
        verdict = await self.tried() if self.can_try else {}
        left = list(verdict.get("problems") or [])
        return left, verdict, _try_repair(verdict) if left else ""

    async def tried(self) -> dict:
        """The draft run as its user will (try_definition), in the environment
        they chose; what to tell them when it couldn't be."""
        ok, out = await self.call("try_definition", {"environment": self.try_on} if self.try_on else {})
        if not ok:
            return {"skipped": out[:400]}
        return _json(out) or {"skipped": out[:400]}

    async def run(self) -> AsyncIterator[dict]:
        ok, reference = await self.call("build_reference", {"kind": self.kind})
        if not ok:
            raise BuildFailed(f"The Builder's reference couldn't be read: {reference[:300]}")
        self.reference = _compact(reference)
        self.reference_data = _json(reference)
        for event in self.flush():
            yield event
        draft = self.focus.get("source") or ""
        instructions = CHANGES
        problems = ""
        applied = False
        fixed = 0
        seen: set[str] = set()  # the problems the last check found
        stopped = ""  # why the rounds ended early: a reply that couldn't be read
        if (self.try_now and self.can_try) or self.fix_now:
            # The user chose where to try it (the choices a turn offered), or
            # asked for what's left to be fixed: nothing to plan -- check, try,
            # and fix what that shows.
            left, verdict, what = await self.left()
            for event in self.flush():
                yield event
            if not left:
                events = self._tried_events(verdict, alone=True)
                for event in events or [{"type": "text", "delta": "It checks clean: there's nothing left to fix."}]:
                    yield event
                return
            problems = "; ".join(left)
            plan = summary = (f"Fixed what trying it{_on(self.try_on)} showed." if self.try_now
                              else "Fixed what was left.")
            instructions = REPAIR.format(what=what)
            applied = True  # the editor's draft is the one to propose
        else:
            asked = PLAN.format(lookups=MAX_LOOKUPS, examples=MAX_EXAMPLES) + (START if self.blank else "")
            decided = await self.ask("plan_change", asked, self.context(draft))
            for event in self.flush():
                yield event
            if not decided.get("change"):
                yield {"type": "text", "delta": str(decided.get("answer") or "There's nothing to change.")}
                return
            plan = str(decided.get("plan") or "")
            if self.blank:
                start = await self.start_from(decided.get("start_from"), plan)
                if start:
                    draft = await self.seed(start, draft)
            await self.lookups(decided)
            for event in self.flush():
                yield event
            summary = plan
        for _ in range(self.rounds):
            try:
                value = await self.ask("write_changes", instructions, self.context(draft, plan))
            except BuildFailed as e:
                if not applied:
                    raise
                # Changes already made aren't thrown away for one reply that
                # couldn't be read: the draft goes in the editor as it is.
                problems = f"{problems}; then {e}" if problems else str(e)
                stopped = str(e)
                for event in self.flush():
                    yield event
                break
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
            verdict: dict = {}
            if result.get("ok") and self.can_try:
                # Checking clean isn't showing something: run it as its user
                # will, and what comes back empty is a problem like any other.
                verdict = await self.tried()
                for event in self.flush():
                    yield event
            if result.get("ok") and not verdict.get("problems"):
                ok, out = await self.call("propose_definition", {"summary": summary})
                for event in self.flush():
                    yield event
                if ok:
                    caught = f" The check caught {fixed} problem{'s' if fixed > 1 else ''} on the way, fixed." if fixed else ""
                    yield {"type": "text", "delta": f"{self.started}{summary}{caught}\n\nIt's in the editor, not saved yet: look it "
                                                    f"over, {self.review} and save."}
                    for event in self._tried_events(verdict):
                        yield event
                    return
                problems = out
            elif verdict.get("problems"):
                problems = "; ".join(verdict["problems"])
            else:
                problems = "; ".join(f"{_place(e)}{e.get('message')}" for e in result.get("errors") or [])
            fixed += 1
            now = set(verdict.get("problems") or []) or {str(e.get("message")) for e in result.get("errors") or []}
            stuck = sorted(now & seen)
            seen = now
            again = ""
            if stuck:
                # The same problem after a round meant to fix it: the same kind
                # of fix won't. Said so, a model tries another way.
                again = (f"\n\nThese were there before your last changes too, so what you did didn't fix them: "
                         f"{'; '.join(stuck)[:1200]}. Read the lines they name in the draft below and fix them "
                         f"another way -- by line ({{\"op\": \"lines\"}}) if a path doesn't reach.")
            if result.get("moved"):
                again += f"\n\n{result['moved']}"
            instructions = REPAIR.format(what=(_try_repair(verdict) if verdict.get("problems") else
                                               f"Your changes were made, and the draft now has these problems: "
                                               f"{problems}") + again)
        if not applied:
            yield {"type": "text", "delta": f"I couldn't make the change: {problems[:600]}"}
            return
        # Out of rounds: what's left, read from the draft again -- the last
        # thing that went wrong may have been a change that couldn't be made,
        # which left the draft as it was (a turn ended "still has problems:
        # change_definition couldn't…", the draft clean, and the next turn's
        # model was asked to fix that).
        left, verdict, _what = await self.left()
        for event in self.flush():
            yield event
        if not left:
            ok, out = await self.call("propose_definition", {"summary": summary})
            for event in self.flush():
                yield event
            if ok:
                yield {"type": "text", "delta": f"{self.started}{summary}\n\nIt's in the editor, not saved yet: look it over, "
                                                f"{self.review} and save."}
                for event in self._tried_events(verdict):
                    yield event
                return
            left = [out]
        problems = "; ".join(left)
        # The work so far goes in the editor, named for what it is.
        ok, out = await self.call("propose_definition", {"summary": summary, "even_with_problems": True})
        for event in self.flush():
            yield event
        if ok:
            yield {"type": "text", "delta": f"{self.started}{summary}\n\nIt's in the editor, but it doesn't check clean yet -- "
                                            f"the editor's Check lists what's left. Ask me to carry on and I'll "
                                            f"start from there."}
            why = f" (I stopped because the model's last reply couldn't be used: {stopped[:200]})" if stopped else ""
            yield {"type": "notice", "message": f"The draft still has problems: {problems[:600]}{why}"}
        else:
            yield {"type": "text", "delta": f"I couldn't get the change to check clean: {problems[:600]}"}

    def _tried_events(self, verdict: dict, alone: bool = False) -> list[dict]:
        """What trying it found, for the user -- and, when it needs an
        environment they haven't chosen, the choice of one."""
        if not verdict:
            return []
        if verdict.get("needs_environment"):
            lead = "It checks clean." if alone else ""
            return [{"type": "text", "delta": f"{lead}\n\nTo see it work, I can try it on one of your environments: "
                                              "pick one and I'll run it there and fix what comes back empty."},
                    {"type": "choices", "action": "try", "prompt": "Try it on",
                     "options": [str(e) for e in verdict.get("environments") or []]}]
        if verdict.get("skipped"):
            return [{"type": "text", "delta": f"\n\nI didn't try it: {verdict['skipped']}"}]
        rows = ", ".join(f"{n} row{'' if n == 1 else 's'}" + ("" if k == "rows" else f" in {k}")
                         for k, n in (verdict.get("rows") or {}).items())
        said = f"Tried it{_on(verdict.get('environment'))}: {rows or 'it ran'}"
        if verdict.get("opened"):
            said += "; the first row opened onto everything it shows"
        notes = verdict.get("notes") or []
        text = ("" if alone else "\n\n") + said + "." + (f" ({' '.join(notes)[:600]})" if notes else "")
        return [{"type": "text", "delta": text}]

    def flush(self) -> list[dict]:
        events, self.events = self.events, []
        return events


class BuildFailed(Exception):
    """A turn the Builder can't carry on with; the message is the user's."""


# A blank draft starts from the recipe sharing at least this many words with
# the request, when the model names none.
MIN_SHARED = 3
_STOP = set("the and for with that this from what when which their there then them they you your our are was "
            "were has have had not but all any can each its into also want need show see like just more most "
            "one two only some such than too very will would should could here how why who per get those "
            "pane pick start use make build add new".split())


def _words(text: str) -> set[str]:
    """The words of a text that say something, crudely stemmed: `jobs`,
    `job's` and `job` are one."""
    out = set()
    for word in re.findall(r"[a-z]{3,}", text.lower()):
        for suffix in ("ing", "ed", "es", "s"):
            if word.endswith(suffix) and len(word) - len(suffix) >= 3:
                word = word[: -len(suffix)]
                break
        if word not in _STOP:
            out.add(word)
    return out


def _on(environment: Any) -> str:
    return f" on {environment}" if environment else ""


def _try_repair(verdict: dict) -> str:
    """What trying the draft found, for a repair round: the problems, and what
    the run really got -- the rows and the detail -- to fix them against."""
    seen = {k: verdict[k] for k in ("first row", "opened", "code's log") if verdict.get(k)}
    return (f"The draft checks clean, but run as its user will{_on(verdict.get('environment'))}, it shows nothing "
            f"where it should: {'; '.join(verdict.get('problems') or [])}\n\nWhat the run got: "
            f"{json.dumps(seen, default=str)[:3000]}\n\nFix the draft so these come back filled: read the names "
            "and paths from what the run got, not from the reference's examples.")


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
