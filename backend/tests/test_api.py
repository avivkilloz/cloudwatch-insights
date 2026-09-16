from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health():
    resp = client.get("/api/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_environment_and_settings_crud():
    resp = client.put("/api/settings", json={"default_role_name": "TestRole"})
    assert resp.status_code == 200
    assert resp.json()["default_role_name"] == "TestRole"
    # untouched fields keep their defaults/previous values
    assert resp.json()["logs_enabled"] is True
    assert resp.json()["iot_enabled"] is True

    resp = client.put("/api/settings", json={"app_title": "My Org Insights", "iot_enabled": False})
    assert resp.status_code == 200
    updated = resp.json()
    assert updated["app_title"] == "My Org Insights"
    assert updated["iot_enabled"] is False
    assert updated["logs_enabled"] is True  # untouched field preserved
    assert updated["default_role_name"] == "TestRole"  # untouched field preserved

    resp = client.put("/api/settings", json={"iot_enabled": True})
    assert resp.status_code == 200
    assert resp.json()["iot_enabled"] is True

    resp = client.put("/api/settings", json={"app_logo_url": "data:image/png;base64,abc123"})
    assert resp.status_code == 200
    updated = resp.json()
    assert updated["app_logo_url"] == "data:image/png;base64,abc123"
    assert updated["app_title"] == "My Org Insights"  # untouched field preserved

    resp = client.put("/api/settings", json={"app_logo_url": None})
    assert resp.status_code == 200
    assert resp.json()["app_logo_url"] is None

    resp = client.get("/api/settings")
    assert resp.status_code == 200
    defaults = resp.json()
    # new tab toggles default to visible, same as logs/iot
    assert defaults["tables_enabled"] is True
    assert defaults["buckets_enabled"] is True
    assert defaults["cognito_enabled"] is True

    resp = client.put("/api/settings", json={"tables_enabled": False, "buckets_enabled": False})
    assert resp.status_code == 200
    updated = resp.json()
    assert updated["tables_enabled"] is False
    assert updated["buckets_enabled"] is False
    assert updated["cognito_enabled"] is True  # untouched field preserved

    resp = client.put("/api/settings", json={"tables_enabled": True, "buckets_enabled": True})
    assert resp.status_code == 200

    resp = client.post(
        "/api/environments",
        json={"name": "Prod us-east-1", "account_id": "111122223333", "region": "us-east-1"},
    )
    assert resp.status_code == 201
    environment = resp.json()
    assert environment["account_id"] == "111122223333"
    assert environment["region"] == "us-east-1"

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

    resp = client.put(f"/api/saved-queries/{saved['id']}", json={"query_string": "fields @message | filter @message like /ERROR/"})
    assert resp.status_code == 200
    updated = resp.json()
    assert updated["query_string"] == "fields @message | filter @message like /ERROR/"
    assert updated["name"] == "Errors"

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
