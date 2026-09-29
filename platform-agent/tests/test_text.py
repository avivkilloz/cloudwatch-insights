"""The pieces of a turn that don't need a model: sorting a step's words into
reasoning and answer, spotting a step that's looping, and checking an
answer's details against what the turn's tools returned. Most of what can go
wrong here is a false alarm on ordinary output, so that's most of what's
tested."""

from app import grounding
from app.text import StepText, looping


def _run(chunks: list[str], **kwargs) -> tuple[str, str]:
    step = StepText(**kwargs)
    answer, thinking = "", ""
    for event in [e for c in chunks for e in step.feed(c)] + step.end():
        if event["type"] == "text":
            answer += event["delta"]
        elif event["type"] == "retract":
            answer = answer[: len(answer) - event["chars"]]
        else:
            thinking += event["delta"]
    assert answer == step.answer
    return answer, thinking.strip()


def _chunked(text: str, size: int) -> list[str]:
    return [text[i : i + size] for i in range(0, len(text), size)]


def test_plain_answers_pass_straight_through():
    for size in (1, 3, 50):
        assert _run(_chunked("Found 3 things in IoT Test.", size)) == ("Found 3 things in IoT Test.", "")


def test_reasoning_with_both_tags_or_only_the_closing_one_is_split_off_at_any_chunking():
    for text in ("<think>plan it</think>\n\nThe answer.", "plan it\n</think>\n\nThe answer."):
        for size in (1, 2, 5, 100):
            assert _run(_chunked(text, size)) == ("The answer.", "plan it"), (text, size)


def test_a_later_step_starts_a_new_paragraph_and_the_separator_goes_with_a_retract():
    assert _run(["Next, the run."], separate=True) == ("\n\nNext, the run.", "")
    assert _run(["checking</think>Done."], separate=True) == ("\n\nDone.", "checking")


def test_text_that_merely_mentions_angle_brackets_is_left_alone():
    assert _run(_chunked("Use <thing> names, e.g. a</b.", 2)) == ("Use <thing> names, e.g. a</b.", "")


def test_a_loop_is_caught_and_ordinary_long_output_is_not():
    loop = "I need to search the shadow. Let me configure the IoT pane with shadow filters. " * 12
    assert looping(loop)
    table = "| Thing | Connected |\n|---|---|\n" + "".join(f"| robot-{i:04d} | {'Yes' if i % 3 else 'No'} |\n" for i in range(300))
    assert looping(table) is None
    prose = " ".join(f"Environment {i} returned {i * 7} rows with status Complete." for i in range(80))
    assert looping(prose) is None


def test_made_up_rows_are_flagged_and_rows_from_a_tool_are_not():
    invented = "| Thing Name |\n|---|\n| `test-device-001` |\n| `test-sensor-temp-01` |\n| `test-gateway-alpha` |"
    missing = grounding.ungrounded(invented, ["run_pane", '{"sample": [{"thing_name": "Z3563HMR"}]}'])
    assert missing and "test-device-001" in missing

    real = "| Thing | Connected |\n|---|---|\n| Z3563HMR | No |\n| J2354KNC | Yes |\n| K9981QQA | Yes |"
    output = '{"sample": [{"thing_name": "Z3563HMR"}, {"thing_name": "J2354KNC"}, {"thing_name": "K9981QQA"}]}'
    assert grounding.ungrounded(real, [output]) is None


def test_a_real_run_summarised_in_the_answers_own_words_is_not_flagged():
    output = (
        '{"sample": [{"@timestamp": "2026-09-29 10:32:01.123", "@message": "ERROR checkout: connection timed out '
        'after 30000ms talking to payments-api (attempt 3 of 3)"}, {"@timestamp": "2026-09-29 10:33:12.004", '
        '"@message": "ERROR checkout: payments-api returned 503 Service Unavailable"}]}'
    )
    summary = (
        "| Time | What happened |\n|---|---|\n"
        "| 10:32 | Connection to payments-api timed out after 30000ms |\n"
        "| 2026-09-29T10:33 | payments-api returned 503 Service Unavailable |\n"
        "| 10:34 | `checkout` gave up after three attempts |"
    )
    assert grounding.ungrounded(summary, [output]) is None


def test_answers_from_the_context_or_the_question_itself_are_not_flagged():
    context = '{"environments": [{"id": 5, "name": "IoT Dev"}, {"id": 1, "name": "IoT Test"}, {"id": 9, "name": "IoT Prod"}]}'
    listing = "| Environment | Id |\n|---|---|\n| IoT Dev | 5 |\n| IoT Test | 1 |\n| IoT Prod | 9 |"
    assert grounding.ungrounded(listing, [context]) is None
    # Rows the user attached are the question's own evidence.
    question = 'why? ```json [{"thing_name": "alpha-01"}, {"thing_name": "beta-02"}, {"thing_name": "gamma-03"}]```'
    assert grounding.ungrounded("`alpha-01`, `beta-02` and `gamma-03` are offline.", [question]) is None
    # Too little to judge: a single name in a sentence.
    assert grounding.ungrounded("I set the query to `shadow.reported.deviceType:0x65`.", []) is None
