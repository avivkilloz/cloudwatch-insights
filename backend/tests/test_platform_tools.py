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

from app import aws_client, live_store, models
from app.db import SessionLocal
from app.main import app
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
    db = SessionLocal()
    try:
        return live_store.get(db, _admin().id, client_id)
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
    # Every kind the group has is offered, the browser-only ones too -- with
    # nothing to fill in, and a run that says why.
    mqtt = next(k for k in context["pane_kinds"] if k["kind"] == "tool-mqtt")
    assert mqtt["inputs"] == [] and "browser" in mqtt["run"]
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
    token = _token()
    session = call(mcp, token, "create_session", title="s", panes=[{"kind": "tool-diff"}])["session_id"]
    added = call(mcp, token, "add_pane", session_id=session, kind="tool-mqtt")
    assert added["pane_id"] == "tool-mqtt"
    call(mcp, token, "add_pane", session_id=session, kind="tool-jwt")
    state = _row(session).state
    assert state["services"] == ["tool-diff", "tool-mqtt", "tool-jwt"]

    error = call_error(mcp, token, "set_pane_inputs", session_id=session, pane_id="tool-mqtt", inputs={"topic": "a/b"})
    assert "Connect" in error
    assert "browser" in call_error(mcp, token, "run_pane", session_id=session, pane_id="tool-jwt")
    described = call(mcp, token, "get_session", session_id=session)
    mqtt = next(p for p in described["panes"] if p["pane_id"] == "tool-mqtt")
    assert mqtt["title"] == "MQTT tester" and "Connect" in mqtt["note"]


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
    assert state["logs-cloudwatch.logGroupSelection"] == {str(env): {"__cwiSet": ["/aws/lambda/checkout"]}}
    # Picking log groups ticks their environment, as it does by hand.
    assert state["logs-cloudwatch.selectedEnvironmentIds"] == {"__cwiSet": [env]}
    assert state["logs-cloudwatch.preset"] == 3600

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


def test_a_browser_holding_an_old_version_is_refused_after_the_agent_writes(mcp):
    token = _token()
    session = call(mcp, token, "create_session", title="s", panes=[{"kind": "tool-diff"}])["session_id"]
    before = client.get(f"/api/live-sessions/{session}").json()
    call(mcp, token, "set_pane_inputs", session_id=session, pane_id="tool-diff", inputs={"left": "a", "right": "b"})
    stale = client.put(
        f"/api/live-sessions/{session}", json={**before, "state": {}, "base_version": before["version"]}
    )
    assert stale.status_code == 409
    assert _row(session).state["tool-diff.left"] == "a"


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
    monkeypatch.setattr(panes, "POLL_SECONDS", 0.01)
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
    assert out["total_rows"] == 3 and out["targets"][0]["status"] == "Complete"
    # The sample the model reads leaves out CloudWatch's opaque @ptr.
    assert out["sample"][0] == {"@timestamp": "2024-01-01 00:00:00", "@message": "m0"}

    state = _row(session).state
    results = state["logs-cloudwatch.results"]
    assert results[0]["status"] == "Complete" and len(results[0]["rows"]) == 3
    assert state["logs-cloudwatch.osResults"] == []
    assert state["logs-cloudwatch.resultsVersion"] == 1 and state["logs-cloudwatch.ranAt"] > 0
    # Two announced writes: the inputs as the run started, then its results.
    assert [e["origin"] for e in events] == ["agent", "agent"]


def test_a_run_too_big_for_a_pane_is_cut_down_rather_than_lost(mcp, monkeypatch):
    _fake_cloudwatch(monkeypatch, rows=4)
    monkeypatch.setattr(live_store, "BROWSER_STATE_BYTES", 3000)
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
    state = _row(session).state
    assert 0 < len(state["logs-cloudwatch.results"][0]["rows"]) < 4
    assert live_store.state_bytes(state) <= 3000


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
    assert state["tool-http.method"] == "POST"
    assert state["tool-http.headerRows"][0] == {"id": 1, "key": "X-A", "value": "1"}
    assert "tool-http.response" not in state


def test_base64_is_worked_out_for_the_agent_too(mcp):
    token = _token()
    session = call(mcp, token, "create_session", title="s", panes=[{"kind": "tool-base64"}])["session_id"]
    out = call(mcp, token, "run_pane", session_id=session, pane_id="tool-base64", inputs={"input": "hi there"})
    assert out["output"] == "aGkgdGhlcmU="
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
