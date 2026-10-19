"""Published templates (PLATFORM_PLAN.md §23, D76, D99-D102): a saved
template made portable and plugin content -- in the store repo, offered to
whoever may use each of its panes, opened for the environment they choose."""

import subprocess
from pathlib import Path

import yaml

from app import models, store
from app.db import SessionLocal
from tests.conftest import client
from tests.test_pane_grants import _login_as
from tests.test_platform_tools import _environment
from tests.test_platform_tools import mcp  # noqa: F401 -- a fixture
from tests.test_store import _configure, _env, _show, _sync, remote  # noqa: F401 -- fixtures


def _saved(state: dict, name: str = "Orders debug") -> int:
    resp = client.post("/api/saved-sessions", json={"page": "aggregator", "name": name,
                                                    "state": {**state, "__savedStateVersion": 2}})
    assert resp.status_code in (200, 201), resp.text
    return resp.json()["id"]


def _session_state(env: int, other_env: int) -> dict:
    return {
        "services": ["tables", "logs-cloudwatch", "tool-http"],
        "paneTypes": {"tables": "tables", "logs-cloudwatch": "logs-cloudwatch", "tool-http": "tool-http"},
        "paneTitles": {"tables": "Orders", "logs-cloudwatch": "API errors", "tool-http": "Health"},
        "layout": "stacked",
        "description": "Why orders fail.",
        "variables": {"environment": env},
        # Unlinked from the variable, pointed at an environment by hand.
        "tables.unlinked": ["environment"],
        "tables.in.connection": other_env,
        "tables.in.tableName": "Orders",
        "logs-cloudwatch.in.connections": [env],
        "logs-cloudwatch.in.logGroupSelection": {str(env): {"__cwiSet": ["/app/api"]}},
        "logs-cloudwatch.in.queryString": "filter @message like /ERROR/",
        "tool-http.in.url": "/health",
        "tool-http.in.targetId": 999,
        "tool-http.in.credentialId": 7,
        "tool-http.in.headerRows": [{"id": 1, "key": "Authorization", "value": "Bearer s3cr3t"},
                                     {"id": 2, "key": "Accept", "value": "application/json"}],
    }


def _publish(saved_id: int, template_id: str = "orders_debug", c=client):
    return c.post("/api/templates", json={"saved_session_id": saved_id, "id": template_id, "label": "Orders debug",
                                          "description": "The orders panes, for any environment."})


def _member(username: str, pane_types: list[str], env: int) -> object:
    g = client.post("/api/user-groups", json={"name": f"g-{username}", "role_name": "R", "environment_ids": [env],
                                              "pane_types": pane_types})
    assert g.status_code == 201, g.text
    assert client.post("/api/users", json={"username": username, "password": "pw-123456",
                                           "group_id": g.json()["id"]}).status_code == 201
    return _login_as(username)


def test_publishing_makes_a_template_work_anywhere_and_says_what_changed():
    env, other = _environment(), _environment()
    resp = _publish(_saved(_session_state(env, other)))
    assert resp.status_code == 201, resp.text
    out = resp.json()
    assert out["id"] == "orders_debug" and out["needs_environment"] is True
    assert out["pane_types"] == ["logs-cloudwatch", "tables", "tool-http"]
    with SessionLocal() as db:
        state = db.get(models.PublishedTemplate, "orders_debug").state
    # Nothing that names this platform's own connections or credentials...
    for key in ("tables.in.connection", "logs-cloudwatch.in.connections", "tool-http.in.targetId",
                "tool-http.in.credentialId"):
        assert key not in state, key
    assert "__savedStateVersion" not in state and "Bearer" not in str(state)
    # ...the AWS panes follow the Environment variable, the one unlinked too...
    assert state["variables"] == {"environment": None} and "tables.unlinked" not in state
    # ...and the log groups wait for the environment chosen on opening.
    assert state["logs-cloudwatch.in.logGroupSelection"] == {"$environment": {"__cwiSet": ["/app/api"]}}
    assert state["tool-http.in.headerRows"][1]["value"] == "application/json"
    assert state["tables.in.tableName"] == "Orders" and state["description"] == "Why orders fail."
    said = " ".join(out["changes"])
    assert "Environment variable" in said and "Authorization" in said and "credential" in said
    assert "Target" in said or "targetId" in said


def test_only_admins_publish():
    env = _environment()
    member = _member("pat", ["tables"], env)
    saved = member.post("/api/saved-sessions", json={"page": "aggregator", "name": "Mine", "state": {
        "services": ["tables"], "tables.in.tableName": "T"}}).json()["id"]
    assert _publish(saved, c=member).status_code == 403
    # An admin can't publish someone else's either: a saved template is its owner's.
    assert _publish(saved).status_code == 400


def test_its_offered_to_whoever_may_use_every_pane_and_opens_for_their_environment():
    env, other = _environment(), _environment()
    assert _publish(_saved(_session_state(env, other))).status_code == 201
    able = _member("ana", ["tables", "logs-cloudwatch", "tool-http"], env)
    unable = _member("bo", ["tables"], env)
    assert [t["id"] for t in able.get("/api/templates").json()] == ["orders_debug"]
    # Only its publisher is told which saved template of theirs it replaces.
    assert able.get("/api/templates").json()[0]["from_saved_session_id"] is None
    assert client.get("/api/templates").json()[0]["from_saved_session_id"] is not None
    assert unable.get("/api/templates").json() == []
    assert unable.post("/api/templates/orders_debug/open", json={"environment": env}).status_code == 404

    refused = able.post("/api/templates/orders_debug/open", json={})
    assert refused.status_code == 400 and "Choose the environment" in refused.json()["detail"]
    assert able.post("/api/templates/orders_debug/open", json={"environment": other}).status_code == 400

    opened = able.post("/api/templates/orders_debug/open", json={"environment": env})
    assert opened.status_code == 201, opened.text
    session = able.get(f"/api/live-sessions/{opened.json()['session_id']}").json()
    state = session["state"]
    assert session["title"] == "Orders debug" and state["variables"] == {"environment": env}
    assert state["tables.in.connection"] == env and state["logs-cloudwatch.in.connections"] == [env]
    assert state["logs-cloudwatch.in.logGroupSelection"] == {str(env): {"__cwiSet": ["/app/api"]}}
    assert state["tables.in.tableName"] == "Orders" and "tool-http.in.targetId" not in state


def test_a_published_template_is_kept_in_the_store_and_comes_back(remote):
    env = _environment()
    _configure(remote)
    out = _publish(_saved(_session_state(env, env)), "orders").json()
    assert out["id"] == "devops:orders"
    _sync()
    kept = yaml.safe_load(_show(remote, "templates/orders.yaml"))
    assert kept["id"] == "devops:orders" and kept["label"] == "Orders debug"
    assert kept["state"]["variables"] == {"environment": None}
    assert "templates" in yaml.safe_load(_show(remote, "plugin.yaml"))["contributes"]

    with SessionLocal() as db:
        db.query(models.StoreItem).filter_by(kind="template").delete()
        db.query(models.PublishedTemplate).delete()
        db.commit()
    store.startup()
    assert [t["id"] for t in client.get("/api/templates").json()] == ["devops:orders"]

    assert client.delete("/api/templates/devops:orders").status_code == 204
    _sync()
    assert _show(remote, "templates/orders.yaml") is None


def test_the_agent_sees_and_opens_them(mcp):
    from tests.test_platform_tools import _token, call

    env, other = _environment(), _environment("Test", "222233334444")
    assert _publish(_saved(_session_state(env, other))).status_code == 201
    context = call(mcp, _token(), "get_context")
    assert {"id": "orders_debug", "label": "Orders debug", "description": "The orders panes, for any environment.",
            "needs_environment": True} in context["templates"]
    opened = call(mcp, _token(), "open_template", template_id="orders_debug", environment="Prod")
    session = client.get(f"/api/live-sessions/{opened['session_id']}").json()
    assert session["state"]["variables"] == {"environment": env} and session["state"]["tables.in.connection"] == env
