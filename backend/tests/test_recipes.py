"""The Builder's recipes (D152): whole pane types its agent reads before
writing one like them. A recipe that didn't check, or checked and showed
nothing, would teach the very mistakes it's there to prevent -- so each is
checked as Check checks it, saved, and run the way the pane runs it, AWS
answering through a real botocore client (its parameters validated against
the service's model) and the code recipe in the real runner."""

import datetime
import json

import pytest
from botocore.awsrequest import AWSResponse

from app import aws_client, builder, models, tools_http_client
from tests.conftest import client
from tests.test_code import stack  # noqa: F401 -- a fixture
from app.db import SessionLocal
from tests.test_platform_tools import _token, call, call_error, mcp  # noqa: F401 -- a fixture

RECIPES = builder.recipes()


def _aws(monkeypatch, replies: dict[str, dict]):
    """aws_client.get_client handing out real clients whose calls are answered
    from `replies` -- per account, operation name -> reply, or a function of
    the call's parameters -- after botocore has validated those parameters.
    Returns what was asked: (account, operation, params)."""
    asked: list = []

    def fake(service, account_id, region, identity):
        real = aws_client.boto3.client(service, region_name=region, aws_access_key_id="x", aws_secret_access_key="y")
        given: dict = {}

        def keep(params, model, **_):
            given[model.name] = dict(params)

        def answer(model, **_):
            reply = replies.get(account_id, {}).get(model.name)
            if reply is None:
                raise AssertionError(f"{account_id} wasn't expecting {model.name}")
            params = given.get(model.name, {})
            asked.append((account_id, model.name, params))
            return (AWSResponse("https://aws.fake", 200, {}, None), reply(params) if callable(reply) else reply)

        real.meta.events.register("before-parameter-build.*.*", keep)
        real.meta.events.register("before-call.*.*", answer)
        return real

    monkeypatch.setattr(aws_client, "get_client", fake)
    return asked


def _env(name: str, account: str) -> int:
    resp = client.post("/api/environments", json={"name": name, "account_id": account, "region": "eu-west-1"})
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


def _save(name: str) -> str:
    recipe = RECIPES[name]
    type_id = name.replace("-", "_")
    resp = client.post("/api/builder/panes", json={"id": type_id, "source": recipe["source"], "files": recipe["files"]})
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


def test_there_are_recipes_and_the_reference_lists_them():
    assert {"rows-that-open", "per-row-values-in-code", "modes", "http-api-table"} <= set(RECIPES)
    with SessionLocal() as db:
        admin = db.query(models.User).filter_by(username="admin").one()
        recipes = builder.reference(db, "pane", admin)["recipes"]
    for name, recipe in RECIPES.items():
        assert recipes[f"recipe:{name}"] == recipe["about"] and recipe["about"], name


@pytest.mark.parametrize("name", sorted(RECIPES))
def test_every_recipe_checks_clean_and_says_why_its_built_so(name):
    recipe = RECIPES[name]
    builder.preview(recipe["source"], f"default:{name.replace('-', '_')}", None, recipe["files"])
    assert recipe["source"].startswith("# Recipe: ")
    # Its comments are what it teaches: more than the one line.
    assert sum(1 for line in recipe["source"].splitlines() if line.startswith("#")) >= 4
    # Code is only ever in files beside the YAML (D149).
    assert "code: |" not in recipe["source"]


def test_the_agent_reads_a_recipe_with_its_files(mcp):
    token = _token()
    out = call(mcp, token, "read_definition", kind="pane", definition_id="recipe:per-row-values-in-code")
    assert out["source"] == RECIPES["per-row-values-in-code"]["source"]
    assert set(out["files"]) == {"jobs.py", "job.py"}
    missing = call_error(mcp, token, "read_definition", kind="pane", definition_id="recipe:nope")
    assert "build_reference lists the recipes" in missing


FUNCTION = {"FunctionName": "orders", "Runtime": "python3.12", "MemorySize": 256,
            "LastModified": "2026-10-01T10:00:00.000+0000"}


def test_rows_that_open_list_every_environment_and_open_onto_their_detail(monkeypatch):
    type_id = _save("rows-that-open")
    prod, test = _env("Prod", "111122223333"), _env("Test", "444455556666")
    asked = _aws(monkeypatch, {
        "111122223333": {"ListFunctions": {"Functions": [FUNCTION]},
                         "GetFunctionConfiguration": {**FUNCTION, "Handler": "app.handler", "Timeout": 30,
                                                      "Role": "arn:aws:iam::111122223333:role/orders",
                                                      "Layers": [{"Arn": "arn:aws:lambda:l:1", "CodeSize": 2048}]}},
        "444455556666": {"ListFunctions": {"Functions": [{**FUNCTION, "FunctionName": "billing"}]}},
    })
    listed = client.post(f"/api/panes/{type_id}/actions/list", json={"inputs": {"connections": [prod, test]}})
    assert listed.status_code == 200, listed.text
    rows = listed.json()["rows"]
    assert [(r["Environment"], r["Name"], r["Memory"]) for r in rows] == [("Prod", "orders", 256), ("Test", "billing", 256)]

    # Opened: the args read the row by its column names; the detail is the reply.
    opened = client.post(f"/api/panes/{type_id}/actions/function",
                         json={"inputs": {"connections": rows[0]["Environment"], "name": rows[0]["Name"]}})
    assert opened.status_code == 200, opened.text
    detail = opened.json()
    assert detail["Timeout"] == 30 and detail["Layers"][0]["CodeSize"] == 2048
    assert asked[-1] == ("111122223333", "GetFunctionConfiguration", {"FunctionName": "orders"})


def test_modes_run_the_action_their_mode_names_into_its_own_output(monkeypatch):
    type_id = _save("modes")
    prod = _env("Prod", "111122223333")
    _aws(monkeypatch, {"111122223333": {
        "ListFunctions": {"Functions": [FUNCTION]},
        "ListLayers": {"Layers": [{"LayerName": "shared", "LatestMatchingVersion": {"Version": 3}}]},
    }})
    manifest = builder.preview(RECIPES["modes"]["source"], "default:modes", None, {})
    assert manifest.main_action({"mode": "layers"}).id == "list_layers"
    assert manifest.main_action({"mode": "functions"}).id == "list_functions"
    layers = client.post(f"/api/panes/{type_id}/actions/list_layers",
                         json={"inputs": {"mode": "layers", "connections": [prod]}})
    assert layers.status_code == 200, layers.text
    assert layers.json()["layers"] == [{"Environment": "Prod", "Layer": "shared", "Version": 3}]
    assert "functions" not in layers.json() or not layers.json()["functions"]


def test_an_http_api_table_sends_its_inputs_as_parameters(monkeypatch):
    type_id = _save("http-api-table")
    env = client.post("/api/environments", json={"name": "Shop"}).json()
    conn = client.post(f"/api/environments/{env['id']}/connections", json={
        "type_id": "http_api", "name": "shop", "config": {"base_url": "https://shop.example.com/api"}}).json()
    sent: list = []

    def fake(method, url, headers=None, body=None, timeout=30):
        sent.append(url)
        reply = {"data": {"items": [{"id": "o-1", "customer": {"name": "Ada"}, "total": "12.5",
                                     "created_at": "2026-10-20T08:00:00Z"}]}}
        return {"status_code": 200, "status_text": "OK", "headers": [], "body": json.dumps(reply),
                "body_truncated": False, "elapsed_ms": 3}

    monkeypatch.setattr(tools_http_client, "send_request", fake)
    out = client.post(f"/api/panes/{type_id}/actions/list",
                      json={"inputs": {"connection": conn["id"], "status": "shipped", "search": "Ada"}})
    assert out.status_code == 200, out.text
    [url] = sent
    assert url.startswith("https://shop.example.com/api/orders?") and "status=shipped" in url and "q=Ada" in url
    [row] = out.json()["rows"]
    assert row["Order"] == "o-1" and row["Customer"] == "Ada" and row["Total"] == 12.5
    # An empty search is left out, not sent empty.
    client.post(f"/api/panes/{type_id}/actions/list", json={"inputs": {"connection": conn["id"], "status": "open"}})
    assert "q=" not in sent[-1]


CREATED = datetime.datetime(2026, 10, 20, 8, 0, tzinfo=datetime.timezone.utc)


def _iot(account: str, jobs: list[str]) -> dict:
    def describe(params):
        n = jobs.index(params["jobId"]) + 1
        return {"job": {"jobId": params["jobId"], "status": "IN_PROGRESS", "description": "firmware",
                        "targets": [f"arn:aws:iot:eu-west-1:{account}:thinggroup/fleet"],
                        "jobProcessDetails": {"numberOfQueuedThings": n, "numberOfSucceededThings": 10 * n,
                                              "numberOfFailedThings": 1}}}

    return {
        "ListJobs": {"jobs": [{"jobId": j, "status": "IN_PROGRESS", "createdAt": CREATED} for j in jobs]},
        "DescribeJob": describe,
        "GetJobDocument": {"document": json.dumps({"operation": "ota", "version": "2.1"})},
        "ListJobExecutionsForJob": {"executionSummaries": [
            {"thingArn": f"arn:aws:iot:eu-west-1:{account}:thing/pool-7",
             "jobExecutionSummary": {"status": "SUCCEEDED", "lastUpdatedAt": CREATED}}]},
    }


def test_per_row_values_are_columns_of_every_row_and_open_by_environment_name(stack, monkeypatch):
    type_id = _save("per-row-values-in-code")
    prod, test = _env("Prod", "111122223333"), _env("Test", "444455556666")
    asked = _aws(monkeypatch, {"111122223333": _iot("111122223333", ["ota-1", "ota-2"]),
                               "444455556666": _iot("444455556666", ["ota-9"])})
    listed = client.post(f"/api/panes/{type_id}/actions/list",
                         json={"inputs": {"connections": [prod, test], "status": "IN_PROGRESS"}})
    assert listed.status_code == 200, listed.text
    rows = listed.json()["rows"]
    # The counts DescribeJob alone knows are columns of the listed rows -- in
    # the table and its CSV -- and each row says its environment by name.
    assert [(r["Environment"], r["Job ID"], r["Queued"], r["Succeeded"], r["Failed"]) for r in rows] == [
        ("Prod", "ota-1", 1, 10, 1), ("Prod", "ota-2", 2, 20, 1), ("Test", "ota-9", 1, 10, 1)]
    assert ("111122223333", "ListJobs", {"status": "IN_PROGRESS"}) in asked

    # Opened as the pane opens it: the args from the row's columns.
    opened = client.post(f"/api/panes/{type_id}/actions/job",
                         json={"inputs": {"connection": rows[2]["Environment"], "job_id": rows[2]["Job ID"]}})
    assert opened.status_code == 200, opened.text
    d = opened.json()
    assert d["job"]["jobId"] == "ota-9" and d["document"] == {"operation": "ota", "version": "2.1"}
    assert d["targets"] == "fleet" and d["executions"][0]["thing"] == "pool-7"
    assert asked[-1][0] == "444455556666", "the row's environment, reached by its name"


def test_a_new_panes_starter_becomes_a_recipe_as_the_builder_seeds_it(mcp):
    """D155: a blank draft is made the pane it starts from -- the editor's
    starter replaced by the recipe's YAML (its notes left out) and its files
    written beside it -- and it checks clean as it stands."""
    from app.platform_tools import tokens

    with SessionLocal() as db:
        admin = db.query(models.User).filter_by(username="admin").one()
        token = tokens.mint(db, admin, build={"kind": "pane", "id": None, "source": builder.STARTER, "files": {}})
    recipe = RECIPES["per-row-values-in-code"]
    body = "\n".join(line for line in recipe["source"].splitlines() if not line.startswith("#")).lstrip("\n")
    changes = [{"op": "lines", "from": 1, "to": len(builder.STARTER.splitlines()), "text": body}]
    changes += [{"op": "file", "name": name, "text": text} for name, text in recipe["files"].items()]
    out = call(mcp, token, "change_definition", changes=changes)
    assert out["ok"], out
    draft = call(mcp, token, "read_draft")["text"]
    assert "label: IoT jobs" in draft and "Service status" not in draft and "# Recipe" not in draft
