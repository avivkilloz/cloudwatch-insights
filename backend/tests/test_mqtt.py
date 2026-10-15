"""MQTT on the server (PLATFORM_PLAN.md §16.13, D54): a connection is a
background run whose poll drains what it received into the pane, appended,
newest first, capped; topics changed while connected reconnect as whoever
changed them; it closes when stopped -- from any replica -- or two minutes
after the last viewer leaves; one person may hold five; publishing is a
person's action. The network is faked at `mqtt_client.connect`.
"""

import datetime

import pytest

from app import iot_client, models, mqtt_client
from app.db import SessionLocal
from app.panes import manifest as pane_manifest
from app.panes import runs
from app.panes import saved as pane_saved
from tests.conftest import client
from tests.test_pane_runs import _admin_id, _environment, _state, _tab
from tests.test_platform_tools import _row, _token, call, call_error, mcp  # noqa: F401 - mcp is a fixture

PANE = "tool-mqtt"


class FakeConn:
    def __init__(self, deliver, client_id: str) -> None:
        self.deliver = deliver
        self.client_id = client_id
        self.topics: list[str] = []
        self.open = True

    def subscribe(self, topic: str) -> None:
        self.topics.append(topic)

    def unsubscribe(self, topic: str) -> None:
        self.topics.remove(topic)

    def alive(self) -> bool:
        return self.open

    def error(self):
        return None

    def close(self) -> None:
        self.open = False


@pytest.fixture
def broker(monkeypatch) -> list[FakeConn]:
    conns: list[FakeConn] = []

    def connect(account, region, identity, client_id, deliver):
        conn = FakeConn(deliver, client_id)
        conns.append(conn)
        return conn, "fake-ats.iot.us-east-1.amazonaws.com"

    monkeypatch.setattr(mqtt_client, "connect", connect)
    yield conns
    mqtt_client.close_all()


def _session(client_id: str = "mqtt-1") -> str:
    resp = client.put(
        f"/api/live-sessions/{client_id}",
        json={"title": "MQTT", "type": "aggregator", "state": {"services": [PANE], "layout": "tabs"}},
    )
    assert resp.status_code == 200, resp.text
    return client_id


def _connect(sid: str, env: int, topics: list[str], restart: bool = False):
    return client.post(
        f"/api/panes/{PANE}/actions/connect",
        json={"inputs": {"connection": env, "topics": topics}, "session": sid, "pane": PANE, "restart": restart},
    )


def _run_id(sid: str) -> str:
    return _state(sid)[f"{PANE}.out.run"]["id"]


def _say(conn: FakeConn, topic: str, text: str) -> None:
    conn.deliver(topic, text.encode())


def test_a_connection_streams_what_it_receives_into_the_pane_newest_first(broker):
    env = _environment()
    sid = _session()
    _tab(_admin_id())
    resp = _connect(sid, env, ["devices/#"])
    assert resp.status_code == 200, resp.text
    assert broker[0].topics == ["devices/#"]
    state = _state(sid)
    assert state[f"{PANE}.out.run"]["status"] == "running"
    assert "Connected to fake-ats.iot.us-east-1.amazonaws.com" in state[f"{PANE}.out.status"]
    assert "devices/#" in state[f"{PANE}.out.status"]

    _say(broker[0], "devices/a", "one")
    _say(broker[0], "devices/b", "two")
    runs.tick(_run_id(sid))
    assert [m["payload"] for m in _state(sid)[f"{PANE}.out.messages"]] == ["two", "one"]
    # A quiet second writes nothing: the session's version doesn't move.
    version = client.get(f"/api/live-sessions/{sid}").json()["version"]
    runs.tick(_run_id(sid))
    assert client.get(f"/api/live-sessions/{sid}").json()["version"] == version
    # New messages go in front, and the pane keeps 200.
    for i in range(250):
        _say(broker[0], "devices/c", f"m{i}")
    runs.tick(_run_id(sid))
    messages = _state(sid)[f"{PANE}.out.messages"]
    assert len(messages) == 200 and messages[0]["payload"] == "m249"


def test_a_big_payload_is_cut_down():
    sub = mqtt_client.Subscription(key="k" * 32, client_id="c")
    sub.deliver("t", b"x" * (mqtt_client.MAX_PAYLOAD + 10))
    [message] = sub.drain()
    assert message["payload"].startswith("x" * 100) and "cut at 8 KB" in message["payload"]


def test_changing_topics_while_connected_reconnects_and_keeps_the_messages(broker):
    env = _environment()
    sid = _session()
    _tab(_admin_id())
    assert _connect(sid, env, ["a/#"]).status_code == 200
    _say(broker[0], "a/1", "kept")
    first = _run_id(sid)
    runs.tick(first)
    assert _connect(sid, env, ["a/#", "b/#"], restart=True).status_code == 200
    assert not broker[0].open and broker[1].topics == ["a/#", "b/#"]
    assert _run_id(sid) != first
    _say(broker[1], "b/1", "new")
    runs.tick(_run_id(sid))
    assert [m["payload"] for m in _state(sid)[f"{PANE}.out.messages"]] == ["new", "kept"]
    # A fresh Connect (not a restart) starts the stream over.
    assert _connect(sid, env, ["a/#"]).status_code == 200
    assert _state(sid).get(f"{PANE}.out.messages") is None


def test_disconnect_closes_it_even_when_another_replica_took_the_request(broker):
    env = _environment()
    sid = _session()
    _tab(_admin_id())
    assert _connect(sid, env, ["a"]).status_code == 200
    resp = client.post(f"/api/panes/{PANE}/stop", json={"session": sid, "pane": PANE})
    assert resp.json() == {"stopped": True} and not broker[0].open
    # "Connected to ..." goes; the run's note says who disconnected it.
    state = _state(sid)
    assert state.get(f"{PANE}.out.status") is None and state[f"{PANE}.out.run"]["stoppedBy"] == "admin"

    assert _connect(sid, env, ["a"]).status_code == 200
    run_id = _run_id(sid)
    # Another replica marked it stopped; this one, holding the connection,
    # closes it on its next tick.
    with SessionLocal() as db:
        db.get(models.PaneRun, run_id).status = runs.STOPPED
        db.commit()
    assert runs.tick(run_id).finished and not broker[1].open


def test_nobody_looking_for_two_minutes_disconnects_it(broker):
    env = _environment()
    sid = _session()
    tab = _tab(_admin_id())
    assert _connect(sid, env, ["a"]).status_code == 200
    from app import presence

    with SessionLocal() as db:
        presence.close_tab(db, tab)
        run = db.get(models.PaneRun, _run_id(sid))
        run.unwatched_since = datetime.datetime.utcnow() - datetime.timedelta(seconds=90)
        db.commit()
    assert not runs.tick(_run_id(sid)).finished and broker[0].open
    with SessionLocal() as db:
        run = db.get(models.PaneRun, _run_id(sid))
        run.unwatched_since = datetime.datetime.utcnow() - datetime.timedelta(seconds=130)
        db.commit()
    assert runs.tick(_run_id(sid)).finished and not broker[0].open
    assert "no one had the session open" in _state(sid)[f"{PANE}.out.run"]["note"]


def test_one_person_holds_at_most_five_connections(broker):
    env = _environment()
    _tab(_admin_id())
    for i in range(5):
        assert _connect(_session(f"m{i}"), env, ["a"]).status_code == 200
    resp = _connect(_session("m5"), env, ["a"])
    assert resp.status_code == 400 and "stop one first" in resp.json()["detail"]
    # Reconnecting a pane already connected isn't a sixth.
    assert _connect("m0", env, ["b"]).status_code == 200


def test_publish_goes_through_the_data_plane_as_the_person(monkeypatch):
    env = _environment()
    sent = []
    monkeypatch.setattr(iot_client, "publish", lambda a, r, i, topic, payload, qos=0: sent.append((topic, payload)))
    resp = client.post(
        f"/api/panes/{PANE}/actions/publish",
        json={"inputs": {"connection": env, "publishTopic": "devices/x/cmd", "payload": '{"go": 1}'}},
    )
    assert resp.status_code == 200, resp.text
    assert sent == [("devices/x/cmd", '{"go": 1}')] and "Published 9 bytes to devices/x/cmd" in resp.json()["published"]
    resp = client.post(
        f"/api/panes/{PANE}/actions/publish", json={"inputs": {"connection": env, "publishTopic": "devices/#"}}
    )
    assert resp.status_code == 400 and "wildcards" in resp.json()["detail"]
    assert pane_manifest.get(PANE).actions[1].effects == "external"


def test_the_agent_connects_reads_and_reconnects_as_itself_but_cannot_publish(mcp, broker, monkeypatch):
    poll = pane_manifest.get(PANE).main_action().poll
    monkeypatch.setattr(poll, "agent_wait", 2.0)
    token = _token()
    env = _environment()
    session = call(mcp, token, "create_session", title="s", panes=[{"kind": PANE}])["session_id"]
    call(mcp, token, "set_pane_inputs", session_id=session, pane_id=PANE, inputs={"connection": env, "topics": "a/#"})
    import threading

    threading.Timer(0.5, lambda: _say(broker[0], "a/1", "hello")).start()
    out = call(mcp, token, "run_pane", session_id=session, pane_id=PANE)
    assert out["status"] == "running" and "keeps running" in out["note"]
    assert out["messages"] == 1 and out["sample"][0]["payload"] == "hello"

    changed = call(mcp, token, "set_pane_inputs", session_id=session, pane_id=PANE, inputs={"topics": ["a/#", "b/#"]})
    assert "restarted" in changed["note"]
    assert not broker[0].open and broker[-1].topics == ["a/#", "b/#"]
    assert _row(session).state[f"{PANE}.out.messages"][0]["payload"] == "hello"

    kinds = {k["kind"]: k for k in call(mcp, token, "get_context")["pane_kinds"]}
    assert "stop_pane" in kinds[PANE]
    assert call(mcp, token, "stop_pane", session_id=session, pane_id=PANE)["stopped"] is True
    assert not broker[-1].open


def test_saved_topics_move_into_saved_inputs_once():
    with SessionLocal() as db:
        admin = _admin_id()
        db.add(models.SavedSession(user_id=admin, page="tools-mqtt-topics", name="Telemetry", state={"topic": "devices/+/t"}))
        db.add(models.SavedSession(user_id=admin, page="tools-mqtt-topics", name="Empty", state={"topic": ""}))
        db.query(models.Setting).filter(models.Setting.key == pane_saved.MARKER_3B5).delete()
        db.commit()
        assert pane_saved.migrate_saved_shortcuts(db) == ["MQTT topic 'Telemetry' (user %d) -> saved inputs" % admin]
        assert pane_saved.migrate_saved_shortcuts(db) == []
    saved = client.get(f"/api/saved-inputs?pane_type={PANE}").json()
    assert [(s["name"], s["inputs"]) for s in saved] == [("Telemetry", {"topics": ["devices/+/t"], "publishTopic": "devices/+/t"})]
    with SessionLocal() as db:
        assert db.query(models.SavedSession).filter(models.SavedSession.page == "tools-mqtt-topics").count() == 0


def test_topic_filters_match_as_mqtt_does():
    assert mqtt_client.matches("a/+/c", "a/b/c") and not mqtt_client.matches("a/+/c", "a/b/x/c")
    assert mqtt_client.matches("a/#", "a/b/c") and mqtt_client.matches("#", "x")
    assert not mqtt_client.matches("a/b", "a/b/c")


def test_a_refused_connect_says_what_answered_the_handshake_never_the_signed_url(monkeypatch):
    from app import iot_mqtt_signer

    url = "wss://abc-ats.iot.us-east-1.amazonaws.com/mqtt?X-Amz-Security-Token=SECRETTOKEN"
    monkeypatch.setattr(iot_mqtt_signer, "build_presigned_ws_url", lambda *a, **k: {"endpoint": "abc", "url": url})

    def refused(*_a, **_k):
        raise mqtt_client.MqttError("Couldn't reach abc: WebSocket handshake error, connection not upgraded")

    monkeypatch.setattr(mqtt_client, "_PahoConn", refused)
    probes = iter(
        [
            {"status_code": 403, "body": f"Forbidden for {url}", "headers": ["X-Amzn-RequestId: 1"]},
            {"status_code": 403, "body": "Blocked", "headers": ["Server: corp-proxy"]},
        ]
    )
    monkeypatch.setattr(iot_mqtt_signer, "probe_presigned_url", lambda _url: next(probes))
    with pytest.raises(mqtt_client.MqttError) as aws:
        mqtt_client.connect("1", "us-east-1", None, "c", lambda *_: None)
    assert "HTTP 403: Forbidden for the endpoint" in str(aws.value) and "SECRETTOKEN" not in str(aws.value)
    with pytest.raises(mqtt_client.MqttError) as proxy:
        mqtt_client.connect("1", "us-east-1", None, "c", lambda *_: None)
    assert "isn't AWS" in str(proxy.value)
