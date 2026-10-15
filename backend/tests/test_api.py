from fastapi.testclient import TestClient

from app.main import app
from tests.conftest import send_http, TEST_ROLE_NAME, client


def _client_without_cookies() -> TestClient:
    """A fresh, unauthenticated client -- for asserting a route is reachable
    (or rejected) with no session at all, independent of the shared,
    logged-in `client`."""
    return TestClient(app)


def test_health():
    resp = client.get("/api/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_environment_and_settings_crud():
    resp = client.put("/api/settings", json={"app_title": "My Org Insights"})
    assert resp.status_code == 200
    assert resp.json()["app_title"] == "My Org Insights"

    resp = client.put("/api/settings", json={"app_logo_url": "data:image/png;base64,abc123"})
    assert resp.status_code == 200
    updated = resp.json()
    assert updated["app_logo_url"] == "data:image/png;base64,abc123"
    assert updated["app_title"] == "My Org Insights"  # untouched field preserved

    resp = client.put("/api/settings", json={"app_logo_url": None})
    assert resp.status_code == 200
    assert resp.json()["app_logo_url"] is None

    # /api/settings is deliberately public -- reachable with no session cookie.
    resp = _client_without_cookies().get("/api/settings")
    assert resp.status_code == 200

    resp = client.post(
        "/api/environments",
        json={"name": "Prod us-east-1", "account_id": "111122223333", "region": "us-east-1"},
    )
    assert resp.status_code == 201
    environment = resp.json()
    assert environment["account_id"] == "111122223333"
    assert environment["region"] == "us-east-1"

    # Admins see every environment regardless of the Admin group's own
    # environment-access list (which is never consulted for that group).
    resp = client.get("/api/environments")
    assert resp.status_code == 200
    assert any(e["id"] == environment["id"] for e in resp.json())

    resp = client.delete(f"/api/environments/{environment['id']}")
    assert resp.status_code == 204


def test_iot_search_reports_error_for_unconfigured_environment():
    resp = _action("iot", "search", {"connections": [999999], "queryString": "thingName:*"})
    assert resp.status_code == 200
    results = resp.json()["thingResults"]
    assert len(results) == 1
    assert results[0]["error"] is not None
    assert results[0]["things"] == []


def test_iot_thing_detail_rejects_unconfigured_environment():
    assert _action("iot", "thing_detail", {"connection": 999999, "thingName": "t"}).status_code == 400


def test_iot_certificate_search_reports_error_for_unconfigured_environment():
    resp = _action("iot", "search", {"connections": [999999], "searchMode": "certificates", "queryString": "status:ACTIVE"})
    assert resp.status_code == 200
    results = resp.json()["certResults"]
    assert len(results) == 1
    assert results[0]["error"] is not None
    assert results[0]["certificates"] == []


def test_iot_certificate_detail_rejects_unconfigured_environment():
    assert _action("iot", "cert_detail", {"connection": 999999, "certificateId": "c"}).status_code == 400


def test_saved_session_crud():
    state = {
        "environment_ids": [1, 2],
        "log_group_selection": {"1": ["/aws/lambda/foo"]},
        "query_string": "fields @message",
        "limit": 500,
        "sort_field": "@timestamp",
        "sort_direction": "desc",
    }
    resp = client.post(
        "/api/saved-sessions",
        json={"page": "logs", "name": "Investigate outage", "state": state},
    )
    assert resp.status_code == 201
    saved = resp.json()
    assert saved["page"] == "logs"
    assert saved["state"] == state

    resp = client.get("/api/saved-sessions", params={"page": "logs"})
    assert resp.status_code == 200
    assert any(s["id"] == saved["id"] for s in resp.json())

    resp = client.get("/api/saved-sessions", params={"page": "iot"})
    assert resp.status_code == 200
    assert not any(s["id"] == saved["id"] for s in resp.json())

    new_state = {**state, "query_string": "fields @message | filter @message like /ERROR/"}
    resp = client.put(
        f"/api/saved-sessions/{saved['id']}",
        json={"state": new_state},
    )
    assert resp.status_code == 200
    updated = resp.json()
    assert updated["state"]["query_string"] == "fields @message | filter @message like /ERROR/"
    assert updated["name"] == "Investigate outage"  # untouched field preserved

    resp = client.delete(f"/api/saved-sessions/{saved['id']}")
    assert resp.status_code == 204

    resp = client.delete(f"/api/saved-sessions/{saved['id']}")
    assert resp.status_code == 404

    resp = client.put(f"/api/saved-sessions/{saved['id']}", json={"name": "x"})
    assert resp.status_code == 404


def _action(pane: str, action: str, inputs: dict):
    return client.post(f"/api/panes/{pane}/actions/{action}", json={"inputs": inputs})


def test_tables_actions_reject_unconfigured_environment():
    assert _action("tables", "list_tables", {"connection": 999999}).status_code == 400
    assert _action("tables", "describe", {"connection": 999999, "tableName": "orders"}).status_code == 400
    assert _action("tables", "scan", {"connection": 999999, "tableName": "orders"}).status_code == 400


def test_buckets_actions_reject_unconfigured_environment():
    assert _action("buckets", "list_buckets", {"connection": 999999}).status_code == 400
    assert _action("buckets", "browse", {"connection": 999999, "bucket": "my-bucket"}).status_code == 400


def test_cognito_actions_reject_unconfigured_environment():
    assert _action("cognito", "list_user_pools", {"connection": 999999}).status_code == 400
    resp = _action("cognito", "search", {"connection": 999999, "userPoolId": "us-east-1_abc123"})
    assert resp.status_code == 400
    assert "not configured" in resp.json()["detail"]


def test_tools_http_request_rejects_blocked_address():
    resp = send_http(client, {"method": "GET", "url": "http://169.254.169.254/latest/meta-data/"})
    assert resp.status_code == 400
    assert "169.254.169.254" in resp.json()["detail"]


def test_tools_http_request_rejects_non_http_scheme():
    resp = send_http(client, {"method": "GET", "url": "ftp://example.com/file"})
    assert resp.status_code == 400


def test_saved_items_are_isolated_per_user():
    group = client.post("/api/user-groups", json={"name": "Viewers"}).json()
    resp = client.post("/api/users", json={"username": "isolated-user", "password": "x", "group_id": group["id"]})
    assert resp.status_code == 201

    other = _client_without_cookies()
    login = other.post("/api/auth/login", json={"username": "isolated-user", "password": "x"})
    assert login.status_code == 200

    # Saved queries are saved inputs now (D46), the same per-user store.
    query = {"pane_type": "logs-cloudwatch", "inputs": {"queryString": "fields @message"}}
    resp = client.post("/api/saved-inputs", json={**query, "name": "Admin's query"})
    assert resp.status_code == 201
    admin_saved_id = resp.json()["id"]

    resp = other.post("/api/saved-inputs", json={**query, "name": "Other user's query"})
    assert resp.status_code == 201
    other_saved_id = resp.json()["id"]

    # Neither user's list includes the other's saved query.
    admin_names = {q["name"] for q in client.get("/api/saved-inputs").json()}
    other_names = {q["name"] for q in other.get("/api/saved-inputs").json()}
    assert "Admin's query" in admin_names and "Other user's query" not in admin_names
    assert "Other user's query" in other_names and "Admin's query" not in other_names

    # Nor can one edit/delete the other's by id.
    resp = other.put(f"/api/saved-inputs/{admin_saved_id}", json={"name": "hijacked"})
    assert resp.status_code == 404
    resp = other.delete(f"/api/saved-inputs/{admin_saved_id}")
    assert resp.status_code == 404
    resp = client.delete(f"/api/saved-inputs/{other_saved_id}")
    assert resp.status_code == 404
