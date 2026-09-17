from fastapi.testclient import TestClient

from app.main import app
from tests.conftest import client


def _login_as(username: str, password: str) -> TestClient:
    c = TestClient(app)
    resp = c.post("/api/auth/login", json={"username": username, "password": password})
    assert resp.status_code == 200, resp.text
    return c


def test_create_group_with_role_tabs_and_environment_access():
    resp = client.post(
        "/api/environments", json={"name": "Prod", "account_id": "111122223333", "region": "us-east-1"}
    )
    env_id = resp.json()["id"]

    resp = client.post(
        "/api/user-groups",
        json={
            "name": "Ops",
            "role_name": "OpsReadOnlyRole",
            "iot_enabled": False,
            "tools_enabled": False,
            "environment_ids": [env_id],
        },
    )
    assert resp.status_code == 201
    group = resp.json()
    assert group["role_name"] == "OpsReadOnlyRole"
    assert group["is_admin"] is False
    assert group["iot_enabled"] is False
    assert group["tools_enabled"] is False
    assert group["logs_enabled"] is True  # default, untouched
    assert group["environment_ids"] == [env_id]
    assert group["user_count"] == 0


def test_update_group_replaces_environment_access_list():
    env_a = client.post("/api/environments", json={"name": "A", "account_id": "1", "region": "us-east-1"}).json()
    env_b = client.post("/api/environments", json={"name": "B", "account_id": "2", "region": "us-east-1"}).json()

    group = client.post("/api/user-groups", json={"name": "Ops", "environment_ids": [env_a["id"]]}).json()
    assert group["environment_ids"] == [env_a["id"]]

    resp = client.put(f"/api/user-groups/{group['id']}", json={"environment_ids": [env_b["id"]]})
    assert resp.status_code == 200
    assert resp.json()["environment_ids"] == [env_b["id"]]

    resp = client.put(f"/api/user-groups/{group['id']}", json={"role_name": "NewRole"})
    assert resp.status_code == 200
    updated = resp.json()
    assert updated["role_name"] == "NewRole"
    assert updated["environment_ids"] == [env_b["id"]]  # untouched when omitted from the payload


def test_non_admin_group_only_sees_its_granted_environments():
    env_a = client.post("/api/environments", json={"name": "A", "account_id": "1", "region": "us-east-1"}).json()
    client.post("/api/environments", json={"name": "B", "account_id": "2", "region": "us-east-1"})

    group = client.post("/api/user-groups", json={"name": "Ops", "environment_ids": [env_a["id"]]}).json()
    client.post("/api/users", json={"username": "dave", "password": "dave-pass", "group_id": group["id"]})
    dave = _login_as("dave", "dave-pass")

    resp = dave.get("/api/environments")
    assert resp.status_code == 200
    ids = [e["id"] for e in resp.json()]
    assert ids == [env_a["id"]]


def test_admin_group_sees_every_environment_regardless_of_access_list():
    client.post("/api/environments", json={"name": "A", "account_id": "1", "region": "us-east-1"})
    client.post("/api/environments", json={"name": "B", "account_id": "2", "region": "us-east-1"})

    resp = client.get("/api/environments")
    assert resp.status_code == 200
    assert len(resp.json()) == 2


def test_group_role_name_is_used_to_resolve_aws_calls():
    env = client.post(
        "/api/environments", json={"name": "Prod", "account_id": "111122223333", "region": "us-east-1"}
    ).json()
    group = client.post(
        "/api/user-groups",
        json={"name": "Ops", "role_name": "OpsRole", "environment_ids": [env["id"]]},
    ).json()
    client.post("/api/users", json={"username": "erin", "password": "erin-pass", "group_id": group["id"]})
    erin = _login_as("erin", "erin-pass")

    # The role resolves fine (no ResolveError -> 400) -- it fails later, for
    # an unrelated reason (no real AWS credentials in this test), proving
    # role resolution itself succeeded using the group's role_name.
    resp = erin.get("/api/tables/list", params={"environment_id": env["id"]})
    assert resp.status_code != 400


def test_group_with_no_role_name_rejects_aws_calls():
    env = client.post(
        "/api/environments", json={"name": "Prod", "account_id": "111122223333", "region": "us-east-1"}
    ).json()
    group = client.post("/api/user-groups", json={"name": "Ops", "environment_ids": [env["id"]]}).json()
    client.post("/api/users", json={"username": "frank", "password": "frank-pass", "group_id": group["id"]})
    frank = _login_as("frank", "frank-pass")

    resp = frank.get("/api/tables/list", params={"environment_id": env["id"]})
    assert resp.status_code == 400
    assert "role name" in resp.json()["detail"].lower()


def test_cannot_delete_admin_group():
    resp = client.get("/api/user-groups")
    admin_group = next(g for g in resp.json() if g["is_admin"])
    resp = client.delete(f"/api/user-groups/{admin_group['id']}")
    assert resp.status_code == 400


def test_cannot_delete_group_with_users():
    group = client.post("/api/user-groups", json={"name": "Ops"}).json()
    client.post("/api/users", json={"username": "gina", "password": "x", "group_id": group["id"]})

    resp = client.delete(f"/api/user-groups/{group['id']}")
    assert resp.status_code == 400


def test_delete_empty_non_admin_group():
    group = client.post("/api/user-groups", json={"name": "Temp"}).json()
    resp = client.delete(f"/api/user-groups/{group['id']}")
    assert resp.status_code == 204


def test_duplicate_group_name_rejected():
    client.post("/api/user-groups", json={"name": "Ops"})
    resp = client.post("/api/user-groups", json={"name": "Ops"})
    assert resp.status_code == 400
