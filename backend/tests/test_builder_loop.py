"""What the Builder's loop stands on (D116): changes to a draft by path
(yaml_edit, change_definition), an AWS operation described offline
(describe_aws_operation) and a request's rows held to its reply -- and a pane
holding more than one request, each into an output of its own."""

import re

import pytest
import yaml
from botocore.stub import Stubber

from app import aws_client, builder, models, yaml_edit
from app.db import SessionLocal
from tests.conftest import client
from tests.test_aws_request import FUNCTION, ONE, _check, _env
from tests.test_builder import _group, _member
from tests.test_builder_preview import _build_token
from tests.test_platform_tools import _token, call, call_error, mcp  # noqa: F401 -- a fixture

IOT = builder.example_source("iot")

JOBS = {
    "id": "list_jobs", "run_label": "List jobs",
    "request": {"connection": "connections", "service": "iot", "operation": "ListJobs", "paginate": True,
                "output": "jobs", "rows": {"at": "jobs", "columns": {"Job": "jobId", "Status": "status"}}},
}


def _changed(before: str, after: str) -> list[str]:
    old = set(before.splitlines())
    return [line for line in after.splitlines() if line not in old]


# ---------------------------------------------------------------- yaml_edit


def test_a_change_by_path_touches_only_its_own_lines():
    after = yaml_edit.apply_all(IOT, [
        {"op": "set", "path": "actions/search/run_label", "value": "Search things"},
        {"op": "set", "path": "inputs/searchMode/choice_labels/things", "value": "All things"},
        {"op": "add", "path": "actions", "value": JOBS},
        {"op": "add", "path": "outputs", "value": {"key": "jobs", "render": "table"}},
        {"op": "add", "path": "layout", "value": {"title": "Jobs", "items": [{"output": "jobs"}]}, "before": "3. Results"},
        {"op": "remove", "path": "layout/3. Results/items/output=certResults"},
    ])
    data = yaml.safe_load(after)
    assert data["actions"][-1]["request"]["output"] == "jobs" and data["outputs"][-1] == {"key": "jobs", "render": "table"}
    assert [c["title"] for c in data["layout"]][-2:] == ["Jobs", "3. Results"]
    assert {"output": "certResults", "when": {"input": "searchMode", "equals": "certificates"}} not in data["layout"][-1]["items"]
    # Comments, folded text and inline mappings elsewhere exactly as they were.
    assert "choice_labels: { things: All things, certificates: Certificates }" in after
    assert "      groups: { rows: things, name: environment_name, error: error, as: environment }\n" in after
    assert len(_changed(IOT, after)) <= 24, _changed(IOT, after)
    assert builder.check(builder.parse(after, None), after) == []


def test_every_scalar_of_a_real_manifest_can_be_set_in_place():
    """Each set is checked against what it means; here, that holds for every
    leaf of IoT's manifest (inline mappings, folded text, anchors' targets)."""
    data = yaml.safe_load(IOT)
    leaves: list[list] = []

    def walk(node, path):
        if isinstance(node, dict):
            for k, v in node.items():
                walk(v, [*path, k])
        elif isinstance(node, list):
            for i, v in enumerate(node):
                walk(v, [*path, i])
        else:
            leaves.append(path)

    walk(data, [])
    assert len(leaves) > 150
    refused = 0
    for path in leaves:
        try:
            after = yaml_edit.apply(IOT, {"op": "set", "path": [str(p) for p in path], "value": "X"})
        except yaml_edit.EditError as e:
            assert "alias" in str(e), (path, e)
            refused += 1
            continue
        assert len(_changed(IOT, after)) <= 3, (path, _changed(IOT, after))
    assert refused < 10


def test_a_path_that_names_nothing_says_whats_there_and_nothing_changes():
    with pytest.raises(yaml_edit.EditError) as e:
        yaml_edit.apply_all(IOT, [
            {"op": "set", "path": "label", "value": "Changed"},
            {"op": "set", "path": "outputs/jobs/render", "value": "table"},
        ])
    assert str(e.value).startswith("Change 2 (set outputs/jobs/render): outputs has no item 'jobs'. It holds: key=thingResults")
    both = "layout:\n  - title: A\n    items:\n      - input: a\n      - output: a\n"
    with pytest.raises(yaml_edit.EditError, match="name one as field=value"):
        yaml_edit.apply(both, {"op": "remove", "path": "layout/A/items/a"})
    assert yaml_edit.apply(both, {"op": "remove", "path": "layout/A/items/output=a"}).endswith("      - input: a\n")
    with pytest.raises(yaml_edit.EditError, match='op is "set", "add" or "remove"'):
        yaml_edit.apply(IOT, {"op": "patch", "path": "label", "value": "x"})


def test_missing_parents_are_made_and_inline_ones_written_out():
    source = "label: X\nactions:\n  - id: a\n    request: { connection: c, service: lambda, operation: ListFunctions }\n"
    after = yaml_edit.apply(source, {"op": "set", "path": "actions/a/request/rows/at", "value": "Functions"})
    assert yaml.safe_load(after)["actions"][0]["request"]["rows"] == {"at": "Functions"}
    assert after.startswith("label: X\nactions:\n  - id: a\n")
    emptied = yaml_edit.apply(source, {"op": "remove", "path": "actions/a"})
    assert yaml.safe_load(emptied) == {"label": "X", "actions": []}
    made = yaml_edit.apply(source, {"op": "add", "path": "outputs", "value": {"key": "rows", "render": "table"}})
    assert made.endswith("outputs:\n  - key: rows\n    render: table\n")


# ---------------------------------------------------------------- the agent's tools


def test_the_agent_changes_the_draft_by_path_all_or_nothing(mcp):
    token = _build_token(IOT)
    refused = call_error(mcp, token, "change_definition", changes=[
        {"op": "add", "path": "actions", "value": JOBS},
        {"op": "set", "path": "outputs/jobs/render", "value": "table"},
    ])
    assert "Change 2" in refused and "Nothing was changed" in refused
    assert call(mcp, token, "read_draft")["text"].count("\n") == len(IOT.splitlines()) - 1

    # A part added without what it names: kept, and the check says so with the line.
    half = call(mcp, token, "change_definition", changes=[
        {"op": "add", "path": "layout", "value": {"title": "Jobs", "items": [{"output": "jobs"}]}}])
    assert half["ok"] is False and "output jobs that isn't declared" in half["errors"][0]["message"]
    whole = call(mcp, token, "change_definition", changes=[
        {"op": "add", "path": "actions", "value": JOBS},
        {"op": "add", "path": "outputs", "value": {"key": "jobs", "render": "table"}},
    ])
    assert whole == {"ok": True, "errors": [], "changed": 2, "lines": whole["lines"]}
    proposed = call(mcp, token, "propose_definition", summary="Jobs.")
    assert "operation: ListJobs" in proposed["propose"]["source"]


def test_out_of_rounds_a_draft_with_problems_can_still_be_put_in_the_editor(mcp):
    token = _build_token(IOT.replace("render: list", "render: nope", 1))
    assert "Nothing was put in the editor" in call_error(mcp, token, "propose_definition", summary="x")
    out = call(mcp, token, "propose_definition", summary="x", even_with_problems=True)
    assert out["ok"] is False and out["problems"] and "render: nope" in out["propose"]["source"]


def test_an_aws_operation_is_described_without_a_call(mcp):
    jobs = call(mcp, _token(), "describe_aws_operation", service="iot", operation="list_jobs")
    assert jobs["operation"] == "ListJobs" and jobs["lists"] == ["jobs"] and jobs["paginates"] is True
    assert jobs["reply"]["jobs"][0]["jobId"] == "string" and "maxResults" in jobs["params"]
    assert "ListTopicRules" in call(mcp, _token(), "describe_aws_operation", service="iot")["reads"]
    assert "did you mean ListTopicRules" in call_error(mcp, _token(), "describe_aws_operation", service="iot",
                                                         operation="ListRules")
    secret = call(mcp, _token(), "describe_aws_operation", service="secretsmanager", operation="GetSecretValue")
    assert "credentials or secrets" in secret["refused"]
    _member("pat3", _group("Plain3", pane_types=["tool-base64"], agent_enabled=True))
    with SessionLocal() as db:
        pat = db.query(models.User).filter_by(username="pat3").one().id
    assert "isn't turned on" in call_error(mcp, _token(pat), "describe_aws_operation", service="iot")


# ---------------------------------------------------------------- rows held to the reply


def test_rows_that_name_what_the_reply_doesnt_have_are_said_with_what_it_does():
    wrong_at = _check(ONE.replace("at: Functions", "at: Functions.items"))
    assert any("ListFunctions's reply: Functions is the list itself, so there is no items in it" in m
               and "Its lists are at: Functions" in m for m in wrong_at), wrong_at
    assert any("Its lists are at: Functions" in m for m in _check(ONE.replace("at: Functions", "at: functions")))
    wrong_column = _check(ONE.replace("Runtime: Runtime", "Runtime: runtime"))
    assert any("Functions items have no runtime" in m and "Their fields: FunctionName" in m for m in wrong_column)
    assert _check(ONE.replace("Memory: {from: MemorySize, as: number}", "Memory: {from: MemorySize.Nope, as: number}"))


# ---------------------------------------------------------------- several requests, each its own output

TWO = ONE.replace("      rows:\n        at: Functions", "      output: functions\n      rows:\n        at: Functions").replace(
    "outputs:\n  - key: rows\n", "outputs:\n  - key: functions\n    render: table\n  - key: layers\n    render: table\n"
    "  - key: rows\n").replace("actions:\n", """actions:
  - id: layers
    run_label: Layers
    request:
      connection: connection
      service: lambda
      operation: ListLayers
      output: layers
      rows: {at: Layers, columns: {Layer: LayerName}}
""", 1)


def _stub_lambda(monkeypatch, *operations: str):
    """A client per call, each answering the next of `operations`."""
    replies = {"list_functions": {"Functions": [FUNCTION]}, "list_layers": {"Layers": [{"LayerName": "common"}]}}
    queue = list(operations)

    def fake(service, account_id, region, identity):
        real = aws_client.boto3.client(service, region_name=region, aws_access_key_id="x", aws_secret_access_key="y")
        stub = Stubber(real)
        operation = queue.pop(0)
        stub.add_response(operation, replies[operation])
        stub.activate()
        return real

    monkeypatch.setattr(aws_client, "get_client", fake)


def test_two_requests_in_one_pane_keep_each_others_rows(monkeypatch):
    """IoT with its jobs and its rules: every request wrote `rows` and cleared
    the pane, so fetching one list emptied the other."""
    assert _check(TWO) == [], _check(TWO)
    assert client.post("/api/builder/panes", json={"id": "lambdas", "source": TWO}).status_code == 201
    prod = _env("Prod", "111122223333")
    _stub_lambda(monkeypatch, "list_functions", "list_layers")
    resp = client.put("/api/live-sessions/s-two", json={"type": "aggregator", "title": "Two",
                                                       "state": {"services": ["lambdas"]}, "truncated": False})
    assert resp.status_code in (200, 201), resp.text
    where = {"session": "s-two", "pane": "lambdas", "inputs": {"connection": prod}}
    first = client.post("/api/panes/lambdas/actions/list", json=where).json()
    assert first["functions"][0]["Name"] == "orders" and "rows" not in first
    second = client.post("/api/panes/lambdas/actions/layers", json=where)
    assert second.status_code == 200, second.text
    stored = second.json()["__outputs"]["values"]
    assert stored["layers"] == [{"Layer": "common"}] and stored["functions"][0]["Name"] == "orders", stored


def test_a_request_into_an_output_that_isnt_declared_is_refused():
    errors = _check(TWO.replace("output: layers", "output: layerz"))
    assert any("writes its rows to an output layerz that isn't declared" in m for m in errors), errors
    assert re.search(r"output", builder.OUTPUT_DOC)
