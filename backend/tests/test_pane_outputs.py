"""A pane's outputs in their own records (PLATFORM_PLAN.md D21, §18.2): the
action endpoint stores what it ran for a session's pane -- Load more
appending and summing, an input change's resets cleared in the same write --
announced per pane without moving the session's own version; outputs still
in a session's state move out; a closed pane's go; a viewer's clicks are
theirs alone."""

from app import live_events, models, pane_outputs
from app.db import SessionLocal
from tests.conftest import client
from tests.test_pane_actions import aws  # noqa: F401 -- a fixture
from tests.test_pane_runs import _user
from tests.test_platform_tools import _environment


def _session(client_id: str = "out-1", state: dict | None = None) -> str:
    body = {"title": "T", "type": "aggregator", "state": {"services": ["tables"], "layout": "tabs", **(state or {})}}
    resp = client.put(f"/api/live-sessions/{client_id}", json=body)
    assert resp.status_code == 200, resp.text
    return client_id


def _scan(sid: str, env: int, cursor=None, clear=None, c=client):
    body = {"inputs": {"connection": env, "tableName": "Orders"}, "cursor": cursor, "session": sid, "pane": "tables"}
    if clear:
        body["clear"] = clear
    return c.post("/api/panes/tables/actions/scan", json=body)


def _got(sid: str) -> dict:
    return client.get(f"/api/live-sessions/{sid}").json()


def test_a_run_for_a_pane_is_stored_there_and_announced_without_moving_the_session(aws, monkeypatch):
    env = _environment()
    sid = _session()
    announced = []
    real = live_events.notify
    monkeypatch.setattr(pane_outputs, "notify", lambda db, uid, kind, cid, version, origin, **kw: (announced.append((kind, cid, version, kw.get("pane"), origin)), real(db, uid, kind, cid, version, origin, **kw)))
    version = _got(sid)["version"]
    resp = _scan(sid, env)
    assert resp.status_code == 200, resp.text
    stored = resp.json()["__outputs"]
    assert stored["values"]["items"] == [{"id": "1"}, {"id": "2"}] and stored["values"]["resultsVersion"] == 1
    body = _got(sid)
    assert body["version"] == version and not any(".out." in k for k in body["state"])
    assert body["outputs"]["tables"]["values"]["scannedCount"] == 3
    assert announced == [("outputs", sid, stored["version"], "tables", None)]

    # Load more appends and sums, and keeps the selection's version.
    more = _scan(sid, env, cursor="k1").json()["__outputs"]["values"]
    assert more["items"] == [{"id": "1"}, {"id": "2"}, {"id": "3"}] and more["scannedCount"] == 5
    assert more["resultsVersion"] == 1


def test_an_input_change_clears_its_resets_in_the_same_write(aws):
    env = _environment()
    sid = _session()
    _scan(sid, env)
    resp = client.post(f"/api/live-sessions/{sid}/outputs/tables/clear", json={"keys": ["items", "scannedCount"]})
    assert resp.status_code == 200 and "items" not in resp.json()["values"]
    # Carried on the action that the change triggers, so the two can't cross.
    values = _scan(sid, env, clear=["tableInfo"]).json()["__outputs"]["values"]
    assert "tableInfo" not in values and values["items"]


def test_a_viewers_clicks_are_shown_to_them_and_stored_for_nobody(aws):
    env = _environment()
    sid = _session()
    bob, as_bob = _user("bob", env)
    with SessionLocal() as db:
        row = db.query(models.LiveSession).filter(models.LiveSession.client_id == sid).one()
        db.add(models.SessionMember(session_id=row.id, user_id=bob, permission="viewer"))
        db.commit()
    resp = _scan(sid, env, c=as_bob)
    assert resp.status_code == 200 and resp.json()["items"] and "__outputs" not in resp.json()
    assert _got(sid)["outputs"] == {}
    assert as_bob.post(f"/api/live-sessions/{sid}/outputs/tables/clear", json={"keys": ["items"]}).status_code == 403


def test_outputs_left_in_a_sessions_state_move_out_and_a_record_is_newer():
    sid = _session(state={"tables.out.items": [{"id": "old"}], "tables.in.tableName": "Orders"})
    body = _got(sid)
    assert body["state"]["tables.in.tableName"] == "Orders" and "tables.out.items" not in body["state"]
    assert body["outputs"]["tables"]["values"]["items"] == [{"id": "old"}]
    # A tab from before the store sends its own copy again: the record stands.
    _session(state={"tables.out.items": [{"id": "stale"}]})
    assert _got(sid)["outputs"]["tables"]["values"]["items"] == [{"id": "old"}]


def test_a_closed_pane_takes_its_outputs_with_it(aws):
    env = _environment()
    sid = _session()
    _scan(sid, env)
    client.put(f"/api/live-sessions/{sid}", json={"title": "T", "type": "aggregator", "state": {"services": [], "layout": "tabs"}})
    with SessionLocal() as db:
        assert db.query(models.PaneOutput).count() == 0
    # Reopened under the same id, it starts empty -- and a write for a pane
    # the session doesn't have is refused rather than bringing one back.
    assert _scan(sid, env).status_code == 400
    _session()
    assert _got(sid)["outputs"] == {}


def test_one_panes_outputs_can_be_read_alone(aws):
    env = _environment()
    sid = _session()
    _scan(sid, env)
    read = client.get(f"/api/live-sessions/{sid}/outputs", params={"pane": "tables"}).json()
    assert list(read) == ["tables"] and read["tables"]["version"] == 1
