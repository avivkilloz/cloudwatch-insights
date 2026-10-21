"""Settings, from the environment, read once at startup."""

import os
from dataclasses import dataclass
from typing import Optional


# The Builder's output ceiling unless AGENT_BUILDER_MAX_TOKENS says otherwise.
BUILDER_MAX_TOKENS = 16000

@dataclass(frozen=True)
class Settings:
    # The model, through the same LiteLLM proxy the backend's assistant uses
    # (anything with an OpenAI-compatible /chat/completions works). The model
    # has to support tool calling.
    llm_base_url: Optional[str]
    llm_api_key: Optional[str]
    model: Optional[str]
    # The backend's MCP endpoint, which the agent reaches inside the cluster.
    mcp_url: str
    # Shared with the backend: when set, /chat answers only calls carrying it,
    # so nothing else in the cluster can spend the model's budget.
    service_key: Optional[str]
    # A turn's ceiling on model-and-tool steps, so one confused turn can't
    # loop until the token expires.
    max_steps: int
    # Left to the model's own default unless set. This used to be pinned to
    # 0, and greedy decoding is exactly what reasoning models (the ones that
    # think in <think> tags) are documented to loop under: one turn wrote the
    # same four sentences of plan over and over until it ran out of tokens.
    temperature: Optional[float] = None
    # A ceiling on one step's output, so a step that does go wrong ends.
    max_tokens: Optional[int] = None
    # Whether every answer is checked against what the turn ran (check.py,
    # D55), and by which model -- the agent's own unless set.
    check: bool = True
    check_model: Optional[str] = None
    # A turn beside an editor (D116): "loop" runs the Builder's own loop
    # (builder.py) -- plan, read, change by path, check, repair -- and "agent"
    # the chat agent with build tools, as before. Its model, temperature and
    # output ceiling default to the agent's; `builder_rounds` is how many
    # times a draft with problems goes back to the model.
    builder: str = "loop"
    builder_model: Optional[str] = None
    builder_temperature: Optional[float] = None
    # A whole set of changes in one reply, after a reasoning model's thinking:
    # left to the provider's default (a few thousand tokens on some), replies
    # were cut off mid-JSON. 0 sends none.
    builder_max_tokens: Optional[int] = BUILDER_MAX_TOKENS
    builder_rounds: int = 6

    @property
    def configured(self) -> bool:
        return bool(self.llm_base_url and self.llm_api_key and self.model)


def load() -> Settings:
    return Settings(
        llm_base_url=os.environ.get("LITELLM_BASE_URL") or None,
        llm_api_key=os.environ.get("LITELLM_API_KEY") or None,
        # AGENT_MODEL lets the agent use a different model from the assistant
        # -- it needs one that calls tools well, which the assistant doesn't.
        model=os.environ.get("AGENT_MODEL") or os.environ.get("LITELLM_MODEL") or None,
        mcp_url=os.environ.get("PLATFORM_MCP_URL", "http://backend:8000/mcp"),
        service_key=os.environ.get("AGENT_SERVICE_KEY") or None,
        max_steps=int(os.environ.get("AGENT_MAX_STEPS", "40")),
        temperature=float(os.environ["AGENT_TEMPERATURE"]) if os.environ.get("AGENT_TEMPERATURE") else None,
        max_tokens=int(os.environ["AGENT_MAX_TOKENS"]) if os.environ.get("AGENT_MAX_TOKENS") else None,
        check=os.environ.get("AGENT_CHECK", "on").lower() not in ("off", "false", "0", "no"),
        check_model=os.environ.get("AGENT_CHECK_MODEL") or None,
        builder=(os.environ.get("AGENT_BUILDER") or "loop").lower(),
        builder_model=os.environ.get("AGENT_BUILDER_MODEL") or None,
        builder_temperature=(float(os.environ["AGENT_BUILDER_TEMPERATURE"])
                             if os.environ.get("AGENT_BUILDER_TEMPERATURE") else None),
        builder_max_tokens=(int(os.environ["AGENT_BUILDER_MAX_TOKENS"]) or None) if os.environ.get("AGENT_BUILDER_MAX_TOKENS")
        else BUILDER_MAX_TOKENS,
        builder_rounds=max(1, int(os.environ.get("AGENT_BUILDER_ROUNDS", "6"))),
    )
