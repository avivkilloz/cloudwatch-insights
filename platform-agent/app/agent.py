"""One chat turn: the model, the platform's tools, and what the user sees.

Each turn builds its agent afresh -- a LangGraph agent from LangChain's
`create_agent` -- around the tools the backend's MCP server offers *this*
user, reached with *this* turn's token. Nothing about one user's turn
outlives it here, so a replica can serve anyone's next turn, and a token is
never held past the turn it was minted for.

What the turn produces is a stream of small events, which the backend relays
to the browser unchanged:

- `{"type": "text", "delta"}` -- the model's words as they arrive.
- `{"type": "tool_call", "id", "name", "args"}` -- a tool about to run.
- `{"type": "tool_result", "id", "name", "ok", "summary", "session_id"?}` --
  how it went; `session_id` names the session it touched, which is how the
  browser can follow the agent to it.
- `{"type": "error", "message"}` then the stream ends -- a turn that failed.
- `{"type": "done"}` -- a turn that finished.
"""

import json
import logging
from typing import Any, AsyncIterator, Optional

from langchain.agents import create_agent
from langchain_core.messages import AIMessage, AIMessageChunk, ToolMessage
from langchain_mcp_adapters.client import MultiServerMCPClient
from langchain_openai import ChatOpenAI

from .config import Settings
from .prompt import SYSTEM_PROMPT

logger = logging.getLogger(__name__)

# What a tool_result event carries of the tool's output: enough for the
# activity line in the chat, not the rows themselves.
SUMMARY_CHARS = 400


def build_model(settings: Settings) -> ChatOpenAI:
    return ChatOpenAI(
        model=settings.model,
        base_url=settings.llm_base_url,
        api_key=settings.llm_api_key,
        temperature=0,
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


async def run_turn(
    settings: Settings,
    messages: list[dict],
    token: str,
    model: Optional[Any] = None,
) -> AsyncIterator[dict]:
    """Runs one turn and yields its events. `messages` is the conversation so
    far, the user's new message last, as {"role": "user" | "assistant",
    "content"}. `model` stands in for the configured one in tests."""
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

    agent = create_agent(model or build_model(settings), tools, system_prompt=SYSTEM_PROMPT)
    names: dict[str, str] = {}
    try:
        async for mode, chunk in agent.astream(
            {"messages": messages},
            config={"recursion_limit": settings.max_steps},
            stream_mode=["messages", "updates"],
        ):
            if mode == "messages":
                message, meta = chunk
                # Only the model's own words: tool output also passes through
                # this stream, as ToolMessages, and is reported below instead.
                if isinstance(message, AIMessageChunk) and meta.get("langgraph_node") == "model":
                    delta = _text(message.content)
                    if delta:
                        yield {"type": "text", "delta": delta}
                continue
            for node, update in (chunk or {}).items():
                for message in (update or {}).get("messages", []) if isinstance(update, dict) else []:
                    if isinstance(message, AIMessage):
                        for call in message.tool_calls:
                            names[call["id"]] = call["name"]
                            yield {"type": "tool_call", "id": call["id"], "name": call["name"], "args": call["args"]}
                    elif isinstance(message, ToolMessage):
                        output = _text(message.content)
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
    except Exception as e:  # noqa: BLE001 -- reported to the user, not raised
        logger.warning("Agent turn failed: %s", e)
        yield {"type": "error", "message": _failure(e)}
        return
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
