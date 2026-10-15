"""A session as the home page (R3, D63, PLATFORM_PLAN.md §18.9): per user, any
session they can reach, and a note -- not an error -- once it's gone."""

from fastapi.testclient import TestClient

from app.main import app
from tests.conftest import client


def _login_as(username: str, password: str = "pw-123456") -> TestClient:
    c = TestClient(app)
    resp = c.post("/api/auth/login", json={"username": username, "password": password})
    assert resp.status_code == 200, resp.text
    return c


def _user(username: str, password: str = "pw-123456") -> int:
    group = client.post("/api/user-groups", json={"name": f"{username}-group", "role_name": "R"})
    assert group.status_code == 201, group.text
    resp = client.post("/api/users", json={"username": username, "password": password, "group_id": group.json()["id"]})
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


def _put_session(c: TestClient, client_id: str, title: str | None = None) -> None:
    payload = {"type": "aggregator", "title": title or client_id, "position": 0, "state": {}, "truncated": False}
    resp = c.put(f"/api/live-sessions/{client_id}", json=payload)
    assert resp.status_code == 200, resp.text


def test_none_until_set_then_the_session():
    assert client.get("/api/live-sessions/home").json() == {"home": None, "missing": None}
    _put_session(client, "s1", "Fleet")
    resp = client.put("/api/live-sessions/s1/home")
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"home": {"client_id": "s1", "title": "Fleet", "closed": False}, "missing": None}
    assert client.get("/api/live-sessions/home").json()["home"]["client_id"] == "s1"


def test_home_is_routed_before_a_session_id():
    # "home" must not be read as a client_id by GET /{client_id}.
    _put_session(client, "s1")
    client.put("/api/live-sessions/s1/home")
    assert client.get("/api/live-sessions/home").status_code == 200
    assert client.get("/api/live-sessions/s1").json()["client_id"] == "s1"


def test_closed_and_renamed_are_reported_as_they_are_now():
    _put_session(client, "s1", "Fleet")
    client.put("/api/live-sessions/s1/home")
    client.post("/api/live-sessions/s1/close")
    _put_session(client, "s1", "Fleet health")
    assert client.get("/api/live-sessions/home").json()["home"] == {
        "client_id": "s1",
        "title": "Fleet health",
        "closed": False,
    }
    client.post("/api/live-sessions/s1/close")
    assert client.get("/api/live-sessions/home").json()["home"]["closed"] is True


def test_deleted_leaves_a_note_until_cleared():
    _put_session(client, "s1", "Fleet")
    client.put("/api/live-sessions/s1/home")
    assert client.delete("/api/live-sessions/s1").status_code == 204
    assert client.get("/api/live-sessions/home").json() == {"home": None, "missing": "Fleet"}
    assert client.delete("/api/live-sessions/home").json() == {"home": None, "missing": None}
    assert client.get("/api/live-sessions/home").json() == {"home": None, "missing": None}


def test_a_session_shared_with_you_and_leaving_it():
    bob_id = _user("bob")
    _put_session(client, "s1", "Shared board")
    assert client.post("/api/live-sessions/s1/members", json={"username": "bob", "permission": "viewer"}).status_code == 201
    bob = _login_as("bob")
    assert bob.put("/api/live-sessions/s1/home").status_code == 200
    assert bob.get("/api/live-sessions/home").json()["home"]["title"] == "Shared board"
    # Their closed-state is their own: the owner closing it changes nothing.
    client.post("/api/live-sessions/s1/close")
    assert bob.get("/api/live-sessions/home").json()["home"]["closed"] is False
    assert bob.delete(f"/api/live-sessions/s1/members/{bob_id}").status_code == 204
    assert bob.get("/api/live-sessions/home").json() == {"home": None, "missing": "Shared board"}


def test_only_a_session_you_can_reach_and_only_yours_changes():
    _user("bob")
    _put_session(client, "s1")
    bob = _login_as("bob")
    assert bob.put("/api/live-sessions/s1/home").status_code == 404
    _put_session(bob, "b1")
    bob.put("/api/live-sessions/b1/home")
    assert client.get("/api/live-sessions/home").json() == {"home": None, "missing": None}
