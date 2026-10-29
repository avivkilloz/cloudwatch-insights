"""Connection types beyond AWS, and a pane built from a manifest alone (D67,
PLATFORM_PLAN.md §19.3): admins define HTTP connection types, a manifest can
ship the one it needs, and a declarative request reads a nested reply --
Prometheus with no code of its own."""

import json
from urllib.parse import parse_qs, urlparse

import pytest

from app import tools_http_client
from app.platform_tools import panes
from tests.conftest import client
from tests.test_connections import _login_as


def _types() -> dict[str, dict]:
    return {t["id"]: t for t in client.get("/api/connection-types").json()}


def _prometheus_env(group_id: int, base_url: str = "https://prom.example.com/") -> dict:
    env = client.post("/api/environments", json={"name": "Metrics"}).json()
    conn = client.post(f"/api/environments/{env['id']}/connections", json={
        "type_id": "prometheus", "name": "prom", "config": {"base_url": base_url}})
    assert conn.status_code in (200, 201), conn.text
    client.put(f"/api/environments/{env['id']}/groups", json={"group_ids": [group_id]})
    return conn.json()


def _member(name: str) -> tuple[int, object]:
    g = client.post("/api/user-groups", json={"name": f"{name}-g"}).json()
    assert client.post("/api/users", json={"username": name, "password": "pw-123456", "group_id": g["id"]}).status_code == 201
    return g["id"], _login_as(name, "pw-123456")


# ---------------------------------------------------------------- types


def test_a_manifest_ships_its_connection_type():
    prom = _types()["prometheus"]
    assert prom["origin"] == "manifest:prometheus" and not prom["builtin"]
    assert prom["fields"][0]["key"] == "base_url"
    assert prom["needed_by"] == ["Prometheus"]


def test_an_admin_defines_one_and_edits_it():
    resp = client.post("/api/connection-types", json={
        "id": "grafana", "label": "Grafana", "fields": [{"key": "org_id", "label": "Org ID"}]})
    assert resp.status_code == 201, resp.text
    assert [f["key"] for f in resp.json()["fields"]] == ["base_url", "org_id"]
    resp = client.put("/api/connection-types/grafana", json={"label": "Grafana Cloud", "fields": []})
    assert resp.json()["label"] == "Grafana Cloud" and [f["key"] for f in resp.json()["fields"]] == ["base_url"]


@pytest.mark.parametrize("body", [
    {"id": "Bad Id", "label": "x"},
    {"id": "aws", "label": "Again"},
    {"id": "ok_one", "label": ""},
    {"id": "ok_two", "label": "x", "fields": [{"key": "a"}, {"key": "a"}]},
])
def test_what_a_type_can_be_is_checked(body):
    assert client.post("/api/connection-types", json=body).status_code == 400


def test_built_ins_are_locked():
    assert client.put("/api/connection-types/aws", json={"label": "Amazon"}).status_code == 400
    assert client.delete("/api/connection-types/http_api").status_code == 400


def test_a_connection_of_a_defined_type_has_its_base_url_checked():
    client.post("/api/connection-types", json={"id": "grafana", "label": "Grafana"})
    env = client.post("/api/environments", json={"name": "G"}).json()
    bad = client.post(f"/api/environments/{env['id']}/connections", json={
        "type_id": "grafana", "name": "g", "config": {"base_url": "not a url"}})
    assert bad.status_code == 400


def test_a_type_in_use_or_needed_stays():
    group_id, _ = _member("pat")
    conn = _prometheus_env(group_id)
    # Needed by the Prometheus pane, and a connection is of it.
    resp = client.delete("/api/connection-types/prometheus")
    assert resp.status_code == 400
    client.post("/api/connection-types", json={"id": "grafana", "label": "Grafana", "fields": [{"key": "org_id"}]})
    env = client.post("/api/environments", json={"name": "G"}).json()
    g = client.post(f"/api/environments/{env['id']}/connections", json={
        "type_id": "grafana", "name": "g", "config": {"base_url": "https://g.example.com", "org_id": "7"}}).json()
    # A field a connection holds a value for can't go...
    resp = client.put("/api/connection-types/grafana", json={"label": "Grafana", "fields": []})
    assert resp.status_code == 400 and "org_id" in resp.json()["detail"]
    # ...nor the type while a connection is of it.
    assert client.delete("/api/connection-types/grafana").status_code == 400
    client.delete(f"/api/connections/{g['id']}")
    assert client.delete("/api/connection-types/grafana").status_code == 204
    assert conn["type_id"] == "prometheus"


# ---------------------------------------------------------------- reading nested replies


MATRIX = {
    "status": "success",
    "data": {
        "resultType": "matrix",
        "result": [
            {"metric": {"__name__": "up", "job": "api", "instance": "a:9090"}, "values": [[1700000000, "1"], [1700000060, "0"]]},
            {"metric": {"__name__": "up", "job": "db", "instance": "b:9090"}, "values": [[1700000000, "1"]]},
        ],
    },
}


def test_extract_rows_explodes_spreads_and_names_series():
    spec = {
        "at": "data.result", "explode": "values", "spread": "metric",
        "labels": {"column": "series", "from": "metric"},
        "columns": {"time": {"from": "0", "as": "time"}, "value": {"from": "1", "as": "number"}},
    }
    rows = panes.extract_rows(MATRIX, spec)
    assert len(rows) == 3
    assert rows[0] == {
        "__name__": "up", "job": "api", "instance": "a:9090", "series": 'up{instance="a:9090", job="api"}',
        "time": "2023-11-14T22:13:20.000Z", "value": 1,
    }
    assert rows[1]["value"] == 0 and rows[2]["job"] == "db"
    # The element's columns first, then the series and its labels.
    assert list(rows[0])[:3] == ["time", "value", "series"]
    with pytest.raises(panes.InputError):
        panes.extract_rows({"data": {"result": {}}}, {"at": "data.result"})


# ---------------------------------------------------------------- Prometheus, from its manifest alone


@pytest.fixture
def prom(monkeypatch):
    sent: list[str] = []

    def fake_send(method, url, headers=None, body=None, timeout=30):
        sent.append(url)
        return {"status_code": 200, "status_text": "OK", "headers": [], "elapsed_ms": 1, "body_truncated": False,
                "body": json.dumps(MATRIX)}

    monkeypatch.setattr(tools_http_client, "send_request", fake_send)
    return sent


def test_prometheus_queries_its_range_over_the_window(prom):
    group_id, member = _member("pat")
    conn = _prometheus_env(group_id)
    resp = member.post("/api/panes/prometheus/actions/run", json={
        "inputs": {"connection": conn["id"], "query": "up", "preset": "3600"}, "timezone": "Europe/London"})
    assert resp.status_code == 200, resp.text
    url = urlparse(prom[0])
    assert url.netloc == "prom.example.com" and url.path == "/api/v1/query_range"
    q = {k: v[0] for k, v in parse_qs(url.query).items()}
    assert q["query"] == "up" and int(q["end"]) - int(q["start"]) == 3600 and q["step"] == "15"
    rows = resp.json()["rows"]
    assert len(rows) == 3 and rows[0]["series"].startswith("up{") and rows[0]["value"] == 1


def test_a_custom_range_is_read_in_the_browsers_zone(prom):
    group_id, member = _member("pat")
    conn = _prometheus_env(group_id)
    member.post("/api/panes/prometheus/actions/run", json={
        "inputs": {"connection": conn["id"], "query": "up", "preset": "custom",
                   "customStart": "2024-01-01T10:00", "customEnd": "2024-01-01T11:00"},
        "timezone": "Asia/Jerusalem"})
    q = {k: v[0] for k, v in parse_qs(urlparse(prom[0]).query).items()}
    assert q["start"] == "1704096000"  # 10:00 in Jerusalem is 08:00 UTC


def test_prometheus_is_everyones_on_their_own_connection(prom):
    # No grant (D160): a member of any group runs it on a connection of theirs.
    group_id, member = _member("pat")
    conn = _prometheus_env(group_id)
    resp = member.post("/api/panes/prometheus/actions/run", json={"inputs": {"connection": conn["id"], "query": "up"}})
    assert resp.status_code == 200, resp.text
    assert len(prom) == 1
