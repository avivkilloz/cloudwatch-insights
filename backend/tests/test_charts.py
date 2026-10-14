"""Charts (PLATFORM_PLAN.md §16.11): the log-volume histogram (D52) -- a
counting query beside a CloudWatch run, an aggregation in an OpenSearch
search -- and a chart over a pane's rows, which the agent sets as a view
key (D53).
"""

import pytest

from app import aws_client, opensearch_client
from app.panes import runs, timewindow
from tests.conftest import client
from tests.test_pane_runs import PANE, _admin_id, _environment, _run, _session, _state, _tab
from tests.test_platform_tools import _row, _token, call, call_error, mcp  # noqa: F401 - mcp is a fixture

# ---------------------------------------------------------------- the counting query


def test_a_query_is_split_into_commands_outside_quotes_and_regexes():
    query = 'fields @message | filter @message like /a|b/ and x = "c|d" | sort @timestamp desc | limit 20'
    assert timewindow._commands(query) == [
        "fields @message",
        'filter @message like /a|b/ and x = "c|d"',
        "sort @timestamp desc",
        "limit 20",
    ]


def test_the_counting_query_keeps_what_filters_and_drops_what_only_shapes_rows():
    query = "fields @timestamp, @message | parse @message 'user=*' as user | filter user != 'x|y' | sort @timestamp | limit 5"
    assert timewindow.count_query(query, "5m") == (
        "parse @message 'user=*' as user | filter user != 'x|y' | stats count(*) as count by bin(5m)"
    )
    assert timewindow.count_query("", "1m") == "stats count(*) as count by bin(1m)"
    with pytest.raises(timewindow.NoHistogram, match="its own stats"):
        timewindow.count_query("filter x | stats count(*) by bin(5m)", "5m")


def test_the_interval_keeps_a_window_to_about_sixty_bars():
    assert timewindow.interval(0, 900) == (30, "30s")
    assert timewindow.interval(0, 3600) == (60, "1m")
    assert timewindow.interval(0, 86400) == (1800, "30m")
    assert timewindow.interval(0, 30 * 86400) == (43200, "12h")
    assert timewindow.interval(0, 90 * 86400) == (86400, "1d")


# ---------------------------------------------------------------- CloudWatch's histogram


@pytest.fixture
def counting(monkeypatch) -> dict:
    """Logs Insights stubbed: rows for the query, a count per bar for the
    counting one; both finish on the second poll."""
    calls: dict = {"queries": [], "polls": 0, "stopped": []}

    def start_query(account, region, identity, groups, query, start, end, limit):
        calls["queries"].append(query)
        calls["window"] = (start, end)
        return f"q-{len(calls['queries'])}"

    def get_query_results(account, region, identity, query_id):
        calls["polls"] += 1
        done = calls["polls"] >= 3
        if calls["queries"][int(query_id[2:]) - 1].endswith("by bin(30s)"):
            start = calls["window"][0] - calls["window"][0] % 30
            import datetime

            bar = datetime.datetime.fromtimestamp(start + 60, datetime.timezone.utc).strftime("%Y-%m-%d %H:%M:%S.000")
            rows = [[{"field": "bin(30s)", "value": bar}, {"field": "count", "value": "7"}]]
        else:
            rows = [[{"field": "@message", "value": "m"}]]
        return {"status": "Complete" if done else "Running", "results": rows, "statistics": {}}

    monkeypatch.setattr(aws_client, "start_query", start_query)
    monkeypatch.setattr(aws_client, "get_query_results", get_query_results)
    monkeypatch.setattr(aws_client, "stop_query", lambda a, r, i, q: calls["stopped"].append(q))
    return calls


def test_histogram_on_counts_every_match_beside_the_query_and_both_are_stopped_together(counting):
    env = _environment()
    sid = _session()
    _tab(_admin_id())
    resp = _run(client, sid, env, histogram=True, queryString="fields @message | filter level = 'ERROR' | limit 5")
    assert resp.status_code == 200, resp.text
    assert counting["queries"] == [
        "fields @message | filter level = 'ERROR' | limit 5",
        "filter level = 'ERROR' | stats count(*) as count by bin(30s)",
    ]
    volume = _state(sid)[f"{PANE}.out.volume"]
    # Every bar of the window is there from the start, at 0 until counted.
    assert volume["interval"] == "30s" and len(volume["groups"]) == 1
    bars = volume["groups"][0]["buckets"]
    assert len(bars) >= 30 and all(b["count"] == 0 for b in bars)

    run_id = _state(sid)[f"{PANE}.out.run"]["id"]
    runs.tick(run_id)
    bars = _state(sid)[f"{PANE}.out.volume"]["groups"][0]["buckets"]
    assert [b["count"] for b in bars[:4]] == [0, 0, 7, 0]
    # The rows are the query's, never the counting query's.
    assert _state(sid)[f"{PANE}.out.results"][0]["rows"] == [[{"field": "@message", "value": "m"}]]

    assert client.post(f"/api/panes/{PANE}/stop", json={"session": sid, "pane": PANE}).json() == {"stopped": True}
    assert sorted(counting["stopped"]) == ["q-1", "q-2"]


def test_histogram_off_runs_one_query_and_clears_an_earlier_histogram(counting):
    env = _environment()
    sid = _session()
    _tab(_admin_id())
    assert _run(client, sid, env, histogram=True).status_code == 200
    assert _state(sid)[f"{PANE}.out.volume"] is not None
    assert _run(client, sid, env).status_code == 200
    assert counting["queries"][-1] == "fields @message"
    assert len(counting["queries"]) == 3
    assert _state(sid)[f"{PANE}.out.volume"] is None


def test_a_query_with_its_own_stats_gets_no_histogram_and_the_pane_says_why(counting):
    env = _environment()
    sid = _session()
    _tab(_admin_id())
    assert _run(client, sid, env, histogram=True, queryString="stats count(*) by bin(5m)").status_code == 200
    assert counting["queries"] == ["stats count(*) by bin(5m)"]
    volume = _state(sid)[f"{PANE}.out.volume"]
    assert volume["groups"] == [] and "its own stats" in volume["note"]


# ---------------------------------------------------------------- OpenSearch's histogram


def test_an_opensearch_search_counts_every_match_in_the_same_request(monkeypatch):
    env = _environment()
    asked: list = []

    def search(account, region, identity, endpoint, indices, query, start, end, field, limit, interval=None):
        asked.append(interval)
        first = start - start % 30
        return {"hits": [], "total": 40, "buckets": [{"t": (first + 30) * 1000, "count": 40}]}

    monkeypatch.setattr(opensearch_client, "search", search)
    resp = client.post(
        "/api/panes/logs-opensearch/actions/run",
        json={"inputs": {"openSearchSelection": {str(env): {"d": {"domain_endpoint": "d.example", "indices": ["a"]}}},
                         "preset": 900}},
    )
    assert resp.status_code == 200, resp.text
    assert asked == ["30s"]
    volume = resp.json()["volume"]
    assert volume["interval"] == "30s" and volume["groups"][0]["environment_name"] == "Prod"
    assert [b["count"] for b in volume["groups"][0]["buckets"][:3]] == [0, 40, 0]


# ---------------------------------------------------------------- the agent's set_pane_view


def test_the_agent_charts_a_panes_rows_and_is_told_what_a_chart_can_be(mcp):
    token = _token()
    session = call(mcp, token, "create_session", title="s", panes=[{"kind": "api-table"}])["session_id"]
    kinds = {k["kind"]: k for k in call(mcp, token, "get_context")["pane_kinds"]}
    chart_view = next(v for v in kinds["api-table"]["views"] if v["key"] == "chart")
    assert "timeseries" in chart_view["help"]

    spec = {"type": "bar", "x": "status", "y": "total", "agg": "sum", "series": "region"}
    call(mcp, token, "set_pane_view", session_id=session, pane_id="api-table", views={"chart": spec})
    assert _row(session).state["api-table.view.chart"] == spec
    # y "count" counts the rows, whatever agg was asked.
    call(mcp, token, "set_pane_view", session_id=session, pane_id="api-table",
         views={"chart": {"type": "pie", "x": "status", "y": "count", "agg": "max"}})
    assert _row(session).state["api-table.view.chart"] == {"type": "pie", "x": "status", "y": "count", "agg": "count"}

    assert "type is one of" in call_error(
        mcp, token, "set_pane_view", session_id=session, pane_id="api-table", views={"chart": {"type": "radar", "x": "a"}}
    )
    assert "needs an x" in call_error(
        mcp, token, "set_pane_view", session_id=session, pane_id="api-table", views={"chart": {"type": "bar"}}
    )
    assert "has no view sortField" in call_error(
        mcp, token, "set_pane_view", session_id=session, pane_id="api-table", views={"sortField": "x"}
    )
    call(mcp, token, "set_pane_view", session_id=session, pane_id="api-table", views={"chart": None})
    assert _row(session).state["api-table.view.chart"] is None


def test_the_agent_sorts_and_groups_a_log_list_through_its_views(mcp):
    token = _token()
    session = call(mcp, token, "create_session", title="s", panes=[{"kind": "logs-cloudwatch"}])["session_id"]
    call(mcp, token, "set_pane_view", session_id=session, pane_id="logs-cloudwatch",
         views={"groupBy": "log", "sortField": "@message"})
    state = _row(session).state
    assert state["logs-cloudwatch.view.groupBy"] == "log" and state["logs-cloudwatch.view.sortField"] == "@message"
