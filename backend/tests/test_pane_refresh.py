"""Auto-refresh (PLATFORM_PLAN.md R4, D22, §18.3): a tab asks when a pane is
due; the server runs it once with the session's own inputs, however many
tabs ask, never faster than the pane type's floor; a failure is kept on the
pane for every viewer, and a viewer can't refresh."""

import datetime
import time

from app import models, pane_outputs
from app.db import SessionLocal
from app.panes import refresh as pane_refresh
from tests.conftest import client
from tests.test_pane_actions import aws  # noqa: F401 -- a fixture
from tests.test_pane_runs import PANE as LOGS, _run, _tab, _admin_id, _user, cloudwatch  # noqa: F401 -- fixtures
from tests.test_platform_tools import _environment, _token, call, call_error, mcp  # noqa: F401 -- a fixture


def _tables(env: int, sid: str = "r-1", table: str | None = "Orders") -> str:
    state = {"services": ["tables"], "layout": "tabs", "tables.in.connection": env}
    if table:
        state["tables.in.tableName"] = table
    resp = client.put(f"/api/live-sessions/{sid}", json={"title": "T", "type": "aggregator", "state": state})
    assert resp.status_code == 200, resp.text
    return sid


def _refresh(sid: str, pane: str = "tables", every: int = 30, c=client, type_: str = "tables"):
    return c.post(f"/api/panes/{type_}/refresh", json={"session": sid, "pane": pane, "every": every})


def _values(sid: str, pane: str = "tables") -> dict:
    return client.get(f"/api/live-sessions/{sid}").json()["outputs"].get(pane, {}).get("values", {})


def test_a_due_pane_runs_once_with_the_sessions_own_inputs_however_many_ask(aws):
    env = _environment()
    sid = _tables(env)
    first = _refresh(sid).json()
    assert first["refreshed"] is True and first["version"] == 1
    assert aws["scan"][0]["table"] == "Orders"
    assert _values(sid)["items"] == [{"id": "1"}, {"id": "2"}] and _values(sid)["resultsVersion"] == 1
    # A second tab asking a moment later finds it fresh.
    assert _refresh(sid).json() == {"refreshed": False, "reason": "fresh", "version": 1}
    assert len(aws["scan"]) == 1


def test_one_under_way_is_waited_for_not_repeated(aws):
    env = _environment()
    sid = _tables(env)
    with SessionLocal() as db:
        row = db.query(models.LiveSession).filter(models.LiveSession.client_id == sid).one()
        db.add(models.PaneOutput(session_id=row.id, pane_id="tables", data={}, version=0, refreshing_at=datetime.datetime.utcnow()))
        db.commit()
    assert _refresh(sid).json()["reason"] == "refreshing" and aws["scan"] == []
    # One left behind by a replica that died is taken over.
    with SessionLocal() as db:
        record = db.query(models.PaneOutput).one()
        record.refreshing_at = datetime.datetime.utcnow() - datetime.timedelta(seconds=pane_refresh.STALE_REFRESH_SECONDS + 5)
        db.commit()
    assert _refresh(sid).json()["refreshed"] is True


def test_never_faster_than_the_floor(aws, monkeypatch):
    env = _environment()
    sid = _tables(env)
    assert _refresh(sid, every=1).json()["refreshed"] is True
    time.sleep(1.2)
    # Asked every second, it's still held to 10.
    assert _refresh(sid, every=1).json()["reason"] == "fresh"
    monkeypatch.setenv("REFRESH_FLOOR_SECONDS", "120")
    types = {t["id"]: t for t in client.get("/api/pane-types").json()}
    assert types["tables"]["refresh"] == {"floor": 120} and types["logs-cloudwatch"]["refresh"] == {"floor": 60}
    assert "refresh" not in types["tool-mqtt"] and "refresh" not in types["tool-http"]


def test_a_failure_is_kept_on_the_pane_counted_and_cleared_by_a_success(aws):
    env = _environment()
    sid = _tables(env, table=None)
    failed = _refresh(sid).json()
    assert failed["refreshed"] is False and failed["reason"] == "failed" and "table" in failed["error"]
    assert _values(sid)["refresh"]["failures"] == 1
    assert _refresh(sid).json()["reason"] == "failed"
    assert _values(sid)["refresh"]["failures"] == 2 and "table" in _values(sid)["refresh"]["error"]
    _tables(env, table="Orders")
    assert _refresh(sid).json()["refreshed"] is True and "refresh" not in _values(sid)


def test_a_background_pane_starts_a_run_and_waits_for_one_going(cloudwatch):
    env = _environment()
    sid = "r-logs"
    state = {"services": [LOGS], "layout": "tabs", f"{LOGS}.in.logGroupSelection": {str(env): ["/app"]}, f"{LOGS}.in.queryString": "fields @message"}
    client.put(f"/api/live-sessions/{sid}", json={"title": "L", "type": "aggregator", "state": state})
    _tab(_admin_id())
    assert _refresh(sid, pane=LOGS, every=60, type_=LOGS).json()["refreshed"] is True
    assert cloudwatch["start"] and _values(sid, LOGS)["run"]["status"] == "running"
    with SessionLocal() as db:  # not fresh yet: it hasn't finished, so ranAt is a minute old
        record = db.query(models.PaneOutput).one()
        record.data = {**record.data, "ranAt": record.data["ranAt"] - 120_000}
        db.commit()
    assert _refresh(sid, pane=LOGS, every=60, type_=LOGS).json()["reason"] == "running"


def test_a_viewer_cant_and_a_pane_that_doesnt_refresh_says_so(aws):
    env = _environment()
    sid = _tables(env)
    bob, as_bob = _user("bob", env)
    with SessionLocal() as db:
        row = db.query(models.LiveSession).filter(models.LiveSession.client_id == sid).one()
        db.add(models.SessionMember(session_id=row.id, user_id=bob, permission="viewer"))
        db.commit()
    group = client.get("/api/user-groups").json()
    gid = next(g["id"] for g in group if g["name"] == "g-bob")
    client.put(f"/api/user-groups/{gid}", json={"tables_enabled": True})
    assert _refresh(sid, c=as_bob).status_code == 403
    client.put("/api/live-sessions/r-2", json={"title": "M", "type": "aggregator", "state": {"services": ["tool-mqtt"], "layout": "tabs"}})
    resp = _refresh("r-2", pane="tool-mqtt", type_="tool-mqtt")
    assert resp.status_code == 400 and "don't refresh" in resp.json()["detail"]


def test_the_agent_sets_a_panes_refresh_or_the_sessions_within_the_floor(mcp):
    token = _token()
    session = call(mcp, token, "create_session", title="s", panes=[{"kind": "tables"}, {"kind": "logs-cloudwatch"}, {"kind": "tool-mqtt"}])["session_id"]
    kinds = {k["kind"]: k for k in call(mcp, token, "get_context")["pane_kinds"]}
    assert kinds["logs-cloudwatch"]["refresh_floor"] == 60 and "refresh_floor" not in kinds["tool-mqtt"]
    out = call(mcp, token, "set_refresh", session_id=session, every="5m", pane_id="tables")
    assert next(p for p in out["panes"] if p["pane_id"] == "tables")["refresh_every"] == 300
    assert "at most every 60" in call_error(mcp, token, "set_refresh", session_id=session, every="30s", pane_id="logs-cloudwatch")
    assert "don't refresh" in call_error(mcp, token, "set_refresh", session_id=session, every="1m", pane_id="tool-mqtt")
    assert call(mcp, token, "set_refresh", session_id=session, every="1m")["refresh_every"] == 60
    assert call(mcp, token, "set_refresh", session_id=session, every="off", pane_id="tables")["panes"][0]["refresh_every"] == "off"
