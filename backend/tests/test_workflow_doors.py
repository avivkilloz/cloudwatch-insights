"""The doors between workflows and sessions (PLATFORM_PLAN.md §22.10,
D95-D98): a run investigated in a session, a session drafted into a
workflow, the workflow pane, and a run's own chat."""

import time

import yaml

from app import models, workflows
from app.db import SessionLocal
from app.panes import handlers
from tests.conftest import client
from tests.test_pane_actions import aws  # noqa: F401 -- a fixture
from tests.test_platform_tools import _environment, _token, call, mcp  # noqa: F401 -- fixtures
from tests.test_workflows import _create, _finished, _member, _run

SCANS = """label: Scans
parameters:
  - { key: env, type: connection, connection_type: aws, label: Environment, required: true }
steps:
  - id: orders
    label: Orders
    pane: tables
    action: scan
    with: { connection: "{{ params.env }}", tableName: Orders, limit: 10 }
  - id: each
    label: Each table
    for_each: "{{ ['Users', 'Carts'] }}"
    pane: tables
    action: scan
    with: { connection: "{{ params.env }}", tableName: "{{ item }}" }
  - id: said
    note: "{{ size(steps.orders.outputs.items) }} orders."
"""


def _session(client_id: str, c=client) -> dict:
    resp = c.get(f"/api/live-sessions/{client_id}")
    assert resp.status_code == 200, resp.text
    return resp.json()


# ---------------------------------------------------------------- investigate (D95)


def test_investigate_opens_a_session_of_what_the_run_found(aws):
    env = _environment()
    _create(SCANS, "scans")
    run = _finished(_run("scans", {"env": env})["id"])
    assert run["status"] == "succeeded", run

    resp = client.post(f"/api/workflow-runs/{run['id']}/investigate")
    assert resp.status_code == 201, resp.text
    made = _session(resp.json()["session_id"])
    state = made["state"]
    assert made["title"] == "Scans #1" and state["layout"] == "stacked"
    assert state["services"] == ["tables", "tables~2", "tables~3"]
    assert [state["paneTitles"][p] for p in state["services"]] == ["Orders", "Each table · 1", "Each table · 2"]
    # The inputs it ran with, the pane's own keys -- the connection included.
    assert state["tables.in.tableName"] == "Orders" and state["tables.in.connection"] == env
    assert state["tables~3.in.tableName"] == "Carts"
    # Its outputs are the panes' own records, for the renderers.
    assert [i["id"] for i in made["outputs"]["tables"]["values"]["items"]] == ["1", "2"]
    assert made["outputs"]["tables~2"]["values"]["ranAt"] > 0
    assert "From Scans #1" in state["description"] and "said: 2 orders." in state["description"]

    # Only a reader may: another group sees the run happened, not what it found.
    _, bob = _member("bob", ["tables"], env, grant="scans")
    assert bob.post(f"/api/workflow-runs/{run['id']}/investigate").status_code == 400


def test_the_agent_can_investigate_a_run(aws, mcp):
    env = _environment()
    _create(SCANS, "scans")
    run = _run("scans", {"env": env})
    # The app's own runner is up here (the MCP endpoint needs its lifespan), so
    # the run may be on its thread while the test drains: wait for its end.
    for _ in range(100):
        run = _finished(run["id"])
        if run["status"] in workflows.FINISHED:
            break
        time.sleep(0.1)
    out = call(mcp, _token(), "investigate_run", run_id=run["id"])
    assert out["title"] == "Scans #1"
    assert _session(out["session_id"])["state"]["services"] == ["tables", "tables~2", "tables~3"]


# ---------------------------------------------------------------- make repeatable (D96)


def test_a_session_drafts_a_workflow_with_its_environments_as_parameters(aws):
    env = _environment()
    state = {
        "services": ["tables", "logs-cloudwatch", "tool-base64"],
        "paneTypes": {"tables": "tables", "logs-cloudwatch": "logs-cloudwatch", "tool-base64": "tool-base64"},
        "paneTitles": {"tables": "Orders table", "logs-cloudwatch": "API errors", "tool-base64": "Decode"},
        "tables.in.connection": env,
        "tables.in.tableName": "Orders",
        # As the browser keeps them: the environment ticked beside its log
        # groups, and those a tagged Set -- one parameter, the groups plain.
        "logs-cloudwatch.in.connections": [env],
        "logs-cloudwatch.in.logGroupSelection": {str(env): {"__cwiSet": ["/app"]}},
        "logs-cloudwatch.in.queryString": "filter @message like /ERROR/",
        "tool-base64.in.input": "aGk=",
        "description": "Why orders fail.",
    }
    assert client.put("/api/live-sessions/dr-1", json={"type": "aggregator", "title": "Orders", "state": state}).status_code == 200
    resp = client.post("/api/workflows/draft", json={"session": "dr-1"})
    assert resp.status_code == 200, resp.text
    draft = resp.json()
    assert draft["errors"] == [], draft
    parsed = yaml.safe_load(draft["source"])
    assert parsed["label"] == "Orders" and parsed["description"] == "Why orders fail."
    # One connection, one parameter -- both panes read it.
    [param] = parsed["parameters"]
    assert param["type"] == "connection" and param["default"] == env
    steps = {s["id"]: s for s in parsed["steps"]}
    assert set(steps) == {"orders_table", "api_errors"}, "the browser-only tool has nothing to repeat"
    assert steps["orders_table"]["with"] == {"connection": "{{ params.%s }}" % param["key"], "tableName": "Orders"}
    assert steps["api_errors"]["with"]["logGroupSelection"] == "{{ {string(params.%s): [\"/app\"]} }}" % param["key"]
    assert "connections" not in steps["api_errors"]["with"], "picking the groups ticks it, as it does by hand"

    # It runs as drafted.
    made = client.post("/api/workflows", json={"id": draft["suggested_id"], "source": draft["source"]})
    assert made.status_code == 201, made.text

    _, bob = _member("bob", ["tables"], env)
    assert bob.post("/api/workflows/draft", json={"session": "dr-1"}).status_code == 403


# ---------------------------------------------------------------- the workflow pane (D97)


def test_the_workflow_pane_runs_and_follows_a_workflow(aws):
    env = _environment()
    _create(SCANS, "scans")
    with SessionLocal() as db:
        admin = db.query(models.User).filter_by(username="admin").one()
        label = next(t["label"] for t in __import__("app.connections", fromlist=["targets"]).targets(db, admin, "aws") if t["id"] == env)
        listed = handlers.ACTIONS["platform.workflows.list"](db, admin, {}, None)
        assert {"value": "scans", "label": "Scans"} in listed["options"]
        # A connection by its name, as the pane's rows give it.
        started = handlers.ACTIONS["platform.workflows.start"](
            db, admin, {"workflow": "scans", "params": [{"id": 1, "key": "env", "value": label}]}, None)
        [handle] = started["handles"]
        assert "Scans #1: queued" in started["summary"]
    workflows.drain()
    with SessionLocal() as db:
        admin = db.query(models.User).filter_by(username="admin").one()
        polled = handlers.ACTIONS["platform.workflows.poll"](db, admin, {"handles": [handle]}, None)
    assert polled["done"] is True and "Scans #1: succeeded" in polled["summary"]
    assert [s["stage"] for s in polled["stages"]] == ["Orders", "Each table", "said"]
    run = client.get(f"/api/workflow-runs/{handle['run_id']}").json()
    assert run["trigger"] == "pane" and run["params"] == {"env": env}

    with SessionLocal() as db:
        admin = db.query(models.User).filter_by(username="admin").one()
        try:
            handlers.ACTIONS["platform.workflows.start"](
                db, admin, {"workflow": "scans", "params": [{"key": "env", "value": "Nowhere"}]}, None)
            raise AssertionError("an unknown connection name was taken")
        except Exception as e:  # HTTPException
            assert "no connection called Nowhere" in str(getattr(e, "detail", e))


def test_the_workflow_pane_is_a_manifest_the_action_endpoint_runs(aws):
    _create(SCANS, "scans")
    resp = client.post("/api/panes/workflow/actions/list_workflows", json={"inputs": {}})
    assert resp.status_code == 200, resp.text
    assert {"value": "scans", "label": "Scans"} in resp.json()["options"]


# ---------------------------------------------------------------- this run's chat (D98)


def test_a_runs_chat_is_kept_on_the_run_for_its_readers():
    _create("label: Chatty\nsteps:\n  - id: a\n    note: hi\n", "chatty")
    run = _finished(_run("chatty", {})["id"])
    url = f"/api/workflow-runs/{run['id']}/chat"
    assert client.get(url).json() == {"turns": []}
    one = {"id": "t1", "question": "why?", "status": "running"}
    client.post(url, json={"turns": [one]})
    # Someone else's message lands meanwhile; then the first one's answer.
    client.post(url, json={"turns": [{"id": "t2", "question": "and?", "status": "done"}]})
    client.post(url, json={"turns": [{**one, "status": "done", "answer": "Because."}]})
    turns = client.get(url).json()["turns"]
    assert [(t["id"], t["status"]) for t in turns] == [("t1", "done"), ("t2", "done")]
    # A late copy of a running turn doesn't undo its answer.
    client.post(url, json={"turns": [one]})
    assert client.get(url).json()["turns"][0]["answer"] == "Because."

    _, bob = _member("bob", ["tables"], None, grant="chatty")
    assert bob.get(url).status_code == 403
