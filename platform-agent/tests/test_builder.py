"""The Builder's loop reads one JSON object out of whatever a model wraps it
in (app/builder.py, D116); the loop itself is driven in test_agent.py."""

import pytest

from app.builder import _history, parse_json


@pytest.mark.parametrize(
    "reply",
    [
        '{"change": true, "plan": "Add jobs."}',
        'The user wants jobs.\n</think>\n\n```json\n{"change": true, "plan": "Add jobs."}\n```',
        'Here it is:\n{"change": true, "plan": "Add jobs.",}\nDone.',
        '```\n{"change": true, "plan": "Add jobs."}\n```',
    ],
)
def test_the_object_is_found_whatever_is_around_it(reply):
    assert parse_json(reply) == {"change": True, "plan": "Add jobs."}


@pytest.mark.parametrize("reply, says", [
    ("Sure! I'll rename it.", "no JSON object"),
    ('{"change": tru}', "isn't valid JSON"),
    ("[1, 2]", "no JSON object"),
])
def test_a_reply_without_one_says_why(reply, says):
    with pytest.raises(ValueError, match=says):
        parse_json(reply)


def test_the_conversation_before_the_request_goes_along_briefly():
    messages = [{"role": "user", "content": "add jobs"}, {"role": "assistant", "content": "x" * 5000},
                {"role": "user", "content": "now rules"}]
    text = _history(messages)
    assert text.startswith("Earlier in this conversation:\nUser: add jobs\nYou: xxx") and "now rules" not in text
    assert len(text) < 1700 and _history(messages[-1:]) == ""
