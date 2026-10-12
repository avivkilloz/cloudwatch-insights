"""DynamoDB, Cognito and S3 as manifest panes (PLATFORM_PLAN.md §16.3).

One action endpoint for the browser and the agent: the pane calls
`POST /api/panes/{type}/actions/{action}`, `run_pane` calls the same handler,
and both get the same outputs. These pin that, the manifest's `requires`,
paging, resets, the v2 keys a session saved before the port moves to, and
saved inputs (D46) with their once-only migration. AWS itself is stubbed at
the client modules, as test_connections does.
"""

import pytest

from app import cognito_client, dynamodb_client, models, s3_client
from app.db import SessionLocal
from app.panes import saved as pane_saved
from app.panes import state as pane_state
from tests.conftest import client
from tests.test_connections import _group
from tests.test_platform_tools import _environment, _row, _token, call, call_error, mcp  # noqa: F401 -- a fixture


@pytest.fixture
def aws(monkeypatch) -> dict:
    """Every stubbed AWS call, with what it was asked for."""
    calls: dict[str, list] = {"scan": [], "browse": [], "users": []}

    monkeypatch.setattr(dynamodb_client, "list_tables", lambda *a: ["Orders", "Users"])
    monkeypatch.setattr(
        dynamodb_client,
        "describe_table",
        lambda a, r, i, name: {"table_name": name, "status": "ACTIVE", "item_count": 3, "size_bytes": 9,
                               "partition_key": "id", "sort_key": None},
    )

    def scan(account, region, identity, table, query="", limit=25, start=None):
        calls["scan"].append({"table": table, "query": query, "limit": limit, "start": start})
        page = [{"id": "3"}] if start else [{"id": "1"}, {"id": "2"}]
        return {"items": page, "scanned_count": len(page) + 1, "count": len(page), "last_evaluated_key": None if start else "k1"}

    monkeypatch.setattr(dynamodb_client, "scan_items", scan)
    monkeypatch.setattr(cognito_client, "list_user_pools", lambda *a: [{"id": "p1", "name": "Main"}, {"id": "p2", "name": None}])

    def users(account, region, identity, pool, query="", limit=30, token=None):
        calls["users"].append({"pool": pool, "query": query, "token": token})
        return {"users": [{"username": "jane", "status": "CONFIRMED", "enabled": True, "created": None,
                           "last_modified": None, "attributes": {"email": "jane@example.com"}}],
                "pagination_token": None}

    monkeypatch.setattr(cognito_client, "search_users", users)
    monkeypatch.setattr(s3_client, "list_buckets", lambda *a: [{"name": "logs", "creation_date": None}])

    def browse(account, region, identity, bucket, prefix="", search="", max_results=200, token=None):
        calls["browse"].append({"bucket": bucket, "prefix": prefix, "search": search, "token": token})
        return {"bucket": bucket, "bucket_region": "eu-west-1", "prefix": prefix,
                "folders": [{"name": "2024", "prefix": f"{prefix}2024/"}],
                "files": [{"key": f"{prefix}a.txt", "name": "a.txt", "size": 1, "last_modified": None, "storage_class": None}],
                "continuation_token": None}

    monkeypatch.setattr(s3_client, "browse_bucket", browse)
    return calls


def _act(type_: str, action: str, inputs: dict, cursor=None, c=client):
    return c.post(f"/api/panes/{type_}/actions/{action}", json={"inputs": inputs, "cursor": cursor})


# ---------------------------------------------------------------- the endpoint


def test_loaders_answer_with_options(aws):
    env = _environment()
    assert _act("tables", "list_tables", {"connection": env}).json() == {
        "options": [{"value": "Orders", "label": "Orders"}, {"value": "Users", "label": "Users"}]
    }
    assert _act("cognito", "list_user_pools", {"connection": env}).json()["options"] == [
        {"value": "p1", "label": "Main (p1)"},
        {"value": "p2", "label": "p2 (p2)"},
    ]
    assert _act("buckets", "list_buckets", {"connection": env}).json() == {"options": [{"value": "logs", "label": "logs"}]}


def test_a_missing_input_is_the_manifests_own_sentence(aws):
    resp = _act("tables", "scan", {"connection": _environment()})
    assert resp.status_code == 400 and resp.json()["detail"] == "Choose a table first."
    assert _act("buckets", "browse", {}).json()["detail"] == "Choose an environment first."
    assert aws["scan"] == []


def test_scan_pages_with_the_cursor_it_returned(aws):
    env = _environment()
    first = _act("tables", "scan", {"connection": env, "tableName": "Orders", "queryString": "status:x", "limit": 900}).json()
    assert first == {"items": [{"id": "1"}, {"id": "2"}], "lastEvaluatedKey": "k1", "scannedCount": 3}
    more = _act("tables", "scan", {"connection": env, "tableName": "Orders"}, cursor=first["lastEvaluatedKey"]).json()
    assert more["items"] == [{"id": "3"}] and more["lastEvaluatedKey"] is None
    # The limit is held to the page's own bounds; the cursor goes to AWS as is.
    assert aws["scan"][0]["limit"] == 200 and aws["scan"][1]["start"] == "k1"


def test_browse_takes_its_inputs_and_doesnt_write_them_back(aws):
    out = _act("buckets", "browse", {"connection": _environment(), "bucket": "logs", "prefix": "a/", "search": "x"}).json()
    assert set(out) == {"bucketRegion", "activeSearch", "folders", "files", "continuationToken"}
    assert out["activeSearch"] == "x" and aws["browse"][0] == {"bucket": "logs", "prefix": "a/", "search": "x", "token": None}


def test_the_groups_flag_and_its_environments_still_decide(aws):
    env = _environment()
    _, as_g = _group("NoTables", [env])
    client.put(f"/api/user-groups/{_group_id('NoTables')}", json={"tables_enabled": False})
    assert _act("tables", "list_tables", {"connection": env}, c=as_g).status_code == 404
    other = _environment("Elsewhere", "999988887777")
    resp = _act("cognito", "list_user_pools", {"connection": other}, c=as_g)
    assert resp.status_code == 400 and "not configured" in resp.json()["detail"]


def _group_id(name: str) -> int:
    return next(g["id"] for g in client.get("/api/user-groups").json() if g["name"] == name)


# ---------------------------------------------------------------- the agent


def test_the_agent_runs_the_same_handlers_into_the_v2_keys(aws, mcp):
    token = _token()
    env = _environment()
    session = call(mcp, token, "create_session", title="s", panes=[{"kind": "tables"}])["session_id"]
    ran = call(mcp, token, "run_pane", session_id=session, pane_id="tables",
               inputs={"connection": env, "tableName": "Orders", "queryString": "status:x"})
    assert ran["items"] == 2 and ran["more"] is True and ran["sample"][0] == {"id": "1"}
    state = _row(session).state
    assert state["tables.in.connection"] == env and state["tables.in.tableName"] == "Orders"
    assert state["tables.out.tableInfo"]["partition_key"] == "id"  # described first, as picking it does
    assert state["tables.out.items"] == [{"id": "1"}, {"id": "2"}] and state["tables.out.lastEvaluatedKey"] == "k1"
    assert state["tables.out.resultsVersion"] == 1 and state["tables.view.expanded"] == []
    assert "tables.items" not in state and "tables.tables" not in state

    # Another table clears the last one's results, as picking it in the pane does.
    call(mcp, token, "set_pane_inputs", session_id=session, pane_id="tables", inputs={"tableName": "Users"})
    state = _row(session).state
    assert "tables.out.items" not in state and "tables.out.tableInfo" not in state

    looked = call(mcp, token, "run_pane", session_id=session, pane_id="tables")
    assert looked["tableInfo"]["table_name"] == "Users"
    assert call(mcp, token, "inspect_row", session_id=session, pane_id="tables", row=1)["detail"] == {"id": "2"}


def test_the_agent_names_the_connection_as_it_named_environments(aws, mcp):
    token = _token()
    _environment("Partner", "123456789012")
    session = call(mcp, token, "create_session", title="s", panes=[{"kind": "buckets"}])["session_id"]
    ran = call(mcp, token, "run_pane", session_id=session, pane_id="buckets",
               inputs={"connection": "Partner", "bucket": "logs", "prefix": "a/"})
    assert ran["files"] == 1 and ran["folders"] == 1
    described = [k for k in call(mcp, token, "get_context")["pane_kinds"] if k["kind"] == "buckets"][0]
    assert described["inputs"][0] == {"key": "connection", "type": "environment id (get_context's environments)",
                                      "help": "The environment the bucket is in."}
    # A missing input is the same sentence the pane shows.
    assert "Choose a bucket first." in call_error(mcp, token, "run_pane", session_id=session, pane_id="buckets",
                                                  inputs={"bucket": ""})


# ---------------------------------------------------------------- state


def test_a_session_saved_before_the_port_moves_to_the_new_keys():
    legacy = {
        "services": ["tables", "cognito"],
        "tables.environmentId": 4, "tables.tableName": "Orders", "tables.tables": ["Orders"],
        "tables.items": [{"id": "1"}], "tables.expanded": {"__cwiSet": [0]}, "tables.ranAt": 5, "tables.resultsVersion": 2,
        "cognito.environmentId": 4, "cognito.userPools": [{"id": "p"}], "cognito.paginationToken": "t",
    }
    moved = pane_state.migrate(legacy)
    assert moved["tables.in.connection"] == 4 and moved["tables.in.tableName"] == "Orders"
    assert moved["tables.out.items"] == [{"id": "1"}] and moved["tables.view.expanded"] == {"__cwiSet": [0]}
    assert moved["tables.out.ranAt"] == 5 and moved["tables.out.resultsVersion"] == 2
    assert moved["cognito.out.paginationToken"] == "t"
    # Picker options aren't session state any more (D47).
    assert not any(k.endswith((".tables", ".userPools")) for k in moved)
    assert pane_state.migrate(moved) is moved


# ---------------------------------------------------------------- saved inputs


def test_saved_inputs_keep_only_a_panes_own_non_sensitive_inputs():
    made = client.post("/api/saved-inputs", json={
        "pane_type": "tool-jwt", "name": "token", "inputs": {"token": "eyJ.secret.sig", "mode": "decode"}}).json()
    assert made["inputs"] == {}  # every JWT input is sensitive
    made = client.post("/api/saved-inputs", json={
        "pane_type": "tables", "name": "orders", "inputs": {"connection": 3, "tableName": "Orders", "rogue": 1}}).json()
    assert made["inputs"] == {"connection": 3, "tableName": "Orders"}
    assert client.post("/api/saved-inputs", json={"pane_type": "nothing", "name": "x", "inputs": {}}).status_code == 400

    renamed = client.put(f"/api/saved-inputs/{made['id']}", json={"name": "Orders table"}).json()
    assert renamed["name"] == "Orders table"
    assert [s["name"] for s in client.get("/api/saved-inputs?pane_type=tables").json()] == ["Orders table"]

    _, other = _group("Others", [])
    assert other.get("/api/saved-inputs").json() == []
    assert other.delete(f"/api/saved-inputs/{made['id']}").status_code == 404
    assert client.delete(f"/api/saved-inputs/{made['id']}").status_code == 204


def test_saved_tables_and_buckets_move_into_saved_inputs_once():
    client.post("/api/saved-sessions", json={"page": "tables", "name": "Orders", "state": {"environment_id": 7, "table_name": "Orders"}})
    client.post("/api/saved-sessions", json={"page": "buckets", "name": "Logs", "state": {"environment_id": 7, "bucket": "logs"}})
    client.post("/api/saved-sessions", json={"page": "aggregator", "name": "A template", "state": {"services": []}})
    db = SessionLocal()
    try:
        assert len(pane_saved.migrate_saved_shortcuts(db)) == 2
        assert pane_saved.migrate_saved_shortcuts(db) == []
        assert db.query(models.Setting).filter(models.Setting.key == pane_saved.MARKER_3B1).count() == 1
    finally:
        db.close()
    saved = {s["name"]: s for s in client.get("/api/saved-inputs").json()}
    assert saved["Orders"]["pane_type"] == "tables" and saved["Orders"]["inputs"] == {"connection": 7, "tableName": "Orders"}
    assert saved["Logs"]["inputs"] == {"connection": 7, "bucket": "logs"}
    left = [s["page"] for s in client.get("/api/saved-sessions").json()]
    assert left == ["aggregator"]  # templates are another thing, and stay

    # A saved table written afterwards by a tab that hasn't reloaded stays where it is.
    client.post("/api/saved-sessions", json={"page": "tables", "name": "Late", "state": {"environment_id": 7, "table_name": "X"}})
    db = SessionLocal()
    try:
        assert pane_saved.migrate_saved_shortcuts(db) == []
    finally:
        db.close()
