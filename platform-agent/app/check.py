"""Every answer, checked against what the turn actually did (D55).

A model can say it did something it didn't. From a real conversation:
asked to connect the MQTT tester and subscribe, the agent filled the topics
in, never connected, and said "connected and listening" -- three turns in a
row, until the user pointed at the pane. The prompt already said never to
claim what no tool showed, and grounding.py only looks at an answer's data
values (table cells, `code`), not at what it says happened.

So a second model call reads, side by side:
- the request, in the user's words;
- what ran this turn: each tool call, its arguments and what it returned;
- the sessions the turn touched as they are now, read by the platform after
  the answer (so "connected" is checked against the pane's run status, not
  against what the agent remembers);
- the answer.

It answers in JSON: `ok`, or `not_done` (the request asked for something
nothing did) or `unsupported` (the answer states something nothing shows),
with up to three problems in a sentence each. TurnGuard (repair.py) takes a
failed answer back and has the agent redo it once; a second miss stays, with
the problems under it. The check never blocks a turn: if it fails or can't
be read, the answer stands as it is.
"""

import json
import logging
from dataclasses import dataclass, field
from typing import Any, Optional

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

from .text import CLOSE

logger = logging.getLogger(__name__)

# Starts the check's own instructions -- the fake model knows a check by it.
CHECK_MARK = "You check an AI agent's answer against what it actually did."
CHECK_PROMPT = f"""{CHECK_MARK} The agent works in a workspace of \
sessions and panes through tools; you see the user's request, every tool \
call it made this turn with what it returned, the sessions it touched as \
they are now (read after the answer), and the answer.

Reply with only a JSON object: {{"verdict": "ok" | "not_done" | \
"unsupported", "problems": ["...", ...]}}.

- "not_done": the request asked for something to be done (created, filled \
in, run, connected, charted, changed...) and no successful tool call did \
it, and the sessions afterwards don't show it done either.
- "unsupported": the answer states as fact something -- a state, a result, \
a count, a name -- that neither the tool results nor the sessions \
afterwards show, or that they contradict (it says connected or running and \
the pane's run status isn't "running"; it says results are in a pane that \
holds none).
- "ok": everything else. An answer that says plainly it couldn't do \
something, or asks the user a question, is ok. Wording, style and length \
are not your concern.

Judge only from what is given here, never from what you'd expect. If you \
are unsure, the verdict is "ok". Each problem is one short sentence naming \
what is missing or unsupported; at most three."""

# What each part of the evidence may take: enough to judge by, not whole
# result sets (the run's sample is already cut down).
ARGS_CHARS = 300
RESULT_CHARS = 600
SESSION_CHARS = 6000
VERDICTS = ("ok", "not_done", "unsupported")


@dataclass
class Verdict:
    verdict: str
    problems: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return self.verdict == "ok"

    def summary(self) -> str:
        if self.ok:
            return "The answer matches what ran."
        return " ".join(self.problems) or "The answer doesn't match what ran."


def _text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
    return ""


def _cut(text: str, chars: int) -> str:
    return text if len(text) <= chars else text[:chars] + "…"


def ledger(messages: list) -> str:
    """This turn's tool calls and what each returned, one line each, from
    the messages since the user's latest."""
    names: dict[str, str] = {}
    lines: list[str] = []
    for m in messages:
        if isinstance(m, AIMessage):
            for call in m.tool_calls:
                names[call["id"]] = call["name"]
                args = _cut(json.dumps(call.get("args") or {}, ensure_ascii=False), ARGS_CHARS)
                lines.append(f"- called {call['name']} {args}")
        elif isinstance(m, ToolMessage):
            status = "failed" if m.status == "error" else "returned"
            name = names.get(m.tool_call_id, m.name or "a tool")
            lines.append(f"  {name} {status}: {_cut(_text(m.content), RESULT_CHARS)}")
    return "\n".join(lines) or "(no tool calls)"


def touched(messages: list) -> list[str]:
    """The sessions this turn's tools were called on, or returned, in order."""
    out: list[str] = []
    for m in messages:
        found: list[Any] = []
        if isinstance(m, AIMessage):
            found = [(c.get("args") or {}).get("session_id") for c in m.tool_calls]
        elif isinstance(m, ToolMessage) and m.status != "error":
            try:
                parsed = json.loads(_text(m.content))
            except ValueError:
                parsed = None
            if isinstance(parsed, dict):
                found = [parsed.get("session_id")]
        out += [s for s in found if isinstance(s, str) and s and s not in out]
    return out


def evidence(request: str, steps: str, sessions: list[str], answer: str) -> str:
    after = "\n\n".join(_cut(s, SESSION_CHARS) for s in sessions) or "(the turn touched no session)"
    return (
        f"Request:\n{request}\n\nWhat ran this turn:\n{steps}\n\n"
        f"Sessions it touched, as they are now:\n{after}\n\nThe answer:\n{answer}"
    )


def parse(content: str) -> Optional[Verdict]:
    """The check's reply as a verdict; None if it can't be read (reasoning
    models put their thinking first, closed by </think>)."""
    text = content.rsplit(CLOSE, 1)[-1]
    start = text.find("{")
    if start < 0:
        return None
    try:
        value, _ = json.JSONDecoder().raw_decode(text[start:])
    except ValueError:
        return None
    if not isinstance(value, dict) or value.get("verdict") not in VERDICTS:
        return None
    problems = [str(p).strip() for p in value.get("problems") or [] if str(p).strip()][:3]
    return Verdict(value["verdict"], problems)


async def judge(model: Any, evidence_text: str) -> Optional[Verdict]:
    """One check. Tagged "nostream" so its words never reach the chat as the
    agent's: it runs inside the agent's model step, whose output is streamed."""
    try:
        reply = await model.ainvoke(
            [SystemMessage(CHECK_PROMPT), HumanMessage(evidence_text)], config={"tags": ["nostream"]}
        )
    except Exception as e:  # noqa: BLE001 -- the answer stands without it
        logger.warning("The answer check failed: %s", e)
        return None
    verdict = parse(_text(reply.content))
    if verdict is None:
        logger.warning("The answer check's reply couldn't be read: %.200s", _text(reply.content))
    return verdict


def correction(verdict: Verdict) -> str:
    from .repair import FROM_PLATFORM

    found = " ".join(f"({i + 1}) {p}" for i, p in enumerate(verdict.problems)) or "it doesn't match what ran."
    return (
        f"{FROM_PLATFORM} a check of your answer against what ran this turn found: {found} If the request still "
        "needs doing, do it now with the tools; otherwise correct the answer. Don't mention this check.)"
    )


def notice(verdict: Verdict) -> str:
    return f"A check of this answer against what the agent ran found: {verdict.summary()}"
