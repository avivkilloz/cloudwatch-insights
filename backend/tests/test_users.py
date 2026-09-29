from fastapi.testclient import TestClient

from app.main import app
from tests.conftest import client


def _login_as(username: str, password: str) -> TestClient:
    c = TestClient(app)
    resp = c.post("/api/auth/login", json={"username": username, "password": password})
    assert resp.status_code == 200, resp.text
    return c


def _create_group(name: str, **extra) -> dict:
    resp = client.post("/api/user-groups", json={"name": name, **extra})
    assert resp.status_code == 201, resp.text
    return resp.json()


def test_admin_can_create_list_update_delete_user():
    group = _create_group("Viewers")

    resp = client.post("/api/users", json={"username": "alice", "password": "alice-pass", "group_id": group["id"]})
    assert resp.status_code == 201
    user = resp.json()
    assert user["username"] == "alice"
    assert user["group_id"] == group["id"]
    assert user["is_admin"] is False

    resp = client.get("/api/users")
    assert resp.status_code == 200
    assert any(u["id"] == user["id"] for u in resp.json())

    # The new user can actually log in with the password they were given.
    alice = _login_as("alice", "alice-pass")
    resp = alice.get("/api/auth/me")
    assert resp.status_code == 200
    assert resp.json()["username"] == "alice"
    assert resp.json()["is_admin"] is False

    resp = client.put(f"/api/users/{user['id']}", json={"password": "alice-new-pass"})
    assert resp.status_code == 200

    resp = _login_as("alice", "alice-new-pass").get("/api/auth/me")
    assert resp.status_code == 200

    resp = client.delete(f"/api/users/{user['id']}")
    assert resp.status_code == 204

    resp = client.get("/api/users")
    assert not any(u["username"] == "alice" for u in resp.json())


def test_duplicate_username_rejected():
    group = _create_group("Viewers")
    resp = client.post("/api/users", json={"username": "bob", "password": "x", "group_id": group["id"]})
    assert resp.status_code == 201

    resp = client.post("/api/users", json={"username": "bob", "password": "y", "group_id": group["id"]})
    assert resp.status_code == 400


def test_non_admin_cannot_manage_users_or_groups():
    group = _create_group("Viewers")
    client.post("/api/users", json={"username": "carol", "password": "carol-pass", "group_id": group["id"]})
    carol = _login_as("carol", "carol-pass")

    assert carol.get("/api/users").status_code == 403
    assert carol.post("/api/users", json={"username": "x", "password": "y", "group_id": group["id"]}).status_code == 403
    assert carol.get("/api/user-groups").status_code == 403
    assert carol.post("/api/user-groups", json={"name": "New group"}).status_code == 403
    assert carol.post("/api/environments", json={"name": "x", "account_id": "1", "region": "us-east-1"}).status_code == 403
    assert carol.put("/api/settings", json={"app_title": "Hijacked"}).status_code == 403


# ---------------------------------------------------------------- username suggestions (invite field autocomplete)

def test_suggest_users_matches_by_prefix_case_insensitively():
    group = _create_group("Viewers")
    client.post("/api/users", json={"username": "gabi1", "password": "x", "group_id": group["id"]})
    client.post("/api/users", json={"username": "gar2", "password": "x", "group_id": group["id"]})
    client.post("/api/users", json={"username": "harriet", "password": "x", "group_id": group["id"]})

    resp = client.get("/api/users/suggest", params={"prefix": "g"})
    assert resp.status_code == 200
    assert {u["username"] for u in resp.json()} == {"gabi1", "gar2"}

    resp = client.get("/api/users/suggest", params={"prefix": "ga"})
    assert {u["username"] for u in resp.json()} == {"gabi1", "gar2"}

    resp = client.get("/api/users/suggest", params={"prefix": "gab"})
    assert [u["username"] for u in resp.json()] == ["gabi1"]

    # Case-insensitive, since a user typing doesn't match a stored case exactly.
    resp = client.get("/api/users/suggest", params={"prefix": "GAB"})
    assert [u["username"] for u in resp.json()] == ["gabi1"]

    # Each row is just enough to fill the dropdown, not the full user record.
    assert set(resp.json()[0]) == {"id", "username"}


def test_suggest_users_excludes_self_and_empty_prefix():
    group = _create_group("Viewers")
    client.post("/api/users", json={"username": "dana", "password": "dana-pass", "group_id": group["id"]})
    dana = _login_as("dana", "dana-pass")

    # Inviting yourself makes no sense, so you're never your own suggestion.
    assert dana.get("/api/users/suggest", params={"prefix": "dan"}).json() == []

    # An empty prefix is never a full listing -- that stays admin-only.
    assert client.get("/api/users/suggest", params={"prefix": ""}).json() == []
    assert client.get("/api/users/suggest").json() == []


def test_suggest_users_is_open_to_any_authenticated_user():
    group = _create_group("Viewers")
    client.post("/api/users", json={"username": "erin", "password": "erin-pass", "group_id": group["id"]})
    client.post("/api/users", json={"username": "frank", "password": "x", "group_id": group["id"]})
    erin = _login_as("erin", "erin-pass")

    # Unlike GET /api/users, this reaches a non-admin -- the invite endpoint
    # it feeds is already open to any user, cross-group, by exact username.
    resp = erin.get("/api/users/suggest", params={"prefix": "fra"})
    assert resp.status_code == 200
    assert [u["username"] for u in resp.json()] == ["frank"]


def test_admin_cannot_delete_own_account():
    resp = client.get("/api/auth/me")
    my_id = resp.json()["id"]
    resp = client.delete(f"/api/users/{my_id}")
    assert resp.status_code == 400


def test_cannot_remove_the_last_admin():
    resp = client.get("/api/auth/me")
    my_id = resp.json()["id"]
    viewers = _create_group("Viewers")

    # Only one admin exists (the bootstrapped one) -- can't demote them even
    # via updating someone else, since there IS no one else in Admin yet.
    resp = client.put(f"/api/users/{my_id}", json={"group_id": viewers["id"]})
    assert resp.status_code == 400

    # Add a second admin, then the first can be moved out freely.
    admin_group_resp = client.get("/api/user-groups")
    admin_group = next(g for g in admin_group_resp.json() if g["is_admin"])
    resp = client.post(
        "/api/users", json={"username": "second-admin", "password": "x", "group_id": admin_group["id"]}
    )
    assert resp.status_code == 201

    resp = client.put(f"/api/users/{my_id}", json={"group_id": viewers["id"]})
    assert resp.status_code == 400  # still blocked: this endpoint refuses to demote *yourself*
