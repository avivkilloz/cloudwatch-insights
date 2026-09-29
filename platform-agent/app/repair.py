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
  an answer that ends by announcing a step ("Let me search now:") it never
  took. The user saw the turn stop. Such a step is asked once, per turn, to
  carry on; the reply it gives instead is what the turn keeps.
"""

import json
import re
import uuid
from typing import Any, Optional

from langchain.agents.middleware import AgentMiddleware, ModelRequest, ModelResponse
from langchain_core.messages import AIMessage, HumanMessage

from .text import CLOSE

# What Bedrock (and most providers) accept as a tool name or tool call id.
VALID_NAME = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
# A valid name for a call nobody could read, answered "not a valid tool".
UNREADABLE = "unreadable_tool_call"

NUDGE = (
    "(From the platform, not the user: your last reply ended without an answer or a tool call. Carry on -- make "
    "the tool call you meant to, or give your answer.)"
)


def _text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
    return ""


def stopped_short(message: AIMessage) -> bool:
    """Whether a step ended with nothing the user can use: no tool call, and
    either no answer (only reasoning, or nothing) or one that ends on the
    colon of a step it announced and never took."""
    if message.tool_calls or message.invalid_tool_calls:
        return False
    visible = _text(message.content).rsplit(CLOSE, 1)[-1].strip()
    return not visible or visible.endswith(":")


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

    async def awrap_model_call(self, request: ModelRequest, handler) -> ModelResponse:
        response = await handler(request)
        message = _last_ai(response)
        if message is not None and not self.nudged and stopped_short(message):
            self.nudged = True
            response = await handler(request.override(messages=[*request.messages, message, HumanMessage(NUDGE)]))
        return ModelResponse(
            result=[repair(m, self.names) if isinstance(m, AIMessage) else m for m in response.result],
            structured_response=response.structured_response,
        )


def _last_ai(response: ModelResponse) -> Optional[AIMessage]:
    for message in reversed(response.result):
        if isinstance(message, AIMessage):
            return message
    return None
