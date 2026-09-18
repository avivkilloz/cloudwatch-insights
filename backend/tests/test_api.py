from fastapi.testclient import TestClient

from app.main import app
from tests.conftest import client


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


def test_log_groups_reports_error_for_unconfigured_environment():
    resp = client.post("/api/log-groups", json={"environment_ids": [999999]})
    assert resp.status_code == 200
    results = resp.json()["results"]
    assert len(results) == 1
    assert results[0]["error"] is not None


def test_start_query_reports_error_for_unconfigured_environment():
    resp = client.post(
        "/api/queries/start",
        json={
            "targets": [{"environment_id": 999999, "log_group_names": ["/aws/lambda/foo"]}],
            "query_string": "fields @timestamp, @message",
            "start_time": 0,
            "end_time": 3600,
            "limit": 100,
        },
    )
    assert resp.status_code == 200
    queries = resp.json()["queries"]
    assert len(queries) == 1
    assert queries[0]["error"] is not None


def test_start_query_rejects_out_of_range_limit():
    resp = client.post(
        "/api/queries/start",
        json={
            "targets": [{"environment_id": 1, "log_group_names": ["/aws/lambda/foo"]}],
            "query_string": "fields @timestamp",
            "start_time": 0,
            "end_time": 3600,
            "limit": 50000,
        },
    )
    assert resp.status_code == 422


def test_iot_saved_search_crud():
    resp = client.post(
        "/api/iot/saved-searches",
        json={"name": "Disconnected prod devices", "query_string": "connectivity.connected:false"},
    )
    assert resp.status_code == 201
    saved = resp.json()
    assert saved["query_string"] == "connectivity.connected:false"
    assert saved["search_mode"] == "things"  # default when not specified

    resp = client.put(
        f"/api/iot/saved-searches/{saved['id']}",
        json={"query_string": "status:ACTIVE", "search_mode": "certificates"},
    )
    assert resp.status_code == 200
    updated = resp.json()
    assert updated["query_string"] == "status:ACTIVE"
    assert updated["search_mode"] == "certificates"
    assert updated["name"] == "Disconnected prod devices"  # untouched field preserved

    resp = client.get("/api/iot/saved-searches")
    assert resp.status_code == 200
    assert any(s["id"] == saved["id"] for s in resp.json())

    resp = client.delete(f"/api/iot/saved-searches/{saved['id']}")
    assert resp.status_code == 204

    resp = client.delete(f"/api/iot/saved-searches/{saved['id']}")
    assert resp.status_code == 404

    resp = client.put(f"/api/iot/saved-searches/{saved['id']}", json={"name": "x"})
    assert resp.status_code == 404


def test_saved_query_update():
    resp = client.post("/api/saved-queries", json={"name": "Errors", "query_string": "fields @message"})
    assert resp.status_code == 201
    saved = resp.json()
    assert saved["backend"] == "cloudwatch"  # default when not specified

    resp = client.put(f"/api/saved-queries/{saved['id']}", json={"query_string": "fields @message | filter @message like /ERROR/"})
    assert resp.status_code == 200
    updated = resp.json()
    assert updated["query_string"] == "fields @message | filter @message like /ERROR/"
    assert updated["name"] == "Errors"
    assert updated["backend"] == "cloudwatch"  # untouched field preserved

    resp = client.delete(f"/api/saved-queries/{saved['id']}")
    assert resp.status_code == 204


def test_saved_query_backend_field_persists_and_filters():
    resp = client.post(
        "/api/saved-queries",
        json={"name": "OS Errors", "query_string": "level:ERROR", "backend": "opensearch"},
    )
    assert resp.status_code == 201
    saved = resp.json()
    assert saved["backend"] == "opensearch"

    resp = client.get("/api/saved-queries")
    assert resp.status_code == 200
    matching = next(q for q in resp.json() if q["id"] == saved["id"])
    assert matching["backend"] == "opensearch"

    resp = client.put(f"/api/saved-queries/{saved['id']}", json={"backend": "cloudwatch"})
    assert resp.status_code == 200
    assert resp.json()["backend"] == "cloudwatch"
    assert resp.json()["query_string"] == "level:ERROR"  # untouched field preserved

    resp = client.delete(f"/api/saved-queries/{saved['id']}")
    assert resp.status_code == 204


def test_iot_search_reports_error_for_unconfigured_environment():
    resp = client.post(
        "/api/iot/search",
        json={"environment_ids": [999999], "query_string": "connectivity.connected:true"},
    )
    assert resp.status_code == 200
    results = resp.json()["results"]
    assert len(results) == 1
    assert results[0]["error"] is not None
    assert results[0]["things"] == []


def test_iot_thing_detail_rejects_unconfigured_environment():
    resp = client.post(
        "/api/iot/things/detail",
        json={"environment_id": 999999, "thing_name": "my-thing"},
    )
    assert resp.status_code == 400


def test_iot_certificate_search_reports_error_for_unconfigured_environment():
    resp = client.post(
        "/api/iot/certificates/search",
        json={"environment_ids": [999999], "query_string": "status:ACTIVE"},
    )
    assert resp.status_code == 200
    results = resp.json()["results"]
    assert len(results) == 1
    assert results[0]["error"] is not None
    assert results[0]["certificates"] == []


def test_iot_certificate_detail_rejects_unconfigured_environment():
    resp = client.post(
        "/api/iot/certificates/detail",
        json={"environment_id": 999999, "certificate_id": "abc123"},
    )
    assert resp.status_code == 400


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


def test_tables_endpoints_reject_unconfigured_environment():
    resp = client.get("/api/tables/list", params={"environment_id": 999999})
    assert resp.status_code == 400

    resp = client.post("/api/tables/describe", json={"environment_id": 999999, "table_name": "orders"})
    assert resp.status_code == 400

    resp = client.post("/api/tables/scan", json={"environment_id": 999999, "table_name": "orders"})
    assert resp.status_code == 400


def test_buckets_endpoints_reject_unconfigured_environment():
    resp = client.get("/api/buckets/list", params={"environment_id": 999999})
    assert resp.status_code == 400

    resp = client.post("/api/buckets/browse", json={"environment_id": 999999, "bucket": "my-bucket"})
    assert resp.status_code == 400


def test_cognito_endpoints_reject_unconfigured_environment():
    resp = client.get("/api/cognito/user-pools", params={"environment_id": 999999})
    assert resp.status_code == 400

    resp = client.post(
        "/api/cognito/users",
        json={"environment_id": 999999, "user_pool_id": "us-east-1_abc123"},
    )
    assert resp.status_code == 400


def test_opensearch_domains_reports_error_for_unconfigured_environment():
    resp = client.post("/api/opensearch/domains", json={"environment_ids": [999999]})
    assert resp.status_code == 200
    results = resp.json()["results"]
    assert len(results) == 1
    assert results[0]["error"] is not None
    assert results[0]["domains"] == []


def test_opensearch_indices_rejects_unconfigured_environment():
    resp = client.post(
        "/api/opensearch/indices",
        json={"environment_id": 999999, "domain_endpoint": "search-x.us-east-1.es.amazonaws.com"},
    )
    assert resp.status_code == 400


def test_opensearch_search_reports_error_for_unconfigured_environment():
    resp = client.post(
        "/api/opensearch/search",
        json={
            "targets": [
                {
                    "environment_id": 999999,
                    "domain_name": "logs",
                    "domain_endpoint": "search-x.us-east-1.es.amazonaws.com",
                    "indices": ["app-logs"],
                }
            ],
            "query_string": "level:ERROR",
            "start_time": 0,
            "end_time": 3600,
        },
    )
    assert resp.status_code == 200
    results = resp.json()["results"]
    assert len(results) == 1
    assert results[0]["status"] == "Failed"
    assert results[0]["error"] is not None


def test_opensearch_search_rejects_out_of_range_limit():
    resp = client.post(
        "/api/opensearch/search",
        json={
            "targets": [
                {
                    "environment_id": 1,
                    "domain_name": "logs",
                    "domain_endpoint": "search-x.us-east-1.es.amazonaws.com",
                    "indices": ["app-logs"],
                }
            ],
            "query_string": "level:ERROR",
            "start_time": 0,
            "end_time": 3600,
            "limit": 50000,
        },
    )
    assert resp.status_code == 422


def test_ai_status_reports_unconfigured_by_default():
    # The test environment never sets LITELLM_API_KEY/BASE_URL/MODEL.
    resp = client.get("/api/ai/status")
    assert resp.status_code == 200
    assert resp.json() == {"configured": False}


def test_ai_assist_returns_503_when_unconfigured():
    resp = client.post(
        "/api/ai/assist",
        json={"mode": "build_query", "messages": [{"role": "user", "content": "show errors"}]},
    )
    assert resp.status_code == 503


def test_ai_assist_accepts_every_page_domain():
    for domain in ("logs-cloudwatch", "logs-opensearch", "iot-things", "iot-certificates", "tables", "buckets", "cognito"):
        resp = client.post(
            "/api/ai/assist",
            json={"mode": "build_query", "messages": [{"role": "user", "content": "hi"}], "domain": domain},
        )
        # 503 (not configured) rather than 422 -- i.e. the domain validated.
        assert resp.status_code == 503, domain


def test_ai_assist_rejects_an_unknown_domain():
    resp = client.post(
        "/api/ai/assist",
        json={"mode": "build_query", "messages": [{"role": "user", "content": "hi"}], "domain": "nope"},
    )
    assert resp.status_code == 422


def test_tools_http_request_rejects_blocked_address():
    resp = client.post("/api/tools/http-request", json={"method": "GET", "url": "http://169.254.169.254/latest/meta-data/"})
    assert resp.status_code == 400
    assert "169.254.169.254" in resp.json()["detail"]


def test_tools_http_request_rejects_non_http_scheme():
    resp = client.post("/api/tools/http-request", json={"method": "GET", "url": "ftp://example.com/file"})
    assert resp.status_code == 400


def test_tools_mqtt_presigned_url_rejects_unconfigured_environment():
    resp = client.post("/api/tools/mqtt/presigned-url", json={"environment_id": 999999})
    assert resp.status_code == 400


def test_tools_mqtt_presigned_url_includes_preflight_diagnostic(monkeypatch):
    from app import iot_mqtt_signer

    resp = client.post(
        "/api/environments",
        json={"name": "Prod us-east-1", "account_id": "111122223333", "region": "us-east-1"},
    )
    assert resp.status_code == 201
    environment_id = resp.json()["id"]

    monkeypatch.setattr(
        iot_mqtt_signer,
        "build_presigned_ws_url",
        lambda account_id, region, role_name, expires=300: {
            "endpoint": "abc123-ats.iot.us-east-1.amazonaws.com",
            "url": "wss://abc123-ats.iot.us-east-1.amazonaws.com/mqtt?X-Amz-Signature=deadbeef",
        },
    )
    monkeypatch.setattr(
        iot_mqtt_signer,
        "probe_presigned_url",
        lambda url: {
            "status_code": 403,
            "body": '{"message":"Forbidden"}',
            "headers": ["Content-Type: application/json", "X-Amzn-Requestid: abc123"],
        },
    )

    resp = client.post("/api/tools/mqtt/presigned-url", json={"environment_id": environment_id})
    assert resp.status_code == 200
    body = resp.json()
    assert body["endpoint"] == "abc123-ats.iot.us-east-1.amazonaws.com"
    assert body["diagnostic_status_code"] == 403
    assert body["diagnostic_body"] == '{"message":"Forbidden"}'
    assert body["diagnostic_headers"] == ["Content-Type: application/json", "X-Amzn-Requestid: abc123"]

    client.delete(f"/api/environments/{environment_id}")


def test_saved_items_are_isolated_per_user():
    group = client.post("/api/user-groups", json={"name": "Viewers"}).json()
    resp = client.post("/api/users", json={"username": "isolated-user", "password": "x", "group_id": group["id"]})
    assert resp.status_code == 201

    other = _client_without_cookies()
    login = other.post("/api/auth/login", json={"username": "isolated-user", "password": "x"})
    assert login.status_code == 200

    resp = client.post("/api/saved-queries", json={"name": "Admin's query", "query_string": "fields @message"})
    assert resp.status_code == 201
    admin_saved_id = resp.json()["id"]

    resp = other.post("/api/saved-queries", json={"name": "Other user's query", "query_string": "fields @message"})
    assert resp.status_code == 201
    other_saved_id = resp.json()["id"]

    # Neither user's list includes the other's saved query.
    admin_names = {q["name"] for q in client.get("/api/saved-queries").json()}
    other_names = {q["name"] for q in other.get("/api/saved-queries").json()}
    assert "Admin's query" in admin_names and "Other user's query" not in admin_names
    assert "Other user's query" in other_names and "Admin's query" not in other_names

    # Nor can one edit/delete the other's by id.
    resp = other.put(f"/api/saved-queries/{admin_saved_id}", json={"name": "hijacked"})
    assert resp.status_code == 404
    resp = other.delete(f"/api/saved-queries/{admin_saved_id}")
    assert resp.status_code == 404
    resp = client.delete(f"/api/saved-queries/{other_saved_id}")
    assert resp.status_code == 404
