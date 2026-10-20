"""The Builder's preview (5-2c, D112) and which handlers a builder may name
(D113): a draft is drawn and its actions run as its builder, through the same
functions a saved pane's go through, with nothing stored -- and a built pane
runs only handlers of pane types its builder's group may use."""

from app import builder, models
from app.db import SessionLocal
from tests.conftest import client
from tests.test_aws_request import FUNCTION, ONE, _env, _stubbed
from tests.test_builder import ENCODER, _group, _member
from tests.test_platform_tools import _token, call, call_error, mcp  # noqa: F401 -- a fixture

SCAN = """label: Table peek
description: The first rows of a table.
inputs:
  - key: connection
    type: connection
    connection_type: aws
  - key: tableName
    type: text
actions:
  - id: scan
    main: true
    handler: aws.dynamodb.scan
outputs:
  - key: items
    render: json
layout:
  - title: Peek
    items:
      - input: connection
      - input: tableName
      - output: items
"""


def test_a_draft_is_served_as_the_renderer_draws_a_pane_type():
    out = client.post("/api/builder/preview", json={"source": ENCODER}).json()
    assert out["ok"] is True and out["manifest"]["label"] == "Shouty encoder"
    assert out["manifest"]["state"] == "v2" and out["manifest"]["rendered"] is True
    assert [a["id"] for a in out["manifest"]["actions"]] == ["convert"]
    bad = client.post("/api/builder/preview", json={"source": ENCODER.replace("live: base64.convert", "handler: no.such")}).json()
    assert bad["ok"] is False and bad["manifest"] is None and "no.such" in bad["errors"][0]["message"]


def test_a_drafts_action_runs_as_its_builder_and_nothing_is_stored(monkeypatch):
    prod = _env("Prod", "111122223333")
    _stubbed(monkeypatch, {"111122223333": [{"Functions": [FUNCTION]}]})
    resp = client.post("/api/builder/preview/actions/list", json={"source": ONE, "inputs": {"connection": prod}})
    assert resp.status_code == 200, resp.text
    assert resp.json()["rows"][0]["Name"] == "orders"
    assert client.get("/api/builder/panes").json() == []
    with SessionLocal() as db:
        assert db.query(models.PaneOutput).count() == 0

    live = client.post("/api/builder/preview/actions/convert", json={"source": ENCODER})
    assert live.status_code == 400 and "as you type" in live.json()["detail"]
    broken = client.post("/api/builder/preview/actions/list", json={"source": ONE.replace("service: lambda", "service: nope")})
    assert broken.status_code == 400 and broken.json()["detail"].startswith("The draft has a problem: Line ")


def test_only_a_builder_previews():
    plain = _member("pat", _group("Plain", pane_types=["tool-base64"]))
    assert plain.post("/api/builder/preview", json={"source": ENCODER}).status_code == 403
    assert plain.post("/api/builder/preview/actions/convert", json={"source": ENCODER}).status_code == 403


def test_a_builder_names_only_handlers_of_panes_their_group_may_use():
    """Built panes are granted to their builder's group at once (D105): a
    handler of a pane they weren't given reached past the admin's grants."""
    bea = _member("bea", _group("Builders", builder_enabled=True, pane_types=["tool-base64"]))
    assert "aws.dynamodb.scan" not in bea.get("/api/builder/schema").json()["handlers"]
    checked = bea.post("/api/builder/check", json={"source": SCAN}).json()
    assert checked["ok"] is False
    [error] = checked["errors"]
    assert error["line"] == 12 and "can't use the handler aws.dynamodb.scan" in error["message"] and "DynamoDB" in error["message"]
    assert bea.post("/api/builder/panes", json={"id": "peek", "source": SCAN}).status_code == 400
    assert bea.post("/api/builder/preview", json={"source": SCAN}).json()["ok"] is False

    # Given DynamoDB, they may build on its handlers; an admin always may.
    dee = _member("dee", _group("Table builders", builder_enabled=True, pane_types=["tables"]))
    assert "aws.dynamodb.scan" in dee.get("/api/builder/schema").json()["handlers"]
    assert dee.post("/api/builder/check", json={"source": SCAN}).json() == {"ok": True, "errors": []}
    assert client.post("/api/builder/check", json={"source": SCAN}).json()["ok"] is True
    assert set(builder.handler_owners()["aws.dynamodb.scan"]) == {"tables"}


def test_the_agent_previews_a_draft_before_proposing_it(mcp, monkeypatch):
    prod = _env("Prod", "111122223333")
    _stubbed(monkeypatch, {"111122223333": [{"Functions": [FUNCTION]}]})
    out = call(mcp, _token(), "preview_definition", source=ONE, action="list", inputs={"connection": prod})
    assert out["outputs"]["rows"]["rows"] == 1 and out["outputs"]["rows"]["sample"][0]["Name"] == "orders"
    assert "nothing was saved" in out["note"]
    assert "background run" not in call_error(mcp, _token(), "preview_definition", source=ONE, action="nope")
    # The agent, but not the Builder: its token is valid, its build tools refused.
    _member("pat2", _group("Plain2", pane_types=["tool-base64"], agent_enabled=True))
    with SessionLocal() as db:
        pat_id = db.query(models.User).filter_by(username="pat2").one().id
    assert "isn't turned on" in call_error(mcp, _token(pat_id), "preview_definition", source=ONE, action="list")


# ---------------------------------------------------------------- the turn's working draft (D114)


def _build_token(source: str, kind: str = "pane", definition_id: str | None = None) -> str:
    from app.platform_tools import tokens

    with SessionLocal() as db:
        admin = db.query(models.User).filter_by(username="admin").one()
        return tokens.mint(db, admin, build={"kind": kind, "id": definition_id, "source": source})


def test_beside_an_editor_the_agent_edits_a_draft_a_piece_at_a_time(mcp):
    """Regenerating an IoT-sized manifest for every check ran a model out of
    tokens; now it changes the editor's text with small edits."""
    from tests.test_platform_tools import call_error

    token = _build_token(ENCODER)
    assert call(mcp, token, "read_draft")["text"].startswith("1: label: Shouty encoder")
    assert call(mcp, token, "check_definition") == {"ok": True, "errors": []}

    # Each find must be in the draft exactly once; otherwise nothing changes.
    missing = call_error(mcp, token, "edit_definition", edits=[{"find": "no such text", "replace": "x"}])
    assert "isn't in the draft" in missing
    twice = call_error(mcp, token, "edit_definition", edits=[{"find": "    items:\n", "replace": "x"}])
    assert "2 times" in twice

    # A broken edit is kept (a change can pass through broken states) and named, with the lines around it.
    broken = call(mcp, token, "edit_definition", edits=[{"find": "live: base64.convert", "replace": "handler: no.such"}])
    assert broken["ok"] is False and "11: " in broken["near"] and "no.such" in broken["near"]
    assert "no.such" in call_error(mcp, token, "propose_definition", summary="Broken.")

    fixed = call(mcp, token, "edit_definition", edits=[
        {"find": "handler: no.such", "replace": "live: base64.convert"},
        {"find": "label: Shouty encoder", "replace": "label: Loud encoder"},
    ])
    assert fixed["ok"] is True
    proposed = call(mcp, token, "propose_definition", summary="Renamed it.")
    assert proposed["propose"]["source"] == ENCODER.replace("Shouty encoder", "Loud encoder")


def test_outside_an_editor_there_is_no_draft(mcp):
    from tests.test_platform_tools import call_error

    assert "only beside an editor" in call_error(mcp, _token(), "check_definition", kind="pane")
    # Given its source, a check needs no editor.
    assert call(mcp, _token(), "check_definition", kind="pane", source=ENCODER)["ok"] is True


def test_every_example_starts_a_pane_type_that_checks_clean():
    """Started from as it was, IoT failed Check on its `flag:` line before
    anything was changed."""
    from app.panes import manifest as pane_manifest

    for type_id in pane_manifest.bundled():
        out = client.get(f"/api/builder/examples/{type_id}").json()
        assert "flag:" not in out["source"] and not out["source"].startswith("id:"), type_id
        checked = client.post("/api/builder/check", json={"source": out["source"]}).json()
        assert checked == {"ok": True, "errors": []}, (type_id, checked)
