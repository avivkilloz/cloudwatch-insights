"""Workflows (PLATFORM_PLAN.md §22, D82-D86): a definition checked in full on
save, steps that are pane actions run as whoever started the run, `if`,
`for_each` and `continue_on_error`, cancel, an interrupted run, who sees a
run's outputs, the store keeping the YAML as written, and the agent's tools.

Runs are drained in the test (`workflows.drain`): a bare TestClient starts no
lifespan, so no runner is waiting for them."""

import datetime
import subprocess
from pathlib import Path

import pytest
import yaml

from app import models, workflows
from app.db import SessionLocal
from tests.conftest import client
from tests.test_connections import _login_as
from tests.test_pane_actions import aws  # noqa: F401 -- a fixture
from tests.test_platform_tools import _environment, _token, call, call_error, mcp  # noqa: F401 -- fixtures

SCAN = """\
# Says how many items a table holds -- this comment stays in the store's file.
label: Table check
description: Scans a table and says how many items it holds.
parameters:
  - { key: env, type: connection, connection_type: aws, label: Environment, required: true }
  - { key: table, type: text, default: Orders }
steps:
  - id: scan
    pane: tables
    action: scan
    with: { connection: "{{ params.env }}", tableName: "{{ params.table }}", limit: 10 }
  - id: report
    if: "{{ size(steps.scan.outputs.items) > 0 }}"
    note: "{{ size(steps.scan.outputs.items) }} items in {{ params.table }}."
"""


def _create(source: str = SCAN, workflow_id: str = "table_check", c=client) -> dict:
    resp = c.post("/api/workflows", json={"id": workflow_id, "source": source})
    assert resp.status_code == 201, resp.text
    return resp.json()


def _run(workflow_id: str, params: dict, c=client, status: int = 201) -> dict:
    resp = c.post(f"/api/workflows/{workflow_id}/runs", json={"params": params})
    assert resp.status_code == status, resp.text
    return resp.json()


def _finished(run_id: int, c=client) -> dict:
    workflows.drain()
    resp = c.get(f"/api/workflow-runs/{run_id}")
    assert resp.status_code == 200, resp.text
    return resp.json()


def _errors(source: str) -> list[str]:
    resp = client.post("/api/workflows/validate", json={"source": source})
    assert resp.status_code == 200, resp.text
    return [f"{e.get('line')}: {e['message']}" for e in resp.json()["errors"]]


def _member(name: str, pane_types: list[str], env: int | None = None, grant: str | None = None):
    g = client.post("/api/user-groups", json={"name": f"{name}-g", "pane_types": pane_types,
                                              "environment_ids": [env] if env else [], "role_name": "R"}).json()
    assert client.post("/api/users", json={"username": name, "password": "pw-123456", "group_id": g["id"]}).status_code == 201
    if grant:
        current = client.get(f"/api/workflows/{grant}").json().get("group_ids", [])
        assert client.put(f"/api/workflows/{grant}/grants", json={"group_ids": current + [g["id"]]}).status_code == 200
    return g["id"], _login_as(name, "pw-123456")


# ---------------------------------------------------------------- the definition


def test_a_broken_workflow_is_refused_with_every_problem_and_its_line():
    source = SCAN.replace("action: scan", "action: scann").replace("steps.scan.outputs", "steps.later.outputs")
    source += "  - id: report\n    note: again\n  - id: x\n    pane: nope\n    action: run\n"
    found = _errors(source)
    text = "\n".join(found)
    assert "DynamoDB has no action 'scann'" in text and "it has: list_tables, describe, scan" in text
    assert "refers to steps.later, which isn't a step before it" in text
    assert "Two steps are called report" in text and "no pane type 'nope'" in text
    # Each points at its step's line.
    assert any(line.startswith("10:") for line in found), found
    assert client.post("/api/workflows", json={"id": "broken", "source": source}).status_code == 400


@pytest.mark.parametrize("snippet, says", [
    ("    with: { tableName: '{{ params.table + }}' }", "doesn't compile"),
    ("    with: { tableNam: x }", "has no input 'tableNam'"),
    ("    with: { tableName: '{{ item }}' }", "uses item, but it has no for_each"),
])
def test_each_step_is_checked(snippet, says):
    source = "label: t\nsteps:\n  - id: s\n    pane: tables\n    action: scan\n" + snippet + "\n"
    assert any(says in e for e in _errors(source)), _errors(source)


def test_saved_as_written_with_its_id_and_admins_only():
    made = _create()
    assert made["id"] == "table_check" and made["label"] == "Table check"
    assert made["source"].startswith("id: table_check\n# Says how many items")
    assert [p["key"] for p in made["parameters"]] == ["env", "table"]
    _, bob = _member("bob", ["tables"])
    assert bob.post("/api/workflows", json={"id": "mine", "source": SCAN}).status_code == 403
    assert bob.get("/api/workflows/table_check").status_code == 404  # not granted: not there for them


# ---------------------------------------------------------------- running


def test_a_run_scans_and_reports(aws):
    env = _environment()
    _create()
    run = _run("table_check", {"env": env})
    assert run["status"] == "queued" and run["number"] == 1
    done = _finished(run["id"])
    assert done["status"] == "succeeded", done
    scan, report = done["steps"]
    assert scan["status"] == "succeeded" and scan["outputs"]["items"] == [{"id": "1"}, {"id": "2"}]
    assert scan["inputs"]["tableName"] == "Orders" and scan["inputs"]["limit"] == 10
    assert aws["scan"][0]["table"] == "Orders" and aws["scan"][0]["limit"] == 10
    assert report["outputs"] == {"text": "2 items in Orders."}
    assert _run("table_check", {"env": env})["number"] == 2


def test_if_skips_and_for_each_runs_per_item(aws):
    env = _environment()
    _create(SCAN + """\
  - id: never
    if: "params.table == 'nothing'"
    note: unseen
  - id: each
    for_each: "{{ steps.scan.outputs.items }}"
    note: "item {{ index }} is {{ item.id }}"
""")
    done = _finished(_run("table_check", {"env": env, "table": "Users"})["id"])
    steps = {s["id"]: s for s in done["steps"]}
    assert steps["never"]["status"] == "skipped"
    assert steps["each"]["outputs"] == {"items": [{"text": "item 0 is 1"}, {"text": "item 1 is 2"}]}
    assert steps["report"]["outputs"]["text"] == "2 items in Users."


def test_a_failing_step_stops_the_run_unless_it_may_fail(aws):
    env = _environment()
    # No table: the scan fails its own check ("requires"), as the pane would.
    may_fail = SCAN.replace("    with: { connection", "    continue_on_error: CONTINUE\n    with: { connection")
    _create(may_fail.replace("CONTINUE", "false"), "stops")
    _create(may_fail.replace("CONTINUE", "true").replace(
        '    if: "{{ size(steps.scan.outputs.items) > 0 }}"\n    note: "{{ size(steps.scan.outputs.items) }} items in {{ params.table }}."',
        '    note: "The scan {{ steps.scan.status }}."'), "goes_on")
    stopped = _finished(_run("stops", {"env": env, "table": ""})["id"])
    assert stopped["status"] == "failed" and stopped["steps"][0]["status"] == "failed"
    assert stopped["steps"][1]["status"] == "cancelled" and "scan failed" in stopped["error"]
    went_on = _finished(_run("goes_on", {"env": env, "table": ""})["id"])
    assert went_on["status"] == "succeeded", went_on
    assert went_on["steps"][0]["status"] == "failed"
    assert went_on["steps"][1]["outputs"] == {"text": "The scan failed."}


def test_parameters_are_checked_at_the_start(aws):
    env = _environment()
    _create()
    assert "Fill in Environment" in _run("table_check", {}, status=400)["detail"]
    assert "no parameter" in _run("table_check", {"env": env, "nope": 1}, status=400)["detail"]
    assert "isn't one you can reach" in _run("table_check", {"env": 424242}, status=400)["detail"]


# ---------------------------------------------------------------- as whoever started it (D84)


def test_a_step_acts_as_the_starter(aws):
    env = _environment()
    _create()
    # Granted the workflow, but not DynamoDB: the scan is refused as their own click would be.
    _, bob = _member("bob", ["tool-base64"], env, grant="table_check")
    run = _run("table_check", {"env": env}, c=bob)
    done = _finished(run["id"], c=bob)
    assert done["status"] == "failed"
    assert "DynamoDB turned on" in done["steps"][0]["error"]
    assert aws["scan"] == []


def test_a_runs_outputs_are_its_starters_groups_and_admins(aws):
    env = _environment()
    _create()
    gid, bob = _member("bob", ["tables"], env, grant="table_check")
    _, carol = _member("carol", ["tables"], env, grant="table_check")
    # dave shares bob's group.
    assert client.post("/api/users", json={"username": "dave", "password": "pw-123456", "group_id": gid}).status_code == 201
    dave = _login_as("dave", "pw-123456")
    run = _run("table_check", {"env": env}, c=bob)
    _finished(run["id"], c=bob)
    assert dave.get(f"/api/workflow-runs/{run['id']}").json()["steps"][0]["outputs"]["items"]
    seen = carol.get(f"/api/workflow-runs/{run['id']}").json()
    assert seen["readable"] is False and "steps" not in seen and "params" not in seen
    assert seen["started_by"] == "bob" and seen["status"] == "succeeded"
    assert carol.post(f"/api/workflow-runs/{run['id']}/cancel").status_code == 403
    # Rerunning someone else's run needs your own parameters.
    assert carol.post(f"/api/workflow-runs/{run['id']}/rerun").status_code == 403
    again = carol.post(f"/api/workflow-runs/{run['id']}/rerun", json={"params": {"env": env}}).json()
    assert again["rerun_of"] == run["id"] and again["started_by"] == "carol"
    assert [r["readable"] for r in carol.get("/api/workflows/table_check/runs").json()] == [True, False]


# ---------------------------------------------------------------- cancel, interrupted


def test_cancel_queued_and_running(aws):
    env = _environment()
    _create()
    queued = _run("table_check", {"env": env})
    assert client.post(f"/api/workflow-runs/{queued['id']}/cancel").json()["status"] == "cancelled"
    running = _run("table_check", {"env": env})
    db = SessionLocal()
    try:
        assert workflows.claim(db) == running["id"]
    finally:
        db.close()
    assert client.post(f"/api/workflow-runs/{running['id']}/cancel").status_code == 200
    workflows.execute(running["id"])
    done = client.get(f"/api/workflow-runs/{running['id']}").json()
    assert done["status"] == "cancelled" and {s["status"] for s in done["steps"]} == {"cancelled"}
    assert aws["scan"] == []


def test_a_run_whose_server_went_away_is_failed_not_resumed(aws):
    env = _environment()
    _create()
    run = _run("table_check", {"env": env})
    db = SessionLocal()
    try:
        workflows.claim(db)
        row = db.get(models.WorkflowRun, run["id"])
        row.heartbeat_at = datetime.datetime.utcnow() - datetime.timedelta(seconds=workflows.HEARTBEAT_STALE_SECONDS + 5)
        db.commit()
        assert workflows.sweep(db) == [run["id"]]
    finally:
        db.close()
    done = client.get(f"/api/workflow-runs/{run['id']}").json()
    assert done["status"] == "failed" and "Interrupted" in done["error"]


# ---------------------------------------------------------------- the store keeps it as written


def test_the_store_keeps_the_yaml_as_written(monkeypatch, tmp_path):
    from app import store

    monkeypatch.setenv("STORE_GIT_ALLOW_FILE_URLS", "1")
    monkeypatch.setenv("STORE_WORKDIR", str(tmp_path / "work"))
    remote = tmp_path / "remote.git"
    subprocess.run(["git", "init", "--quiet", "--bare", "--initial-branch=main", str(remote)], check=True)
    assert client.put("/api/store", json={"url": f"file://{remote}", "namespace": "devops"}).status_code == 200
    made = _create()
    assert made["id"] == "devops:table_check"
    store.flush()
    show = subprocess.run(["git", "--git-dir", str(remote), "show", "main:workflows/table_check.yaml"],
                          capture_output=True, text=True).stdout
    assert show.startswith("id: devops:table_check\n# Says how many items a table holds")
    assert yaml.safe_load(subprocess.run(["git", "--git-dir", str(remote), "show", "main:plugin.yaml"],
                                         capture_output=True, text=True).stdout)["contributes"]["workflows"] == ["table_check"]
    # Lost and restored: back, comment and all.
    db = SessionLocal()
    try:
        db.query(models.Workflow).delete()
        db.query(models.StoreItem).delete()
        db.commit()
        store.restore(db)
    finally:
        db.close()
    assert client.get("/api/workflows/devops:table_check").json()["source"] == show


# ---------------------------------------------------------------- the agent


def test_the_agent_lists_runs_and_reads(aws, mcp):
    env = _environment()
    _create()
    token = _token()
    listed = call(mcp, token, "list_workflows")["workflows"]
    assert listed[0]["id"] == "table_check" and listed[0]["parameters"][0]["key"] == "env"
    done = call(mcp, token, "run_workflow", workflow_id="table_check", params={"env": env}, wait_seconds=20)
    assert done["status"] == "succeeded" and done["trigger"] == "agent"
    assert done["steps"][1]["outputs"] == {"text": "2 items in Orders."}
    again = call(mcp, token, "get_workflow_run", run_id=done["id"])
    assert again["number"] == done["number"]
    assert "Fill in Environment" in call_error(mcp, token, "run_workflow", workflow_id="table_check", params={})
    assert "no workflow" in call_error(mcp, token, "run_workflow", workflow_id="nope")
