from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health():
    resp = client.get("/api/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_account_and_settings_crud():
    resp = client.put("/api/settings", json={"default_role_name": "TestRole"})
    assert resp.status_code == 200
    assert resp.json()["default_role_name"] == "TestRole"

    resp = client.post(
        "/api/accounts",
        json={"account_id": "111122223333", "name": "Test", "regions": ["us-east-1"]},
    )
    assert resp.status_code == 201
    account = resp.json()
    assert account["account_id"] == "111122223333"

    resp = client.get("/api/accounts")
    assert resp.status_code == 200
    assert any(a["id"] == account["id"] for a in resp.json())

    resp = client.delete(f"/api/accounts/{account['id']}")
    assert resp.status_code == 204


def test_log_groups_reports_error_for_unconfigured_account():
    resp = client.post("/api/log-groups", json={"targets": [{"account_id": "999999999999", "region": "us-east-1"}]})
    assert resp.status_code == 200
    results = resp.json()["results"]
    assert len(results) == 1
    assert results[0]["error"] is not None
