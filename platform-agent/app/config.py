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
    )
