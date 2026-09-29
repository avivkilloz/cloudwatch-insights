"""Settings, from the environment, read once at startup."""

import os
from dataclasses import dataclass
from typing import Optional


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
    )
