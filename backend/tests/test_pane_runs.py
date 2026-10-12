"""Long-running pane actions, polled by the server while someone is looking
(PLATFORM_PLAN.md §16.9.1, D51).

A CloudWatch query's run is driven here one `tick` at a time -- outside the
app's lifespan nothing spawns a task, so each step is the test's to take --
and AWS is stubbed at `aws_client`, as the other suites do.
"""

import datetime

import pytest
from fastapi.testclient import TestClient

from app import aws_client, models, presence
from app.db import SessionLocal
from app.main import app
from app.panes import runs
from app.panes import saved as pane_saved
from tests.conftest import client

PANE = "logs-cloudwatch"


def _login_as(username: str) -> TestClient:
    c = TestClient(app)
    assert c.post("/api/auth/login", json={"username": username, "password": "pw-123456"}).status_code == 200
    return c


def _environment() -> int:
    resp = client.post("/api/environments", json={"name": "Prod", "account_id": "111122223333", "region": "eu-west-1"})
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


def _user(name: str, env_id: int) -> tuple[int, TestClient]:
    group = client.post(
        "/api/user-groups",
        json={"name": f"g-{name}", "role_name": "R", "environment_ids": [env_id], "logs_enabled": True},
    ).json()
    made = client.post("/api/users", json={"username": name, "password": "pw-123456", "group_id": group["id"]}).json()
    return made["id"], _login_as(name)


def _session(c: TestClient = client, client_id: str = "logs-1") -> str:
    resp = c.put(
        f"/api/live-sessions/{client_id}",
        json={"title": "Logs", "type": "aggregator", "state": {"services": [PANE], "layout": "tabs"}},
    )
    assert resp.status_code == 200, resp.text
    return client_id


def _admin_id() -> int:
    with SessionLocal() as db:
        return db.query(models.User).filter(models.User.username == "admin").one().id


def _tab(user_id: int) -> str:
    with SessionLocal() as db:
        return presence.open_tab(db, user_id)


def _forget_tab(tab_id: str) -> None:
    with SessionLocal() as db:
        presence.close_tab(db, tab_id)


def _state(client_id: str, c: TestClient = client) -> dict:
    return c.get(f"/api/live-sessions/{client_id}").json()["state"]


def _run_row(run_id: str) -> models.PaneRun:
    with SessionLocal() as db:
        run = db.get(models.PaneRun, run_id)
        db.expunge(run)
        return run


@pytest.fixture
def cloudwatch(monkeypatch) -> dict:
    """Logs Insights stubbed: each query finishes on its third poll."""
    calls: dict = {"start": [], "polls": 0, "stopped": []}

    def start_query(account, region, identity, groups, query, start, end, limit):
        calls["start"].append((account, groups, query, limit))
        return "q-1"

    def get_query_results(account, region, identity, query_id):
        calls["polls"] += 1
        n = calls["polls"]
        return {
            "status": "Complete" if n >= 3 else "Running",
            "results": [[{"field": "@timestamp", "value": f"t{i}"}, {"field": "@message", "value": f"m{i}"}] for i in range(n)],
            "statistics": {},
        }

    monkeypatch.setattr(aws_client, "start_query", start_query)
    monkeypatch.setattr(aws_client, "get_query_results", get_query_results)
    monkeypatch.setattr(aws_client, "stop_query", lambda a, r, i, q: calls["stopped"].append(q))
    return calls


def _run(c: TestClient, client_id: str, env: int, **extra):
    return c.post(
        f"/api/panes/{PANE}/actions/run",
        json={
            "inputs": {"logGroupSelection": {str(env): ["/app"]}, "queryString": "fields @message", "preset": 900, **extra},
            "session": client_id,
            "pane": PANE,
        },
    )


# ---------------------------------------------------------------- presence


def test_a_session_is_watched_while_a_participant_has_it_open_in_a_browser():
    env = _environment()
    sid = _session()
    with SessionLocal() as db:
        row = db.query(models.LiveSession).filter(models.LiveSession.client_id == sid).one()
        assert not presence.watched(db, row)
    tab = _tab(_admin_id())
    with SessionLocal() as db:
        row = db.query(models.LiveSession).filter(models.LiveSession.client_id == sid).one()
        assert presence.watched(db, row)
    # Closed in the owner's workspace, it isn't on their screen any more.
    assert client.post(f"/api/live-sessions/{sid}/close").status_code in (200, 204)
    with SessionLocal() as db:
        row = db.query(models.LiveSession).filter(models.LiveSession.client_id == sid).one()
        assert not presence.watched(db, row)
        # A member with it open, and a browser, watches it for everyone.
        bob, _ = _user("bob", env)
        db.add(models.SessionMember(session_id=row.id, user_id=bob, permission="editor"))
        db.commit()
        assert not presence.watched(db, row)
    bob_tab = _tab(bob)
    with SessionLocal() as db:
        row = db.query(models.LiveSession).filter(models.LiveSession.client_id == sid).one()
        assert presence.watched(db, row)
        # A tab not heard from in a while counts as gone.
        db.query(models.TabPresence).update({"seen_at": datetime.datetime.utcnow() - datetime.timedelta(minutes=5)})
        db.commit()
        assert not presence.watched(db, row)
    _forget_tab(tab)
    _forget_tab(bob_tab)


# ---------------------------------------------------------------- a run


def test_a_run_is_polled_into_the_session_while_watched_and_paused_while_not(cloudwatch):
    env = _environment()
    sid = _session()
    tab = _tab(_admin_id())
    started = _run(client, sid, env)
    assert started.status_code == 200, started.text
    run_id = started.json()["run"]["id"]
    state = _state(sid)
    assert state[f"{PANE}.out.run"]["status"] == "running" and state[f"{PANE}.out.resultsVersion"] == 1
    assert cloudwatch["start"] == [("111122223333", ["/app"], "fields @message", 100)]

    assert runs.tick(run_id).finished is False
    state = _state(sid)
    assert cloudwatch["polls"] == 1 and len(state[f"{PANE}.out.results"][0]["rows"]) == 1

    # Nobody looking: no call to AWS, and the run waits longer between checks.
    _forget_tab(tab)
    step = runs.tick(run_id)
    assert step.finished is False and step.wait == runs.IDLE_SECONDS and cloudwatch["polls"] == 1
    assert _run_row(run_id).unwatched_since is not None

    # Someone opens it again: it carries on, and finishes.
    tab = _tab(_admin_id())
    runs.tick(run_id)
    assert runs.tick(run_id).finished is True
    state = _state(sid)
    assert cloudwatch["polls"] == 3 and state[f"{PANE}.out.run"]["status"] == "done"
    assert state[f"{PANE}.out.results"][0]["status"] == "Complete" and len(state[f"{PANE}.out.results"][0]["rows"]) == 3
    assert _run_row(run_id).status == "done"
    _forget_tab(tab)


def test_a_run_nobody_comes_back_to_is_stopped_in_aws(cloudwatch):
    env = _environment()
    sid = _session()
    run_id = _run(client, sid, env).json()["run"]["id"]
    assert runs.tick(run_id).finished is False  # unwatched, but not for long yet
    with SessionLocal() as db:
        db.get(models.PaneRun, run_id).unwatched_since = datetime.datetime.utcnow() - datetime.timedelta(minutes=11)
        db.commit()
    assert runs.tick(run_id).finished is True
    assert cloudwatch["stopped"] == ["q-1"] and cloudwatch["polls"] == 0
    run = _state(sid)[f"{PANE}.out.run"]
    assert run["status"] == "stopped" and "no one had the session open" in run["note"]


def test_results_arriving_dont_reopen_a_closed_session(cloudwatch):
    env = _environment()
    sid = _session()
    run_id = _run(client, sid, env).json()["run"]["id"]
    assert client.post(f"/api/live-sessions/{sid}/close").status_code in (200, 204)
    bob, as_bob = _user("bob", env)
    with SessionLocal() as db:
        row = db.query(models.LiveSession).filter(models.LiveSession.client_id == sid).one()
        db.add(models.SessionMember(session_id=row.id, user_id=bob, permission="editor"))
        db.commit()
    tab = _tab(bob)  # watched by the member, not the owner who closed it
    runs.tick(run_id)
    assert cloudwatch["polls"] == 1
    with SessionLocal() as db:
        row = db.query(models.LiveSession).filter(models.LiveSession.client_id == sid).one()
        assert row.closed_at is not None
        assert len(row.state[f"{PANE}.out.results"][0]["rows"]) == 1
    _forget_tab(tab)


def test_a_run_whose_replica_went_away_is_claimed_by_another(cloudwatch, monkeypatch):
    env = _environment()
    sid = _session()
    run_id = _run(client, sid, env).json()["run"]["id"]
    assert runs.claim_stale() == []  # its replica is heartbeating
    with SessionLocal() as db:
        run = db.get(models.PaneRun, run_id)
        run.replica = "gone"
        run.heartbeat_at = datetime.datetime.utcnow() - datetime.timedelta(minutes=2)
        db.commit()
    assert runs.tick(run_id).finished is True  # not this replica's: left alone
    assert runs.claim_stale() == [run_id]
    assert _run_row(run_id).replica == runs.REPLICA
    tab = _tab(_admin_id())
    runs.tick(run_id)
    assert cloudwatch["polls"] == 1
    _forget_tab(tab)


# ---------------------------------------------------------------- who may


def test_any_editor_stops_a_run_and_a_viewer_can_do_neither(cloudwatch):
    env = _environment()
    sid = _session()
    run_id = _run(client, sid, env).json()["run"]["id"]
    _, as_eve = _user("eve", env)
    _, as_vic = _user("vic", env)
    assert client.post(f"/api/live-sessions/{sid}/members", json={"username": "eve", "permission": "editor"}).status_code == 201
    assert client.post(f"/api/live-sessions/{sid}/members", json={"username": "vic", "permission": "viewer"}).status_code == 201

    refused = _run(as_vic, sid, env)
    assert refused.status_code == 403 and "read-only" in refused.json()["detail"]
    refused = as_vic.post(f"/api/panes/{PANE}/stop", json={"session": sid, "pane": PANE})
    assert refused.status_code == 403

    stopped = as_eve.post(f"/api/panes/{PANE}/stop", json={"session": sid, "pane": PANE})
    assert stopped.status_code == 200 and stopped.json() == {"stopped": True}
    assert cloudwatch["stopped"] == ["q-1"]
    run = _state(sid)[f"{PANE}.out.run"]
    assert run["status"] == "stopped" and run["stoppedBy"] == "eve"
    assert runs.tick(run_id).finished is True  # the task sees it and ends
    assert as_eve.post(f"/api/panes/{PANE}/stop", json={"session": sid, "pane": PANE}).json() == {"stopped": False}


def test_a_run_needs_a_pane_of_its_kind_and_its_inputs(cloudwatch):
    env = _environment()
    sid = _session()
    resp = client.post(f"/api/panes/{PANE}/actions/run", json={"inputs": {}})
    assert resp.status_code == 400 and "say which" in resp.json()["detail"]
    resp = client.post(f"/api/panes/{PANE}/actions/run", json={"inputs": {}, "session": sid, "pane": "iot"})
    assert resp.status_code == 404
    resp = _run(client, sid, env, logGroupSelection={})
    assert resp.status_code == 400 and resp.json()["detail"] == "Select at least one log group to query."
    resp = _run(client, sid, env, preset="custom", customStart="2024-01-02T10:00", customEnd="2024-01-01T10:00")
    assert resp.status_code == 400 and "after start" in resp.json()["detail"]


def test_a_second_run_replaces_the_first(cloudwatch):
    env = _environment()
    sid = _session()
    first = _run(client, sid, env).json()["run"]["id"]
    second = _run(client, sid, env).json()["run"]["id"]
    assert _run_row(first).status == "stopped" and cloudwatch["stopped"] == ["q-1"]
    assert _run_row(second).status == "running"
    assert _state(sid)[f"{PANE}.out.resultsVersion"] == 2


# ---------------------------------------------------------------- saved queries


def test_saved_queries_move_into_saved_inputs_once():
    with SessionLocal() as db:
        admin = _admin_id()
        db.add(models.SavedQuery(user_id=admin, name="Errors", query_string="filter @message like /ERROR/", backend="cloudwatch"))
        db.add(models.SavedQuery(user_id=admin, name="Lucene", query_string="level:ERROR", backend="opensearch"))
        db.query(models.Setting).filter(models.Setting.key == pane_saved.MARKER_3B3).delete()
        db.commit()
        assert len(pane_saved.migrate_saved_shortcuts(db)) == 2
        assert pane_saved.migrate_saved_shortcuts(db) == []
        assert db.query(models.SavedQuery).count() == 0
    saved = {s["name"]: s for s in client.get("/api/saved-inputs").json()}
    assert saved["Errors"]["pane_type"] == "logs-cloudwatch"
    assert saved["Errors"]["inputs"] == {"queryString": "filter @message like /ERROR/"}
    assert saved["Lucene"]["pane_type"] == "logs-opensearch"
