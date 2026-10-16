"""The platform agent's MCP tools, called the way the agent calls them: JSON-RPC
over POST /mcp with a per-turn bearer token.

What matters here is that the agent can do no more than its user could by
hand (tokens, flags, environments), and that what it does lands in the
session exactly as the browser stores it -- tagged Sets, pane ids, result
keys -- through the same versioned, announced write every browser save goes
through."""

import json

import pytest
from fastapi.testclient import TestClient

from app import aws_client, iot_client, live_store, models, pane_outputs
from app.db import SessionLocal
from app.main import app
from app.panes import runs as pane_runs
from app.platform_tools import panes, tokens
from tests.conftest import client
from tests.test_live_sessions import _drain, _listen


@pytest.fixture()
def mcp():
    # The MCP endpoint needs the app's lifespan running, which a bare
    # TestClient (like conftest's shared one) never starts.
    with TestClient(app) as c:
        yield c


def _admin() -> models.User:
    db = SessionLocal()
    try:
        return db.query(models.User).filter(models.User.username == "admin").one()
    finally:
        db.close()


def _token(user_id: int | None = None, **kwargs) -> str:
    db = SessionLocal()
    try:
        user = db.get(models.User, user_id or _admin().id)
        return tokens.mint(db, user, **kwargs)
    finally:
        db.close()


def _rpc(c: TestClient, token: str | None, method: str, params: dict | None = None):
    headers = {"Accept": "application/json, text/event-stream"}
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    return c.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}, headers=headers)


def call(c: TestClient, token: str, name: str, **arguments) -> dict:
    resp = _rpc(c, token, "tools/call", {"name": name, "arguments": arguments})
    assert resp.status_code == 200, resp.text
    result = resp.json()["result"]
    text = result["content"][0]["text"]
    assert not result.get("isError"), text
    return json.loads(text)


def call_error(c: TestClient, token: str, name: str, **arguments) -> str:
    resp = _rpc(c, token, "tools/call", {"name": name, "arguments": arguments})
    assert resp.status_code == 200, resp.text
    result = resp.json()["result"]
    assert result.get("isError"), result
    return result["content"][0]["text"]


def _row(client_id: str) -> models.LiveSession:
    """The row, its state showing its panes' outputs under `out.` keys as it
    did before they had their own records (§18.2) -- detached, so nothing
    here is written back."""
    db = SessionLocal()
    try:
        row = live_store.get(db, _admin().id, client_id)
        if row is not None:
            merged = dict(row.state or {})
            for pane, record in pane_outputs.read(db, row).items():
                for key, value in record["values"].items():
                    merged[f"{pane}.out.{key}"] = value
            db.expunge(row)
            row.state = merged
        return row
    finally:
        db.close()


def _environment(name: str = "Prod", account: str = "111122223333") -> int:
    resp = client.post("/api/environments", json={"name": name, "account_id": account, "region": "us-east-1"})
    assert resp.status_code == 201
    return resp.json()["id"]


def _group(**flags) -> int:
    resp = client.post("/api/user-groups", json={"name": "Agents", "role_name": "R", **flags})
    assert resp.status_code == 201, resp.text
    group_id = resp.json()["id"]
    user = client.post("/api/users", json={"username": "bob", "password": "pw-123456", "group_id": group_id})
    assert user.status_code == 201, user.text
    return user.json()["id"]


# ---------------------------------------------------------------- who may call


def test_calls_without_a_valid_token_are_refused_before_mcp_sees_them(mcp):
    assert _rpc(mcp, None, "tools/list").status_code == 401
    assert _rpc(mcp, "not-a-token", "tools/list").status_code == 401

    token = _token()
    assert _rpc(mcp, token, "tools/list").status_code == 200
    db = SessionLocal()
    try:
        tokens.revoke(db, token)
    finally:
        db.close()
    assert _rpc(mcp, token, "tools/list").status_code == 401


def test_a_group_without_the_agent_can_not_use_it_even_mid_turn(mcp):
    bob = _group(agent_enabled=True)
    token = _token(bob)
    assert _rpc(mcp, token, "tools/list").status_code == 200

    groups = client.get("/api/user-groups").json()
    agents = next(g for g in groups if g["name"] == "Agents")
    client.put(f"/api/user-groups/{agents['id']}", json={"agent_enabled": False})
    # The same token, a moment later: the flag is checked on every call.
    assert _rpc(mcp, token, "tools/list").status_code == 401


def test_new_groups_do_not_get_the_agent_unless_asked_but_admin_does():
    me = client.get("/api/auth/me").json()
    assert me["agent_enabled"] is True
    resp = client.post("/api/user-groups", json={"name": "Plain"})
    assert resp.json()["agent_enabled"] is False


def test_tokens_are_stored_only_as_hashes():
    token = _token(timezone="Asia/Jerusalem", viewing_session_id="s1")
    db = SessionLocal()
    try:
        stored = db.query(models.AgentToken).all()
        assert len(stored) == 1
        assert stored[0].token_hash != token and token not in stored[0].token_hash
        assert stored[0].timezone == "Asia/Jerusalem"
        assert tokens.resolve(db, token).viewing_session_id == "s1"
    finally:
        db.close()


# ---------------------------------------------------------------- looking around


def test_context_lists_only_what_the_group_can_reach(mcp):
    visible = _environment("Visible")
    _environment("Hidden", "999988887777")
    bob = _group(agent_enabled=True, iot_enabled=False)
    groups = client.get("/api/user-groups").json()
    agents = next(g for g in groups if g["name"] == "Agents")
    client.put(f"/api/user-groups/{agents['id']}", json={"environment_ids": [visible]})

    context = call(mcp, _token(bob, timezone="Europe/London"), "get_context")
    assert [e["name"] for e in context["environments"]] == ["Visible"]
    kinds = [k["kind"] for k in context["pane_kinds"]]
    assert "iot" not in kinds and "logs-cloudwatch" in kinds
    # Every kind the group has is offered.
    mqtt = next(k for k in context["pane_kinds"] if k["kind"] == "tool-mqtt")
    # MQTT's connection is the server's now (D54): the agent can fill it in,
    # connect and read -- but not publish.
    assert [i["key"] for i in mqtt["inputs"]] == ["connection", "topics", "publishTopic", "payload"]
    assert "can't publish" in mqtt["run"] and "stop_pane" in mqtt
    assert "tool-jwt" in kinds
    assert context["timezone"] == "Europe/London"
    cloudwatch = next(k for k in context["pane_kinds"] if k["kind"] == "logs-cloudwatch")
    assert "logGroupSelection" in [i["key"] for i in cloudwatch["inputs"]]


# ---------------------------------------------------------------- shaping a session


def test_create_session_writes_the_browsers_own_shape_and_announces_it_as_the_agent(mcp):
    token = _token()
    conn = _listen()
    try:
        made = call(
            mcp,
            token,
            "create_session",
            title="Checkout errors",
            panes=[{"kind": "logs-cloudwatch"}, {"kind": "logs-cloudwatch"}, {"kind": "tool-base64", "title": "Decode"}],
            layout="columns",
        )
        events = _drain(conn)
    finally:
        conn.close()

    assert made["pane_ids"] == ["logs-cloudwatch", "logs-cloudwatch~2", "tool-base64"]
    row = _row(made["session_id"])
    assert row.type == "aggregator" and row.version == 1 and row.title == "Checkout errors"
    assert row.state["services"] == made["pane_ids"]
    assert row.state["paneTypes"]["logs-cloudwatch~2"] == "logs-cloudwatch"
    assert row.state["paneTitles"] == {
        "logs-cloudwatch": "CloudWatch",
        "logs-cloudwatch~2": "CloudWatch 2",
        "tool-base64": "Decode",
    }
    assert row.state["layout"] == "columns" and row.state["activePane"] == "logs-cloudwatch"
    assert [(e["kind"], e["client_id"], e["origin"]) for e in events] == [("upsert", made["session_id"], "agent")]

    # It shows in the browser's own listing, like any other open session.
    listed = client.get("/api/live-sessions").json()
    assert made["session_id"] in [s["client_id"] for s in listed]
    # And a second one of the same name is numbered, as the browser does it.
    again = call(mcp, token, "create_session", title="Checkout errors", panes=[])
    assert _row(again["session_id"]).title == "Checkout errors 2"


def test_a_kind_the_group_lacks_can_not_be_added(mcp):
    bob = _group(agent_enabled=True, tables_enabled=False)
    error = call_error(mcp, _token(bob), "create_session", title="x", panes=[{"kind": "tables"}])
    assert "DynamoDB" in error


def test_add_pane_also_refuses_a_kind_the_group_lacks(mcp):
    bob_id = _group(agent_enabled=True, tables_enabled=False)
    token = _token(bob_id)
    session = call(mcp, token, "create_session", title="x", panes=[{"kind": "tool-base64"}])["session_id"]
    error = call_error(mcp, token, "add_pane", session_id=session, kind="tables")
    assert "DynamoDB" in error
    db = SessionLocal()
    try:
        row = live_store.get(db, bob_id, session)
    finally:
        db.close()
    assert row.state["services"] == ["tool-base64"]


def test_run_pane_also_refuses_an_environment_outside_the_group(mcp):
    hidden = _environment("Hidden")
    bob = _group(agent_enabled=True)
    token = _token(bob)
    session = call(mcp, token, "create_session", title="s", panes=[{"kind": "iot"}])["session_id"]
    error = call_error(
        mcp, token, "run_pane", session_id=session, pane_id="iot", inputs={"selectedEnvironmentIds": [hidden]}
    )
    assert "isn't visible" in error


def test_nobody_can_run_a_shared_pane_with_the_owners_access(mcp, monkeypatch):
    # "Search IoT Prod on behalf of @owner": the owner already pointed the
    # shared pane at an environment only they can see, and an editor without
    # it asks their own agent to run it. The run is theirs, so Prod is refused
    # for them before anything reaches AWS -- the pane being set up by someone
    # who could see it lends them nothing.
    searched: list[str] = []
    monkeypatch.setattr(
        iot_client, "search_things", lambda account, *_a, **_k: searched.append(account) or [{"thing_name": "t"}]
    )
    prod = _environment("IoT Prod", "999988887777")
    test = _environment("IoT Test", "111100001111")
    owner = _token()
    session = call(mcp, owner, "create_session", title="Shared", panes=[{"kind": "iot"}])["session_id"]
    call(mcp, owner, "set_pane_inputs", session_id=session, pane_id="iot", inputs={"selectedEnvironmentIds": [prod]})
    groups = client.post(
        "/api/user-groups",
        json={"name": "Backend", "role_name": "R", "environment_ids": [test], "agent_enabled": True, "iot_enabled": True},
    )
    assert groups.status_code == 201, groups.text
    bob = client.post("/api/users", json={"username": "bob", "password": "pw-123456", "group_id": groups.json()["id"]})
    bob = bob.json()["id"]
    client.post(f"/api/live-sessions/{session}/members", json={"username": "bob", "permission": "editor"})

    # Refused before anything reaches AWS, saying which input to change and
    # to what -- a bare "Environment 2 is not configured" sent a model round
    # in circles calling IoT Test missing when it was the pane's Prod.
    error = call_error(mcp, _token(bob), "run_pane", session_id=session, pane_id="iot")
    assert searched == []
    assert f"environment {prod}, which you can't reach" in error and f"{test} (IoT Test)" in error
    # Nor can they name it themselves.
    error = call_error(mcp, _token(bob), "set_pane_inputs", session_id=session, pane_id="iot", inputs={"selectedEnvironmentIds": [prod]})
    assert "isn't visible" in error
    # Their own context never lists it, whoever else is in the chat.
    assert [e["name"] for e in call(mcp, _token(bob), "get_context")["environments"]] == ["IoT Test"]
    # Pointed at their own, it runs, as them.
    out = call(mcp, _token(bob), "run_pane", session_id=session, pane_id="iot", inputs={"selectedEnvironmentIds": [test]})
    assert searched == ["111100001111"] and out["thingResults"]["total"] == 1

    # The owner's own run does reach Prod.
    call(mcp, owner, "set_pane_inputs", session_id=session, pane_id="iot", inputs={"selectedEnvironmentIds": [prod]})
    out = call(mcp, owner, "run_pane", session_id=session, pane_id="iot")
    assert searched == ["111100001111", "999988887777"] and out["thingResults"]["total"] == 1


def test_a_shared_sessions_pane_is_still_gated_by_the_members_own_group_not_the_owners(mcp):
    # The owner's group has "tables" turned on; the invited editor's doesn't
    # -- the pane already exists in the shared session, but the member's own
    # agent still can't touch it, exactly as if they'd tried to add it fresh.
    session = call(mcp, _token(), "create_session", title="Shared", panes=[{"kind": "tables"}])["session_id"]
    bob = _group(agent_enabled=True, tables_enabled=False)
    client.post(f"/api/live-sessions/{session}/members", json={"username": "bob", "permission": "editor"})
    error = call_error(mcp, _token(bob), "set_pane_inputs", session_id=session, pane_id="tables", inputs={})
    assert "DynamoDB" in error


def test_adding_and_removing_panes_follows_the_browsers_rules(mcp):
    token = _token()
    session = call(mcp, token, "create_session", title="s", panes=[{"kind": "tool-base64"}])["session_id"]
    added = call(mcp, token, "add_pane", session_id=session, kind="tool-base64")
    assert (added["pane_id"], added["title"]) == ("tool-base64~2", "Base64 2")
    assert _row(session).state["activePane"] == "tool-base64~2"

    call(mcp, token, "set_pane_inputs", session_id=session, pane_id="tool-base64~2", inputs={"input": "hello"})
    call(mcp, token, "remove_pane", session_id=session, pane_id="tool-base64~2")
    state = _row(session).state
    assert state["services"] == ["tool-base64"]
    assert "tool-base64~2" not in state["paneTypes"] and "tool-base64~2" not in state["paneTitles"]
    # Its inputs go with it, so a pane that later reuses the id starts empty.
    assert not any(k.startswith("tool-base64~2.") for k in state)
    assert "no pane" in call_error(mcp, token, "remove_pane", session_id=session, pane_id="nope")


def test_a_sessions_description_is_what_the_agent_reads_it_for(mcp):
    token = _token()
    resp = client.put(
        "/api/live-sessions/s-about",
        json={"type": "aggregator", "title": "Checkout", "state": {"description": "Why checkout 500s since Tuesday"}},
    )
    assert resp.status_code == 200
    described = call(mcp, token, "get_session", session_id="s-about")
    assert described["description"] == "Why checkout 500s since Tuesday"
    listed = call(mcp, token, "list_sessions")
    about = [s for s in (listed["sessions"] if isinstance(listed, dict) else listed) if s["session_id"] == "s-about"]
    assert about and about[0]["description"] == "Why checkout 500s since Tuesday"


def test_the_agent_can_set_a_sessions_description_and_category(mcp):
    token = _token()
    session = call(mcp, token, "create_session", title="Checkout", panes=[{"kind": "tool-diff"}])["session_id"]

    described = call(mcp, token, "set_description", session_id=session, description="Why checkout 500s")
    assert described["description"] == "Why checkout 500s"
    assert _row(session).state["description"] == "Why checkout 500s"
    described = call(mcp, token, "set_description", session_id=session, description="  ")
    assert "description" not in described

    assert call(mcp, token, "list_categories") == {"categories": []}
    described = call(mcp, token, "set_category", session_id=session, category="Incidents")
    assert described["category"] == "Incidents"
    assert call(mcp, token, "list_categories") == {"categories": ["Incidents"]}
    # A second session filing into the same name reuses it, not a duplicate.
    other = call(mcp, token, "create_session", title="Other", panes=[{"kind": "tool-diff"}])["session_id"]
    call(mcp, token, "set_category", session_id=other, category="Incidents")
    assert call(mcp, token, "list_categories") == {"categories": ["Incidents"]}

    described = call(mcp, token, "set_category", session_id=session)
    assert "category" not in described


def test_browser_only_tools_can_be_added_and_named_but_not_filled_in(mcp):
    # JWT is the one left (its token is a secret, kept in the browser); MQTT's
    # connection moved to the server in 3b-5 (test_mqtt.py).
    token = _token()
    session = call(mcp, token, "create_session", title="s", panes=[{"kind": "tool-diff"}])["session_id"]
    added = call(mcp, token, "add_pane", session_id=session, kind="tool-jwt")
    assert added["pane_id"] == "tool-jwt"
    state = _row(session).state
    assert state["services"] == ["tool-diff", "tool-jwt"]
    assert "browser" in call_error(mcp, token, "run_pane", session_id=session, pane_id="tool-jwt")


def test_inputs_are_stored_as_the_browser_expects_and_checked(mcp):
    token = _token()
    env = _environment()
    session = call(mcp, token, "create_session", title="s", panes=[{"kind": "logs-cloudwatch"}])["session_id"]
    call(
        mcp,
        token,
        "set_pane_inputs",
        session_id=session,
        pane_id="logs-cloudwatch",
        inputs={"logGroupSelection": {str(env): ["/aws/lambda/checkout"]}, "queryString": "fields @message", "preset": 3600},
    )
    state = _row(session).state
    # Sets are tagged, or the browser's first .has() takes the page down.
    assert state["logs-cloudwatch.in.logGroupSelection"] == {str(env): {"__cwiSet": ["/aws/lambda/checkout"]}}
    # Picking log groups ticks their environment, as it does by hand.
    assert state["logs-cloudwatch.in.connections"] == [env]
    assert state["logs-cloudwatch.in.preset"] == 3600

    assert "no input" in call_error(
        mcp, token, "set_pane_inputs", session_id=session, pane_id="logs-cloudwatch", inputs={"nonsense": 1}
    )
    assert "isn't visible" in call_error(
        mcp,
        token,
        "set_pane_inputs",
        session_id=session,
        pane_id="logs-cloudwatch",
        inputs={"selectedEnvironmentIds": [987654]},
    )
    assert "must be one of" in call_error(
        mcp, token, "set_pane_inputs", session_id=session, pane_id="logs-cloudwatch", inputs={"preset": 7}
    )


def test_an_environment_outside_the_group_is_refused(mcp):
    hidden = _environment("Hidden")
    bob = _group(agent_enabled=True)
    token = _token(bob)
    session = call(mcp, token, "create_session", title="s", panes=[{"kind": "iot"}])["session_id"]
    error = call_error(
        mcp, token, "set_pane_inputs", session_id=session, pane_id="iot", inputs={"selectedEnvironmentIds": [hidden]}
    )
    assert "isn't visible" in error


def test_the_agent_can_only_reach_its_own_users_sessions(mcp):
    mine = call(mcp, _token(), "create_session", title="admin's", panes=[])["session_id"]
    bob = _group(agent_enabled=True)
    error = call_error(mcp, _token(bob), "rename", session_id=mine, title="taken over")
    assert "no session" in error
    assert _row(mine).title == "admin's"


# ---------------------------------------------------------------- sharing, phase 5: the agent on a shared session


def test_a_member_reaches_a_shared_session_through_get_session_and_list_sessions(mcp):
    session = call(mcp, _token(), "create_session", title="Shared", panes=[{"kind": "tool-diff"}])["session_id"]
    bob = _group(agent_enabled=True)
    assert client.post(f"/api/live-sessions/{session}/members", json={"username": "bob", "permission": "viewer"}).status_code == 201
    token = _token(bob)

    described = call(mcp, token, "get_session", session_id=session)
    assert described["role"] == "viewer"
    listed = call(mcp, token, "list_sessions")["sessions"]
    assert [s["session_id"] for s in listed] == [session]
    assert listed[0]["role"] == "viewer"


def test_a_viewer_member_cannot_change_a_shared_session_through_the_agent(mcp):
    session = call(mcp, _token(), "create_session", title="Shared", panes=[{"kind": "tool-diff"}])["session_id"]
    bob = _group(agent_enabled=True)
    client.post(f"/api/live-sessions/{session}/members", json={"username": "bob", "permission": "viewer"})
    token = _token(bob)

    error = call_error(mcp, token, "add_pane", session_id=session, kind="tool-base64")
    assert "read-only" in error
    assert _row(session).state["services"] == ["tool-diff"]


def test_an_editor_member_can_change_a_shared_session_and_the_owner_sees_it(mcp):
    session = call(mcp, _token(), "create_session", title="Shared", panes=[{"kind": "tool-diff"}])["session_id"]
    bob = _group(agent_enabled=True)
    client.post(f"/api/live-sessions/{session}/members", json={"username": "bob", "permission": "editor"})
    token = _token(bob)

    added = call(mcp, token, "add_pane", session_id=session, kind="tool-base64")
    assert added["pane_id"] == "tool-base64"
    # The one shared document: the owner's own read sees the editor's pane too.
    assert _row(session).state["services"] == ["tool-diff", "tool-base64"]
    owner_view = call(mcp, _token(), "get_session", session_id=session)
    assert owner_view["role"] == "owner"
    assert {p["pane_id"] for p in owner_view["panes"]} == {"tool-diff", "tool-base64"}


def test_set_category_on_a_shared_session_is_the_members_own_never_the_owners(mcp):
    session = call(mcp, _token(), "create_session", title="Shared", panes=[])["session_id"]
    bob = _group(agent_enabled=True)
    client.post(f"/api/live-sessions/{session}/members", json={"username": "bob", "permission": "editor"})
    token = _token(bob)

    described = call(mcp, token, "set_category", session_id=session, category="Bob's stuff")
    assert described["category"] == "Bob's stuff"
    # Bob's own view is categorized; the owner's own row never was.
    assert _row(session).category_id is None
    bob_browser = TestClient(app)
    assert bob_browser.post("/api/auth/login", json={"username": "bob", "password": "pw-123456"}).status_code == 200
    assert bob_browser.get(f"/api/live-sessions/{session}").json()["category_id"] is not None
    assert client.get(f"/api/live-sessions/{session}").json()["category_id"] is None


def test_get_context_reports_the_viewed_sessions_role(mcp):
    session = call(mcp, _token(), "create_session", title="Shared", panes=[])["session_id"]
    bob = _group(agent_enabled=True)
    client.post(f"/api/live-sessions/{session}/members", json={"username": "bob", "permission": "editor"})
    ctx = call(mcp, _token(bob, viewing_session_id=session), "get_context")
    assert ctx["viewing_session"]["role"] == "editor"


def test_a_shared_sessions_description_reports_who_else_is_on_it(mcp):
    session = call(mcp, _token(), "create_session", title="Shared", panes=[])["session_id"]
    bob = _group(agent_enabled=True)
    client.post(f"/api/live-sessions/{session}/members", json={"username": "bob", "permission": "editor"})

    # The owner's own read sees it, through get_session and list_sessions alike.
    owner_view = call(mcp, _token(), "get_session", session_id=session)
    assert {(m["username"], m["role"]) for m in owner_view["members"]} == {("admin", "owner"), ("bob", "editor")}
    listed = call(mcp, _token(), "list_sessions")["sessions"][0]
    assert {(m["username"], m["role"]) for m in listed["members"]} == {("admin", "owner"), ("bob", "editor")}

    # So does the invited member's own read of the same session.
    bob_view = call(mcp, _token(bob), "get_session", session_id=session)
    assert {(m["username"], m["role"]) for m in bob_view["members"]} == {("admin", "owner"), ("bob", "editor")}


def test_an_unshared_sessions_description_carries_no_members_field(mcp):
    session = call(mcp, _token(), "create_session", title="Solo", panes=[])["session_id"]
    described = call(mcp, _token(), "get_session", session_id=session)
    assert "members" not in described


def test_a_session_chats_turn_can_change_only_that_session(mcp):
    # The prompt asked for this and a model didn't always listen: asked in one
    # session's chat, it wrote into another, off screen, and the user saw an
    # answer with nothing in their panes. The token is held to the session.
    token = _token()
    here = call(mcp, token, "create_session", title="Here", panes=[{"kind": "tool-base64"}])["session_id"]
    there = call(mcp, token, "create_session", title="There", panes=[{"kind": "tool-base64"}])["session_id"]
    before = _row(there).version
    scoped = _token(session_scope_id=_row(here).id, viewing_session_id=here)

    # Its own session: every kind of change still works.
    call(mcp, scoped, "add_pane", session_id=here, kind="tool-diff")
    call(mcp, scoped, "rename", session_id=here, title="Here, renamed")
    call(mcp, scoped, "set_layout", session_id=here, layout="columns")

    # Any other: refused, and nothing written.
    for name, args in [
        ("add_pane", {"kind": "tool-diff"}),
        ("rename", {"title": "Moved"}),
        ("set_layout", {"layout": "columns"}),
        ("set_description", {"description": "x"}),
        ("set_category", {"category": "Elsewhere"}),
        ("remove_pane", {"pane_id": "tool-base64"}),
        ("set_pane_inputs", {"pane_id": "tool-base64", "inputs": {"input": "aGk="}}),
        ("run_pane", {"pane_id": "tool-base64", "inputs": {"input": "aGk="}}),
    ]:
        assert "only change this session" in call_error(mcp, scoped, name, session_id=there, **args), name
    assert _row(there).version == before
    assert _row(there).title == "There"
    # Nor can it make a new one, which would be off screen just the same.
    assert "only change this session" in call_error(mcp, scoped, "create_session", title="New", panes=[])
    assert "New" not in [s["title"] for s in call(mcp, token, "list_sessions")["sessions"]]
    # Reading any session is still fine; so is a Global turn changing it.
    assert call(mcp, scoped, "get_session", session_id=there)["title"] == "There"
    call(mcp, token, "rename", session_id=there, title="There, from Global")


def test_filling_or_running_a_minimised_pane_unfolds_it(mcp):
    # Folded to its header, a pane the agent filled showed nothing, which read
    # as the agent working in the background.
    token = _token()
    session = call(
        mcp,
        token,
        "create_session",
        title="s",
        panes=[{"kind": "tool-base64"}, {"kind": "tool-diff"}],
        layout="columns",
    )["session_id"]
    db = SessionLocal()
    try:
        live_store.mutate(
            db,
            _admin().id,
            session,
            lambda s, _r, _m: s.__setitem__("minimized", live_store.tag_set(["tool-base64", "tool-diff"])),
            None,
        )
    finally:
        db.close()
    call(mcp, token, "set_pane_inputs", session_id=session, pane_id="tool-diff", inputs={"left": "a", "right": "b"})
    assert live_store.untag(_row(session).state["minimized"]) == ["tool-base64"]
    call(mcp, token, "run_pane", session_id=session, pane_id="tool-base64", inputs={"input": "aGk="})
    assert live_store.untag(_row(session).state["minimized"]) == []


def test_inspect_row_shows_a_row_in_full_and_a_things_shadows(mcp, monkeypatch):
    # A search's sample shows a thing's summary, never its shadows -- so a
    # model asked about "deviceType in the Search shadow" wrote a filter on a
    # shape it had never seen, misread the error, and told the user shadow
    # indexing was off. A row can now be looked at in full, the way the pane
    # shows it on expanding it.
    env = _environment("IoT Prod", "999988887777")
    monkeypatch.setattr(
        iot_client,
        "search_things",
        lambda *_a, **_k: [{"thing_name": "Z3563HMR", "thing_id": "t1", "attributes": {}, "connected": False}],
    )
    looked: list[tuple] = []

    def detail(account, region, role, thing_name):
        looked.append((account, thing_name))
        return {"thing_name": thing_name, "shadows": [{"name": "Search", "reported": {"deviceType": "0x65"}}]}

    monkeypatch.setattr(iot_client, "get_thing_detail", detail)
    token = _token()
    session = call(mcp, token, "create_session", title="IoT", panes=[{"kind": "iot"}])["session_id"]
    assert "no results yet" in call_error(mcp, token, "inspect_row", session_id=session, pane_id="iot", row=0)
    call(mcp, token, "run_pane", session_id=session, pane_id="iot", inputs={"selectedEnvironmentIds": [env]})

    out = call(mcp, token, "inspect_row", session_id=session, pane_id="iot", row=0)
    assert looked == [("999988887777", "Z3563HMR")]
    assert out["of"] == 1 and out["detail"]["shadows"] == [
        {"name": "Search", "reported": {"deviceType": "0x65"}, "desired": {}, "version": None, "last_updated": None}
    ]
    assert out["detail"]["environment"] == "IoT Prod"
    assert "no row 3" in call_error(mcp, token, "inspect_row", session_id=session, pane_id="iot", row=3)
    # get_context says which kinds can be inspected, and how far.
    kinds = {k["kind"]: k for k in call(mcp, token, "get_context")["pane_kinds"]}
    assert "shadows" in kinds["iot"]["inspect_row"] and "inspect_row" not in kinds["tool-base64"]

    # In a shared session, a member without that environment can't have its
    # detail looked up -- a second look-up acts as them, like a run.
    bob = _group(agent_enabled=True, iot_enabled=True)
    client.post(f"/api/live-sessions/{session}/members", json={"username": "bob", "permission": "viewer"})
    error = call_error(mcp, _token(bob), "inspect_row", session_id=session, pane_id="iot", row=0)
    assert f"environment {env}, which you can't reach" in error and len(looked) == 1


def test_inspect_row_gives_a_log_row_uncut(mcp, monkeypatch):
    long_message = "x" * (panes.MAX_CELL_CHARS + 500)
    token = _token()
    session = call(mcp, token, "create_session", title="Logs", panes=[{"kind": "logs-cloudwatch"}])["session_id"]
    db = SessionLocal()
    try:
        live_store.mutate(
            db,
            _admin().id,
            session,
            lambda s, _r, _m: s.__setitem__(
                "logs-cloudwatch.out.results",
                [{"environment_id": 1, "environment_name": "Prod",
                  "rows": [[{"field": "@message", "value": long_message}, {"field": "@ptr", "value": "p"}]]}],
            ),
            None,
        )
    finally:
        db.close()
    out = call(mcp, token, "inspect_row", session_id=session, pane_id="logs-cloudwatch", row=0)
    # The row as the pane lists it: its environment, every field but CloudWatch's opaque @ptr.
    assert out["detail"] == {"environment": "Prod", "@message": long_message}
    base64 = call(mcp, token, "add_pane", session_id=session, kind="tool-base64")["pane_id"]
    assert "no rows to inspect" in call_error(mcp, token, "inspect_row", session_id=session, pane_id=base64, row=0)


def test_a_browser_holding_an_old_version_is_refused_after_the_agent_writes(mcp):
    token = _token()
    session = call(mcp, token, "create_session", title="s", panes=[{"kind": "tool-diff"}])["session_id"]
    before = client.get(f"/api/live-sessions/{session}").json()
    call(mcp, token, "set_pane_inputs", session_id=session, pane_id="tool-diff", inputs={"left": "a", "right": "b"})
    stale = client.put(
        f"/api/live-sessions/{session}", json={**before, "state": {}, "base_version": before["version"]}
    )
    assert stale.status_code == 409
    assert _row(session).state["tool-diff.in.left"] == "a"


def test_arrange_dashboard_leaves_a_plan_for_the_browser_to_place(mcp):
    token = _token()
    made = call(
        mcp, token, "create_session", title="s", panes=[{"kind": "tool-base64"}, {"kind": "tool-diff"}]
    )
    call(
        mcp,
        token,
        "arrange_dashboard",
        session_id=made["session_id"],
        rows=[{"height": 400, "panes": [{"pane_id": "tool-base64", "width": 4}, {"pane_id": "tool-diff", "width": 8}]}],
    )
    state = _row(made["session_id"]).state
    assert state["layout"] == "dashboard"
    assert state["dashboardPlan"]["rows"][0]["panes"][1] == {"pane_id": "tool-diff", "width": 8}
    assert state["dashboardPlan"]["id"]
    assert "more than 12" in call_error(
        mcp,
        token,
        "arrange_dashboard",
        session_id=made["session_id"],
        rows=[{"panes": [{"pane_id": "tool-base64", "width": 8}, {"pane_id": "tool-diff", "width": 8}]}],
    )


# ---------------------------------------------------------------- running


def _fake_cloudwatch(monkeypatch, rows: int = 3, polls_before_done: int = 0):
    calls = {"polls": 0}

    def start_query(account_id, region, role_name, log_group_names, query_string, start_time, end_time, limit):
        calls["start"] = (log_group_names, query_string, end_time - start_time, limit)
        return "q-1"

    def get_query_results(account_id, region, role_name, query_id):
        calls["polls"] += 1
        done = calls["polls"] > polls_before_done
        return {
            "status": "Complete" if done else "Running",
            "results": [
                [{"field": "@timestamp", "value": f"2024-01-01 00:00:0{i}"}, {"field": "@message", "value": f"m{i}"},
                 {"field": "@ptr", "value": "opaque"}]
                for i in range(rows)
            ],
            "statistics": {"recordsMatched": rows},
        }

    monkeypatch.setattr(aws_client, "start_query", start_query)
    monkeypatch.setattr(aws_client, "get_query_results", get_query_results)
    monkeypatch.setattr(pane_runs, "POLL_SECONDS", 0.01)
    return calls


def test_run_pane_runs_on_the_server_and_puts_the_rows_in_the_pane(mcp, monkeypatch):
    calls = _fake_cloudwatch(monkeypatch, rows=3, polls_before_done=2)
    token = _token()
    env = _environment()
    session = call(mcp, token, "create_session", title="s", panes=[{"kind": "logs-cloudwatch"}])["session_id"]
    conn = _listen()
    try:
        out = call(
            mcp,
            token,
            "run_pane",
            session_id=session,
            pane_id="logs-cloudwatch",
            inputs={"logGroupSelection": {str(env): ["/app"]}, "queryString": "fields @message", "limit": 50, "preset": 900},
        )
        events = _drain(conn)
    finally:
        conn.close()

    assert calls["start"] == (["/app"], "fields @message", 900, 50)
    assert calls["polls"] == 3
    assert out["status"] == "done" and out["results"]["total"] == 3
    # The sample the model reads leaves out CloudWatch's opaque @ptr.
    assert out["sample"][0] == {"environment": "Prod", "@timestamp": "2024-01-01 00:00:00", "@message": "m0"}

    state = _row(session).state
    results = state["logs-cloudwatch.out.results"]
    assert results[0]["status"] == "Complete" and len(results[0]["rows"]) == 3
    assert state["logs-cloudwatch.out.run"]["status"] == "done"
    assert state["logs-cloudwatch.out.resultsVersion"] == 1 and state["logs-cloudwatch.out.ranAt"] > 0
    # The agent's write of the inputs, then the run's own: started, and each
    # poll that changed something -- the results stream into the pane.
    origins = [e["origin"] for e in events]
    assert origins[0] == "agent" and set(origins[1:]) == {"run"} and len(origins) >= 3


def test_a_run_too_big_for_a_pane_is_cut_down_rather_than_lost(mcp, monkeypatch):
    _fake_cloudwatch(monkeypatch, rows=4)
    monkeypatch.setattr(pane_outputs, "OUTPUT_BYTES", 3000)
    token = _token()
    env = _environment()
    session = call(mcp, token, "create_session", title="s", panes=[{"kind": "logs-cloudwatch"}])["session_id"]
    # Big rows: each message is ~1KB, so four of them don't fit in 3000 bytes.
    monkeypatch.setattr(
        aws_client,
        "get_query_results",
        lambda *a: {"status": "Complete", "results": [[{"field": "@message", "value": "x" * 1000}]] * 4},
    )
    out = call(
        mcp, token, "run_pane", session_id=session, pane_id="logs-cloudwatch",
        inputs={"logGroupSelection": {str(env): ["/app"]}},
    )
    assert "cut down" in out["note"]
    with SessionLocal() as db:
        values = pane_outputs.values_of(db, live_store.get(db, _admin().id, session), "logs-cloudwatch")
    assert 0 < len(values["results"][0]["rows"]) < 4
    assert pane_outputs.output_bytes(values) <= 3000


def test_a_run_that_needs_its_inputs_says_which(mcp):
    token = _token()
    session = call(mcp, token, "create_session", title="s", panes=[{"kind": "logs-cloudwatch"}])["session_id"]
    assert "log group" in call_error(mcp, token, "run_pane", session_id=session, pane_id="logs-cloudwatch")


def test_sending_an_http_request_waits_for_approval_but_the_request_is_filled_in(mcp):
    token = _token()
    session = call(mcp, token, "create_session", title="s", panes=[{"kind": "tool-http"}])["session_id"]
    error = call_error(
        mcp,
        token,
        "run_pane",
        session_id=session,
        pane_id="tool-http",
        inputs={"method": "POST", "url": "https://example.com/x", "headerRows": {"X-A": "1"}},
    )
    assert "approval" in error
    state = _row(session).state
    assert state["tool-http.in.method"] == "POST"
    assert state["tool-http.in.headerRows"][0] == {"id": 1, "key": "X-A", "value": "1"}
    assert "tool-http.out.response" not in state


def test_base64_is_worked_out_for_the_agent_too(mcp):
    token = _token()
    session = call(mcp, token, "create_session", title="s", panes=[{"kind": "tool-base64"}])["session_id"]
    out = call(mcp, token, "run_pane", session_id=session, pane_id="tool-base64", inputs={"input": "hi there"})
    assert out["output"] == "aGkgdGhlcmU="
    # Where to look, by the names the user sees, for the answer to point at.
    assert out["shown_in"] == 'the Base64 pane of the session "s"'
    out = call(
        mcp, token, "run_pane", session_id=session, pane_id="tool-base64", inputs={"mode": "decode", "input": "aGk"}
    )
    assert out["output"] == "hi"


def test_get_session_reports_inputs_and_result_counts(mcp, monkeypatch):
    _fake_cloudwatch(monkeypatch, rows=2)
    token = _token()
    env = _environment()
    session = call(mcp, token, "create_session", title="s", panes=[{"kind": "logs-cloudwatch"}])["session_id"]
    call(
        mcp, token, "run_pane", session_id=session, pane_id="logs-cloudwatch",
        inputs={"logGroupSelection": {str(env): ["/app"]}},
    )
    described = call(mcp, token, "get_session", session_id=session)
    pane = described["panes"][0]
    assert pane["inputs"]["logGroupSelection"] == {str(env): ["/app"]}
    assert pane["results"]["results"] == 1 and "last_run" in pane


def test_a_query_still_running_is_left_running_and_the_agent_can_stop_it(mcp, monkeypatch):
    # It used to be stopped at the agent's 90 s; now it keeps running in the
    # pane, results arriving, and stop_pane is the agent's Stop button.
    calls = _fake_cloudwatch(monkeypatch, rows=2, polls_before_done=10_000)
    stopped: list[str] = []
    monkeypatch.setattr(aws_client, "stop_query", lambda a, r, i, q: stopped.append(q))
    from app.platform_tools import server

    monkeypatch.setattr(server, "BACKGROUND_WAIT_SECONDS", 1.5)
    token = _token()
    env = _environment()
    session = call(mcp, token, "create_session", title="s", panes=[{"kind": "logs-cloudwatch"}])["session_id"]
    out = call(
        mcp, token, "run_pane", session_id=session, pane_id="logs-cloudwatch",
        inputs={"logGroupSelection": {str(env): ["/app"]}},
    )
    assert out["status"] == "running" and "keeps running" in out["note"] and calls["polls"] >= 1
    assert out["results"]["total"] == 2 and stopped == []

    kinds = {k["kind"]: k for k in call(mcp, token, "get_context")["pane_kinds"]}
    assert "stop_pane" in kinds["logs-cloudwatch"] and "stop_pane" not in kinds["logs-opensearch"]
    assert call(mcp, token, "stop_pane", session_id=session, pane_id="logs-cloudwatch")["stopped"] is True
    assert stopped == ["q-1"]
    assert _row(session).state["logs-cloudwatch.out.run"]["status"] == "stopped"
    again = call(mcp, token, "stop_pane", session_id=session, pane_id="logs-cloudwatch")
    assert again["stopped"] is False and "Nothing was running" in again["note"]


def test_list_options_lists_the_logs_pickers_choices_level_by_level(mcp, monkeypatch):
    # The agent's own list_log_groups and list_opensearch_* went with the old
    # routes (D49); list_options lists the same, from the panes' loaders.
    from app import opensearch_client

    monkeypatch.setattr(
        aws_client, "list_log_groups", lambda a, r, i: [{"name": n} for n in ("/app/api", "/app/worker", "/infra/lb")]
    )
    monkeypatch.setattr(
        opensearch_client, "list_domains", lambda a, r, i: [{"domain_name": "d", "endpoint": "d.example", "engine_version": "2"}]
    )
    asked: list = []

    def list_indices(a, r, i, endpoint):
        asked.append(endpoint)
        return [{"index": "logs-1", "docs_count": 5}, {"index": "audit", "docs_count": 1}]

    monkeypatch.setattr(opensearch_client, "list_indices", list_indices)
    token = _token()
    env = _environment()
    session = call(mcp, token, "create_session", title="s", panes=[{"kind": "logs-cloudwatch"}, {"kind": "logs-opensearch"}])["session_id"]

    groups = call(mcp, token, "list_options", session_id=session, pane_id="logs-cloudwatch", input="logGroupSelection",
                  inputs={"connections": [env]}, contains="app")
    assert groups["groups"] == [{"environment_id": env, "environment": "Prod", "items": ["/app/api", "/app/worker"]}]

    domains = call(mcp, token, "list_options", session_id=session, pane_id="logs-opensearch", input="openSearchSelection",
                   inputs={"connections": [env]})
    assert domains["groups"][0]["items"] == [{"domain_name": "d", "endpoint": "d.example", "engine_version": "2"}]
    assert "parent" in domains["next"]
    indices = call(mcp, token, "list_options", session_id=session, pane_id="logs-opensearch", input="openSearchSelection",
                   parent={"connection": "Prod", "domainEndpoint": "d.example"})
    assert [o["value"] for o in indices["options"]] == ["logs-1", "audit"] and asked == ["d.example"]
    assert "one level" in call_error(mcp, token, "list_options", session_id=session, pane_id="logs-cloudwatch",
                                     input="logGroupSelection", parent={"connection": env})


def test_what_get_session_shows_of_an_input_set_pane_inputs_takes_back(mcp):
    # Shown the query as the rows its editor keeps, a model sent `query: []`
    # back, was refused, and the turn ended with no answer.
    token = _token()
    session = call(mcp, token, "create_session", title="t", panes=[{"kind": "api-table"}])["session_id"]
    set_ = call(mcp, token, "set_pane_inputs", session_id=session, pane_id="api-table", inputs={"query": {"page": "2"}})
    assert set_["pane"]["inputs"]["query"] == {"page": "2"}
    shown = call(mcp, token, "get_session", session_id=session)["panes"][0]["inputs"]["query"]
    assert shown == {"page": "2"}
    for sent, kept in (
        (shown, {"page": "2"}),
        ([], {}),
        ([{"id": 1, "key": "limit", "value": "5"}, {"id": 2, "key": "", "value": ""}], {"limit": "5"}),
    ):
        out = call(mcp, token, "set_pane_inputs", session_id=session, pane_id="api-table", inputs={"query": sent})
        assert out["pane"]["inputs"]["query"] == kept
    assert "e.g." in call_error(mcp, token, "set_pane_inputs", session_id=session, pane_id="api-table", inputs={"query": "x"})


def test_get_context_gives_each_kind_its_catalogue_category(mcp):
    # The category it's listed under (D66) -- renamed by an admin, the new name.
    tools = next(c for c in client.get("/api/catalogue").json()["categories"] if c["name"] == "Tools")
    client.put(f"/api/catalogue/categories/{tools['id']}", json={"name": "Utilities"})
    kinds = {k["kind"]: k for k in call(mcp, _token(), "get_context")["pane_kinds"]}
    assert kinds["tool-base64"]["category"] == "Utilities"
    assert kinds["iot"]["category"] == "Services"
