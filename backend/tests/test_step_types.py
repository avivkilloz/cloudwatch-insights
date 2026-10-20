"""Step types made in the Builder (D122) and workflows for builders (D121):
a declarative HTTP request or a chain of steps, checked with its lines, used
by a workflow by name, run as its starter -- one that changes something
waiting for a person first -- and a builder's workflows their group's."""

import json

import pytest

from app import step_types, tools_http_client
from tests.conftest import client
from tests.test_builder import _group, _member
from tests.test_platform_tools import mcp  # noqa: F401 -- a fixture
from tests.test_workflows import _finished, _run

RESTART = """label: Restart a device
description: Asks the devices API to restart one.
inputs:
  - {key: connection, type: connection, connection_type: http_api}
  - {key: device, required: true}
  - {key: reason, default: maintenance}
request:
  connection: connection
  method: POST
  path: "/devices/{{ inputs.device }}/restart"
  headers: {X-Reason: "{{ inputs.reason }}"}
  body: {reason: "{{ inputs.reason }}", force: true}
"""

LIST = """label: List devices
inputs:
  - {key: connection, type: connection, connection_type: http_api}
  - {key: site, default: north}
request:
  connection: connection
  path: /devices
  query: {site: "{{ inputs.site }}"}
  rows: {at: items, columns: {Device: id, Online: {from: online, as: text}}}
"""

CHAIN = """label: List, then count
inputs:
  - {key: connection, type: connection, connection_type: http_api}
steps:
  - id: listed
    step: list_devices
    with: {connection: "{{ inputs.connection }}", site: south}
  - id: said
    note: "{{ size(steps.listed.outputs.rows) }} devices"
outputs:
  count: "{{ size(steps.listed.outputs.rows) }}"
  note: "{{ steps.said.outputs.text }}"
"""


def _workflow(step: str, extra: str = "") -> str:
    return f"""label: Uses {step}
parameters:
  - {{key: api, type: connection, connection_type: http_api, required: true}}
steps:
  - id: it
    step: {step}
    with: {{connection: "{{{{ params.api }}}}"{extra}}}
"""


@pytest.fixture
def api(monkeypatch):
    """An HTTP API connection, and what was sent to it."""
    env = client.post("/api/environments", json={"name": "Devices"}).json()
    conn = client.post(f"/api/environments/{env['id']}/connections", json={
        "type_id": "http_api", "name": "devices", "config": {"base_url": "https://devices.example.com/v1"}}).json()
    sent: list = []

    def fake(method, url, headers=None, body=None, timeout=30):
        sent.append({"method": method, "url": url, "headers": headers, "body": body})
        reply = {"items": [{"id": "d1", "online": True}, {"id": "d2", "online": False}]} if method == "GET" else {"ok": True}
        return {"status_code": 200, "status_text": "OK", "headers": [], "body": json.dumps(reply),
                "body_truncated": False, "elapsed_ms": 3}

    monkeypatch.setattr(tools_http_client, "send_request", fake)
    return conn["id"], sent


def _make(type_id: str, source: str, c=client) -> dict:
    resp = c.post("/api/builder/steps", json={"id": type_id, "source": source})
    assert resp.status_code == 201, resp.text
    return resp.json()


def _check(source: str) -> list[str]:
    out = client.post("/api/builder/steps/check", json={"source": source}).json()
    return [e["message"] for e in out["errors"]]


# ---------------------------------------------------------------- the definition


@pytest.mark.parametrize("change, says", [
    (("connection_type: http_api", "connection_type: aws"), "an HTTP type"),
    (("method: POST", "method: SEND"), "method is one of"),
    (('/devices/{{ inputs.device }}/restart', '/devices/{{ inputs.devise }}/restart'), "inputs.devise isn't one of"),
    (('/devices/{{ inputs.device }}/restart', '/devices/{{ params.device }}/restart'), "read its inputs"),
    (("description: Asks", "steps: []\ndescription: Asks"), "a request, steps or code: one of them"),
    (("request:", "requests:"), "there is no requests here; a step type may say"),
])
def test_a_step_type_that_cant_run_is_said_with_its_line(change, says):
    errors = _check(RESTART.replace(*change))
    assert any(says in e for e in errors), errors
    assert _check(RESTART) == []


def test_a_request_is_sent_as_its_runner_and_one_that_changes_something_waits_for_a_person(api):
    conn, sent = api
    made = _make("restart_device", RESTART)
    assert made["kind"] == "request" and made["external"] is True and made["can_edit"]
    assert client.post("/api/workflows", json={"id": "restart", "source": _workflow("restart_device", ', device: "d7"')}
                       ).status_code == 201
    run = _finished(_run("restart", {"api": conn})["id"])
    [step] = run["steps"]
    assert run["status"] == "waiting" and sent == [] and step["approval"]["details"]["inputs"]["device"] == "d7"
    assert "changes something outside the platform" in step["approval"]["message"]
    assert client.post(f"/api/approvals/{step['approval']['id']}/approve").status_code == 200
    done = _finished(run["id"])
    assert done["status"] == "succeeded", done
    [request] = sent
    assert (request["method"], request["url"]) == ("POST", "https://devices.example.com/v1/devices/d7/restart")
    assert json.loads(request["body"]) == {"reason": "maintenance", "force": True}
    assert request["headers"]["X-Reason"] == "maintenance" and done["steps"][0]["outputs"]["status"] == 200


def test_a_read_runs_at_once_with_rows_and_a_chain_is_one_step(api):
    conn, sent = api
    _make("list_devices", LIST)
    assert _make("list_count", CHAIN)["kind"] == "steps"
    assert client.post("/api/workflows", json={"id": "count", "source": _workflow("list_count")}).status_code == 201
    done = _finished(_run("count", {"api": conn})["id"])
    assert done["status"] == "succeeded", done
    assert done["steps"][0]["outputs"] == {"count": 2, "note": "2 devices"}
    assert sent[0]["url"] == "https://devices.example.com/v1/devices?site=south"

    # Tried from the editor: the draft sent once, as the builder.
    tried = client.post("/api/builder/steps/try", json={"source": LIST, "inputs": {"connection": conn}})
    assert tried.status_code == 200, tried.text
    assert tried.json()["rows"] == [{"Device": "d1", "Online": True}, {"Device": "d2", "Online": False}]


def test_a_step_type_cant_hold_itself_and_one_in_use_cant_go(api):
    _make("list_devices", LIST)
    _make("list_count", CHAIN)
    looped = CHAIN.replace("step: list_devices", "step: list_count")
    resp = client.put("/api/builder/steps/list_count", json={"source": looped})
    assert resp.status_code == 400 and "inside itself" in json.dumps(resp.json())
    refused = client.delete("/api/builder/steps/list_devices")
    assert refused.status_code == 400 and "List, then count uses it" in json.dumps(refused.json())
    assert "list_devices" in step_types.REGISTRY


def test_a_chain_has_no_approval_of_its_own():
    _make("list_devices", LIST)
    held = CHAIN.replace("  - id: said\n", "  - id: wait\n    approval: {}\n  - id: said\n")
    assert any("the workflow's step that uses it is what's approved" in e for e in _check(held))


# ---------------------------------------------------------------- workflows for builders (D121)


def test_a_builders_workflow_is_their_groups_to_edit_and_run(api):
    conn, _sent = api
    builders = _group("Wf builders", builder_enabled=True, pane_types=["api-table"])
    bea = _member("bea_wf", builders)
    made = bea.post("/api/workflows", json={"id": "bea_flow", "source": _workflow("list_devices")})
    assert made.status_code == 400 and "there is no step type" in made.text
    assert bea.post("/api/builder/steps", json={"id": "list_devices", "source": LIST}).status_code == 201
    made = bea.post("/api/workflows", json={"id": "bea_flow", "source": _workflow("list_devices")})
    assert made.status_code == 201, made.text
    assert made.json()["can_edit"] is True and made.json()["can_run"] is True

    # Another group's builder sees neither the workflow nor may change the step type.
    other = _member("cal_wf", _group("Other builders", builder_enabled=True, pane_types=["api-table"]))
    assert other.get("/api/workflows/bea_flow").status_code == 404
    assert other.put("/api/builder/steps/list_devices", json={"source": LIST}).status_code == 400
    # A member of the group who isn't a builder runs it but can't make one.
    plain = _member("dee_wf", _group("Plain wf", pane_types=["api-table"]))
    assert plain.post("/api/workflows", json={"id": "x", "source": _workflow("list_devices")}).status_code == 403
    # Admins: everything, and only they grant it to another group.
    assert client.get("/api/workflows/bea_flow").json()["can_edit"] is True
    assert bea.put("/api/workflows/bea_flow/grants", json={"group_ids": []}).status_code == 403
    assert bea.put("/api/workflows/bea_flow", json={"source": _workflow("list_devices").replace("Uses", "Lists")}
                   ).status_code == 200


def test_a_builder_names_only_panes_their_group_may_use():
    bea = _member("bea_wf2", _group("Wf builders 2", builder_enabled=True, pane_types=["tool-base64"]))
    scan = """label: Scan
steps:
  - {id: scan, pane: tables, action: scan, with: {tableName: Orders}}
"""
    resp = bea.post("/api/workflows/validate", json={"source": scan}).json()
    assert resp["ok"] is False and "your group can't use DynamoDB panes" in resp["errors"][0]["message"]
    assert resp["errors"][0]["line"] == 3
    assert client.post("/api/workflows/validate", json={"source": scan}).json()["ok"] is True


# ---------------------------------------------------------------- the agent builds them too (D123)


def test_the_agent_reads_checks_and_changes_a_step_type_draft(mcp):
    from app import models
    from app.db import SessionLocal
    from app.platform_tools import tokens
    from tests.test_platform_tools import _token, call, call_error

    _make("list_devices", LIST)
    ref = call(mcp, _token(), "build_reference", kind="step")
    assert ref["kind"] == "step" and "list_devices" in json.dumps(ref["step_types"])
    assert "request" in ref["examples"] and "steps" in ref["examples"]
    assert call(mcp, _token(), "read_definition", kind="step", definition_id="list_devices")["source"].startswith("id: list_devices")
    assert "list_devices" in json.dumps(call(mcp, _token(), "build_reference", kind="workflow")["step_types"])

    with SessionLocal() as db:
        admin = db.query(models.User).filter_by(username="admin").one()
        token = tokens.mint(db, admin, build={"kind": "step", "id": None, "source": RESTART})
    assert call(mcp, token, "check_definition") == {"ok": True, "errors": []}
    changed = call(mcp, token, "change_definition", changes=[{"op": "set", "path": "request/method", "value": "PUT"}])
    assert changed["ok"] is True
    bad = call(mcp, token, "change_definition", changes=[{"op": "set", "path": "request/path", "value": "/{{ inputs.nope }}"}])
    assert bad["ok"] is False and "inputs.nope isn't one of its inputs" in bad["errors"][0]["message"]
    assert "inputs.nope" in call_error(mcp, token, "propose_definition", summary="x")
