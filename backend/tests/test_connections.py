"""Connections, environments and group identities (PLATFORM_PLAN.md §14).

A connection says where (an AWS account and region, a base URL); a group's
identity says who (D31). These tests pin the migration from the old model
(environment = one account, group = one role name), the order identities
resolve in, several connections in one environment (D32), the HTTP API
connection type (D33), and that none of it widens anyone's access."""

import base64

import pytest
from fastapi.testclient import TestClient

from app import audit, connections, credential_store, crypto, dynamodb_client, masking, models, tools_http_client
from app.db import SessionLocal
from app.main import app
from app.platform_tools import panes
from tests.conftest import TEST_ROLE_NAME, client

K1 = base64.b64encode(b"1" * 32).decode()


@pytest.fixture
def master_key(monkeypatch):
    monkeypatch.setenv(crypto.KEYS_ENV, f"k1:{K1}")
    monkeypatch.setenv(crypto.CURRENT_ENV, "k1")
    masking.reset()


@pytest.fixture(autouse=True)
def _fresh_coalescing():
    credential_store._last_recorded.clear()


@pytest.fixture
def seen(monkeypatch) -> list[tuple]:
    """Every (account, region, identity) DynamoDB was asked to list tables as."""
    calls: list[tuple] = []

    def fake_list_tables(account_id, region, identity):
        calls.append((account_id, region, identity))
        return ["t"]

    monkeypatch.setattr(dynamodb_client, "list_tables", fake_list_tables)
    return calls


def _login_as(username: str, password: str) -> TestClient:
    c = TestClient(app)
    resp = c.post("/api/auth/login", json={"username": username, "password": password})
    assert resp.status_code == 200, resp.text
    return c


def _group(name: str, environment_ids: list[int], role_name: str | None = "R") -> tuple[int, TestClient]:
    body = {"name": name, "environment_ids": environment_ids, "tools_enabled": True}
    if role_name:
        body["role_name"] = role_name
    group = client.post("/api/user-groups", json=body)
    assert group.status_code == 201, group.text
    group_id = group.json()["id"]
    assert client.post("/api/users", json={"username": f"u-{name}", "password": "pw-123456", "group_id": group_id}).status_code == 201
    return group_id, _login_as(f"u-{name}", "pw-123456")


def _env(name: str = "Prod", account: str = "111122223333", region: str = "eu-west-1") -> dict:
    resp = client.post("/api/environments", json={"name": name, "account_id": account, "region": region})
    assert resp.status_code == 201, resp.text
    return resp.json()


def _add(env_id: int, name: str, account: str = "444455556666", region: str = "us-east-1") -> dict:
    resp = client.post(
        f"/api/environments/{env_id}/connections",
        json={"type_id": "aws", "name": name, "config": {"account_id": account, "region": region}},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _role(group_id: int, name: str, role: str) -> int:
    """An AWS role credential of the group's own (no master key needed, D35)."""
    db = SessionLocal()
    try:
        group = db.get(models.UserGroup, group_id)
        cred = connections._role_credential(db, None, group, role)
        cred.name = name
        db.commit()
        return cred.id
    finally:
        db.close()


# ------------------------------------------------------------------- migration


def test_the_migration_keeps_every_id_and_every_role():
    db = SessionLocal()
    try:
        # The old model, written the way it was before connections existed.
        db.query(models.Setting).filter(models.Setting.key == connections.MIGRATED_MARKER).delete()
        old = models.Environment(name="Legacy", account_id="999988887777", region="ap-south-1")
        group = models.UserGroup(name="Old", role_name="LegacyRole")
        db.add_all([old, group])
        db.commit()
        env_id, group_id = old.id, group.id

        done = connections.migrate_legacy(db)
        assert any("Legacy" in line for line in done) and any("LegacyRole" in line for line in done)
        conn = db.get(models.Connection, env_id)
        assert conn is not None and conn.environment_id == env_id and conn.name == "aws"
        assert conn.config == {"account_id": "999988887777", "region": "ap-south-1"}
        group = db.get(models.UserGroup, group_id)
        assert connections.group_role_name(db, group) == "LegacyRole"
        ident = connections.group_identity(db, group, conn)
        assert ident.credential.scope == "group" and ident.credential.group_id == group_id

        # Once only: a second run changes nothing, even with the connection gone.
        db.delete(conn)
        db.commit()
        assert connections.migrate_legacy(db) == []
        assert db.get(models.Connection, env_id) is None
    finally:
        db.close()


def test_a_migrated_environment_resolves_to_the_same_account_region_and_role(seen):
    env = _env()
    # The Admin group's role was migrated by conftest the way startup does it.
    assert client.get(f"/api/tables/list?environment_id={env['id']}").status_code == 200
    account, region, identity = seen[-1]
    assert (account, region, identity.role_name) == ("111122223333", "eu-west-1", TEST_ROLE_NAME)
    assert env["connections"][0]["id"] == env["id"]  # its first connection kept its id
    assert (env["account_id"], env["region"]) == ("111122223333", "eu-west-1")  # the old shape, still


def test_identities_need_no_master_key_when_nothing_is_secret(monkeypatch, seen):
    monkeypatch.delenv(crypto.KEYS_ENV, raising=False)
    assert client.get("/api/credentials/status").json()["enabled"] is False
    env = _env()
    group_id, as_g = _group("Keyless", [env["id"]], role_name="KeylessRole")
    assert client.get(f"/api/user-groups").json()[-1]["role_name"] in {"KeylessRole", TEST_ROLE_NAME}
    assert as_g.get(f"/api/tables/list?environment_id={env['id']}").status_code == 200
    assert seen[-1][2].role_name == "KeylessRole"


def test_role_name_in_the_group_api_is_its_default_aws_identity():
    group = client.post("/api/user-groups", json={"name": "Ops", "role_name": "OpsRole"}).json()
    assert group["role_name"] == "OpsRole"
    ids = client.get(f"/api/user-groups/{group['id']}/identities").json()
    assert [(i["connection_type_id"], i["connection_id"], i["credential_type"]) for i in ids] == [("aws", None, "AWS role")]
    assert client.put(f"/api/user-groups/{group['id']}", json={"role_name": "Other"}).json()["role_name"] == "Other"
    assert client.put(f"/api/user-groups/{group['id']}", json={"role_name": None}).json()["role_name"] is None
    assert client.get(f"/api/user-groups/{group['id']}/identities").json() == []


# ------------------------------------------------------------------- resolution order


def test_an_override_then_the_default_then_the_connections_own_credential(seen):
    env = _env()
    eks = _add(env["id"], "eks")
    group_id, as_g = _group("Backend", [env["id"]], role_name="BackendRole")
    override = _role(group_id, "Backend EKS role", "BackendEksRole")
    current = client.get(f"/api/user-groups/{group_id}/identities").json()
    resp = client.put(
        f"/api/user-groups/{group_id}/identities",
        json={"identities": [
            {"connection_type_id": c["connection_type_id"], "connection_id": c["connection_id"], "credential_id": c["credential_id"]}
            for c in current
        ] + [{"connection_type_id": "aws", "connection_id": eks["id"], "credential_id": override}]},
    )
    assert resp.status_code == 200, resp.text

    as_g.get(f"/api/tables/list?environment_id={env['id']}")
    as_g.get(f"/api/tables/list?environment_id={eks['id']}")
    assert [(a, i.role_name) for a, _r, i in seen] == [("111122223333", "BackendRole"), ("444455556666", "BackendEksRole")]

    # No identity of its own: the connection's own credential is used.
    assert client.put(f"/api/user-groups/{group_id}/identities", json={"identities": []}).status_code == 200
    shared = _role(group_id, "Connection role", "ConnRole")
    assert client.patch(f"/api/connections/{eks['id']}", json={"credential_id": shared}).status_code == 200
    as_g.get(f"/api/tables/list?environment_id={eks['id']}")
    assert seen[-1][2].role_name == "ConnRole"

    # Nothing at all: a sentence saying what's missing and where to set it.
    resp = as_g.get(f"/api/tables/list?environment_id={env['id']}")
    assert resp.status_code == 400
    assert "no AWS role for Prod · aws" in resp.json()["detail"] and "User groups" in resp.json()["detail"]


def test_an_identity_must_be_usable_by_the_group_and_of_an_accepted_type(master_key):
    env = _env()
    group_id, as_g = _group("Backend", [env["id"]])
    other_id, _ = _group("Other", [])
    theirs = _role(other_id, "Their role", "TheirRole")
    resp = client.put(
        f"/api/user-groups/{group_id}/identities",
        json={"identities": [{"connection_type_id": "aws", "credential_id": theirs}]},
    )
    assert resp.status_code == 400 and "can't use that credential" in resp.json()["detail"]

    token = client.post("/api/credentials", json={
        "name": "tok", "type_id": "api_token", "scope": "group", "group_id": group_id, "values": {"token": "t0k3n-value"},
    }).json()
    resp = client.put(
        f"/api/user-groups/{group_id}/identities",
        json={"identities": [{"connection_type_id": "aws", "credential_id": token["id"]}]},
    )
    assert resp.status_code == 400 and "can't be an identity on AWS account connections" in resp.json()["detail"]


def test_a_revoked_grant_stops_an_identity_when_it_is_used(seen):
    env = _env()
    group_id, as_g = _group("Backend", [env["id"]], role_name=None)
    shared = client.post("/api/credentials", json={
        "name": "Shared role", "type_id": "aws_role", "scope": "global", "values": {"role_name": "SharedRole"},
    }).json()
    assert client.post(f"/api/credentials/{shared['id']}/grants/{group_id}").status_code == 204
    assert client.put(
        f"/api/user-groups/{group_id}/identities",
        json={"identities": [{"connection_type_id": "aws", "credential_id": shared["id"]}]},
    ).status_code == 200
    assert as_g.get(f"/api/tables/list?environment_id={env['id']}").status_code == 200
    assert seen[-1][2].role_name == "SharedRole"

    assert client.delete(f"/api/credentials/{shared['id']}/grants/{group_id}").status_code == 204
    resp = as_g.get(f"/api/tables/list?environment_id={env['id']}")
    assert resp.status_code == 400 and "isn't available to it any more" in resp.json()["detail"]
    # And a credential in use can't be deleted out from under the group.
    resp = client.delete(f"/api/credentials/{shared['id']}")
    assert resp.status_code == 400 and "Backend's identity for aws" in resp.json()["detail"]


def test_access_keys_are_used_directly(master_key, seen):
    env = _env()
    group_id, as_g = _group("Keys", [env["id"]], role_name=None)
    keys = client.post("/api/credentials", json={
        "name": "keys", "type_id": "aws_access_keys", "scope": "group", "group_id": group_id,
        "values": {"access_key_id": "AKIAEXAMPLE", "secret_access_key": "very-secret-access-key"},
    }).json()
    client.put(f"/api/user-groups/{group_id}/identities", json={"identities": [{"connection_type_id": "aws", "credential_id": keys["id"]}]})
    assert as_g.get(f"/api/tables/list?environment_id={env['id']}").status_code == 200
    identity = seen[-1][2]
    assert identity.access_key_id == "AKIAEXAMPLE" and identity.role_name is None
    assert "very-secret-access-key" not in repr(identity)


# ------------------------------------------------------------------- several connections per environment


def test_several_connections_in_one_environment_are_named_and_each_reachable(seen):
    env = _env()
    eks = _add(env["id"], "eks")
    assert eks["id"] != env["id"]
    targets = client.get("/api/targets?type=aws").json()
    assert [t["label"] for t in targets] == ["Prod · aws", "Prod · eks"]
    assert {t["id"] for t in targets} == {env["id"], eks["id"]}
    # One environment, two accounts.
    client.get(f"/api/tables/list?environment_id={env['id']}")
    client.get(f"/api/tables/list?environment_id={eks['id']}")
    assert [(a, r) for a, r, _i in seen] == [("111122223333", "eu-west-1"), ("444455556666", "us-east-1")]

    # A name already used in the environment is refused.
    resp = client.post(f"/api/environments/{env['id']}/connections", json={
        "type_id": "aws", "name": "eks", "config": {"account_id": "1", "region": "us-east-1"}})
    assert resp.status_code == 400 and "already has a connection called eks" in resp.json()["detail"]


def test_a_group_reaches_an_environments_connections_only_with_access_to_it(seen):
    prod = _env()
    eks = _add(prod["id"], "eks")
    test_env = _env("Test", "222233334444")
    _gid, as_g = _group("Testers", [test_env["id"]])
    assert [t["label"] for t in as_g.get("/api/targets?type=aws").json()] == ["Test"]
    for target in (prod["id"], eks["id"]):
        resp = as_g.get(f"/api/tables/list?environment_id={target}")
        assert resp.status_code == 400 and "is not configured" in resp.json()["detail"]
    assert as_g.get(f"/api/tables/list?environment_id={test_env['id']}").status_code == 200


def test_the_agent_can_name_a_connection_and_is_told_to_choose_when_there_are_several():
    env = _env()
    eks = _add(env["id"], "eks")
    single = _env("Test", "222233334444")
    db = SessionLocal()
    try:
        admin = db.query(models.User).filter(models.User.username == "admin").first()
        rc = panes.RunContext(db=db, user=admin, timezone=None)
        assert panes._visible_environment(rc, eks["id"]) == eks["id"]
        assert panes._visible_environment(rc, "Prod · eks") == eks["id"]
        assert panes._visible_environment(rc, "Test") == single["id"]
        with pytest.raises(panes.InputError) as e:
            panes._visible_environment(rc, "Prod")
        assert "several AWS connections" in str(e.value) and "Prod · eks" in str(e.value)
    finally:
        db.close()


# ------------------------------------------------------------------- audit


def test_an_identitys_use_is_audited_hourly_but_last_used_moves_every_time(seen):
    env = _env()
    db = SessionLocal()
    try:
        before = db.query(models.AuditEvent).filter(models.AuditEvent.action == "credential.use").count()
    finally:
        db.close()
    for _ in range(3):
        assert client.get(f"/api/tables/list?environment_id={env['id']}").status_code == 200
    db = SessionLocal()
    try:
        uses = db.query(models.AuditEvent).filter(models.AuditEvent.action == "credential.use").all()
        assert len(uses) - before == 1 and uses[-1].detail == {"purpose": "AWS account: Prod"}
        admin_group = db.query(models.UserGroup).filter(models.UserGroup.is_admin.is_(True)).first()
        cred = connections.group_identity(db, admin_group, db.get(models.Connection, env["id"])).credential
        assert cred.last_used_at is not None
    finally:
        db.close()


# ------------------------------------------------------------------- testing a connection as a group


def test_test_as_a_group_uses_that_groups_identity(monkeypatch):
    env = _env()
    group_id, _ = _group("Backend", [env["id"]], role_name="BackendRole")
    asked = {}

    class _Sts:
        def get_caller_identity(self):
            return {"Arn": f"arn:aws:sts::111122223333:assumed-role/{asked['identity'].role_name}/x"}

    def fake_client(service, account_id, region, identity):
        asked.update(service=service, identity=identity)
        return _Sts()

    from app import aws_client
    monkeypatch.setattr(aws_client, "get_client", fake_client)
    resp = client.post(f"/api/connections/{env['id']}/test", json={"group_id": group_id}).json()
    assert resp["ok"] is True and "BackendRole" in resp["message"]

    other_id, _ = _group("Other", [])
    resp = client.post(f"/api/connections/{env['id']}/test", json={"group_id": other_id}).json()
    assert resp == {"ok": False, "message": "Other can't see Prod."}


# ------------------------------------------------------------------- HTTP API connections (D33)


def _http_env(group_id: int) -> dict:
    env = client.post("/api/environments", json={"name": "Partner"}).json()
    conn = client.post(f"/api/environments/{env['id']}/connections", json={
        "type_id": "http_api", "name": "api", "config": {"base_url": "https://api.example.com/v1/"}}).json()
    client.put(f"/api/environments/{env['id']}/groups", json={"group_ids": [group_id]})
    return conn


def test_the_http_client_sends_to_a_connection_with_the_groups_identity(master_key, monkeypatch):
    sent = {}

    def echo(method, url, headers=None, body=None, timeout=30):
        sent.update(url=url, headers=dict(headers or {}))
        return {"status_code": 200, "status_text": "OK", "headers": [], "elapsed_ms": 1, "body_truncated": False,
                "body": str(headers)}

    monkeypatch.setattr(tools_http_client, "send_request", echo)
    group_id, as_g = _group("Partners", [], role_name=None)
    conn = _http_env(group_id)
    assert conn["id"] == conn["environment_id"]  # its environment's first connection

    # No identity anywhere: a public API, sent as it is.
    resp = as_g.post("/api/tools/http-request", json={"method": "GET", "url": "/status", "target_id": conn["id"]})
    assert resp.status_code == 200, resp.text
    assert sent["url"] == "https://api.example.com/v1/status" and "Authorization" not in sent["headers"]

    # The connection's own credential...
    shared = client.post("/api/credentials", json={
        "name": "partner-shared", "type_id": "api_token", "scope": "global", "values": {"token": "shared-token-1"}}).json()
    client.post(f"/api/credentials/{shared['id']}/grants/{group_id}")
    client.patch(f"/api/connections/{conn['id']}", json={"credential_id": shared["id"]})
    resp = as_g.post("/api/tools/http-request", json={"method": "GET", "url": "status", "target_id": conn["id"]})
    assert sent["headers"]["Authorization"] == "Bearer shared-token-1"
    assert "shared-token-1" not in resp.text  # echoed back, masked

    # ...unless the group has one of its own.
    own = client.post("/api/credentials", json={
        "name": "partners-own", "type_id": "api_token", "scope": "group", "group_id": group_id,
        "values": {"token": "group-token-2"}}).json()
    client.put(f"/api/user-groups/{group_id}/identities",
               json={"identities": [{"connection_type_id": "http_api", "credential_id": own["id"]}]})
    as_g.post("/api/tools/http-request", json={"method": "GET", "url": "/status", "target_id": conn["id"]})
    assert sent["headers"]["Authorization"] == "Bearer group-token-2"

    # A whole URL with a target picked is refused, saying where the path goes.
    resp = as_g.post("/api/tools/http-request", json={"method": "GET", "url": "https://evil.example/x", "target_id": conn["id"]})
    assert resp.status_code == 400 and "give a path" in resp.json()["detail"]


def test_an_http_api_connection_pointing_inward_is_still_refused_by_the_ssrf_guard():
    group_id, as_g = _group("Partners", [], role_name=None)
    env = client.post("/api/environments", json={"name": "Inside"}).json()
    conn = client.post(f"/api/environments/{env['id']}/connections", json={
        "type_id": "http_api", "name": "api", "config": {"base_url": "http://127.0.0.1:8000"}}).json()
    client.put(f"/api/environments/{env['id']}/groups", json={"group_ids": [group_id]})
    resp = as_g.post("/api/tools/http-request", json={"method": "GET", "url": "/api/auth/me", "target_id": conn["id"]})
    assert resp.status_code == 400 and "127.0.0.1" in resp.json()["detail"]


def test_an_aws_target_is_not_an_http_target():
    env = _env()
    resp = client.post("/api/tools/http-request", json={"method": "GET", "url": "/x", "target_id": env["id"]})
    assert resp.status_code == 400 and "is not configured" in resp.json()["detail"]
