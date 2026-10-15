"""Session variables and view mode (PLATFORM_PLAN.md §18.7, D60, D61): which
inputs a variable binds, worked out from the manifest by input type; the
agent setting variables, which copies them into every pane that follows;
unlinking by setting a bound input; following again; a new pane following;
view mode for the session and per pane."""

from app.panes import manifest as pane_manifest
from app.panes import variables
from tests.test_platform_tools import _environment, _row, _token, call, mcp  # noqa: F401 -- a fixture


def test_a_variable_binds_inputs_by_their_type_never_by_pane():
    targets = {m.id: variables.targets(m) for m in pane_manifest.manifests().values()}
    assert targets["tables"] == {"environment": {"connection": "value"}}
    assert targets["iot"]["environment"] == {"connections": "list"}
    assert targets["logs-cloudwatch"] == {
        "environment": {"connections": "list"},
        "time": {"preset": "preset", "customStart": "start", "customEnd": "end"},
    }
    assert targets["tool-mqtt"] == {"environment": {"connection": "value"}}
    # An HTTP API connection is a different kind of place: no AWS environment there.
    assert targets["tool-http"] == {} and targets["api-table"] == {}
    assert targets["tool-base64"] == {}

    logs = pane_manifest.get("logs-cloudwatch")
    bound = variables.bound_values(logs, {"environment": 7, "time": {"preset": 3600, "start": "", "end": ""}})
    assert bound == {"connections": [7], "preset": 3600, "customStart": "", "customEnd": ""}
    assert variables.bound_values(logs, {"environment": None}) == {}
    assert variables.bound_values(logs, {"environment": 7}, skip=["environment"]) == {}


def test_the_agent_sets_variables_and_every_pane_that_follows_takes_them(mcp):
    env = _environment()
    other = _environment("Other", "222233334444")
    token = _token()
    made = call(
        mcp, token, "create_session", title="Dash",
        panes=[{"kind": "tables"}, {"kind": "logs-cloudwatch"}, {"kind": "tool-http"}],
    )
    sid = made["session_id"]
    out = call(mcp, token, "set_variables", session_id=sid, environment=env, time_range="1h")
    assert out["variables"]["environment"]["id"] == env and out["variables"]["time_range"]["preset"] == 3600
    assert "Copied into" in out["note"] and "Nothing ran" in out["note"]
    state = _row(sid).state
    assert state["tables.in.connection"] == env
    assert state["logs-cloudwatch.in.connections"] == [env] and state["logs-cloudwatch.in.preset"] == 3600
    assert not any(k.startswith("tool-http.in.") and state[k] == env for k in state)
    tables = next(p for p in call(mcp, token, "get_session", session_id=sid)["panes"] if p["pane_id"] == "tables")
    assert tables["from_session"] == {"environment": ["connection"]}

    # Its own value: the pane stops following, and says so.
    set_ = call(mcp, token, "set_pane_inputs", session_id=sid, pane_id="tables", inputs={"connection": other})
    assert "no longer follows the session's environment" in set_["note"]
    assert set_["pane"]["unlinked_from"] == ["environment"] and "from_session" not in set_["pane"]
    call(mcp, token, "set_variables", session_id=sid, environment=env, time_range="15m")
    state = _row(sid).state
    assert state["tables.in.connection"] == other and state["logs-cloudwatch.in.preset"] == 900

    # Following again takes the variable's value now.
    linked = call(mcp, token, "link_pane", session_id=sid, pane_id="tables", variable="environment")
    assert linked["pane"]["from_session"] == {"environment": ["connection"]}
    assert _row(sid).state["tables.in.connection"] == env

    # A pane added later follows from the start.
    call(mcp, token, "add_pane", session_id=sid, kind="tables")
    assert _row(sid).state["tables~2.in.connection"] == env

    # Removed, the panes keep what they had.
    call(mcp, token, "set_variables", session_id=sid, remove=["environment"])
    state = _row(sid).state
    assert "environment" not in state["variables"] and state["tables.in.connection"] == env


def test_the_agent_turns_view_mode_on_for_a_session_or_one_pane(mcp):
    token = _token()
    sid = call(mcp, token, "create_session", title="V", panes=[{"kind": "tables"}])["session_id"]
    assert call(mcp, token, "set_view_mode", session_id=sid, view=True)["view_mode"] is True
    out = call(mcp, token, "set_view_mode", session_id=sid, view=False, pane_id="tables")
    assert out["panes"][0]["inputs_shown"] is True
    assert _row(sid).state["viewMode"] is True and _row(sid).state["tables.inputs"] == "shown"
