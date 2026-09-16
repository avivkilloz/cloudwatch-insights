import json
import os
import re
from typing import Optional

import httpx

# Backed by a LiteLLM proxy (or anything else exposing an OpenAI-compatible
# /chat/completions endpoint) so the app never needs to know which underlying
# model provider is actually configured. Entirely optional: when the three
# env vars below aren't set, the AI assistant features stay hidden in the UI
# (see the /api/ai/status endpoint).

REQUEST_TIMEOUT_SECONDS = 60.0
MAX_RESPONSE_TOKENS = 800

BUILD_QUERY_SYSTEM_PROMPT = """\
You are an expert at writing AWS CloudWatch Logs Insights queries. The user \
will describe, in plain English, what they want to find in their logs. \
Respond with a brief one- or two-sentence explanation of the query, then a \
single fenced code block containing ONLY the CloudWatch Logs Insights query \
itself (no comments, no alternatives, nothing else in the block). If the \
user's request is ambiguous, make a reasonable assumption, state it briefly, \
and still provide a best-effort query."""

ASK_RESULTS_SYSTEM_PROMPT = """\
You are helping a user understand the results of a CloudWatch Logs Insights \
query they just ran. You'll be given the query that produced the results and \
a sample of the resulting rows (it may be truncated if there were many). \
Answer the user's question concisely and specifically, referencing actual \
values from the sample where relevant. If the sample is truncated, say so \
rather than asserting something is true of the full result set that you \
can't actually confirm from the sample."""

_CODE_BLOCK_RE = re.compile(r"```(?:[a-zA-Z0-9_+-]*)\n(.*?)```", re.DOTALL)


class AiNotConfiguredError(Exception):
    pass


def is_configured() -> bool:
    return bool(
        os.environ.get("LITELLM_API_KEY") and os.environ.get("LITELLM_BASE_URL") and os.environ.get("LITELLM_MODEL")
    )


def _get_config() -> tuple[str, str, str]:
    api_key = os.environ.get("LITELLM_API_KEY")
    base_url = os.environ.get("LITELLM_BASE_URL")
    model = os.environ.get("LITELLM_MODEL")
    if not api_key or not base_url or not model:
        raise AiNotConfiguredError(
            "AI assistant is not configured -- LITELLM_API_KEY, LITELLM_BASE_URL, "
            "and LITELLM_MODEL must all be set."
        )
    return api_key, base_url, model


def extract_code_block(text: str) -> Optional[str]:
    match = _CODE_BLOCK_RE.search(text)
    return match.group(1).strip() if match else None


def chat(
    mode: str,
    messages: list[dict],
    query_string: Optional[str] = None,
    sample_rows: Optional[list[dict]] = None,
    row_count: Optional[int] = None,
) -> str:
    api_key, base_url, model = _get_config()
    system_prompt = BUILD_QUERY_SYSTEM_PROMPT if mode == "build_query" else ASK_RESULTS_SYSTEM_PROMPT

    context_parts = []
    if query_string:
        label = "Current query (refine this)" if mode == "build_query" else "Query that produced these results"
        context_parts.append(f"{label}:\n{query_string}")
    if sample_rows:
        total = row_count if row_count is not None else len(sample_rows)
        context_parts.append(
            f"Sample of {len(sample_rows)} result row(s) out of {total} total:\n"
            f"{json.dumps(sample_rows, indent=2, default=str)[:8000]}"
        )

    full_messages = [{"role": "system", "content": system_prompt}]
    if context_parts:
        full_messages.append({"role": "system", "content": "\n\n".join(context_parts)})
    full_messages.extend(messages)

    resp = httpx.post(
        f"{base_url.rstrip('/')}/chat/completions",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json={"model": model, "messages": full_messages, "temperature": 0.2, "max_tokens": MAX_RESPONSE_TOKENS},
        timeout=REQUEST_TIMEOUT_SECONDS,
    )
    resp.raise_for_status()
    data = resp.json()
    return data["choices"][0]["message"]["content"] or ""
