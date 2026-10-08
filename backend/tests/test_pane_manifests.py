"""Pane manifests (PLATFORM_PLAN.md §15): the YAML each pane type is described
by, the agent's kinds generated from it, the v2 state shape and its
migration, the live functions' Python twins, and the API table's declarative
request -- a pane drawn and run from its manifest alone.

The twins are held to `fixtures/live_functions.json`: outputs the browser's
own Base64, Diff and JWT tools computed before the port, so the agent's run
and the pane's display can't drift apart."""

import json
from pathlib import Path

import pytest

from app import models, tools_http_client
from app.db import SessionLocal
from app.panes import live
from app.panes import manifest as pane_manifest
from app.panes import state as pane_state
from app.platform_tools import panes
from tests.conftest import client
from tests.test_connections import _group, _http_env, master_key  # noqa: F401 -- a fixture
from tests.test_platform_tools import _admin, _row, _token, call, call_error, mcp  # noqa: F401 -- a fixture

FIXTURES = json.loads((Path(__file__).parent / "fixtures" / "live_functions.json").read_text())


# ---------------------------------------------------------------- manifests


def test_every_manifest_loads_and_every_kind_comes_from_one():
    manifests = pane_manifest.manifests()
    assert set(panes.KINDS) == set(manifests)
    # In catalogue order, services before tools.
    assert list(manifests)[:2] == ["logs-cloudwatch", "logs-opensearch"]
    for m in manifests.values():
        kind = panes.KINDS[m.id]
        assert kind.label == m.label and kind.flag == m.flag
        assert [i.key for i in kind.inputs] == [i.key for i in m.agent_inputs()]


def test_a_sensitive_input_never_reaches_the_agent():
    jwt = pane_manifest.get("tool-jwt")
    assert jwt.inputs and all(i.sensitive for i in jwt.inputs)
    assert panes.KINDS["tool-jwt"].inputs == ()
    # ...nor the migration: there is no legacy key to carry over.
    assert jwt.legacy_map() == {}


def test_a_manifest_with_a_typo_fails_naming_its_file(tmp_path):
    path = tmp_path / "broken.yaml"
    path.write_text(
        "id: broken\nlabel: B\nflag: tools_enabled\nabout: x\nstate: v2\nrendered: true\n"
        "inputs: [{key: a, type: text}]\nlayout: [{title: T, items: [{input: b}]}]\n"
    )
    with pytest.raises(pane_manifest.ManifestError) as e:
        pane_manifest._load(path)
    assert "broken.yaml" in str(e.value) and "input b" in str(e.value)

    path.write_text("id: other\nlabel: B\nflag: tools_enabled\nabout: x\n")
    with pytest.raises(pane_manifest.ManifestError, match="named after 'broken'"):
        pane_manifest._load(path)


def test_an_action_says_exactly_one_thing_it_does():
    with pytest.raises(ValueError, match="exactly one"):
        pane_manifest.ManifestAction(id="a", live="x", handler="y")


def test_pane_types_are_only_those_the_group_may_use():
    everything = client.get("/api/pane-types").json()
    assert {m["id"] for m in everything} == set(pane_manifest.manifests())
    base64 = next(m for m in everything if m["id"] == "tool-base64")
    # As the YAML spells it, for the renderer: `copy`, not the model's copy_of.
    aside = base64["layout"][1]["aside"]
    assert aside == [{"copy": "output"}]

    group = client.post("/api/user-groups", json={
        "name": "logs-only", "opensearch_enabled": False, "iot_enabled": False, "tables_enabled": False,
        "buckets_enabled": False, "cognito_enabled": False, "tools_enabled": False}).json()
    client.post("/api/users", json={"username": "lo", "password": "pw-123456", "group_id": group["id"]})
    from tests.test_connections import _login_as

    as_lo = _login_as("lo", "pw-123456")
    assert [m["id"] for m in as_lo.get("/api/pane-types").json()] == ["logs-cloudwatch"]
    assert as_lo.post("/api/panes/api-table/actions/fetch", json={"inputs": {}}).status_code == 404


# ---------------------------------------------------------------- state


def _legacy_state() -> dict:
    return {
        "services": ["tool-base64", "tool-diff~2", "logs-cloudwatch"],
        "paneTypes": {"tool-diff~2": "tool-diff"},
        "tool-base64.mode": "decode",
        "tool-base64.input": "aGk=",
        "tool-base64.urlSafe": True,
        "tool-diff~2.left": "a",
        "tool-diff~2.right": "b",
        "tool-diff~2.viewMode": "split",
        # Not ported yet: its keys stay where its page reads them.
        "logs-cloudwatch.queryString": "fields @message",
        # A closed pane's leftovers aren't anyone's to move.
        "tool-diff.left": "old",
    }


def test_the_migration_moves_a_ported_panes_keys_and_nothing_else():
    migrated = pane_state.migrate(_legacy_state())
    assert migrated["tool-base64.in.mode"] == "decode"
    assert migrated["tool-base64.in.input"] == "aGk="
    assert migrated["tool-base64.in.urlSafe"] is True
    assert migrated["tool-diff~2.in.left"] == "a" and migrated["tool-diff~2.in.viewMode"] == "split"
    assert "tool-base64.input" not in migrated and "tool-diff~2.left" not in migrated
    assert migrated["logs-cloudwatch.queryString"] == "fields @message"
    assert migrated["tool-diff.left"] == "old"
    # Idempotent, and a state already migrated is handed back as it is.
    assert pane_state.migrate(migrated) is migrated


def test_a_new_key_already_written_wins_over_a_stale_legacy_one():
    # A tab from before the deploy saves the old key after the new code wrote
    # the new one: the new one is what the pane has been showing.
    state = {"services": ["tool-base64"], "tool-base64.in.input": "new", "tool-base64.input": "old"}
    assert pane_state.migrate(state) == {"services": ["tool-base64"], "tool-base64.in.input": "new"}


def test_a_session_saved_before_the_port_opens_in_the_new_shape():
    # Written straight to the table, as rows saved before the deploy are.
    db = SessionLocal()
    try:
        db.add(
            models.LiveSession(
                user_id=_admin().id, client_id="old-one", type="aggregator", title="Old", position=0,
                state=_legacy_state(), truncated=False, version=3,
            )
        )
        db.commit()
    finally:
        db.close()
    got = client.get("/api/live-sessions/old-one").json()
    assert got["state"]["tool-base64.in.input"] == "aGk=" and "tool-base64.input" not in got["state"]
    assert got["version"] == 3  # read, not written


def test_a_tab_from_before_the_deploy_saves_the_old_keys_and_they_land_in_the_new_shape():
    resp = client.put(
        "/api/live-sessions/s1", json={"title": "S", "type": "aggregator", "state": _legacy_state(), "base_version": None}
    )
    assert resp.status_code == 200, resp.text
    stored = _row("s1").state
    assert stored["tool-diff~2.in.right"] == "b" and "tool-diff~2.right" not in stored


def test_the_agent_writes_a_ported_pane_in_the_new_shape(mcp):
    token = _token()
    session = call(mcp, token, "create_session", title="s", panes=[{"kind": "tool-base64"}])["session_id"]
    call(mcp, token, "set_pane_inputs", session_id=session, pane_id="tool-base64", inputs={"input": "hi there"})
    state = _row(session).state
    assert state["tool-base64.in.input"] == "hi there" and "tool-base64.input" not in state
    described = call(mcp, token, "get_session", session_id=session)
    pane = next(p for p in described["panes"] if p["pane_id"] == "tool-base64")
    assert pane["inputs"]["input"] == "hi there"


# ---------------------------------------------------------------- live functions


@pytest.mark.parametrize("case", FIXTURES["cases"], ids=lambda c: f"{c['function']}:{json.dumps(c['inputs'])[:40]}")
def test_the_twins_answer_as_the_browser_did(case):
    assert live.FUNCTIONS[case["function"]](case["inputs"]) == case["expected"]


def test_every_live_function_a_manifest_names_has_a_twin():
    named = {a.live for m in pane_manifest.manifests().values() for a in m.actions if a.live}
    assert named <= set(live.FUNCTIONS)
    assert {c["function"] for c in FIXTURES["cases"]} == set(live.FUNCTIONS)


def test_the_agent_runs_a_live_pane_through_its_twin(mcp):
    token = _token()
    session = call(
        mcp, token, "create_session", title="s", panes=[{"kind": "tool-base64"}, {"kind": "tool-diff"}]
    )["session_id"]
    ran = call(mcp, token, "run_pane", session_id=session, pane_id="tool-base64", inputs={"input": "hello world"})
    assert ran["output"] == "aGVsbG8gd29ybGQ="
    ran = call(mcp, token, "run_pane", session_id=session, pane_id="tool-diff", inputs={"left": "a\nb\n", "right": "a\nc\n"})
    assert ran["counts"] == "1 removal, 1 addition"
    assert ran["diff"][1] == {"type": "modify", "left": "b", "right": "c"}
    # A failed decode is a failed run, in the pane's own words.
    error = call_error(
        mcp, token, "run_pane", session_id=session, pane_id="tool-base64", inputs={"mode": "decode", "input": "!!"}
    )
    assert "valid Base64" in error


# ---------------------------------------------------------------- the API table


@pytest.fixture
def partner(master_key, monkeypatch):  # noqa: F811 -- the fixture, by name
    """A group that can reach one HTTP API connection, and every request sent there."""
    sent: list[dict] = []
    reply = {"status_code": 200, "status_text": "OK", "body": "", "body_truncated": False}

    def fake_send(method, url, headers=None, body=None, timeout=30):
        sent.append({"method": method, "url": url, "headers": dict(headers or {})})
        return {**reply, "headers": [], "elapsed_ms": 1}

    monkeypatch.setattr(tools_http_client, "send_request", fake_send)
    group_id, as_g = _group("Partners", [], role_name=None)
    conn = _http_env(group_id)
    return {"group_id": group_id, "client": as_g, "conn": conn, "sent": sent, "reply": reply}


def _fetch(c, inputs: dict):
    return c.post("/api/panes/api-table/actions/fetch", json={"inputs": inputs})


def test_fetch_reads_the_rows_from_the_reply(partner):
    partner["reply"]["body"] = json.dumps({"data": {"items": [{"id": 1, "name": "a"}, {"id": 2, "name": "b"}]}})
    resp = _fetch(
        partner["client"],
        {"connection": partner["conn"]["id"], "path": "/orders", "rowsAt": "data.items",
         "query": [{"id": 1, "key": "status", "value": "open"}, {"id": 2, "key": "", "value": ""}]},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["rows"] == [{"id": 1, "name": "a"}, {"id": 2, "name": "b"}]
    assert resp.json()["response"]["data"]["items"][0]["id"] == 1
    assert partner["sent"] == [
        {"method": "GET", "url": "https://api.example.com/v1/orders?status=open", "headers": {"Accept": "application/json"}}
    ]


def test_fetch_signs_with_the_groups_identity_and_masks_it_in_the_reply(partner):
    own = client.post("/api/credentials", json={
        "name": "partners-own", "type_id": "api_token", "scope": "group", "group_id": partner["group_id"],
        "values": {"token": "group-token-9"}}).json()
    client.put(f"/api/user-groups/{partner['group_id']}/identities",
               json={"identities": [{"connection_type_id": "http_api", "credential_id": own["id"]}]})
    partner["reply"]["body"] = json.dumps([{"echo": "Bearer group-token-9"}])
    resp = _fetch(partner["client"], {"connection": partner["conn"]["id"], "path": "echo"})
    assert resp.status_code == 200, resp.text
    assert partner["sent"][0]["headers"]["Authorization"] == "Bearer group-token-9"
    assert "group-token-9" not in resp.text


@pytest.mark.parametrize(
    ("reply", "inputs", "said"),
    [
        ({"status_code": 404, "status_text": "Not Found", "body": "nope"}, {}, "answered HTTP 404"),
        ({"body": "<html>"}, {}, "isn't JSON"),
        ({"body": "x" * 10, "body_truncated": True}, {}, "too large"),
        ({"body": '{"data": []}'}, {"rowsAt": "data.items"}, "nothing at 'data.items'"),
    ],
)
def test_fetch_says_what_went_wrong(partner, reply, inputs, said):
    partner["reply"].update(reply)
    resp = _fetch(partner["client"], {"connection": partner["conn"]["id"], "path": "/x", **inputs})
    assert resp.status_code == 400 and said in resp.json()["detail"]


def test_fetch_needs_a_connection_the_group_can_reach(partner):
    assert "Pick a connection" in _fetch(partner["client"], {"path": "/x"}).json()["detail"]
    other = client.post("/api/environments", json={"name": "Elsewhere"}).json()
    conn = client.post(f"/api/environments/{other['id']}/connections", json={
        "type_id": "http_api", "name": "api", "config": {"base_url": "https://elsewhere.example.com"}}).json()
    resp = _fetch(partner["client"], {"connection": conn["id"], "path": "/x"})
    assert resp.status_code == 400 and partner["sent"] == []


def test_fetch_keeps_the_ssrf_guard():
    group_id, as_g = _group("Inside", [], role_name=None)
    env = client.post("/api/environments", json={"name": "Inside"}).json()
    conn = client.post(f"/api/environments/{env['id']}/connections", json={
        "type_id": "http_api", "name": "api", "config": {"base_url": "http://127.0.0.1:8000"}}).json()
    client.put(f"/api/environments/{env['id']}/groups", json={"group_ids": [group_id]})
    resp = _fetch(as_g, {"connection": conn["id"], "path": "/api/auth/me"})
    assert resp.status_code == 400 and "127.0.0.1" in resp.json()["detail"]


def test_only_a_request_action_runs_on_the_server():
    assert client.post("/api/panes/tool-base64/actions/convert", json={"inputs": {}}).status_code == 404
    assert client.post("/api/panes/nothing/actions/fetch", json={"inputs": {}}).status_code == 404


def test_the_agent_fetches_into_the_pane(partner, mcp):
    partner["reply"]["body"] = json.dumps({"items": [{"sku": f"S{i}"} for i in range(30)]})
    # The admin can reach every connection, by its name as get_context lists it.
    token = _token()
    context = call(mcp, token, "get_context")
    assert {"id": partner["conn"]["id"], "name": "Partner", "base_url": "https://api.example.com/v1"} in context["http_apis"]
    session = call(mcp, token, "create_session", title="s", panes=[{"kind": "api-table"}])["session_id"]
    ran = call(
        mcp, token, "run_pane", session_id=session, pane_id="api-table",
        inputs={"connection": "Partner", "path": "/stock", "rowsAt": "items", "query": {"warehouse": "north"}},
    )
    assert ran["rows"] == 30 and ran["sample"][0] == {"sku": "S0"}
    state = _row(session).state
    assert state["api-table.in.connection"] == partner["conn"]["id"]
    assert state["api-table.in.query"][0] == {"id": 1, "key": "warehouse", "value": "north"}
    assert len(state["api-table.out.rows"]) == 30 and state["api-table.out.resultsVersion"] == 1
    assert partner["sent"][-1]["url"] == "https://api.example.com/v1/stock?warehouse=north"
    looked = call(mcp, token, "inspect_row", session_id=session, pane_id="api-table", row=29)
    assert looked["of"] == 30 and looked["detail"] == {"sku": "S29"}
