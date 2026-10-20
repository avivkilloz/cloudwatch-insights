"""The scenario runner's own logic (evals/run.py): what it fills in, how it
matches what a session holds, and which scenarios it picks. Driving a real
stack is what the runner is for; this keeps its judgements honest."""

from evals.run import Turn, _fill, _matches, judge, load


def test_placeholders_keep_an_ids_type():
    names = {"env": "Prod", "env_id": 7}
    assert _fill({"a": "{env_id}", "b": "connect to {env}", "c": ["{env_id}"]}, names) == {"a": 7, "b": "connect to Prod", "c": [7]}


def test_expectations_match_as_documented():
    assert _matches(["a/#", "b"], {"contains": "a/#"}) and not _matches(None, {"contains": "x"})
    assert _matches([{"id": 1, "key": "_limit", "value": "5"}], {"row": {"key": "_limit", "value": "5"}})
    assert _matches({"type": "bar", "x": "@log", "y": "count"}, {"has": {"type": "bar", "x": "@log"}})
    assert _matches("Connected to x", {"startswith": "Connected"}) and _matches("running", {"not": "done"})
    assert _matches(3, 3) and not _matches(3, "3")


def test_a_failed_expectation_says_what_was_there():
    scenario = {"expect": [{"pane": "p", "run": "running", "inputs": {"topics": {"contains": "a/#"}}}, {"answer_check": "ok"}]}
    state = {"services": ["p"], "p.in.topics": [], "p.out.run": {"status": "stopped"}}
    turn = Turn(answer="Done.", steps=[{"name": "check_answer", "ok": False, "summary": "Nothing ran."}])
    failures = judge(scenario, [turn], state, {})
    assert "p's input topics is []" in failures[0]
    assert failures[1] == "p's run is stopped, expected running."
    assert failures[2].startswith("The answer check failed, expected ok. Nothing ran.")


def test_tagged_scenarios_run_only_when_asked_for():
    untagged = {s["name"] for s in load([], [])}
    assert "mqtt-connect-and-subscribe" in untagged and "fake-pretend-connect" not in untagged
    assert {s["name"] for s in load([], ["fake"])} == {"fake-pretend-connect", "fake-build-jobs-and-rules"}


def test_a_build_scenario_is_judged_on_what_reached_the_editor():
    scenario = {"expect": [{"proposed": {"checks": True, "contains": ["ListJobs", "ListTopicRules"]}}]}
    nothing = judge(scenario, [Turn(answer="I need to add the outputs first.")], {}, {})
    assert nothing == ["Nothing was put in the editor."]
    half = Turn(proposed="operation: ListJobs\n")
    failures = judge(scenario, [half], {}, {}, {"ok": False, "errors": [{"message": "no output jobs"}]})
    assert failures == ["What's in the editor doesn't check clean: no output jobs", "What's in the editor has no 'ListTopicRules'."]
    whole = Turn(proposed="operation: ListJobs\noperation: ListTopicRules\n")
    assert judge(scenario, [Turn(), whole], {}, {}, {"ok": True, "errors": []}) == []
