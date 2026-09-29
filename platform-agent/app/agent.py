"""One chat turn: the model, the platform's tools, and what the user sees.

Each turn builds its agent afresh -- a LangGraph agent from LangChain's
`create_agent` -- around the tools the backend's MCP server offers *this*
user, reached with *this* turn's token. Nothing about one user's turn
outlives it here, so a replica can serve anyone's next turn, and a token is
never held past the turn it was minted for.

What the turn produces is a stream of small events, which the backend relays
to the browser unchanged:

- `{"type": "text", "delta"}` -- the model's words as they arrive; a new
  step's words start a new paragraph.
- `{"type": "thinking", "delta"}` -- the model's reasoning, kept apart from
  its answer (see text.py).
- `{"type": "retract", "chars"}` -- take back the last `chars` characters of
  answer text: they turned out to be reasoning (sent again as thinking), or
  a step stopped for going round in circles.
- `{"type": "tool_call", "id", "name", "args", "preamble"?}` -- a tool about
  to run; `preamble` marks the reads every turn starts with.
- `{"type": "tool_result", "id", "name", "ok", "summary", "session_id"?}` --
  how it went; `session_id` names the session it touched, which is how the
  browser can follow the agent to it.
- `{"type": "notice", "message"}` -- a warning to show under the answer
  (one whose details no tool returned, see grounding.py).
- `{"type": "error", "message"}` then the stream ends -- a turn that failed.
- `{"type": "done"}` -- a turn that finished.
"""

import json
import logging
from typing import Any, AsyncIterator, Optional

from langchain.agents import create_agent
from langchain_core.messages import AIMessage, AIMessageChunk, BaseMessage, HumanMessage, ToolMessage
from langchain_mcp_adapters.client import MultiServerMCPClient
from langchain_openai import ChatOpenAI

from . import grounding
from .config import Settings
from .prompt import SYSTEM_PROMPT, session_prompt, turn_reads
from .repair import VALID_NAME, TurnGuard
from .text import StepText, looping

logger = logging.getLogger(__name__)

# What a tool_result event carries of the tool's output: enough for the
# activity line in the chat, not the rows themselves.
SUMMARY_CHARS = 400
# What an earlier turn's steps may carry back into the conversation.
HISTORY_STEPS = 12
HISTORY_ARGS_CHARS = 600
# How often (in characters of a step's output) to look for a loop.
LOOP_CHECK_CHARS = 200


def build_model(settings: Settings) -> ChatOpenAI:
    return ChatOpenAI(
        model=settings.model,
        base_url=settings.llm_base_url,
        api_key=settings.llm_api_key,
        temperature=settings.temperature,
        max_tokens=settings.max_tokens,
        streaming=True,
        timeout=120,
        max_retries=1,
    )


def _text(content: Any) -> str:
    """A message's content as plain text, whether it came as a string or as
    content blocks (MCP results come back as blocks)."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict) and block.get("type") == "text":
                parts.append(block.get("text", ""))
        return "".join(parts)
    return ""


def _session_id(output: str) -> Optional[str]:
    try:
        parsed = json.loads(output)
    except ValueError:
        return None
    if isinstance(parsed, dict) and isinstance(parsed.get("session_id"), str):
        return parsed["session_id"]
    return None


def _summary(output: str) -> str:
    return output if len(output) <= SUMMARY_CHARS else output[:SUMMARY_CHARS] + "…"


def _args(args: Any) -> dict:
    """An earlier step's arguments, cut down if they were big (a long query,
    a pasted document) -- what was called matters, not every byte of it."""
    if not isinstance(args, dict):
        return {}
    if len(json.dumps(args)) <= HISTORY_ARGS_CHARS:
        return args
    return {k: (v[:200] + "…" if isinstance(v, str) and len(v) > 200 else v) for k, v in args.items()}


def _replayable(step: Any, tool_names: Optional[set[str]], used: set[str]) -> bool:
    """Whether an earlier step can go back to the model as the tool call it
    was. Only with the provider's own id for it: ids made up here ("h25_0")
    were copied by a model whose chat template writes a call as its id and
    then its arguments -- it sent "h25_0" back as a tool's name, and the turn
    died. And only a tool this turn has, under a name the provider accepts:
    a garbled name kept in an old turn's steps was refused by Bedrock on
    every turn after it."""
    if not isinstance(step, dict):
        return False
    name, step_id = step.get("name"), step.get("id")
    if not isinstance(name, str) or not VALID_NAME.match(name) or (tool_names is not None and name not in tool_names):
        return False
    if not isinstance(step_id, str) or not VALID_NAME.match(step_id) or step_id in used:
        return False
    used.add(step_id)
    return True


def conversation(messages: list[dict], tool_names: Optional[set[str]] = None) -> list[BaseMessage]:
    """The conversation as the model reads it. An earlier answer comes with
    the tool calls that led to it and what each returned (in brief), not just
    its words: with only the words, the model had no way to tell an answer
    from a run apart from one it made up, or to see that an answer saying
    "there's no IoT Prod" was the result of *another* person's get_context.
    A step that can't go back as a call (see `_replayable`) is left out; its
    answer's words still go."""
    out: list[BaseMessage] = []
    used: set[str] = set()
    for m in messages:
        if m["role"] == "user":
            out.append(HumanMessage(content=m["content"]))
            continue
        steps = [s for s in (m.get("steps") or []) if _replayable(s, tool_names, used)][-HISTORY_STEPS:]
        if steps:
            ids = [s["id"] for s in steps]
            calls = [
                {"id": ids[j], "name": s["name"], "args": _args(s.get("args")), "type": "tool_call"}
                for j, s in enumerate(steps)
            ]
            out.append(AIMessage(content="", tool_calls=calls))
            for j, s in enumerate(steps):
                ok = bool(s.get("ok"))
                content = s.get("summary") or ("Done." if ok else "Failed.")
                out.append(
                    ToolMessage(content=content, tool_call_id=ids[j], name=s["name"], status="success" if ok else "error")
                )
        out.append(AIMessage(content=m["content"] or "(No answer.)"))
    return out


async def _read(tools: dict, name: str, args: dict, id_: str, seen: list[str]) -> AsyncIterator[dict]:
    """One of the turn's opening reads, reported the way any tool step is.
    Its output lands in `seen` (the last entry) -- or nothing, if it failed."""
    tool = tools.get(name)
    if tool is None:
        return
    yield {"type": "tool_call", "id": id_, "name": name, "args": args, "preamble": True}
    try:
        result = await tool.ainvoke({"name": name, "args": args, "id": id_, "type": "tool_call"})
        output = _text(result.content if isinstance(result, ToolMessage) else result)
        ok = not (isinstance(result, ToolMessage) and result.status == "error")
    except Exception as e:  # noqa: BLE001 -- the model can still look for itself
        output, ok = _reason(e), False
    event = {"type": "tool_result", "id": id_, "name": name, "ok": ok, "summary": _summary(output)}
    yield event
    seen.append(output if ok else "")


async def run_turn(
    settings: Settings,
    messages: list[dict],
    token: str,
    model: Optional[Any] = None,
    focus: Optional[dict] = None,
) -> AsyncIterator[dict]:
    """Runs one turn and yields its events. `messages` is the conversation so
    far, the user's new message last, as {"role": "user" | "assistant",
    "content", "steps"?}. `focus` ({"session_id", "title"}) makes it a
    session's own chat. `model` stands in for the configured one in tests."""
    client = MultiServerMCPClient(
        {
            "platform": {
                "transport": "streamable_http",
                "url": settings.mcp_url,
                "headers": {"Authorization": f"Bearer {token}"},
            }
        }
    )
    try:
        tools = await client.get_tools()
    except Exception as e:  # noqa: BLE001 -- reported to the user, not raised
        logger.warning("Could not load the platform's tools: %s", e)
        yield {"type": "error", "message": f"The agent couldn't reach the platform's tools ({_reason(e)})."}
        return

    # Everything the turn has seen, for checking the answer against: the
    # user's message, and every tool's input and output.
    seen: list[str] = [messages[-1]["content"]]

    # Read before the model says a word, every turn, rather than left to the
    # model to remember to: who's asking and what they can reach (it changes
    # with who wrote the message, in a shared chat), and the session as it
    # is now. Left to the model, it answered an admin from a get_context it
    # had made for somebody else a turn earlier, and "refreshed" a session
    # without calling anything.
    by_name = {t.name: t for t in tools}
    async for event in _read(by_name, "get_context", {}, "turn-context", seen):
        yield event
    context = seen[-1] if len(seen) > 1 else None
    session = None
    if focus:
        before = len(seen)
        async for event in _read(by_name, "get_session", {"session_id": focus["session_id"]}, "turn-session", seen):
            yield event
        session = seen[-1] if len(seen) > before else None

    prompt = SYSTEM_PROMPT + (session_prompt(focus["session_id"], focus["title"]) if focus else "")
    guard = TurnGuard(set(by_name))
    agent = create_agent(model or build_model(settings), tools, system_prompt=prompt, middleware=[guard])
    history = conversation(messages, set(by_name))
    # The reads go with the message they were made for, as the last thing the
    # model reads -- not in the system prompt, many turns of conversation
    # away. There, in a shared chat, a model answered an admin "there's no
    # IoT Prod" from what an earlier answer had told someone without it,
    # though the admin's own read said otherwise.
    history[-1] = HumanMessage(content=_text(history[-1].content) + turn_reads(context or None, session or None))
    names: dict[str, str] = {}
    answer = ""
    thought = False
    step: Optional[StepText] = None
    step_id: Optional[str] = None
    checked = 0
    acted = False

    def finish_step() -> list[dict]:
        nonlocal step, step_id, answer, thought, checked
        checked = 0
        if step is None:
            return []
        events = step.end()
        answer += step.answer
        thought = thought or bool(step.thinking)
        step, step_id = None, None
        return events

    stream = agent.astream(
        {"messages": history},
        config={"recursion_limit": settings.max_steps},
        stream_mode=["messages", "updates"],
    )
    try:
        async for mode, chunk in stream:
            if mode == "messages":
                message, meta = chunk
                # Only the model's own words: tool output also passes through
                # this stream, as ToolMessages, and is reported below instead.
                if not (isinstance(message, AIMessageChunk) and meta.get("langgraph_node") == "model"):
                    continue
                if step is not None and message.id and step_id and message.id != step_id:
                    if step_id in guard.discarded:
                        # An answer TurnGuard replaced with a corrected one:
                        # its words come back out of the chat.
                        for event in [*step.end(), *step.abandon()]:
                            yield event
                        thought = thought or bool(step.thinking)
                        step, step_id, checked = None, None, 0
                    for event in finish_step():
                        yield event
                if step is None:
                    step = StepText(separate=bool(answer.strip()), thoughts_before=thought)
                    step_id = message.id
                delta = _text(message.content)
                if not delta:
                    continue
                for event in step.feed(delta):
                    yield event
                if len(step.raw) - checked >= LOOP_CHECK_CHARS:
                    checked = len(step.raw)
                    repeated = looping(step.raw)
                    if repeated:
                        for event in step.abandon():
                            yield event
                        yield {
                            "type": "error",
                            "message": f"The agent got stuck repeating itself (“{repeated}…”), so it was stopped. "
                            "Try asking again, or break the request into smaller steps.",
                        }
                        return
                continue
            for event in finish_step():
                yield event
            for node, update in (chunk or {}).items():
                for message in (update or {}).get("messages", []) if isinstance(update, dict) else []:
                    if isinstance(message, AIMessage):
                        acted = acted or bool(message.tool_calls)
                        for call in message.tool_calls:
                            names[call["id"]] = call["name"]
                            seen.append(json.dumps(call["args"], ensure_ascii=False))
                            yield {"type": "tool_call", "id": call["id"], "name": call["name"], "args": call["args"]}
                    elif isinstance(message, ToolMessage):
                        output = _text(message.content)
                        seen.append(output)
                        event = {
                            "type": "tool_result",
                            "id": message.tool_call_id,
                            "name": names.get(message.tool_call_id, message.name or ""),
                            "ok": message.status != "error",
                            "summary": _summary(output),
                        }
                        session_id = _session_id(output) if event["ok"] else None
                        if session_id:
                            event["session_id"] = session_id
                        yield event
        for event in finish_step():
            yield event
    except Exception as e:  # noqa: BLE001 -- reported to the user, not raised
        logger.warning("Agent turn failed: %s", e)
        yield {"type": "error", "message": _failure(e)}
        return
    finally:
        await stream.aclose()
    if not answer.strip():
        # Asked once to carry on (repair.TurnGuard) and still nothing: say so,
        # rather than leave the chat looking as if the turn is still going or
        # as if it was dropped.
        if not acted:
            message = "The agent stopped without answering or doing anything. Try asking again."
            yield {"type": "error", "message": message}
            return
        yield {"type": "notice", "message": "The agent ran the steps above but didn't write an answer."}
    missing = grounding.ungrounded(answer, seen)
    if missing:
        yield {"type": "notice", "message": grounding.notice(missing)}
    yield {"type": "done"}


def _reason(e: Exception) -> str:
    # An ExceptionGroup from the MCP client's task group says nothing useful
    # at the top; the first real cause does.
    while isinstance(e, BaseExceptionGroup) and e.exceptions:
        e = e.exceptions[0]
    text = str(e) or type(e).__name__
    return text[:300]


def _failure(e: Exception) -> str:
    name = type(e).__name__
    if name == "GraphRecursionError":
        return "The agent took too many steps without finishing, so it was stopped. Try a narrower request."
    return f"The agent stopped with an error: {_reason(e)}"
