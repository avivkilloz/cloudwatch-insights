"""A pane whose main action an input chooses (D119), and changes in the shapes
models write (D120): the IoT pane the user asked the agent for -- things and
certificates, plus rules and jobs as two more choices of "Search for", each
its own request -- built, run as its button, refreshed and run by the agent
in each mode."""

import pytest
import yaml

from app import aws_request, builder, yaml_edit
from app.panes import manifest as pane_manifest
from tests.conftest import client
from tests.test_aws_request import _env
from tests.test_builder_preview import _build_token
from tests.test_platform_tools import _token, call, call_error, mcp  # noqa: F401 -- a fixture

IOT = builder.example_source("iot")
RULES = {"input": "searchMode", "equals": "rules"}
JOBS = {"input": "searchMode", "equals": "jobs"}
NOT_MINE = {"input": "searchMode", "not_in": ["rules", "jobs"]}


def _request(operation: str, output: str, at: str, columns: dict) -> dict:
    return {"connection": "connections", "service": "iot", "operation": operation, "paginate": True,
            "output": output, "rows": {"at": at, "columns": columns}}


MODES = yaml_edit.apply_all(IOT, [
    {"op": "set", "path": "inputs/searchMode/choices", "value": ["things", "certificates", "rules", "jobs"]},
    {"op": "add", "path": "actions", "value": {"id": "list_rules", "run_label": "Search", "main": RULES,
                                               "request": _request("ListTopicRules", "rules", "rules", {"Rule": "ruleName"})}},
    {"op": "add", "path": "actions", "value": {"id": "list_jobs", "run_label": "Search", "main": JOBS,
                                               "request": _request("ListJobs", "jobs", "jobs", {"Job": "jobId"})}},
    {"op": "add", "path": "outputs", "value": {"key": "rules", "render": "table"}},
    {"op": "add", "path": "outputs", "value": {"key": "jobs", "render": "table"}},
    {"op": "set", "path": "layout/2. Search/items/-1/toolbar/action=search/when", "value": NOT_MINE},
    {"op": "add", "path": "layout/2. Search/items/-1/toolbar", "value": {"action": "list_rules", "when": RULES}},
    {"op": "add", "path": "layout/2. Search/items/-1/toolbar", "value": {"action": "list_jobs", "when": JOBS}},
    {"op": "add", "path": "layout/3. Results/items", "value": {"output": "rules", "when": RULES}},
    {"op": "add", "path": "layout/3. Results/items", "value": {"output": "jobs", "when": JOBS}},
])


def _problems(source: str) -> list[str]:
    try:
        builder.parse(source, None)
    except builder.BuilderError as e:
        return [x["message"] for x in e.errors]
    return []


# ---------------------------------------------------------------- main by an input (D119)


def test_the_main_action_is_the_one_the_inputs_choose():
    assert _problems(MODES) == []
    m = builder.parse(MODES, None)
    assert m.main_action({"searchMode": "rules"}).id == "list_rules"
    assert m.main_action({"searchMode": "jobs"}).id == "list_jobs"
    assert m.main_action({"searchMode": "things"}).id == "search" and m.main_action().id == "search"
    assert m.refresh_action({"searchMode": "jobs"}).id == "list_jobs"
    assert [a.id for a in m.mains()] == ["search", "list_rules", "list_jobs"]


@pytest.mark.parametrize("main, says", [
    ({"output": "rules", "present": True}, "main when an input says"),
    ({"input": "nope", "equals": "x"}, "an input nope that isn't declared"),
    (True, "only one action can be the main one"),
])
def test_a_main_by_an_input_that_cant_be_is_said(main, says):
    source = yaml_edit.apply(MODES, {"op": "set", "path": "actions/list_rules/main", "value": main})
    assert any(says in p for p in _problems(source)), _problems(source)


def test_a_background_run_cant_be_chosen_by_an_input():
    cloudwatch = builder.example_source("logs-cloudwatch")
    data = yaml.safe_load(cloudwatch)
    main = next(a for a in data["actions"] if a.get("main"))
    source = yaml_edit.apply(cloudwatch, {"op": "set", "path": f"actions/{main['id']}/main",
                                          "value": {"input": data["inputs"][0]["key"], "present": True}})
    assert any("only a handler or a request can" in p for p in _problems(source)), _problems(source)


def _stub_iot(monkeypatch) -> list[str]:
    """AWS answering each operation, as the dev backend's fake does: the
    operations asked for, in order."""
    replies = {"ListTopicRules": {"rules": [{"ruleName": "to_s3"}]}, "ListJobs": {"jobs": [{"jobId": "fw-7"}]}}
    asked: list[str] = []

    def call(service, operation, params, account_id, region, identity, paginate=False, max_items=1000):
        asked.append(operation)
        return replies[operation]

    monkeypatch.setattr(aws_request, "call", call)
    return asked


def test_refresh_and_the_agent_run_what_the_mode_chooses(mcp, monkeypatch):
    """Without this, the agent's run and auto-refresh always ran IoT's search
    -- in rules mode, the things/certificates handler with "rules" in it."""
    assert client.post("/api/builder/panes", json={"id": "iot_plus", "source": MODES}).status_code == 201
    prod = _env("Prod", "111122223333")
    asked = _stub_iot(monkeypatch)
    state = {"services": ["iot_plus"], "iot_plus.in.connections": [prod], "iot_plus.in.searchMode": "rules"}
    resp = client.put("/api/live-sessions/s-modes", json={"type": "aggregator", "title": "Modes", "state": state,
                                                         "truncated": False})
    assert resp.status_code in (200, 201), resp.text
    refreshed = client.post("/api/panes/iot_plus/refresh", json={"session": "s-modes", "pane": "iot_plus", "every": 60})
    assert refreshed.status_code == 200, refreshed.text
    assert refreshed.json()["outputs"]["values"]["rules"][0]["Rule"] == "to_s3"

    token = _token()
    ran = call(mcp, token, "run_pane", session_id="s-modes", pane_id="iot_plus", inputs={"searchMode": "jobs"})
    assert "fw-7" in str(ran), ran
    assert asked == ["ListTopicRules", "ListJobs"], "never IoT's search handler"


# ---------------------------------------------------------------- the shapes models write (D120)


def test_the_shape_a_model_wrote_is_read_as_it_meant():
    """A real model's changes, as it wrote them: no op, old/new, "/-" for the
    end of a list, a list and a mapping as text. Three rounds of "op is not
    None" and nothing it meant reached the check."""
    after = yaml_edit.apply_all(IOT, [
        {"path": "inputs/1/choices", "old": "[things, certificates]", "new": "[things, certificates, rules]"},
        {"path": "inputs/2/help", "old": "Things: …", "new": "[Rules] are listed by name."},
        {"path": "outputs/-", "new": "{'key': 'rules', 'render': 'table', 'label': 'Rules'}"},
        {"op": "append", "path": "layout/3. Results/items", "value": {"output": "rules", "when": RULES}},
        {"op": "replace", "path": "label", "new": "IoT and rules"},
        {"op": "delete", "path": "inputs/maxResults/width"},
    ])
    data = yaml.safe_load(after)
    assert data["inputs"][1]["choices"] == ["things", "certificates", "rules"]
    assert data["inputs"][2]["help"] == "[Rules] are listed by name.", "text over text stays text"
    assert data["outputs"][-1] == {"key": "rules", "render": "table", "label": "Rules"}
    assert data["label"] == "IoT and rules" and "width" not in data["inputs"][3]
    # An inline list replaced stays inline.
    assert "    choices: [things, certificates, rules]\n" in after


def test_a_change_that_cant_be_read_says_the_shape_it_needs():
    with pytest.raises(yaml_edit.EditError) as e:
        yaml_edit.apply_all(IOT, [{"op": "patch", "path": "label", "value": "x"}])
    assert 'not \'patch\': {"op": "set" | "add" | "remove"' in str(e.value)
    with pytest.raises(yaml_edit.EditError, match="needs an op and, to set or add, a value"):
        yaml_edit.apply(IOT, {"path": "label", "old": "IoT"})


def test_a_field_a_part_cant_have_is_said_with_those_it_can():
    source = yaml_edit.apply(MODES, {"op": "set", "path": "actions/list_rules/when", "value": RULES})
    [problem] = _problems(source)
    assert "there is no when here; it may say: id, run_label" in problem and "main" in problem


def test_the_agent_changes_the_draft_in_its_own_shape_and_reads_how_modes_are_made(mcp):
    token = _build_token(IOT)
    out = call(mcp, token, "change_definition", changes=[{"path": "label", "new": "Mine"}])
    assert out["ok"] is True
    refused = call_error(mcp, token, "change_definition", changes=[{"path": "label", "op": "nope"}])
    assert '{"op": "set" | "add" | "remove", "path"' in refused and "Nothing was changed" in refused
    rules = " ".join(call(mcp, _token(), "build_reference", kind="pane")["rules"])
    assert "`main: {input: <mode>, equals: <value>}`" in rules and "Actions have no `when`" in rules
    assert pane_manifest.When.model_fields.keys() >= {"input", "equals", "not_in"}
