"""Personal access tokens and the MCP tools from outside (D156): Claude Code
on the user's machine calls /api/mcp with a token they made in Settings, and
builds in their Builder drafts -- never saving -- with the guide, reference
and recipes as resources."""

import datetime
import json

from fastapi.testclient import TestClient

from app import audit, builder, deps, models  # noqa: F401
from app.db import SessionLocal
from app.main import app
from app.platform_tools import tokens
from tests.conftest import client
from tests.test_platform_tools import _token, mcp  # noqa: F401 -- a fixture


def _rpc(c: TestClient, token: str | None, method: str, params: dict | None = None, path: str = "/api/mcp"):
    headers = {"Accept": "application/json, text/event-stream"}
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    return c.post(path, json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}, headers=headers)


def _call(c: TestClient, token: str, name: str, **arguments) -> dict:
    resp = _rpc(c, token, "tools/call", {"name": name, "arguments": arguments})
    assert resp.status_code == 200, resp.text
    result = resp.json()["result"]
    assert not result.get("isError"), result["content"][0]["text"]
    return json.loads(result["content"][0]["text"])


def _error(c: TestClient, token: str, name: str, **arguments) -> str:
    resp = _rpc(c, token, "tools/call", {"name": name, "arguments": arguments})
    assert resp.status_code == 200, resp.text
    result = resp.json()["result"]
    assert result.get("isError"), result
    return result["content"][0]["text"]


def _make(name: str = "laptop", days: int = 90, c: TestClient = client) -> dict:
    resp = c.post("/api/access-tokens", json={"name": name, "days": days})
    assert resp.status_code == 201, resp.text
    return resp.json()


def test_a_token_is_shown_once_kept_hashed_and_listed_by_name(mcp):
    made = _make()
    token = made["token"]
    assert token.startswith("cwi_") and made["prefix"] == token[:10] and made["name"] == "laptop"
    expires = datetime.datetime.fromisoformat(made["expires_at"])
    assert datetime.timedelta(days=89) < expires - datetime.datetime.utcnow() <= datetime.timedelta(days=90)
    listed = client.get("/api/access-tokens").json()
    assert [t["name"] for t in listed] == ["laptop"] and "token" not in listed[0]
    assert token not in json.dumps(listed)
    with SessionLocal() as db:
        row = db.get(models.AccessToken, made["id"])
        assert row.token_hash != token and token not in row.token_hash
        events = db.query(models.AuditEvent).filter_by(object_type="access_token").all()
        assert [e.action for e in events] == ["access_token.create"] and token not in json.dumps(events[0].detail)

    # It calls the tools as its user, at /api/mcp -- and at /mcp, in the cluster.
    context = _call(mcp, token, "get_context")
    assert context["user"] == "admin"
    assert _rpc(mcp, token, "tools/list", path="/mcp").status_code == 200
    with SessionLocal() as db:
        assert db.get(models.AccessToken, made["id"]).last_used_at is not None


def test_only_a_personal_token_opens_the_outside_door(mcp):
    turn = _token()
    assert _rpc(mcp, turn, "tools/list", path="/mcp").status_code == 200
    refused = _rpc(mcp, turn, "tools/list")
    assert refused.status_code == 401 and "Access tokens" in refused.json()["detail"]
    assert _rpc(mcp, None, "tools/list").status_code == 401
    assert _rpc(mcp, "cwi_not-a-token", "tools/list").status_code == 401


def test_revoked_or_expired_tokens_stop_working(mcp):
    made = _make()
    assert _rpc(mcp, made["token"], "tools/list").status_code == 200
    assert client.delete(f"/api/access-tokens/{made['id']}").status_code == 204
    assert _rpc(mcp, made["token"], "tools/list").status_code == 401
    assert client.get("/api/access-tokens").json()[0]["revoked_at"] is not None

    old = _make("old")
    with SessionLocal() as db:
        db.get(models.AccessToken, old["id"]).expires_at = datetime.datetime.utcnow() - datetime.timedelta(seconds=1)
        db.commit()
        assert [e.action for e in db.query(models.AuditEvent).filter_by(object_type="access_token")
                .order_by(models.AuditEvent.id)] == ["access_token.create", "access_token.revoke",
                                                     "access_token.create"]
    assert _rpc(mcp, old["token"], "tools/list").status_code == 401


def _member(name: str, agent: bool) -> tuple[TestClient, int]:
    group = client.post("/api/user-groups", json={"name": f"{name}-group", "role_name": "R", "agent_enabled": agent})
    assert group.status_code == 201, group.text
    user = client.post("/api/users", json={"username": name, "password": "pw-123456", "group_id": group.json()["id"]})
    assert user.status_code == 201, user.text
    c = TestClient(app)
    assert c.post("/api/auth/login", json={"username": name, "password": "pw-123456"}).status_code == 200
    return c, group.json()["id"]


def test_tokens_need_the_agent_and_turning_it_off_stops_them(mcp):
    without, _ = _member("noagent", agent=False)
    refused = without.post("/api/access-tokens", json={"name": "x"})
    assert refused.status_code == 403 and "agent isn't turned on" in refused.json()["detail"]

    member, group_id = _member("tokenuser", agent=True)
    made = _make("desk", c=member)
    assert _rpc(mcp, made["token"], "tools/list").status_code == 200
    assert client.put(f"/api/user-groups/{group_id}", json={"agent_enabled": False}).status_code == 200
    assert _rpc(mcp, made["token"], "tools/list").status_code == 401

    # Someone else's: not theirs to list or revoke; an admin's to see and revoke.
    assert member.get("/api/access-tokens/all").status_code == 403
    mine = _make("admin's")
    assert member.delete(f"/api/access-tokens/{mine['id']}").status_code == 404
    everyone = client.get("/api/access-tokens/all").json()
    assert {(t["username"], t["name"]) for t in everyone} == {("tokenuser", "desk"), ("admin", "admin's")}
    assert all("token" not in t for t in everyone)
    assert client.delete(f"/api/access-tokens/{made['id']}").status_code == 204


def test_too_many_live_tokens_are_refused():
    from app.routers import access_tokens

    for n in range(access_tokens.MAX_ACTIVE):
        _make(f"t{n}")
    refused = client.post("/api/access-tokens", json={"name": "one more"})
    assert refused.status_code == 400 and "revoke one" in refused.json()["detail"]


# ---------------------------------------------------------------- building in drafts


def test_a_pane_is_built_in_a_builder_draft_and_left_there_for_the_user(mcp):
    token = _make()["token"]
    # No editor, no draft: said how to get one.
    assert "open_draft" in _error(mcp, token, "read_draft")

    opened = _call(mcp, token, "open_draft", kind="pane", start_from="recipe:rows-that-open", new_id="lambdas")
    draft_id = opened["draft_id"]
    # The recipe's notes are for the builder, not the pane's YAML.
    assert opened["why_its_built_so"].startswith("# Recipe:")
    assert "# Recipe" not in client.get(f"/api/build-drafts/{draft_id}").json()["source"]
    listed = client.get("/api/build-drafts?kind=pane").json()
    assert [d["id"] for d in listed] == [draft_id] and listed[0]["new_id"] == "lambdas"
    assert _call(mcp, token, "list_drafts")["drafts"][0]["draft_id"] == draft_id

    text = _call(mcp, token, "read_draft", draft_id=draft_id)["text"]
    at = next(line.split(": ", 1)[0] for line in text.splitlines() if ": label: " in line)
    changed = _call(mcp, token, "change_definition", draft_id=draft_id, changes=[
        {"op": "lines", "from": int(at), "to": int(at), "text": "label: Lambdas from outside"}])
    assert changed["ok"], changed
    # The change is the draft's, where the Builder will show it.
    assert "label: Lambdas from outside" in client.get(f"/api/build-drafts/{draft_id}").json()["source"]
    assert _call(mcp, token, "check_definition", draft_id=draft_id)["ok"]

    proposed = _call(mcp, token, "propose_definition", draft_id=draft_id, summary="Renamed it.")
    assert proposed["ok"] and proposed["link"] == f"/?draft={draft_id}" and "Builder → Panes" in proposed["note"]
    assert "propose" not in proposed  # nothing for an editor that isn't there
    draft = client.get(f"/api/build-drafts/{draft_id}").json()
    assert draft["chat"][-1]["answer"] == "Renamed it." and "access token “laptop”" in draft["chat"][-1]["question"]
    # Nothing saved: the pane type isn't there until the user saves it.
    assert client.get("/api/builder/panes").json() == [] or all(
        p["id"] != "default:lambdas" for p in client.get("/api/builder/panes").json())


def test_a_draft_of_a_saved_one_and_of_someone_else(mcp):
    recipe = builder.recipes()["rows-that-open"]
    saved = client.post("/api/builder/panes", json={"id": "lambdas", "source": recipe["source"]})
    assert saved.status_code == 201, saved.text
    type_id = saved.json()["id"]
    token = _make()["token"]
    opened = _call(mcp, token, "open_draft", kind="pane", definition_id=type_id)
    assert opened["target_id"] == type_id and "as saved" in opened["note"]
    assert client.get(f"/api/build-drafts?kind=pane&target={type_id}").json()[0]["id"] == opened["draft_id"]
    # Changed, then opened again: the same draft, as left.
    _call(mcp, token, "change_definition", draft_id=opened["draft_id"],
          changes=[{"op": "set", "path": "description", "value": "Changed outside."}])
    again = _call(mcp, token, "open_draft", kind="pane", definition_id=type_id)
    assert again["draft_id"] == opened["draft_id"] and "as it was left" in again["note"]
    # A kind that isn't the draft's is refused; so is another person's draft.
    assert "is a pane's, not a workflow's" in _error(mcp, token, "check_definition", kind="workflow",
                                                     draft_id=opened["draft_id"])
    member, _ = _member("drafter", agent=True)
    theirs = _make("theirs", c=member)["token"]
    assert "no draft" in _error(mcp, theirs, "read_draft", draft_id=opened["draft_id"])


def test_the_first_python_file_brings_requirements_txt(mcp):
    token = _make()["token"]
    draft_id = _call(mcp, token, "open_draft", kind="pane")["draft_id"]
    out = _call(mcp, token, "change_definition", draft_id=draft_id, changes=[
        {"op": "file", "name": "helpers.py", "text": "def tidy(rows):\n    return rows\n"}])
    assert set(out["files"]) == {"helpers.py", "requirements.txt"}
    files = client.get(f"/api/build-drafts/{draft_id}").json()["files"]
    assert files["requirements.txt"] == deps.HINT
    # Removed, it isn't brought back by the next file.
    _call(mcp, token, "change_definition", draft_id=draft_id, changes=[
        {"op": "file", "name": "requirements.txt", "remove": True}])
    out = _call(mcp, token, "change_definition", draft_id=draft_id, changes=[
        {"op": "file", "name": "more.py", "text": "X = 1\n"}])
    assert set(out["files"]) == {"helpers.py", "more.py"}
    # The code starter has one, and a comment-only one locks nothing.
    assert builder.CODE_EXAMPLE_FILES["requirements.txt"] == deps.HINT
    assert deps.locked(dict(builder.CODE_EXAMPLE_FILES)) == builder.CODE_EXAMPLE_FILES


# ---------------------------------------------------------------- documentation


def test_the_guide_reference_and_recipes_are_resources(mcp):
    token = _make()["token"]
    init = _rpc(mcp, token, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                           "clientInfo": {"name": "test", "version": "1"}})
    instructions = init.json()["result"]["instructions"]
    assert "open_draft" in instructions and "read_guide" in instructions and "never save" in instructions

    listed = _rpc(mcp, token, "resources/list").json()["result"]["resources"]
    assert {r["uri"] for r in listed} >= {"platform://guide", "platform://recipes"}
    templates = _rpc(mcp, token, "resources/templates/list").json()["result"]["resourceTemplates"]
    assert {t["uriTemplate"] for t in templates} >= {"platform://reference/{kind}", "platform://recipes/{name}"}

    def read(uri: str) -> str:
        resp = _rpc(mcp, token, "resources/read", {"uri": uri})
        assert resp.status_code == 200 and "result" in resp.json(), resp.text
        return resp.json()["result"]["contents"][0]["text"]

    guide = read("platform://guide")
    assert "propose_definition" in guide and "draft_id" in guide and "requirements.txt" in guide
    assert _call(mcp, token, "read_guide")["guide"] == guide
    reference = json.loads(read("platform://reference/pane"))
    assert "rules" in reference and "recipes" in reference
    assert "rows-that-open" in read("platform://recipes")
    recipe = read("platform://recipes/per-row-values-in-code")
    assert "## jobs.py" in recipe and "```python" in recipe and "# Recipe:" in recipe

    prompts = _rpc(mcp, token, "prompts/list").json()["result"]["prompts"]
    assert {p["name"] for p in prompts} >= {"build_pane", "build_workflow"}
    got = _rpc(mcp, token, "prompts/get", {"name": "build_pane", "arguments": {"what": "IoT OTA jobs"}}).json()
    text = got["result"]["messages"][0]["content"]["text"]
    assert "IoT OTA jobs" in text and "open_draft" in text and "propose_definition" in text


def test_tokens_resolve_never_logs_the_token(caplog):
    made = _make()
    with SessionLocal() as db:
        caller = tokens.resolve(db, made["token"])
    assert caller is not None and caller.access_token_name == "laptop"
    assert made["token"] not in caplog.text
