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
    assert "fields @message" in captured["json"]["messages"][1]["content"]  # query context
    assert captured["json"]["messages"][-1] == {"role": "user", "content": "show errors"}


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
