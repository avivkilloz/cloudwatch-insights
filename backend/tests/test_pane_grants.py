"""Access per pane type (D65, PLATFORM_PLAN.md §19.1): a group may use the pane
types it has been granted, the old per-page booleans are shorthand for those
grants, and the migration gives every group exactly what its booleans did."""

from fastapi.testclient import TestClient

from app import models, pane_access
from app.db import SessionLocal
from app.main import app
from app.platform_tools import panes as agent_panes
from tests.conftest import client

TOOLS = {"api-table", "tool-base64", "tool-diff", "tool-http", "tool-jwt", "tool-mqtt"}


def _login_as(username: str, password: str = "pw-123456") -> TestClient:
    c = TestClient(app)
    resp = c.post("/api/auth/login", json={"username": username, "password": password})
    assert resp.status_code == 200, resp.text
    return c


def _group(**body) -> dict:
    resp = client.post("/api/user-groups", json={"name": f"g-{len(str(body))}-{sorted(body)}", **body})
    assert resp.status_code == 201, resp.text
    return resp.json()


def _member(group_id: int, username: str) -> TestClient:
    assert client.post("/api/users", json={"username": username, "password": "pw-123456", "group_id": group_id}).status_code == 201
    return _login_as(username)


def test_exact_pane_types_and_the_booleans_they_add_up_to():
    g = _group(name="base64 only", pane_types=["tool-base64"])
    assert g["pane_types"] == ["tool-base64"]
    # "Tools" is on because one tool is granted; every service is off.
    assert g["tools_enabled"] is True
    assert not any(g[f] for f in pane_access.LEGACY_FLAGS if f != "tools_enabled")


def test_the_booleans_are_shorthand_on_create_and_update():
    g = _group(name="no services", logs_enabled=False, opensearch_enabled=False, iot_enabled=False,
               tables_enabled=False, buckets_enabled=False, cognito_enabled=False)
    assert set(g["pane_types"]) == TOOLS
    resp = client.put(f"/api/user-groups/{g['id']}", json={"tools_enabled": False, "iot_enabled": True})
    assert resp.status_code == 200, resp.text
    assert resp.json()["pane_types"] == ["iot"]
    # Left out, a boolean changes nothing.
    resp = client.put(f"/api/user-groups/{g['id']}", json={"name": "renamed"})
    assert resp.json()["pane_types"] == ["iot"]
    # The exact list wins over the shorthand when both are sent.
    resp = client.put(f"/api/user-groups/{g['id']}", json={"pane_types": ["tool-jwt"], "iot_enabled": True})
    assert resp.json()["pane_types"] == ["tool-jwt"]


def test_an_unknown_pane_type_is_refused_by_name():
    resp = client.post("/api/user-groups", json={"name": "typo", "pane_types": ["tool-bas64"]})
    assert resp.status_code == 400
    assert "tool-bas64" in resp.json()["detail"]


def test_one_tool_granted_is_the_only_tool_offered_and_allowed():
    g = _group(name="just base64", pane_types=["tool-base64"])
    alice = _member(g["id"], "alice")
    assert alice.get("/api/auth/me").json()["pane_types"] == ["tool-base64"]
    assert [m["id"] for m in alice.get("/api/pane-types").json()] == ["tool-base64"]
    # Another tool -- once all under one "Tools" switch -- is refused like a
    # pane type that doesn't exist, by the action endpoint and the HTTP Send.
    resp = alice.post("/api/panes/tool-http/actions/send", json={"inputs": {"url": "https://example.com"}})
    assert resp.status_code == 404 and "no pane type" in resp.json()["detail"], resp.text
    db = SessionLocal()
    try:
        user = db.query(models.User).filter(models.User.username == "alice").one()
        assert [k.type for k in agent_panes.available_kinds(user)] == ["tool-base64"]
        try:
            agent_panes.kind_for(user, "tool-http")
            raise AssertionError("the agent was given a pane type the group hasn't")
        except agent_panes.InputError as e:
            assert "turned on" in str(e)
    finally:
        db.close()


def test_the_admin_group_has_every_pane_type_without_grants():
    me = client.get("/api/auth/me").json()
    assert set(me["pane_types"]) >= TOOLS | {"iot", "logs-cloudwatch"}
    assert all(me[f] for f in pane_access.LEGACY_FLAGS)


def test_migration_gives_each_group_what_its_booleans_did_once():
    db = SessionLocal()
    try:
        db.query(models.Setting).filter(models.Setting.key == pane_access.MIGRATED_MARKER).delete()
        old = models.UserGroup(name="Old", tools_enabled=False, iot_enabled=False, logs_enabled=True,
                               opensearch_enabled=False, tables_enabled=True, buckets_enabled=False,
                               cognito_enabled=False)
        db.add(old)
        db.commit()
        assert pane_access.granted(old) == set()
        lines = pane_access.migrate(db)
        assert any("Old" in line for line in lines)
        db.refresh(old)
        assert pane_access.granted(old) == {"logs-cloudwatch", "tables"}
        # Once: a group later stripped of every pane doesn't get them back.
        pane_access.set_grants(db, old, [])
        db.commit()
        assert pane_access.migrate(db) == []
        db.refresh(old)
        assert pane_access.granted(old) == set()
    finally:
        db.close()


def test_grants_go_with_their_group():
    g = _group(name="short lived", pane_types=["tool-diff"])
    assert client.delete(f"/api/user-groups/{g['id']}").status_code == 204
    db = SessionLocal()
    try:
        assert db.query(models.GroupPaneGrant).filter(models.GroupPaneGrant.group_id == g["id"]).count() == 0
    finally:
        db.close()
