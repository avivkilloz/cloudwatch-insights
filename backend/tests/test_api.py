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
