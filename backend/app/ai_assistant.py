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

# Character budget for the serialized sample_rows JSON embedded in the
# prompt. Applied incrementally, row by row, so the row count we report to
# the model always matches what's actually in the prompt text -- unlike a
# naive slice of the fully-serialized JSON string, which can cut off
# mid-object while still claiming the pre-slice row count.
MAX_SAMPLE_CONTEXT_CHARS = 12000

BUILD_QUERY_SYSTEM_PROMPTS = {
    "cloudwatch": """\
You are an expert at writing AWS CloudWatch Logs Insights queries. The user \
will describe, in plain English, what they want to find in their logs. \
Respond with a brief one- or two-sentence explanation of the query, then a \
single fenced code block containing ONLY the CloudWatch Logs Insights query \
itself (no comments, no alternatives, nothing else in the block). If the \
user's request is ambiguous, make a reasonable assumption, state it briefly, \
and still provide a best-effort query.""",
    "opensearch": """\
You are an expert at writing AWS OpenSearch Lucene query_string queries \
(the same syntax as OpenSearch Dashboards' search bar -- e.g. \
`level:ERROR AND service:checkout`, `message:"connection refused"`, \
`status:[500 TO 599]`). The user will describe, in plain English, what they \
want to find in their logs. Respond with a brief one- or two-sentence \
explanation of the query, then a single fenced code block containing ONLY \
the Lucene query_string itself (no comments, no alternatives, no leading \
`GET /_search`, nothing else in the block -- just the query string as it \
would be typed into the search bar). A time range is applied separately by \
the app, so never include one in the query. If the user's request is \
ambiguous, make a reasonable assumption, state it briefly, and still \
provide a best-effort query.""",
}

ASK_RESULTS_SYSTEM_PROMPT = """\
You are helping a user understand the results of a log search query they \
just ran (either a CloudWatch Logs Insights query or an OpenSearch Lucene \
query_string search). You'll be given the query that produced the results \
and a sample of the resulting rows (it may be truncated if there were many). \
Answer the user's question concisely and specifically, referencing actual \
values from the sample where relevant. If the sample is truncated, say so \
rather than asserting something is true of the full result set that you \
can't actually confirm from the sample. When the query spans multiple log \
groups (an @log field with different values), the sample is built to \
include rows from every distinct @log value rather than a plain chronological \
slice, so a sparser log group isn't crowded out -- don't treat the relative \
counts of each @log value in the sample as reflecting their true relative \
frequency in the full result set."""

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


def _build_sample_context(sample_rows: list[dict], row_count: Optional[int]) -> str:
    total = row_count if row_count is not None else len(sample_rows)

    included: list[dict] = []
    serialized_len = 2  # opening/closing brackets of the JSON array
    for row in sample_rows:
        addition = len(json.dumps(row, default=str)) + 2  # plus separator/newline
        if included and serialized_len + addition > MAX_SAMPLE_CONTEXT_CHARS:
            break
        included.append(row)
        serialized_len += addition

    note = ""
    if len(included) < len(sample_rows):
        note = f" (further truncated to the first {len(included)} to fit the assistant's context budget)"

    return (
        f"Sample of {len(included)} result row(s) out of {total} total{note}:\n"
        f"{json.dumps(included, indent=2, default=str)}"
    )


def chat(
    mode: str,
    messages: list[dict],
    query_string: Optional[str] = None,
    sample_rows: Optional[list[dict]] = None,
    row_count: Optional[int] = None,
    backend: str = "cloudwatch",
) -> str:
    api_key, base_url, model = _get_config()
    if mode == "build_query":
        system_prompt = BUILD_QUERY_SYSTEM_PROMPTS.get(backend, BUILD_QUERY_SYSTEM_PROMPTS["cloudwatch"])
    else:
        system_prompt = ASK_RESULTS_SYSTEM_PROMPT

    context_parts = []
    if query_string:
        label = "Current query (refine this)" if mode == "build_query" else "Query that produced these results"
        context_parts.append(f"{label}:\n{query_string}")
    if sample_rows:
        context_parts.append(_build_sample_context(sample_rows, row_count))

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
