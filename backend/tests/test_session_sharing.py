"""Sharing a session, phase 3: an invited member can actually reach it.

Phases 1 and 2 only built the roster (who's invited, at what permission) and
the session card's UI on top of it -- neither let a member touch the session
itself. This is that: a member can GET and (if "editor") PUT the shared
session, sees it in their own open/closed lists with their *own* position,
category and closed state (never the owner's, or another member's), and a
viewer's write is refused. Deleting stays the owner's alone; a member leaves
instead.
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
    payload = {"type": "aggregator", "title": client_id, "position": 0, "state": {"a": 1}, "truncated": False}
    payload.update(overrides)
    resp = client.put(f"/api/live-sessions/{client_id}", json=payload)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _invite(client_id: str, username: str, permission: str = "editor") -> dict:
    resp = client.post(f"/api/live-sessions/{client_id}/members", json={"username": username, "permission": permission})
    assert resp.status_code == 201, resp.text
    return resp.json()


def _share(client_id: str, username: str, permission: str = "editor") -> TestClient:
    """The owner creates and shares a session; returns the invitee, logged in."""
    _put_session(client_id)
    password = f"{username}-pass"
    _user(username, password)
    _invite(client_id, username, permission)
    return _login_as(username, password)


# ---------------------------------------------------------------- reaching it


def test_a_member_can_get_the_shared_session():
    bob = _share("s1", "bob", "viewer")
    resp = bob.get("/api/live-sessions/s1")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["state"] == {"a": 1}
    assert body["role"] == "viewer"


def test_someone_not_invited_cant_reach_it():
    _put_session("s1")
    _user("eve", "eve-pass")
    eve = _login_as("eve", "eve-pass")
    assert eve.get("/api/live-sessions/s1").status_code == 404


def test_the_owners_own_get_reports_role_owner():
    _put_session("s1")
    assert client.get("/api/live-sessions/s1").json()["role"] == "owner"


# ---------------------------------------------------------------- writing it


def test_a_viewer_cannot_write():
    bob = _share("s1", "bob", "viewer")
    resp = bob.put(
        "/api/live-sessions/s1",
        json={"type": "aggregator", "title": "s1", "state": {"a": 2}, "truncated": False},
    )
    assert resp.status_code == 403, resp.text
    # And the state is exactly as the owner left it -- the refused write
    # didn't partially land.
    assert client.get("/api/live-sessions/s1").json()["state"] == {"a": 1}


def test_an_editor_can_write_the_shared_state():
    bob = _share("s1", "bob", "editor")
    resp = bob.put(
        "/api/live-sessions/s1",
        json={"type": "aggregator", "title": "s1", "state": {"a": 2}, "truncated": False},
    )
    assert resp.status_code == 200, resp.text
    # The one shared document -- the owner sees the editor's write too.
    assert client.get("/api/live-sessions/s1").json()["state"] == {"a": 2}


def test_an_editors_stale_write_is_still_refused_409():
    bob = _share("s1", "bob", "editor")
    current = client.get("/api/live-sessions/s1").json()["version"]
    client.put("/api/live-sessions/s1", json={"type": "aggregator", "title": "s1", "state": {"a": 9}, "truncated": False})
    resp = bob.put(
        "/api/live-sessions/s1",
        json={"type": "aggregator", "title": "s1", "state": {"a": 2}, "truncated": False, "base_version": current},
    )
    assert resp.status_code == 409, resp.text


# ---------------------------------------------------------------- each member's own view


def test_a_members_category_and_closed_state_are_their_own():
    bob = _share("s1", "bob", "editor")
    cat = bob.post("/api/session-categories", json={"name": "Bob's category"})
    assert cat.status_code == 201, cat.text

    bob.put(
        "/api/live-sessions/s1",
        json={"type": "aggregator", "title": "s1", "category_id": cat.json()["id"], "state": {"a": 1}, "truncated": False},
    )
    # Bob's own view is categorized; the owner's own row never was.
    assert bob.get("/api/live-sessions/s1").json()["category_id"] == cat.json()["id"]
    assert client.get("/api/live-sessions/s1").json()["category_id"] is None

    bob.post("/api/live-sessions/s1/close")
    # Closed for Bob only -- the owner still sees it open.
    assert "s1" not in [s["client_id"] for s in bob.get("/api/live-sessions").json()]
    assert "s1" in [s["client_id"] for s in client.get("/api/live-sessions").json()]
    assert "s1" in [s["client_id"] for s in bob.get("/api/live-sessions/closed").json()]

    # Reopens the same way an owned session does: writing to it.
    bob.put("/api/live-sessions/s1", json={"type": "aggregator", "title": "s1", "state": {"a": 1}, "truncated": False})
    assert "s1" in [s["client_id"] for s in bob.get("/api/live-sessions").json()]


def test_the_owners_close_never_affects_a_members_view():
    bob = _share("s1", "bob", "editor")
    client.post("/api/live-sessions/s1/close")
    assert "s1" not in [s["client_id"] for s in client.get("/api/live-sessions").json()]
    assert "s1" in [s["client_id"] for s in bob.get("/api/live-sessions").json()]


def test_a_shared_session_appears_in_the_members_own_list_with_its_own_position():
    _put_session("mine")
    bob = _share("s1", "bob", "editor")
    ids = [s["client_id"] for s in bob.get("/api/live-sessions").json()]
    assert "s1" in ids
    assert "mine" not in ids  # bob doesn't own it and isn't a member of it


def test_reorder_moves_the_right_row_for_whoever_asks():
    _put_session("mine1")
    _put_session("mine2")
    bob = _share("s1", "bob", "editor")
    bob.put("/api/live-sessions/bobs-own", json={"type": "aggregator", "title": "bobs-own", "state": {}, "truncated": False})

    bob.post("/api/live-sessions/reorder", json={"client_ids": ["s1", "bobs-own"]})
    bob_order = [s["client_id"] for s in bob.get("/api/live-sessions").json()]
    assert bob_order == ["s1", "bobs-own"]

    # The owner's own order (and their session's real position) is untouched
    # by bob's reorder of his own panel.
    owner_order = [s["client_id"] for s in client.get("/api/live-sessions").json()]
    assert owner_order == ["mine1", "mine2", "s1"]


# ---------------------------------------------------------------- deleting and leaving


def test_a_member_cannot_delete_the_session():
    bob = _share("s1", "bob", "editor")
    assert bob.delete("/api/live-sessions/s1").status_code == 404
    assert client.get("/api/live-sessions/s1").status_code == 200


def test_deleting_removes_it_for_members_too():
    bob = _share("s1", "bob", "editor")
    assert client.delete("/api/live-sessions/s1").status_code == 204
    assert bob.get("/api/live-sessions/s1").status_code == 404


def test_a_member_can_leave_and_the_session_and_its_content_survive():
    bob = _share("s1", "bob", "editor")
    bob_id = client.get("/api/live-sessions/s1/members").json()[0]["user_id"]
    assert bob.delete(f"/api/live-sessions/s1/members/{bob_id}").status_code == 204
    assert bob.get("/api/live-sessions/s1").status_code == 404
    # Untouched for the owner.
    assert client.get("/api/live-sessions/s1").json()["state"] == {"a": 1}


# ---------------------------------------------------------------- participants (read-only, for @mentioning)


def test_a_member_can_list_participants_unlike_the_owner_only_roster():
    bob = _share("s1", "bob", "editor")

    # /members stays owner-only -- a member reaching it 404s, same as before.
    assert bob.get("/api/live-sessions/s1/members").status_code == 404

    # /participants is reachable by the member too, and includes the owner.
    resp = bob.get("/api/live-sessions/s1/participants")
    assert resp.status_code == 200, resp.text
    by_role = {p["username"]: p["role"] for p in resp.json()}
    assert by_role == {"admin": "owner", "bob": "editor"}


def test_the_owner_sees_the_same_participants_list():
    _share("s1", "bob", "viewer")
    resp = client.get("/api/live-sessions/s1/participants")
    assert resp.status_code == 200
    by_role = {p["username"]: p["role"] for p in resp.json()}
    assert by_role == {"admin": "owner", "bob": "viewer"}


def test_someone_not_invited_cant_list_participants_either():
    _put_session("s1")
    _user("eve", "eve-pass")
    eve = _login_as("eve", "eve-pass")
    assert eve.get("/api/live-sessions/s1/participants").status_code == 404
