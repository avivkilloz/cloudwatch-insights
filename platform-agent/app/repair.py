"""What the model sends back, made safe to send on -- and a step that stops
short, asked once to carry on.

Both come from real turns with an open-weights reasoning model behind
LiteLLM and Bedrock, and neither is specific to one model or one tool:

- **A tool call whose name isn't a tool.** The provider couldn't parse the
  model's tool-call markup and handed back a "name" like
  `h25_0 <|tool_call_argument_begin|> {"session_id"...`. LangChain answered it
  with "not a valid tool", as it should -- but the next request carried that
  name back to Bedrock, which refuses any tool name outside
  `[a-zA-Z0-9_-]+`, and the whole turn died with a 400. So a name that isn't
  one of this turn's tools is repaired before anything sees it: to the tool
  it plainly contains (`functions.run_pane:0`), with arguments recovered from
  the markup when the call came without any, or else to a placeholder that
  is a valid name and is answered "not a valid tool", so the model can try
  again. Ids get the same treatment.
- **A step that ends with nothing to show.** No tool call and no answer, or
  an answer that ends by announcing a step it never took -- "Let me search
  now:", and, with a period, "Let me reconnect to IoT Test and subscribe to
  the topic again." The user saw the turn stop and asked "did you do it?".
  Such a step is asked once, per turn, to carry on; the reply it gives
  instead is what the turn keeps. After a tool that failed, the nudge quotes
  the failure: told only to carry on, a model that had sent `query: []` and
  been refused said nothing at all, twice.
- **An answer built from nothing this turn returned.** In a shared chat a
  member without IoT Prod was told "Found 20 things in IoT Prod" and shown
  another person's earlier rows, no tool called. grounding.py already
  noticed and put a warning under it; now such an answer is taken back
  (its id goes in `discarded`, and the turn retracts its words) and the
  model is asked once to run the tool or say it can't. Only a second
  answer that still does it is shown, with the warning.
"""

import json
import re
import uuid
from typing import Any, Optional

from langchain.agents.middleware import AgentMiddleware, ModelRequest, ModelResponse
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from . import grounding
from .text import CLOSE

# What Bedrock (and most providers) accept as a tool name or tool call id.
VALID_NAME = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
# A valid name for a call nobody could read, answered "not a valid tool".
UNREADABLE = "unreadable_tool_call"

# Both start the same way: the model is told they aren't the user's words.
FROM_PLATFORM = "(From the platform, not the user:"
NUDGE = (
    f"{FROM_PLATFORM} your last reply ended without an answer or a tool call. Carry on -- make the tool call you "
    "meant to, or give your answer.)"
)


def correction(missing: list[str]) -> str:
    quoted = ", ".join(f"“{m}”" for m in missing[:3])
    return (
        f"{FROM_PLATFORM} your answer gives details ({quoted}) that nothing this turn returned. Earlier messages don't "
        "count: they may be out of date, or someone else's. If results are wanted, run the tool now and answer from "
        "what it returns; if you can't, say so plainly.)"
    )


def _text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
    return ""


def _visible(message: AIMessage) -> str:
    return _text(message.content).rsplit(CLOSE, 1)[-1].strip()


def failed_nudge(error: str) -> str:
    quoted = error.strip().replace("\n", " ")[:300]
    return (
        f"{FROM_PLATFORM} your last tool call failed: “{quoted}”. Fix what it says and call it again, or tell the "
        "user plainly what failed and why.)"
    )


def announced_nudge(sentence: str) -> str:
    return (
        f"{FROM_PLATFORM} your reply ends “{sentence}”, but you didn't make that call. If it's still needed, make it "
        "now; if not, give your answer.)"
    )


# A last sentence that says what the model is about to do. "Let me know …"
# is a closing courtesy, not a step.
_ANNOUNCES = re.compile(
    r"^(?:(?:now|next|so|ok(?:ay)?|alright)[,\s]+)?(?:let me (?!know\b)|i'll |i will |i'm going to |i am going to )",
    re.IGNORECASE,
)
_SENTENCES = re.compile(r"[^.!?\n]+[.!?:]*")


def announced(visible: str, acted: bool = False) -> Optional[str]:
    """The answer's last sentence, when it announces a step rather than
    reporting one: one ending on a colon, or -- before the turn has called
    anything -- one saying what it's about to do. After a run, "I'll keep it
    running" is a report."""
    sentences = [m.group(0).strip() for m in _SENTENCES.finditer(visible.strip())]
    last = sentences[-1] if sentences else ""
    if last.endswith(":") or (last and not acted and _ANNOUNCES.match(last)):
        return last
    return None


def _acted(messages: list) -> bool:
    """Whether the model has called a tool since the user's latest message
    (the reads the platform made for it don't count: they are attached to
    the message, not calls)."""
    for m in reversed(messages):
        if isinstance(m, HumanMessage) and not _text(m.content).startswith(FROM_PLATFORM):
            return False
        if isinstance(m, AIMessage) and m.tool_calls:
            return True
    return False


def stopped_short(message: AIMessage, messages: Optional[list] = None) -> bool:
    """Whether a step ended with nothing the user can use: no tool call, and
    either no answer (only reasoning, or nothing) or one that ends by
    announcing a step it never took."""
    if message.tool_calls or message.invalid_tool_calls:
        return False
    visible = _visible(message)
    return not visible or announced(visible, _acted(messages or [])) is not None


def _last_failure(messages: list) -> Optional[str]:
    """What the turn's latest tool said, if it failed and nothing came after
    it but the model's empty reply."""
    for m in reversed(messages):
        if isinstance(m, ToolMessage):
            return _text(m.content) or "(no message)" if m.status == "error" else None
        if isinstance(m, HumanMessage):
            return None
    return None


def nudge_for(message: AIMessage, messages: list) -> str:
    visible = _visible(message)
    failure = None if visible else _last_failure(messages)
    if failure is not None:
        return failed_nudge(failure)
    sentence = announced(visible, _acted(messages)) if visible else None
    return announced_nudge(sentence) if sentence else NUDGE


def _this_turn(messages: list) -> list[str]:
    """What this turn has seen, for grounding an answer: the user's latest
    message (with the reads attached to it) and every tool call and result
    since."""
    start = max(
        (i for i, m in enumerate(messages) if isinstance(m, HumanMessage) and not _text(m.content).startswith(FROM_PLATFORM)),
        default=0,
    )
    seen: list[str] = []
    for m in messages[start:]:
        if isinstance(m, HumanMessage) and _text(m.content).startswith(FROM_PLATFORM):
            continue
        seen.append(_text(m.content))
        for call in getattr(m, "tool_calls", None) or []:
            seen.append(json.dumps(call.get("args"), ensure_ascii=False))
    return seen


def _json_in(text: str) -> Optional[dict]:
    start = text.find("{")
    if start < 0:
        return None
    try:
        value, _ = json.JSONDecoder().raw_decode(text[start:])
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def repair_call(call: dict, names: set[str]) -> dict:
    """A tool call with a name that is one of `names` (or the placeholder)
    and a valid id. A good call comes back unchanged."""
    name = call.get("name") or ""
    args = call.get("args")
    if name not in names:
        inside = [n for n in names if n in name]
        recovered = _json_in(name)
        name = max(inside, key=len) if inside else UNREADABLE
        if not args and recovered is not None:
            args = recovered
    call_id = call.get("id") or ""
    if not VALID_NAME.match(call_id):
        call_id = f"call_{uuid.uuid4().hex[:24]}"
    return {"name": name, "args": args if isinstance(args, dict) else {}, "id": call_id, "type": "tool_call"}


def repair(message: AIMessage, names: set[str]) -> AIMessage:
    """The message with every tool call safe to run and to send back. A call
    whose arguments didn't parse (`invalid_tool_calls`) becomes an ordinary
    call with what could be recovered: the tool then says what it's missing,
    where left as it was it would have gone back to the provider unanswered
    and, with a bad name, refused outright."""
    calls = list(message.tool_calls)
    for bad in message.invalid_tool_calls:
        raw = bad.get("args") or ""
        calls.append({"name": bad.get("name") or "", "args": _json_in(raw) or {}, "id": bad.get("id") or ""})
    repaired = [repair_call(c, names) for c in calls]
    if repaired == list(message.tool_calls) and not message.invalid_tool_calls:
        return message
    return message.model_copy(update={"tool_calls": repaired, "invalid_tool_calls": []})


class TurnGuard(AgentMiddleware):
    """Both of the above, around every model call of one turn. Made afresh for
    each turn, so its one nudge is that turn's."""

    def __init__(self, tool_names: set[str]) -> None:
        super().__init__()
        self.names = tool_names | {UNREADABLE}
        self.nudged = False
        self.corrected = False
        # Ids of answers replaced by a corrected one, whose words the turn
        # takes back from the chat.
        self.discarded: set[str] = set()

    async def awrap_model_call(self, request: ModelRequest, handler) -> ModelResponse:
        response = await handler(request)
        message = _last_ai(response)
        if message is not None and not self.nudged and stopped_short(message, request.messages):
            self.nudged = True
            nudge = HumanMessage(nudge_for(message, request.messages))
            response = await handler(request.override(messages=[*request.messages, message, nudge]))
            message = _last_ai(response)
        if message is not None and not self.corrected and not (message.tool_calls or message.invalid_tool_calls):
            missing = grounding.ungrounded(_visible(message), _this_turn(request.messages))
            if missing:
                self.corrected = True
                if message.id:
                    self.discarded.add(message.id)
                retry = [*request.messages, message, HumanMessage(correction(missing))]
                response = await handler(request.override(messages=retry))
        return ModelResponse(
            result=[repair(m, self.names) if isinstance(m, AIMessage) else m for m in response.result],
            structured_response=response.structured_response,
        )


def _last_ai(response: ModelResponse) -> Optional[AIMessage]:
    for message in reversed(response.result):
        if isinstance(message, AIMessage):
            return message
    return None
