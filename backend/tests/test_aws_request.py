"""A request to an AWS connection (D110): any AWS read API as a manifest's
data. AWS itself is a real botocore client with a Stubber, so every call's
parameters are checked against the service's own model, as AWS would."""

import pytest
from botocore.stub import Stubber

from app import aws_client, aws_request, builder, workflows
from tests.conftest import client
from tests.test_platform_tools import _token, call, mcp  # noqa: F401 -- a fixture

PANE = builder.AWS_EXAMPLE

ONE = PANE.replace("type: connections", "type: connection").replace("key: connections", "key: connection").replace(
    "connection: connections", "connection: connection"
).replace("input: connections", "input: connection").replace(
    "      groups: {rows: rows, name: environment_name, error: error, as: environment}\n", ""
)


def _check(source: str) -> list[str]:
    """What the Builder's Check says about a pane type: nothing when it's right."""
    try:
        builder.parse(source, "lambdas")
    except builder.BuilderError as e:
        return [x["message"] for x in e.errors]
    return []


def test_the_example_the_agent_reads_is_a_working_pane_type():
    assert _check(PANE) == []
    assert _check(ONE) == []


@pytest.mark.parametrize(
    "changes, says",
    [
        ([("operation: ListFunctions", "operation: DeleteFunction")], "DeleteFunction changes something"),
        ([("operation: ListFunctions", "operation: Invoke")], "Invoke changes something"),
        ([("service: lambda", "service: secretsmanager"), ("operation: ListFunctions", "operation: GetSecretValue")],
         "hands out credentials or secrets"),
        ([("service: lambda", "service: lambdaa")], "no AWS service called 'lambdaa'"),
        ([("operation: ListFunctions", "operation: ListFunctionz")], "lambda has no operation 'ListFunctionz'"),
        ([("paginate: true", "paginate: true\n      params: {Nope: 1}")], "ListFunctions has no parameter Nope"),
        ([("connection_type: aws", "connection_type: http_api")], "connection_type aws"),
    ],
)
def test_a_request_that_cant_run_is_said(changes, says):
    source = PANE
    for old, new in changes:
        source = source.replace(old, new)
    messages = _check(source)
    assert any(says in m for m in messages), messages


def test_the_python_name_of_an_operation_is_the_same_one_and_streams_are_refused():
    assert aws_request.operation_name("lambda", "list_functions") == "ListFunctions"
    s3 = PANE.replace("service: lambda", "service: s3").replace("operation: ListFunctions", "operation: GetObject")
    assert any("answers with a stream" in m for m in _check(s3))
    assert aws_request.refused("sts", "GetCallerIdentity")


# ------------------------------------------------------------------- running it


def _stubbed(monkeypatch, replies: dict[str, list]):
    """aws_client.get_client handing out stubbed clients: per account, the
    replies (or ClientError codes) its calls get, in order."""
    asked = []

    def fake(service, account_id, region, identity):
        real = aws_client.boto3.client(service, region_name=region, aws_access_key_id="x", aws_secret_access_key="y")
        stub = Stubber(real)
        for reply in replies.get(account_id, []):
            if isinstance(reply, str):
                stub.add_client_error("list_functions", service_error_code=reply, service_message="Not for you")
            else:
                stub.add_response("list_functions", reply)
        stub.activate()
        asked.append((service, account_id, region, identity.role_name))
        return real

    monkeypatch.setattr(aws_client, "get_client", fake)
    return asked


def _env(name: str, account: str) -> int:
    resp = client.post("/api/environments", json={"name": name, "account_id": account, "region": "eu-west-1"})
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


FUNCTION = {"FunctionName": "orders", "Runtime": "python3.12", "MemorySize": 256, "LastModified": "2026-10-01T10:00:00.000+0000"}


def _session_with(pane: str) -> None:
    resp = client.put("/api/live-sessions/s-aws", json={
        "type": "aggregator", "title": "AWS", "state": {"services": [pane]}, "truncated": False})
    assert resp.status_code in (200, 201), resp.text


def test_one_connection_answers_rows_as_the_callers_identity(monkeypatch):
    assert client.post("/api/builder/panes", json={"id": "lambdas", "source": ONE}).status_code == 201
    prod = _env("Prod", "111122223333")
    asked = _stubbed(monkeypatch, {"111122223333": [{"Functions": [FUNCTION, {**FUNCTION, "FunctionName": "billing"}]}]})
    resp = client.post("/api/panes/lambdas/actions/list", json={"inputs": {"connection": prod}})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert [r["Name"] for r in body["rows"]] == ["orders", "billing"]
    assert body["rows"][0]["Memory"] == 256 and body["response"]["Functions"][0]["Runtime"] == "python3.12"
    service, account, region, role = asked[0]
    assert (service, account, region) == ("lambda", "111122223333", "eu-west-1") and role


def test_several_connections_are_one_table_and_one_failing_is_said_apart(monkeypatch):
    assert client.post("/api/builder/panes", json={"id": "lambdas", "source": PANE}).status_code == 201
    prod, test = _env("Prod", "111122223333"), _env("Test", "444455556666")
    _stubbed(monkeypatch, {"111122223333": [{"Functions": [FUNCTION]}], "444455556666": ["AccessDeniedException"]})
    body = client.post("/api/panes/lambdas/actions/list", json={"inputs": {"connections": [prod, test]}}).json()
    # One table: each row says where it's from, and the account that failed says so in `error`.
    assert body["rows"] == [{"Environment": "Prod", "Name": "orders", "Runtime": "python3.12", "Memory": 256,
                             "Modified": FUNCTION["LastModified"]}]
    assert body["error"] == "Test: AccessDeniedException: Not for you"

    # Every one failing is the run's failure, said for each.
    _stubbed(monkeypatch, {"111122223333": ["AccessDeniedException"], "444455556666": ["AccessDeniedException"]})
    failed = client.post("/api/panes/lambdas/actions/list", json={"inputs": {"connections": [prod, test]}})
    assert failed.status_code == 400 and "Prod: " in failed.text and "Test: " in failed.text


def test_paginate_follows_every_page(monkeypatch):
    assert client.post("/api/builder/panes", json={"id": "lambdas", "source": ONE}).status_code == 201
    prod = _env("Prod", "111122223333")
    _stubbed(monkeypatch, {"111122223333": [
        {"Functions": [FUNCTION], "NextMarker": "m2"},
        {"Functions": [{**FUNCTION, "FunctionName": "second"}]},
    ]})
    rows = client.post("/api/panes/lambdas/actions/list", json={"inputs": {"connection": prod}}).json()["rows"]
    assert [r["Name"] for r in rows] == ["orders", "second"]


def test_a_denied_read_is_refused_even_if_a_manifest_got_past_the_check(monkeypatch):
    m = builder.parse(ONE, "lambdas")
    spec = {**m.actions[0].request, "service": "secretsmanager", "operation": "GetSecretValue"}
    with pytest.raises(Exception) as e:
        aws_request.run(None, None, m, spec, {"connection": 1})
    assert "credentials or secrets" in str(getattr(e.value, "detail", e.value))
    with pytest.raises(aws_request.AwsRequestError):
        aws_request.call("secretsmanager", "GetSecretValue", {}, "1", "eu-west-1", aws_client.Identity(role_name="R"))


def test_the_agent_runs_it_like_the_pane(mcp, monkeypatch):
    assert client.post("/api/builder/panes", json={"id": "lambdas", "source": PANE}).status_code == 201
    prod = _env("Prod", "111122223333")
    _stubbed(monkeypatch, {"111122223333": [{"Functions": [FUNCTION]}]})
    token = _token()
    made = call(mcp, token, "create_session", title="Lambdas", panes=[{"kind": "lambdas"}])
    ran = call(mcp, token, "run_pane", session_id=made["session_id"], pane_id="lambdas", inputs={"connections": [prod]})
    assert "orders" in str(ran) and "Prod" in str(ran), ran


def test_a_workflow_step_runs_it_like_the_pane(monkeypatch):
    # Without the mcp fixture: its lifespan starts the runs' manager, which
    # would take the run before drain() does.
    assert client.post("/api/builder/panes", json={"id": "lambdas", "source": PANE}).status_code == 201
    prod = _env("Prod", "111122223333")
    _stubbed(monkeypatch, {"111122223333": [{"Functions": [FUNCTION]}]})
    source = f"label: Functions\nsteps:\n  - id: list\n    pane: lambdas\n    action: list\n    with: {{connections: [{prod}]}}\n"
    assert client.post("/api/workflows", json={"id": "fns", "source": source}).status_code == 201
    run = client.post("/api/workflows/fns/runs", json={"params": {}}).json()
    workflows.drain()
    done = client.get(f"/api/workflow-runs/{run['id']}").json()
    assert done["status"] == "succeeded", done
    assert "orders" in str(done["steps"][0]["outputs"])


def test_a_yaml_id_may_be_the_name_alone():
    builder.parse("id: lambdas\n" + ONE, "default:lambdas")
    with pytest.raises(builder.BuilderError):
        builder.parse("id: other\n" + ONE, "default:lambdas")


def test_window_params_are_numbers_and_dotted_names_nest():
    spec = aws_request.AwsRequestSpec(
        connection="c", service="logs", operation="FilterLogEvents",
        params={"startTime": {"window": "start"}, "Filter.Name": {"input": "n"}, "limit": 5},
        window={"preset": "p"},
    )
    out = aws_request._params(spec, {"p": "3600", "n": "x"})
    assert isinstance(out["startTime"], int) and out["Filter"] == {"Name": "x"} and out["limit"] == 5
