"""The per-page group flags (logs_enabled, opensearch_enabled, iot_enabled,
tables_enabled, buckets_enabled, cognito_enabled, tools_enabled) are what the
frontend uses to decide which pages to offer -- until now, the routers behind
those pages never re-checked them, only environment visibility and the
group's IAM role (resolve.require_flag closes that: see its own docstring).
A raw request to a page a group's UI never shows used to still go through,
as long as the group had the environment and a role; these tests prove that's
no longer true, for one representative endpoint per flag.

Each disabled-flag call has to fail with require_flag's own message ("turned
on") *before* ever reaching AWS -- there are no real AWS credentials in this
test run, so if the flag check didn't short-circuit first, the request would
still fail, but with a different error (502, from the client call), which is
exactly what proves the boundary: the enabled-flag counterpart of each test
gets *that* different error instead, confirming the flag check passed and
the request reached the (deliberately unreachable) AWS call."""

from fastapi.testclient import TestClient

from app.main import app
from tests.conftest import client


def _login_as(username: str, password: str) -> TestClient:
    c = TestClient(app)
    resp = c.post("/api/auth/login", json={"username": username, "password": password})
    assert resp.status_code == 200, resp.text
    return c


def _environment(name: str = "Prod") -> int:
    resp = client.post("/api/environments", json={"name": name, "account_id": "111122223333", "region": "us-east-1"})
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


def _user(env_id: int, **flags) -> TestClient:
    resp = client.post(
        "/api/user-groups", json={"name": f"group-{flags}", "role_name": "R", "environment_ids": [env_id], **flags}
    )
    assert resp.status_code == 201, resp.text
    group_id = resp.json()["id"]
    username = f"user-{group_id}"
    client.post("/api/users", json={"username": username, "password": "pw-123456", "group_id": group_id})
    return _login_as(username, "pw-123456")


def _refused(resp) -> None:
    assert resp.status_code == 400, resp.text
    assert "turned on" in resp.json()["detail"], resp.text


def _reached_aws(resp) -> None:
    # Not the flag's own 400 -- whatever AWS-call error comes back instead
    # (502, no real credentials here) proves the flag check let it through.
    assert resp.status_code != 400 or "turned on" not in resp.json().get("detail", ""), resp.text


def _query_body(env_id: int) -> dict:
    return {
        "targets": [{"environment_id": env_id, "log_group_names": ["/x"]}],
        "query_string": "fields @message",
        "start_time": 0,
        "end_time": 1,
    }


def test_logs_disabled_refuses_cloudwatch_queries():
    env_id = _environment()
    off = _user(env_id, logs_enabled=False)
    _refused(off.post("/api/queries/start", json=_query_body(env_id)))
    on = _user(env_id, logs_enabled=True)
    resp = on.post("/api/queries/start", json=_query_body(env_id))
    assert resp.status_code == 200
    assert resp.json()["queries"][0].get("error")  # no real AWS -- fails past the flag check


def test_tables_disabled_refuses_dynamodb():
    env_id = _environment()
    off = _user(env_id, tables_enabled=False)
    _refused(off.get("/api/tables/list", params={"environment_id": env_id}))
    on = _user(env_id, tables_enabled=True)
    _reached_aws(on.get("/api/tables/list", params={"environment_id": env_id}))


def test_buckets_disabled_refuses_s3():
    env_id = _environment()
    off = _user(env_id, buckets_enabled=False)
    _refused(off.get("/api/buckets/list", params={"environment_id": env_id}))
    on = _user(env_id, buckets_enabled=True)
    _reached_aws(on.get("/api/buckets/list", params={"environment_id": env_id}))


def test_cognito_disabled_refuses_user_pools():
    env_id = _environment()
    off = _user(env_id, cognito_enabled=False)
    _refused(off.get("/api/cognito/user-pools", params={"environment_id": env_id}))
    on = _user(env_id, cognito_enabled=True)
    _reached_aws(on.get("/api/cognito/user-pools", params={"environment_id": env_id}))


def test_opensearch_disabled_refuses_domains():
    env_id = _environment()
    off = _user(env_id, opensearch_enabled=False)
    _refused(off.post("/api/opensearch/domains", json={"environment_ids": [env_id]}))
    on = _user(env_id, opensearch_enabled=True)
    resp = on.post("/api/opensearch/domains", json={"environment_ids": [env_id]})
    assert resp.status_code == 200
    assert resp.json()["results"][0].get("error")


def test_iot_disabled_refuses_search():
    env_id = _environment()
    off = _user(env_id, iot_enabled=False)
    _refused(off.post("/api/iot/search", json={"environment_ids": [env_id], "query_string": ""}))
    on = _user(env_id, iot_enabled=True)
    resp = on.post("/api/iot/search", json={"environment_ids": [env_id], "query_string": ""})
    assert resp.status_code == 200
    assert resp.json()["results"][0].get("error")


def test_tools_disabled_refuses_http_client_and_mqtt():
    env_id = _environment()
    off = _user(env_id, tools_enabled=False)
    _refused(off.post("/api/tools/http-request", json={"method": "GET", "url": "http://example.com", "headers": []}))
    _refused(off.post("/api/tools/mqtt/presigned-url", json={"environment_id": env_id}))

    on = _user(env_id, tools_enabled=True)
    _reached_aws(on.post("/api/tools/mqtt/presigned-url", json={"environment_id": env_id}))
