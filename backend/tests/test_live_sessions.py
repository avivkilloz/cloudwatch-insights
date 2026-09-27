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


# ---- versions: two-way sync without last-write-wins data loss ----


def test_every_write_bumps_the_version():
    assert _put("v1")["version"] == 1
    assert _put("v1", title="again")["version"] == 2
    closed = client.post("/api/live-sessions/v1/close")
    assert closed.json()["version"] == 3


def test_a_write_from_a_stale_version_is_refused_not_applied():
    _put("stale", state={"a": 1})  # version 1
    _put("stale", state={"a": 2}, base_version=1)  # version 2, made from 1: fine
    resp = client.put(
        "/api/live-sessions/stale",
        json={"type": "logs-cloudwatch", "title": "stale", "state": {"a": "lost?"}, "base_version": 1},
    )
    assert resp.status_code == 409, resp.text
    assert "version 2" in resp.json()["detail"]
    # ...and nothing of it was written.
    row = client.get("/api/live-sessions/stale").json()
    assert row["state"] == {"a": 2} and row["version"] == 2


def test_a_write_without_a_base_version_still_overwrites():
    # What a browser from before versions existed sends.
    _put("legacy", state={"a": 1})
    _put("legacy", state={"a": 2})
    assert client.get("/api/live-sessions/legacy").json()["state"] == {"a": 2}


def test_a_new_session_ignores_any_base_version():
    # Nothing to be stale against yet -- a tab creating a session another tab
    # deleted meanwhile brings it back rather than erroring.
    assert _put("fresh", base_version=7)["version"] == 1


# ---- announcements ----


def _listen():
    import psycopg2

    from app.db import engine
    from app.live_events import CHANNEL

    conn = psycopg2.connect(engine.url.render_as_string(hide_password=False).replace("+psycopg2", ""))
    conn.set_isolation_level(psycopg2.extensions.ISOLATION_LEVEL_AUTOCOMMIT)
    conn.cursor().execute(f"LISTEN {CHANNEL};")
    return conn


def _drain(conn, wait: float = 2.0) -> list[dict]:
    import json
    import select
    import time

    events: list[dict] = []
    deadline = time.time() + wait
    while time.time() < deadline:
        if select.select([conn], [], [], 0.1) != ([], [], []):
            conn.poll()
            while conn.notifies:
                events.append(json.loads(conn.notifies.pop(0).payload))
        elif events:
            break
    return events


def test_writes_are_announced_with_who_made_them_but_no_state():
    conn = _listen()
    try:
        resp = client.put(
            "/api/live-sessions/told",
            json={"type": "logs-cloudwatch", "title": "told", "state": {"secret": "rows"}},
            headers={"X-Sync-Origin": "tab-1"},
        )
        assert resp.status_code == 200
        client.post("/api/live-sessions/told/close", headers={"X-Sync-Origin": "tab-1"})
        client.delete("/api/live-sessions/told", headers={"X-Sync-Origin": "agent"})
        events = _drain(conn)
    finally:
        conn.close()
    kinds = [(e["kind"], e["client_id"], e["version"], e["origin"]) for e in events]
    assert kinds == [("upsert", "told", 1, "tab-1"), ("close", "told", 2, "tab-1"), ("delete", "told", None, "agent")]
    assert all("state" not in e and "secret" not in str(e) for e in events)
    assert all(isinstance(e["user_id"], int) for e in events)


def test_a_refused_write_is_not_announced():
    _put("quiet")
    conn = _listen()
    try:
        resp = client.put(
            "/api/live-sessions/quiet",
            json={"type": "logs-cloudwatch", "title": "quiet", "state": {}, "base_version": 0},
        )
        assert resp.status_code == 409
        events = _drain(conn, wait=0.8)
    finally:
        conn.close()
    assert events == []


def test_the_listener_only_hands_events_to_their_own_user():
    import asyncio

    from app.live_events import _Listener

    async def scenario():
        listener = _Listener()
        # Subscribe without starting the LISTEN thread: this is about fan-out.
        listener._thread = type("Alive", (), {"is_alive": lambda self: True})()
        mine = listener.subscribe(1)
        theirs = listener.subscribe(2)
        listener._dispatch({"user_id": 1, "kind": "upsert", "client_id": "x", "version": 3, "origin": None})
        await asyncio.sleep(0)
        assert mine.queue.qsize() == 1 and theirs.queue.qsize() == 0
        listener.unsubscribe(mine)
        listener._dispatch({"user_id": 1, "kind": "delete", "client_id": "x", "version": None, "origin": None})
        await asyncio.sleep(0)
        assert mine.queue.qsize() == 1

    asyncio.run(scenario())


def test_the_event_stream_needs_a_login():
    anonymous = TestClient(app)
    assert anonymous.get("/api/live-sessions/events").status_code == 401


def test_two_writes_from_the_same_version_never_both_land():
    """Concurrent, not sequential: two browsers (or a browser and the agent)
    pushing from the same version a few milliseconds apart. Exactly one may
    win; the other must be told to merge. Without a row lock on the version
    check both passed it and the later write silently replaced the earlier."""
    import threading

    from tests.conftest import ADMIN_PASSWORD, ADMIN_USERNAME

    writers = [_login_as(ADMIN_USERNAME, ADMIN_PASSWORD) for _ in range(2)]
    for attempt in range(15):
        client_id = f"race-{attempt}"
        base = _put(client_id, state={"n": 0})["version"]
        statuses: list[int] = []
        barrier = threading.Barrier(2)

        def write(c: TestClient, value: int) -> None:
            barrier.wait()
            resp = c.put(
                f"/api/live-sessions/{client_id}",
                json={"type": "logs-cloudwatch", "title": client_id, "state": {"n": value}, "base_version": base},
            )
            statuses.append(resp.status_code)

        threads = [threading.Thread(target=write, args=(c, i + 1)) for i, c in enumerate(writers)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert sorted(statuses) == [200, 409], (attempt, statuses)
        assert client.get(f"/api/live-sessions/{client_id}").json()["version"] == base + 1


def test_a_save_does_not_move_a_session_only_a_reorder_does():
    """A tab still showing the old order must not undo a reorder made in
    another one just by saving -- position is set on creation, then belongs
    to /reorder."""
    _put("p1", position=0)
    _put("p2", position=1)
    client.post("/api/live-sessions/reorder", json={"client_ids": ["p2", "p1"]})
    _put("p1", position=0, title="saved from a stale tab")
    assert _open_ids() == ["p2", "p1"]


def test_a_reorder_is_announced_with_the_new_order():
    _put("o1")
    _put("o2")
    conn = _listen()
    try:
        client.post("/api/live-sessions/reorder", json={"client_ids": ["o2", "o1"]}, headers={"X-Sync-Origin": "tab-9"})
        events = _drain(conn)
    finally:
        conn.close()
    assert [(e["kind"], e.get("order"), e["origin"]) for e in events] == [("reorder", ["o2", "o1"], "tab-9")]
