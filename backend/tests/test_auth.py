from fastapi.testclient import TestClient

from app.main import app
from tests.conftest import ADMIN_PASSWORD, ADMIN_USERNAME, client


def _fresh_client() -> TestClient:
    return TestClient(app)


def test_me_reflects_logged_in_admin():
    resp = client.get("/api/auth/me")
    assert resp.status_code == 200
    body = resp.json()
    assert body["username"] == ADMIN_USERNAME
    assert body["is_admin"] is True
    assert body["group_name"] == "Admin"


def test_unauthenticated_request_is_rejected():
    resp = _fresh_client().get("/api/auth/me")
    assert resp.status_code == 401


def test_login_with_wrong_password_is_rejected():
    resp = _fresh_client().post("/api/auth/login", json={"username": ADMIN_USERNAME, "password": "not-the-password"})
    assert resp.status_code == 401


def test_login_with_unknown_username_is_rejected():
    resp = _fresh_client().post("/api/auth/login", json={"username": "nobody", "password": "whatever"})
    assert resp.status_code == 401


def test_login_success_then_logout_invalidates_session():
    c = _fresh_client()
    resp = c.post("/api/auth/login", json={"username": ADMIN_USERNAME, "password": ADMIN_PASSWORD})
    assert resp.status_code == 200

    resp = c.get("/api/auth/me")
    assert resp.status_code == 200

    resp = c.post("/api/auth/logout")
    assert resp.status_code == 204

    resp = c.get("/api/auth/me")
    assert resp.status_code == 401


def test_logout_without_a_session_is_a_harmless_no_op():
    resp = _fresh_client().post("/api/auth/logout")
    assert resp.status_code == 204


def test_change_own_password_requires_correct_current_password():
    resp = client.put(
        "/api/auth/password", json={"current_password": "wrong", "new_password": "irrelevant-new-pass"}
    )
    assert resp.status_code == 400


def test_change_own_password_then_login_with_new_password():
    c = _fresh_client()
    login = c.post("/api/auth/login", json={"username": ADMIN_USERNAME, "password": ADMIN_PASSWORD})
    assert login.status_code == 200

    resp = c.put("/api/auth/password", json={"current_password": ADMIN_PASSWORD, "new_password": "a-new-password-123"})
    assert resp.status_code == 200

    resp = _fresh_client().post("/api/auth/login", json={"username": ADMIN_USERNAME, "password": ADMIN_PASSWORD})
    assert resp.status_code == 401  # old password no longer works

    resp = _fresh_client().post(
        "/api/auth/login", json={"username": ADMIN_USERNAME, "password": "a-new-password-123"}
    )
    assert resp.status_code == 200
