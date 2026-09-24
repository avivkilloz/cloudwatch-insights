"""Slack-style groups for the side panel's session list.

A category is just a name and a position; assigning a session to one goes
through the live-sessions PUT (category_id), not a route here. The tests
below cover creating, renaming, reordering and deleting a category, and that
deleting one leaves its sessions in place rather than taking them with it.
"""

from fastapi.testclient import TestClient

from app.main import app
from tests.conftest import client


def _login_as(username: str, password: str) -> TestClient:
    c = TestClient(app)
    resp = c.post("/api/auth/login", json={"username": username, "password": password})
    assert resp.status_code == 200, resp.text
    return c


def _create(name: str) -> dict:
    resp = client.post("/api/session-categories", json={"name": name})
    assert resp.status_code == 201, resp.text
    return resp.json()


def _list() -> list[dict]:
    resp = client.get("/api/session-categories")
    assert resp.status_code == 200, resp.text
    return resp.json()


def _put_session(client_id: str, **overrides) -> dict:
    payload = {"type": "logs-cloudwatch", "title": client_id, "position": 0, "state": {}, "truncated": False}
    payload.update(overrides)
    resp = client.put(f"/api/live-sessions/{client_id}", json=payload)
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_create_and_list_categories_in_position_order():
    _create("Prod")
    _create("Staging")
    names = [c["name"] for c in _list()]
    assert names == ["Prod", "Staging"]


def test_duplicate_name_is_rejected():
    _create("Prod")
    resp = client.post("/api/session-categories", json={"name": "Prod"})
    assert resp.status_code == 409


def test_rename_category():
    category = _create("Prod")
    resp = client.put(f"/api/session-categories/{category['id']}", json={"name": "Production"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["name"] == "Production"


def test_reorder_categories():
    a = _create("A")
    b = _create("B")
    resp = client.post("/api/session-categories/reorder", json={"ids": [b["id"], a["id"]]})
    assert resp.status_code == 200, resp.text
    assert [c["id"] for c in resp.json()] == [b["id"], a["id"]]


def test_a_session_can_be_assigned_to_a_category():
    category = _create("Prod")
    row = _put_session("s1", category_id=category["id"])
    assert row["category_id"] == category["id"]

    (restored,) = client.get("/api/live-sessions").json()
    assert restored["category_id"] == category["id"]


def test_deleting_a_category_ungroups_its_sessions_instead_of_deleting_them():
    category = _create("Prod")
    _put_session("s1", category_id=category["id"])

    resp = client.delete(f"/api/session-categories/{category['id']}")
    assert resp.status_code == 204

    (restored,) = client.get("/api/live-sessions").json()
    assert restored["client_id"] == "s1"
    assert restored["category_id"] is None


def test_categories_are_scoped_per_user():
    _create("Prod")

    group = client.post("/api/user-groups", json={"name": "Viewers"})
    assert group.status_code == 201, group.text
    client.post("/api/users", json={"username": "eve", "password": "eve-pass", "group_id": group.json()["id"]})
    eve = _login_as("eve", "eve-pass")

    assert eve.get("/api/session-categories").json() == []
