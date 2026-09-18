import pytest

from app import ai_assistant


def test_extract_code_block_pulls_fenced_content():
    text = 'Here is your query:\n```\nfields @timestamp, @message\n| sort @timestamp desc\n```'
    assert ai_assistant.extract_code_block(text) == "fields @timestamp, @message\n| sort @timestamp desc"


def test_extract_code_block_handles_language_tag():
    text = "Explanation.\n```sql\nSELECT 1\n```"
    assert ai_assistant.extract_code_block(text) == "SELECT 1"


def test_extract_code_block_returns_none_when_absent():
    assert ai_assistant.extract_code_block("just plain text, no code block") is None


def test_is_configured_false_when_env_vars_missing(monkeypatch):
    monkeypatch.delenv("LITELLM_API_KEY", raising=False)
    monkeypatch.delenv("LITELLM_BASE_URL", raising=False)
    monkeypatch.delenv("LITELLM_MODEL", raising=False)
    assert ai_assistant.is_configured() is False


def test_is_configured_true_when_all_env_vars_set(monkeypatch):
    monkeypatch.setenv("LITELLM_API_KEY", "sk-test")
    monkeypatch.setenv("LITELLM_BASE_URL", "https://litellm.example.com")
    monkeypatch.setenv("LITELLM_MODEL", "gpt-4o-mini")
    assert ai_assistant.is_configured() is True


def test_is_configured_false_when_partially_set(monkeypatch):
    monkeypatch.setenv("LITELLM_API_KEY", "sk-test")
    monkeypatch.delenv("LITELLM_BASE_URL", raising=False)
    monkeypatch.setenv("LITELLM_MODEL", "gpt-4o-mini")
    assert ai_assistant.is_configured() is False


def test_chat_raises_not_configured_when_env_vars_missing(monkeypatch):
    monkeypatch.delenv("LITELLM_API_KEY", raising=False)
    monkeypatch.delenv("LITELLM_BASE_URL", raising=False)
    monkeypatch.delenv("LITELLM_MODEL", raising=False)
    with pytest.raises(ai_assistant.AiNotConfiguredError):
        ai_assistant.chat("build_query", [{"role": "user", "content": "show errors"}])


class _FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        pass

    def json(self):
        return self._payload


def test_chat_posts_to_chat_completions_with_system_prompt_and_context(monkeypatch):
    monkeypatch.setenv("LITELLM_API_KEY", "sk-test")
    monkeypatch.setenv("LITELLM_BASE_URL", "https://litellm.example.com/v1")
    monkeypatch.setenv("LITELLM_MODEL", "gpt-4o-mini")

    captured = {}

    def fake_post(url, headers, json, timeout):
        captured["url"] = url
        captured["headers"] = headers
        captured["json"] = json
        return _FakeResponse({"choices": [{"message": {"content": "Here you go\n```\nfields @message\n```"}}]})

    monkeypatch.setattr(ai_assistant.httpx, "post", fake_post)

    reply = ai_assistant.chat(
        "build_query",
        [{"role": "user", "content": "show errors"}],
        query_string="fields @message",
    )

    assert reply == "Here you go\n```\nfields @message\n```"
    assert captured["url"] == "https://litellm.example.com/v1/chat/completions"
    assert captured["headers"]["Authorization"] == "Bearer sk-test"
    assert captured["json"]["model"] == "gpt-4o-mini"
    roles = [m["role"] for m in captured["json"]["messages"]]
    assert roles[0] == "system"  # the mode's base system prompt
    assert "Current query (refine this)" in captured["json"]["messages"][1]["content"]
    assert "fields @message" in captured["json"]["messages"][1]["content"]  # query context
    assert captured["json"]["messages"][-1] == {"role": "user", "content": "show errors"}


# Naming them rather than checking for a bare "{" -- the HTTP client's prompt
# contains a literal JSON example, so braces alone no longer mean "someone
# left a placeholder unformatted".
_PLACEHOLDERS = ("{query_language}", "{results_noun}", "{query_block_noun}", "{build_notes}", "{ask_notes}")


def test_every_domain_builds_both_prompts_with_the_shared_rules():
    for name in ai_assistant.DOMAINS:
        build = ai_assistant.build_query_prompt(name)
        # The shared "refine what's already in the editor" behaviour every
        # domain inherits, whether from the shared template or an override.
        assert "Current query" in build, name
        assert "starting point" in build, name
        # The domain's own syntax description made it in, and no placeholder
        # was left unformatted.
        assert ai_assistant.DOMAINS[name].query_language in build, name
        assert not any(p in build for p in _PLACEHOLDERS), name

        ask = ai_assistant.ask_results_prompt(name)
        assert ai_assistant.DOMAINS[name].results_noun in ask, name
        assert "truncated" in ask, name
        assert not any(p in ask for p in _PLACEHOLDERS), name


def test_domains_cover_every_searchable_page_plus_the_aggregator_and_http_client():
    assert set(ai_assistant.DOMAINS) == {
        "logs-cloudwatch",
        "logs-opensearch",
        "iot-things",
        "iot-certificates",
        "tables",
        "buckets",
        "cognito",
        "aggregator",
        "tools-http",
    }


def test_aggregator_ask_prompt_explains_the_service_tag():
    # Its rows are pooled from several services and share no schema, so the
    # `service` field is the only thing keeping them apart.
    prompt = ai_assistant.ask_results_prompt("aggregator")
    assert "`service` field" in prompt
    assert "several different AWS services" in prompt


def test_http_client_build_prompt_asks_for_a_whole_request_as_json():
    prompt = ai_assistant.build_query_prompt("tools-http")
    # Every field of the form has to be nameable, or "Use this request" can
    # only ever fill part of it in.
    for field in ('"method"', '"url"', '"headers"', '"body"'):
        assert field in prompt
    # The body is JSON-encoded into a string field, which is the one part of
    # the shape a model is most likely to get wrong.
    assert "`body` is a STRING" in prompt
    # The SSRF guard is a property of this app, not of HTTP -- the model has
    # to be told, or it will happily suggest a URL the backend then refuses.
    assert "loopback, private and link-local" in prompt
    assert "Never invent a real credential" in prompt


def test_http_client_prompts_do_not_describe_the_tool_as_a_search():
    # It is the one surface that isn't a search box, so it replaces both
    # shared templates rather than being squeezed into their wording.
    build = ai_assistant.build_query_prompt("tools-http")
    ask = ai_assistant.ask_results_prompt("tools-http")
    assert "what they want to find" not in build
    assert "the results of a search" not in ask
    assert "request" in ask and "response" in ask


def test_http_client_ask_prompt_prefers_the_row_over_the_current_form():
    # The form can be edited after sending, so the exchange row -- not the
    # "current query" context block -- is what actually went over the wire.
    prompt = ai_assistant.ask_results_prompt("tools-http")
    assert "trust the row over it" in prompt


def test_template_overrides_do_not_leak_into_the_shared_domains():
    # Only tools-http overrides; everything else must still come from the
    # shared templates, so a change there keeps reaching all of them.
    for name, domain in ai_assistant.DOMAINS.items():
        overrides = domain.build_template is not None or domain.ask_template is not None
        assert overrides == (name == "tools-http"), name


def test_domain_prompts_teach_their_own_syntax_not_another_domains():
    assert "Lucene" in ai_assistant.build_query_prompt("logs-opensearch")
    assert "Lucene" not in ai_assistant.build_query_prompt("logs-cloudwatch")
    assert "Fleet Indexing" in ai_assistant.build_query_prompt("iot-things")
    # Certificates deliberately do NOT use Fleet Indexing -- the prompt has to
    # say so, since it's the obvious wrong assumption for an IoT search box.
    assert "Fleet Indexing does not cover certificates" in ai_assistant.build_query_prompt("iot-certificates")
    assert "Cognito only supports filtering by ONE attribute" in ai_assistant.build_query_prompt("cognito")


def test_no_ask_prompt_describes_frontend_sampling():
    # The assistant no longer samples or interleaves rows -- it is sent exactly
    # the rows the user checked. Any prompt still describing how the frontend
    # picks log rows (the old "@log" fairness note) would now be a lie.
    for name in ai_assistant.DOMAINS:
        assert "@log" not in ai_assistant.ask_results_prompt(name)


def test_unknown_domain_falls_back_to_cloudwatch_rather_than_erroring():
    assert ai_assistant.build_query_prompt("not-a-real-domain") == ai_assistant.build_query_prompt("logs-cloudwatch")
    assert ai_assistant.build_query_prompt(None) == ai_assistant.build_query_prompt("logs-cloudwatch")


def test_chat_includes_sample_rows_in_context(monkeypatch):
    monkeypatch.setenv("LITELLM_API_KEY", "sk-test")
    monkeypatch.setenv("LITELLM_BASE_URL", "https://litellm.example.com")
    monkeypatch.setenv("LITELLM_MODEL", "gpt-4o-mini")

    captured = {}

    def fake_post(url, headers, json, timeout):
        captured["json"] = json
        return _FakeResponse({"choices": [{"message": {"content": "there are 2 errors"}}]})

    monkeypatch.setattr(ai_assistant.httpx, "post", fake_post)

    reply = ai_assistant.chat(
        "ask_results",
        [{"role": "user", "content": "how many errors?"}],
        query_string="fields @message | filter @message like /ERROR/",
        sample_rows=[{"message": "ERROR: boom"}, {"message": "ERROR: bang"}],
        row_count=2,
    )

    assert reply == "there are 2 errors"
    context_message = captured["json"]["messages"][1]["content"]
    assert "ERROR: boom" in context_message
    assert "2 result row(s) out of 2 total" in context_message


def test_build_sample_context_reports_the_count_it_actually_includes():
    # A handful of small rows fit comfortably within the budget -- no truncation note.
    small_rows = [{"message": f"row {i}"} for i in range(5)]
    context = ai_assistant._build_sample_context(small_rows, row_count=5)
    assert "5 result row(s) out of 5 total:" in context
    assert "further truncated" not in context
    for row in small_rows:
        assert row["message"] in context


def test_build_sample_context_truncates_oversized_rows_and_says_so():
    # Each row is ~1000 chars; with a budget of MAX_SAMPLE_CONTEXT_CHARS this
    # must stop well before including all of them.
    big_rows = [{"message": "x" * 1000} for _ in range(50)]
    context = ai_assistant._build_sample_context(big_rows, row_count=426)

    assert len(context) < len(str(big_rows)) + 200  # sanity: we did NOT include everything
    header = context.splitlines()[0]
    assert "out of 426 total" in header
    assert "further truncated to the first" in header

    # The reported count must match what's actually present in the JSON body.
    reported_count = int(header.split("Sample of ")[1].split(" result")[0])
    assert context.count('"message"') == reported_count


def test_chat_uses_the_requested_domains_system_prompt(monkeypatch):
    monkeypatch.setenv("LITELLM_API_KEY", "sk-test")
    monkeypatch.setenv("LITELLM_BASE_URL", "https://litellm.example.com")
    monkeypatch.setenv("LITELLM_MODEL", "gpt-4o-mini")

    captured = {}

    def fake_post(url, headers, json, timeout):
        captured["json"] = json
        return _FakeResponse({"choices": [{"message": {"content": "level:ERROR"}}]})

    monkeypatch.setattr(ai_assistant.httpx, "post", fake_post)

    ai_assistant.chat(
        "build_query",
        [{"role": "user", "content": "show errors"}],
        domain="logs-opensearch",
    )

    system_prompt = captured["json"]["messages"][0]["content"]
    assert system_prompt == ai_assistant.build_query_prompt("logs-opensearch")
    assert "Lucene" in system_prompt


def test_chat_defaults_to_cloudwatch_system_prompt_when_domain_omitted(monkeypatch):
    monkeypatch.setenv("LITELLM_API_KEY", "sk-test")
    monkeypatch.setenv("LITELLM_BASE_URL", "https://litellm.example.com")
    monkeypatch.setenv("LITELLM_MODEL", "gpt-4o-mini")

    captured = {}

    def fake_post(url, headers, json, timeout):
        captured["json"] = json
        return _FakeResponse({"choices": [{"message": {"content": "fields @message"}}]})

    monkeypatch.setattr(ai_assistant.httpx, "post", fake_post)

    ai_assistant.chat("build_query", [{"role": "user", "content": "show errors"}])

    assert captured["json"]["messages"][0]["content"] == ai_assistant.build_query_prompt("logs-cloudwatch")


def test_chat_ask_results_uses_the_domains_ask_prompt(monkeypatch):
    monkeypatch.setenv("LITELLM_API_KEY", "sk-test")
    monkeypatch.setenv("LITELLM_BASE_URL", "https://litellm.example.com")
    monkeypatch.setenv("LITELLM_MODEL", "gpt-4o-mini")

    captured = {}

    def fake_post(url, headers, json, timeout):
        captured["json"] = json
        return _FakeResponse({"choices": [{"message": {"content": "there are 2 errors"}}]})

    monkeypatch.setattr(ai_assistant.httpx, "post", fake_post)

    ai_assistant.chat(
        "ask_results",
        [{"role": "user", "content": "how many errors?"}],
        domain="cognito",
    )

    assert captured["json"]["messages"][0]["content"] == ai_assistant.ask_results_prompt("cognito")
    assert "Cognito users" in captured["json"]["messages"][0]["content"]


def test_build_sample_context_always_includes_at_least_one_row_even_if_oversized():
    huge_row = {"message": "x" * 50000}
    context = ai_assistant._build_sample_context([huge_row], row_count=1)
    assert "1 result row(s) out of 1 total" in context
    assert huge_row["message"] in context
