"""Trying a draft (D153): a pane type that checks clean can still show
nothing -- a column read by a name the reply doesn't use, a row action given
nothing, a detail whose fields aren't where its template looks. try_draft
runs it as its builder in an environment they choose -- the main action with
its inputs' defaults, then the first row opened -- and says what came back
empty, for the Builder's loop to fix before the user ever sees it."""

import json

import pytest

from app import builder, models, tools_http_client
from app.db import SessionLocal
from tests.conftest import client
from tests.test_code import stack  # noqa: F401 -- a fixture
from tests.test_platform_tools import _token, call, mcp  # noqa: F401 -- a fixture
from tests.test_recipes import FUNCTION, RECIPES, _aws, _env, _iot

OPEN = RECIPES["rows-that-open"]["source"]
CONFIG = {**FUNCTION, "Handler": "app.handler", "Timeout": 30, "Role": "arn:aws:iam::111122223333:role/x",
          "State": "Active", "Layers": []}


def _try(source: str, environment, files=None) -> dict:
    with SessionLocal() as db:
        admin = db.query(models.User).filter_by(username="admin").one()
        return builder.try_draft(db, admin, source, "default:lambdas", files or {}, environment)


@pytest.fixture
def prod(monkeypatch):
    env = _env("Prod", "111122223333")
    # An environment with only an HTTP API connection can't run an AWS pane.
    shop = client.post("/api/environments", json={"name": "Shop"}).json()
    client.post(f"/api/environments/{shop['id']}/connections", json={
        "type_id": "http_api", "name": "shop", "config": {"base_url": "https://shop.example.com"}})
    asked = _aws(monkeypatch, {"111122223333": {"ListFunctions": {"Functions": [FUNCTION]},
                                                "GetFunctionConfiguration": CONFIG}})
    return env, asked


def test_without_an_environment_it_asks_which_of_those_it_could_run_in(prod):
    _env("Test", "444455556666")
    assert _try(OPEN, None) == {"needs_environment": True, "environments": ["Prod", "Test"]}
    assert "isn't an environment you can reach" in _try(OPEN, "Shop")["skipped"]
    # A pane with no connection needs none: it just runs.
    tool = _try(RECIPES["http-api-table"]["source"].replace("connection_type: http_api", "connection_type: nope"),
                None)
    assert "No environment you can reach has a nope connection" in tool["skipped"]


def test_a_working_draft_runs_and_opens_its_first_row(prod):
    out = _try(OPEN, "prod")
    assert out["ok"] and out["problems"] == [], out
    assert out["rows"] == {"rows": 1} and out["first row"]["rows"]["Name"] == "orders"
    assert out["opened"]["rows"]["args"] == {"connections": "Prod", "name": "orders"}
    assert "Timeout" in out["opened"]["rows"]["detail holds"]
    # Layers: [] is something -- a function with no layers -- not a problem.


@pytest.fixture
def shop(monkeypatch):
    """An HTTP API whose reply is `reply[0]`, at status `reply[1]`."""
    env = client.post("/api/environments", json={"name": "Shop"}).json()
    client.post(f"/api/environments/{env['id']}/connections", json={
        "type_id": "http_api", "name": "shop", "config": {"base_url": "https://shop.example.com/api"}})
    reply = [{"data": {"items": [{"id": "o-1", "customer": {"name": "Ada"}, "total": 3, "created_at": "2026-10-20T08:00:00Z"},
                                 {"id": "o-2", "customer": {"name": "Bo"}, "total": 4, "created_at": "2026-10-21T08:00:00Z"}]}}, 200]

    def fake(method, url, headers=None, body=None, timeout=30):
        return {"status_code": reply[1], "status_text": "OK", "headers": [], "body": json.dumps(reply[0]),
                "body_truncated": False, "elapsed_ms": 3}

    monkeypatch.setattr(tools_http_client, "send_request", fake)
    return reply


def test_a_column_read_by_a_name_the_reply_doesnt_use_is_said(shop):
    orders = RECIPES["http-api-table"]["source"]
    assert _try(orders, "Shop")["ok"]
    out = _try(orders.replace("Customer: customer.name", "Customer: customer.fullName"), "Shop")
    assert not out["ok"]
    assert out["problems"] == ["In every rows row, Customer came back empty: the path its column reads isn't where "
                               "the reply keeps it."], out


def test_a_run_that_fails_is_a_problem_and_one_refused_access_is_a_note(shop, prod, monkeypatch):
    shop[1] = 500
    out = _try(RECIPES["http-api-table"]["source"], "Shop")
    assert not out["ok"] and out["problems"][0].startswith("list on Shop failed"), out

    from botocore.exceptions import ClientError

    def refused(_params):
        raise ClientError({"Error": {"Code": "AccessDeniedException", "Message": "no"}}, "ListFunctions")

    _aws(monkeypatch, {"111122223333": {"ListFunctions": refused}})
    out = _try(OPEN, "Prod")
    assert out["ok"] and out["problems"] == [] and "AccessDenied" in " ".join(out["notes"]), out


def test_a_detail_whose_fields_arent_where_its_template_looks_is_said_with_what_it_holds(stack, monkeypatch):
    _env("Prod", "111122223333")
    _aws(monkeypatch, {"111122223333": _iot("111122223333", ["ota-1"])})
    recipe = RECIPES["per-row-values-in-code"]
    # What the user's OTA pane did: the code returns the job's fields at the
    # top, the sections read them under d.job.
    files = {**recipe["files"], "job.py": recipe["files"]["job.py"].replace(
        'return {"job": job,', 'return {**job,')}
    out = _try(recipe["source"], "Prod", files)
    assert not out["ok"], out
    [problem] = out["problems"]
    assert "Opened, the first rows row shows nothing for" in problem and "(d.job.jobId)" in problem, problem
    assert "holds" in problem and "jobId" in problem and "executions" in problem
    # As written, it opens onto everything it shows.
    assert _try(recipe["source"], "Prod", recipe["files"])["ok"]
    # Rows code made have columns only a run knows: a row action reading one
    # by another name gets nothing, said with the columns there are.
    out = _try(recipe["source"].replace("job_id: row.Job ID", "job_id: row.jobId"), "Prod", recipe["files"])
    assert any("job got nothing for job_id: its args read row.jobId" in p and "Job ID" in p
               for p in out["problems"]), out


def test_the_agent_tries_its_working_draft(prod, mcp):
    token = _token(build={"kind": "pane", "id": None, "source": OPEN, "files": {}})
    assert call(mcp, token, "try_definition") == {"needs_environment": True, "environments": ["Prod"]}
    out = call(mcp, token, "try_definition", environment="Prod")
    assert out["ok"] and out["rows"] == {"rows": 1}
