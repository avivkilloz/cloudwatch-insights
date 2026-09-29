"""Phase 1 of sharing a live session: inviting other users and managing their
permission. This alone doesn't grant an invited member any reach into the
session -- every read/write route still checks ownership alone -- so these
tests cover only the roster itself: invite, list, change permission, remove,
and that only the owner may do any of it.
"""

from fastapi.testclient import TestClient

from app.main import app
from tests.conftest import client


def _login_as(username: str, password: str) -> TestClient:
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


def _put_session(client_id: str, **overrides) -> dict:
    payload = {"type": "aggregator", "title": client_id, "position": 0, "state": {}, "truncated": False}
    payload.update(overrides)
    resp = client.put(f"/api/live-sessions/{client_id}", json=payload)
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_invite_list_and_default_permission():
    _put_session("s1")
    _user("bob")

    resp = client.post("/api/live-sessions/s1/members", json={"username": "bob"})
    assert resp.status_code == 201, resp.text
    assert resp.json() == {"user_id": resp.json()["user_id"], "username": "bob", "permission": "editor"}

    listed = client.get("/api/live-sessions/s1/members").json()
    assert listed == [{"user_id": listed[0]["user_id"], "username": "bob", "permission": "editor"}]


def test_invite_with_viewer_permission():
    _put_session("s1")
    _user("bob")
    resp = client.post("/api/live-sessions/s1/members", json={"username": "bob", "permission": "viewer"})
    assert resp.status_code == 201, resp.text
    assert resp.json()["permission"] == "viewer"


def test_a_username_that_does_not_exist_is_refused():
    _put_session("s1")
    resp = client.post("/api/live-sessions/s1/members", json={"username": "nobody"})
    assert resp.status_code == 404


def test_inviting_yourself_is_refused():
    _put_session("s1")
    resp = client.post("/api/live-sessions/s1/members", json={"username": "admin"})
    assert resp.status_code == 400


def test_inviting_the_same_user_twice_is_refused():
    _put_session("s1")
    _user("bob")
    assert client.post("/api/live-sessions/s1/members", json={"username": "bob"}).status_code == 201
    resp = client.post("/api/live-sessions/s1/members", json={"username": "bob"})
    assert resp.status_code == 409


def test_change_and_remove_a_members_permission():
    _put_session("s1")
    bob_id = _user("bob")
    client.post("/api/live-sessions/s1/members", json={"username": "bob"})

    resp = client.put(f"/api/live-sessions/s1/members/{bob_id}", json={"permission": "viewer"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["permission"] == "viewer"

    assert client.delete(f"/api/live-sessions/s1/members/{bob_id}").status_code == 204
    assert client.get("/api/live-sessions/s1/members").json() == []


def test_changing_or_removing_a_non_member_is_a_404():
    _put_session("s1")
    bob_id = _user("bob")
    assert client.put(f"/api/live-sessions/s1/members/{bob_id}", json={"permission": "viewer"}).status_code == 404
    assert client.delete(f"/api/live-sessions/s1/members/{bob_id}").status_code == 404


def test_only_the_owner_manages_membership():
    _put_session("s1")
    _user("bob")
    eve_id = _user("eve", "eve-pass")
    eve = _login_as("eve", "eve-pass")

    # eve can't see or manage a session she doesn't own, even its member list.
    assert eve.get("/api/live-sessions/s1/members").status_code == 404
    assert eve.post("/api/live-sessions/s1/members", json={"username": "bob"}).status_code == 404

    client.post("/api/live-sessions/s1/members", json={"username": "eve"})
    assert eve.put(f"/api/live-sessions/s1/members/{eve_id}", json={"permission": "viewer"}).status_code == 404
    # Except removing herself: leaving a session shared with you needs no
    # ownership, only being on it (see test_session_sharing.py).
    assert eve.delete(f"/api/live-sessions/s1/members/{eve_id}").status_code == 204


def test_membership_is_scoped_to_its_own_session():
    _put_session("s1")
    _put_session("s2")
    bob_id = _user("bob")
    client.post("/api/live-sessions/s1/members", json={"username": "bob"})

    assert client.get("/api/live-sessions/s2/members").json() == []
    assert client.put(f"/api/live-sessions/s2/members/{bob_id}", json={"permission": "viewer"}).status_code == 404
