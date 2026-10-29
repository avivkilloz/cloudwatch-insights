"""Every pane type is everyone's (D160): the per-page flags and then the grants
per pane type (D65) are gone, and what still decides what a person reaches is
their group's environments and who it is there. A pane's actions answer any
signed-in user -- and still refuse an environment their group can't see,
before any AWS call.

There are no real AWS credentials in this run, so a call that gets past the
platform's own checks fails at AWS instead (an error per environment, or a
502): that different failure is what proves it got through."""

from fastapi.testclient import TestClient

from tests.conftest import client, login_as


def _environment(name: str = "Prod") -> int:
    resp = client.post("/api/environments", json={"name": name, "account_id": "111122223333", "region": "us-east-1"})
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


def _user(env_ids: list[int], name: str) -> TestClient:
    resp = client.post("/api/user-groups", json={"name": f"group-{name}", "role_name": "R", "environment_ids": env_ids})
    assert resp.status_code == 201, resp.text
    group_id = resp.json()["id"]
    username = f"user-{name}"
    client.post("/api/users", json={"username": username, "password": "pw-123456", "group_id": group_id})
    return login_as(username)


def _action(c: TestClient, pane: str, action: str, inputs: dict):
    return c.post(f"/api/panes/{pane}/actions/{action}", json={"inputs": inputs})


def _reached_aws(resp) -> None:
    # Not refused by the platform: whatever AWS-call error comes back instead.
    assert resp.status_code not in (403, 404), resp.text
    assert "turned on" not in str(resp.json()), resp.text


def test_every_pane_type_is_offered_to_everyone():
    env_id = _environment()
    c = _user([env_id], "plain")
    types = {m["id"] for m in c.get("/api/pane-types").json()}
    assert {"tables", "buckets", "cognito", "logs-cloudwatch", "logs-opensearch", "iot", "tool-http",
            "tool-mqtt"} <= types
    me = c.get("/api/auth/me").json()
    assert "pane_types" not in me and "logs_enabled" not in me


def test_any_user_reaches_any_pane_in_their_own_environment():
    env_id = _environment()
    c = _user([env_id], "reach")
    _reached_aws(_action(c, "tables", "list_tables", {"connection": env_id}))
    _reached_aws(_action(c, "buckets", "list_buckets", {"connection": env_id}))
    _reached_aws(_action(c, "cognito", "list_user_pools", {"connection": env_id}))
    resp = _action(c, "logs-cloudwatch", "list_log_groups", {"connections": [env_id]})
    assert resp.status_code == 200, resp.text
    assert resp.json()["groups"][0].get("error")  # no real AWS -- past every check of ours
    resp = _action(c, "iot", "search", {"connections": [env_id], "queryString": "thingName:*"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["thingResults"][0].get("error")
    _reached_aws(_action(c, "tool-mqtt", "publish", {"connection": env_id, "publishTopic": "devices/x", "payload": "{}"}))


def test_an_environment_the_group_cant_see_is_still_refused():
    mine = _environment("Mine")
    theirs = _environment("Theirs")
    c = _user([mine], "fenced")
    resp = _action(c, "tables", "list_tables", {"connection": theirs})
    assert resp.status_code in (400, 403, 404), resp.text
    assert "AccessDenied" not in resp.text


def test_the_old_per_service_routes_are_gone():
    # Kept one release for tabs that hadn't reloaded (D49): DynamoDB's,
    # Cognito's and S3's removed in 3b-2, IoT's and the HTTP client's in 3b-3,
    # the logs' and saved queries' in 3b-4.
    env_id = _environment()
    assert client.post("/api/queries/start", json={}).status_code == 404
    assert client.post("/api/log-groups", json={"environment_ids": [env_id]}).status_code == 404
    assert client.post("/api/opensearch/domains", json={"environment_ids": [env_id]}).status_code == 404
    assert client.get("/api/saved-queries").status_code == 404
    assert client.post("/api/iot/search", json={"environment_ids": [env_id], "query_string": "x"}).status_code == 404
    assert client.post("/api/tools/http-request", json={"method": "GET", "url": "https://example.com"}).status_code in (404, 405)
    assert client.get("/api/tables/list", params={"environment_id": env_id}).status_code == 404
    assert client.get("/api/buckets/list", params={"environment_id": env_id}).status_code == 404
    assert client.get("/api/cognito/user-pools", params={"environment_id": env_id}).status_code == 404
