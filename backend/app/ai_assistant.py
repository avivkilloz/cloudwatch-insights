import dataclasses
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

@dataclasses.dataclass(frozen=True)
class Domain:
    """One searchable AWS surface in the app, and the prompt fragments that
    teach the model its query syntax and what its result rows are.

    The two system prompts are assembled from a shared template plus these
    fragments, rather than written out per domain, so every surface gets the
    same "refine the current query", "use the selected rows as examples" and
    "don't overstate a truncated sample" behaviour for free."""

    # Completes "You are an expert at writing ..." -- the syntax, with examples.
    query_language: str
    # Plural noun for a result row, e.g. "log events".
    results_noun: str
    # Completes "ONLY the ... itself".
    query_block_noun: str
    # Domain-specific constraints appended to the build_query prompt.
    build_notes: str = ""
    # Domain-specific notes appended to the ask_results prompt.
    ask_notes: str = ""


_MULTI_LOG_GROUP_NOTE = (
    " When the query spans multiple log groups (an @log field with different "
    "values), the sample is built to include rows from every distinct @log "
    "value rather than a plain chronological slice, so a sparser log group "
    "isn't crowded out -- don't treat the relative counts of each @log value "
    "in the sample as reflecting their true relative frequency in the full "
    "result set."
)

DOMAINS: dict[str, Domain] = {
    "logs-cloudwatch": Domain(
        query_language="AWS CloudWatch Logs Insights queries.",
        results_noun="log events",
        query_block_noun="CloudWatch Logs Insights query",
        ask_notes=_MULTI_LOG_GROUP_NOTE,
    ),
    "logs-opensearch": Domain(
        query_language=(
            "AWS OpenSearch Lucene query_string queries (the same syntax as "
            "OpenSearch Dashboards' search bar -- e.g. "
            "`level:ERROR AND service:checkout`, `message:\"connection refused\"`, "
            "`status:[500 TO 599]`)."
        ),
        results_noun="log events",
        query_block_noun=(
            "Lucene query_string itself (no leading `GET /_search` -- just the "
            "query string as it would be typed into the search bar)"
        ),
        build_notes=" A time range is applied separately by the app, so never include one in the query.",
        ask_notes=_MULTI_LOG_GROUP_NOTE,
    ),
    "iot-things": Domain(
        query_language=(
            "AWS IoT Fleet Indexing queries -- the same \"advanced search\" syntax "
            "the AWS IoT console uses, e.g. `thingName:my-thing-*`, "
            "`connectivity.connected:true`, "
            "`attributes.stage:prod AND thingTypeName:sensor`, "
            "`shadow.reported.firmwareVersion:1.2.*`, `thingGroupNames:my-group`."
        ),
        results_noun="IoT things",
        query_block_noun="Fleet Indexing query",
        build_notes=(
            " Only fields that Fleet Indexing actually indexes are searchable: "
            "thingName, thingTypeName, thingGroupNames, attributes.*, "
            "connectivity.* and shadow.* -- if the user asks to filter on "
            "something outside that set, say so rather than inventing a field."
        ),
    ),
    "iot-certificates": Domain(
        query_language=(
            "AWS IoT certificate filters for this app, which are deliberately "
            "simple: `status:ACTIVE` or `status:INACTIVE` to filter by status, "
            "`certid:<id>` for an exact certificate ID lookup, or free text to "
            "match against certificate IDs."
        ),
        results_noun="IoT certificates",
        query_block_noun="certificate filter",
        build_notes=(
            " Fleet Indexing does not cover certificates, so this is NOT Lucene "
            "or Fleet Indexing syntax -- only the three forms above work, and "
            "they cannot be combined. If the user asks for something they don't "
            "support, say so plainly instead of inventing syntax."
        ),
    ),
    "tables": Domain(
        query_language=(
            "DynamoDB scan filters for this app, written as space-separated "
            "`field:value` tokens that are matched exactly and ANDed together, "
            "e.g. `status:ACTIVE region:us-east-1`."
        ),
        results_noun="DynamoDB items",
        query_block_noun="filter expression",
        build_notes=(
            " Only exact equality is supported -- there are no operators, "
            "wildcards, ranges or OR. An empty filter scans the table "
            "unfiltered. If the user asks for something the token syntax can't "
            "express, say so instead of inventing syntax."
        ),
        ask_notes=(
            " These items come from a DynamoDB scan, which reads a page of the "
            "table rather than the whole table, so they are not necessarily "
            "every matching item."
        ),
    ),
    "buckets": Domain(
        query_language=(
            "S3 filename filters for this app, which are a plain case-sensitive "
            "substring matched against object names under the current folder."
        ),
        results_noun="S3 objects",
        query_block_noun="search term",
        build_notes=" There is no wildcard, glob or regex support -- just a literal substring.",
    ),
    "cognito": Domain(
        query_language=(
            "Amazon Cognito user-pool filters for this app, written as a single "
            "`attribute:value` token matched as a starts-with search, e.g. "
            "`email:john` or `username:jdoe`."
        ),
        results_noun="Cognito users",
        query_block_noun="filter token",
        build_notes=(
            " Cognito only supports filtering by ONE attribute at a time, so "
            "never combine tokens with AND/OR, and matching is always "
            "starts-with rather than contains. An empty filter lists all users. "
            "If the user asks to filter on several attributes at once, pick the "
            "most selective one and say that's a Cognito limitation."
        ),
    ),
}

DEFAULT_DOMAIN = "logs-cloudwatch"

_BUILD_QUERY_TEMPLATE = """\
You are an expert at writing {query_language} The user will describe, in \
plain English, what they want to find. If a "Current query" is included in \
the context below, treat it as the query currently sitting in the user's \
query editor: use it as the starting point and modify only what the user's \
request calls for, preserving the rest of it as-is (fields, filters, \
sorting, limits, etc.) rather than writing an unrelated query from scratch. \
If the current query doesn't fit the request at all (e.g. it's for a \
completely different kind of search), or there is no current query, write a \
fresh one instead. If a sample of result rows is included in the context \
below, they are {results_noun} the user selected to point out what they're \
looking for -- use their actual field names and values to inform the query \
(e.g. an exact field to filter on, or a literal value/pattern shared across \
them) rather than guessing. Respond with a brief one- or two-sentence \
explanation of the query, then a single fenced code block containing ONLY \
the {query_block_noun} itself (no comments, no alternatives, nothing else in \
the block).{build_notes} If the user's request is ambiguous, make a \
reasonable assumption, state it briefly, and still provide a best-effort \
query."""

_ASK_RESULTS_TEMPLATE = """\
You are helping a user understand the results of a search for {results_noun} \
they just ran. You'll be given the query that produced the results and a \
sample of the resulting rows (it may be truncated if there were many). \
Answer the user's question concisely and specifically, referencing actual \
values from the sample where relevant. If the sample is truncated, say so \
rather than asserting something is true of the full result set that you \
can't actually confirm from the sample.{ask_notes}"""


def _domain(name: Optional[str]) -> Domain:
    return DOMAINS.get(name or "", DOMAINS[DEFAULT_DOMAIN])


def build_query_prompt(domain: Optional[str]) -> str:
    d = _domain(domain)
    return _BUILD_QUERY_TEMPLATE.format(
        query_language=d.query_language,
        results_noun=d.results_noun,
        query_block_noun=d.query_block_noun,
        build_notes=d.build_notes,
    )


def ask_results_prompt(domain: Optional[str]) -> str:
    d = _domain(domain)
    return _ASK_RESULTS_TEMPLATE.format(results_noun=d.results_noun, ask_notes=d.ask_notes)

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
    domain: str = DEFAULT_DOMAIN,
) -> str:
    api_key, base_url, model = _get_config()
    system_prompt = build_query_prompt(domain) if mode == "build_query" else ask_results_prompt(domain)

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
