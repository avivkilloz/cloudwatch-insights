"""The autosaved side-panel sessions.

Their neighbour, /api/saved-sessions, holds named templates someone chose to
keep. These are the opposite: the working state of sessions that are already
open, written back on every change. The tests below are mostly about what
distinguishes them -- that closing keeps the row and only deleting removes it,
that the closed listing leaves the rows out, and that one user never sees
another's.
"""

from fastapi.testclient import TestClient

from app.main import app
from app.routers.live_sessions import MAX_STATE_BYTES
from tests.conftest import client


def _login_as(username: str, password: str) -> TestClient:
    c = TestClient(app)
    resp = c.post("/api/auth/login", json={"username": username, "password": password})
    assert resp.status_code == 200, resp.text
    return c


def _put(client_id: str, **overrides) -> dict:
    payload = {"type": "logs-cloudwatch", "title": client_id, "position": 0, "state": {}, "truncated": False}
    payload.update(overrides)
    resp = client.put(f"/api/live-sessions/{client_id}", json=payload)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _open_ids() -> list[str]:
    resp = client.get("/api/live-sessions")
    assert resp.status_code == 200, resp.text
    return [s["client_id"] for s in resp.json()]


def _closed_ids() -> list[str]:
    resp = client.get("/api/live-sessions/closed")
    assert resp.status_code == 200, resp.text
    return [s["client_id"] for s in resp.json()]


def test_a_session_round_trips_with_its_whole_state():
    state = {"queryString": "fields @message", "selected": [1, 2], "results": [{"@message": "hello"}]}
    _put("s1", title="CloudWatch 1", state=state)

    (restored,) = client.get("/api/live-sessions").json()
    assert restored["client_id"] == "s1"
    assert restored["title"] == "CloudWatch 1"
    assert restored["type"] == "logs-cloudwatch"
    # Results included, not just inputs -- that is the whole point of these
    # rows as against a saved template.
    assert restored["state"] == state
    assert restored["truncated"] is False
    assert restored["closed_at"] is None


def test_putting_the_same_id_twice_updates_rather_than_duplicates():
    _put("s1", title="First", state={"a": 1})
    _put("s1", title="Second", state={"a": 2})

    sessions = client.get("/api/live-sessions").json()
    assert len(sessions) == 1
    assert sessions[0]["title"] == "Second"
    assert sessions[0]["state"] == {"a": 2}


def test_sessions_come_back_in_panel_order():
    _put("s1", position=0)
    _put("s2", position=1)
    _put("s3", position=2)
    assert _open_ids() == ["s1", "s2", "s3"]

    resp = client.post("/api/live-sessions/reorder", json={"client_ids": ["s3", "s1", "s2"]})
    assert resp.status_code == 200, resp.text
    assert [s["client_id"] for s in resp.json()] == ["s3", "s1", "s2"]
    assert _open_ids() == ["s3", "s1", "s2"]


def test_reordering_ignores_ids_the_caller_does_not_own():
    _put("s1", position=0)
    _put("s2", position=1)
    resp = client.post("/api/live-sessions/reorder", json={"client_ids": ["s2", "gone", "s1"]})
    assert resp.status_code == 200, resp.text
    assert _open_ids() == ["s2", "s1"]


def test_closing_keeps_the_session_and_deleting_removes_it():
    _put("s1")
    _put("s2")

    resp = client.post("/api/live-sessions/s1/close")
    assert resp.status_code == 200, resp.text
    assert resp.json()["closed_at"] is not None
    assert _open_ids() == ["s2"]
    assert _closed_ids() == ["s1"]

    # Its state is still there to reopen from -- fetched one at a time, since
    # the listing deliberately leaves it out.
    assert client.get("/api/live-sessions/closed").json()[0]["type"] == "logs-cloudwatch"

    assert client.delete("/api/live-sessions/s1").status_code == 204
    assert _closed_ids() == []
    assert client.delete("/api/live-sessions/s1").status_code == 404


def test_writing_to_a_closed_session_reopens_it():
    _put("s1", state={"a": 1})
    client.post("/api/live-sessions/s1/close")
    assert _open_ids() == []

    _put("s1", state={"a": 2})
    assert _open_ids() == ["s1"]
    assert _closed_ids() == []


def test_nothing_is_deleted_by_closing_more_sessions():
    """Closing is how a session is put away, not how it is got rid of, so the
    list of closed ones is never trimmed behind the owner's back."""
    for n in range(40):
        _put(f"s{n}")
        assert client.post(f"/api/live-sessions/s{n}/close").status_code == 200

    closed = _closed_ids()
    assert len(closed) == 40
    # Most recently closed first, and the very first one is still there.
    assert closed[0] == "s39"
    assert "s0" in closed


def test_the_closed_listing_leaves_the_rows_out():
    big = {"queryString": "fields @message", "results": [{"@message": "x"} for _ in range(50)]}
    _put("s1", title="Heavy", state=big)
    client.post("/api/live-sessions/s1/close")

    (summary,) = client.get("/api/live-sessions/closed").json()
    assert summary["title"] == "Heavy"
    assert summary["closed_at"] is not None
    # Enough to list and reopen it, and nothing that grows with the results.
    assert "state" not in summary

    # The state comes back in full when the session is actually reopened.
    full = client.get("/api/live-sessions/s1")
    assert full.status_code == 200, full.text
    assert full.json()["state"] == big


def test_one_session_cannot_be_read_by_another_user():
    group = client.post("/api/user-groups", json={"name": "Viewers"})
    client.post("/api/users", json={"username": "eve", "password": "eve-pass", "group_id": group.json()["id"]})
    eve = _login_as("eve", "eve-pass")

    _put("s1", state={"secret": "the admin's rows"})
    assert eve.get("/api/live-sessions/s1").status_code == 404


def test_state_over_the_ceiling_is_refused_with_its_size():
    resp = client.put(
        "/api/live-sessions/s1",
        json={"type": "logs-cloudwatch", "title": "Huge", "state": {"rows": "x" * (MAX_STATE_BYTES + 1)}},
    )
    assert resp.status_code == 413
    assert str(MAX_STATE_BYTES) in resp.json()["detail"]
    # Nothing was written, so the browser can retry without its results.
    assert _open_ids() == []


def test_the_truncated_flag_survives_the_round_trip():
    _put("s1", state={"queryString": "fields @message"}, truncated=True)
    assert client.get("/api/live-sessions").json()[0]["truncated"] is True


def test_sessions_are_private_to_their_user():
    group = client.post("/api/user-groups", json={"name": "Viewers"})
    assert group.status_code == 201, group.text
    client.post("/api/users", json={"username": "bob", "password": "bob-pass", "group_id": group.json()["id"]})
    bob = _login_as("bob", "bob-pass")

    _put("s1", title="Admin's session")
    bob.put("/api/live-sessions/s1", json={"type": "iot", "title": "Bob's session", "state": {}})

    assert [s["title"] for s in client.get("/api/live-sessions").json()] == ["Admin's session"]
    assert [s["title"] for s in bob.get("/api/live-sessions").json()] == ["Bob's session"]

    # Same client id, but Bob deleting his leaves the admin's alone.
    assert bob.delete("/api/live-sessions/s1").status_code == 204
    assert _open_ids() == ["s1"]


def test_live_sessions_need_a_login():
    anonymous = TestClient(app)
    assert anonymous.get("/api/live-sessions").status_code == 401
    assert anonymous.put("/api/live-sessions/s1", json={"type": "iot", "title": "x", "state": {}}).status_code == 401
    assert anonymous.delete("/api/live-sessions/s1").status_code == 401
