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


def test_every_domain_builds_both_prompts_with_the_shared_rules():
    for name in ai_assistant.DOMAINS:
        build = ai_assistant.build_query_prompt(name)
        # The shared "refine what's already in the editor" behaviour every
        # domain inherits from the template.
        assert "Current query" in build
        assert "starting point" in build
        # The domain's own syntax description made it in, and no placeholder
        # was left unformatted.
        assert ai_assistant.DOMAINS[name].query_language in build
        assert "{" not in build

        ask = ai_assistant.ask_results_prompt(name)
        assert ai_assistant.DOMAINS[name].results_noun in ask
        assert "truncated" in ask
        assert "{" not in ask


def test_domains_cover_every_searchable_page():
    assert set(ai_assistant.DOMAINS) == {
        "logs-cloudwatch",
        "logs-opensearch",
        "iot-things",
        "iot-certificates",
        "tables",
        "buckets",
        "cognito",
    }


def test_domain_prompts_teach_their_own_syntax_not_another_domains():
    assert "Lucene" in ai_assistant.build_query_prompt("logs-opensearch")
    assert "Lucene" not in ai_assistant.build_query_prompt("logs-cloudwatch")
    assert "Fleet Indexing" in ai_assistant.build_query_prompt("iot-things")
    # Certificates deliberately do NOT use Fleet Indexing -- the prompt has to
    # say so, since it's the obvious wrong assumption for an IoT search box.
    assert "Fleet Indexing does not cover certificates" in ai_assistant.build_query_prompt("iot-certificates")
    assert "Cognito only supports filtering by ONE attribute" in ai_assistant.build_query_prompt("cognito")


def test_multi_log_group_caveat_only_applies_to_log_domains():
    # The @log fairness note describes how the *frontend* samples log rows, so
    # it would be a lie on any non-log domain.
    for name in ("logs-cloudwatch", "logs-opensearch"):
        assert "@log" in ai_assistant.ask_results_prompt(name)
    for name in ("iot-things", "iot-certificates", "tables", "buckets", "cognito"):
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
