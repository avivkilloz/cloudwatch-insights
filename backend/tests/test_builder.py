"""The Builder, first part (PLATFORM_PLAN.md §24, D103-D106): pane types made
in the platform -- checked by the manifest's own model with the line of each
mistake, used at once by their builder's group, others when granted, kept in
the store and loaded beside the bundled manifests (the agent's kinds too)."""

import yaml

from app import builder, models, store
from app.db import SessionLocal
from app.panes import manifest as pane_manifest
from tests.conftest import client
from tests.test_pane_grants import _login_as
from tests.test_platform_tools import _token, call, mcp  # noqa: F401 -- a fixture
from tests.test_store import _configure, _env, _show, _sync, remote  # noqa: F401 -- fixtures

ENCODER = """label: Shouty encoder
description: Base64, for a team that shouts.
category: Tools
inputs:
  - key: input
    type: text
    label: Text
    default: ""
actions:
  - id: convert
    live: base64.convert
outputs:
  - key: output
    render: code
  - key: error
    render: error
layout:
  - title: Input
    items:
      - input: input
  - title: Base64
    items:
      - output: output
"""


def _group(name: str, **flags) -> int:
    resp = client.post("/api/user-groups", json={"name": name, "role_name": "R", **flags})
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


def _member(username: str, group_id: int):
    assert client.post("/api/users", json={"username": username, "password": "pw-123456", "group_id": group_id}).status_code == 201
    return _login_as(username)


def test_only_a_builder_or_an_admin_builds():
    plain = _member("pat", _group("Plain", pane_types=["tool-base64"]))
    assert plain.get("/api/builder/panes").status_code == 403
    assert plain.get("/api/auth/me").json()["builder_enabled"] is False
    builders = _member("bea", _group("Builders", builder_enabled=True, pane_types=["tool-base64"]))
    assert builders.get("/api/auth/me").json()["builder_enabled"] is True
    assert builders.get("/api/builder/panes").json() == []
    assert client.get("/api/auth/me").json()["builder_enabled"] is True  # an admin


def test_check_says_every_mistake_with_its_line():
    bad = ENCODER.replace("live: base64.convert", "handler: no.such").replace("output: output\n", "output: nothing\n")
    out = client.post("/api/builder/check", json={"source": bad}).json()
    assert out["ok"] is False
    messages = " | ".join(e["message"] for e in out["errors"])
    assert "nothing" in messages, messages
    assert client.post("/api/builder/check", json={"source": ENCODER}).json() == {"ok": True, "errors": []}

    handler = client.post("/api/builder/check", json={"source": ENCODER.replace("live: base64.convert", "handler: no.such")}).json()
    [error] = handler["errors"]
    assert "There is no handler no.such" in error["message"] and error["line"] == 11
    flagged = client.post("/api/builder/check", json={"source": "flag: tools_enabled\n" + ENCODER}).json()
    assert "no flag" in flagged["errors"][0]["message"]
    own = client.post("/api/builder/panes", json={"id": "tool-base64", "source": ENCODER})
    assert own.status_code == 400


def test_a_builders_group_uses_it_at_once_and_others_when_granted():
    builders = _group("Builders", builder_enabled=True, pane_types=["tool-base64"])
    bea = _member("bea", builders)
    others = _member("oz", _group("Others", pane_types=["tool-base64"]))
    made = bea.post("/api/builder/panes", json={"id": "shouty", "source": ENCODER})
    assert made.status_code == 201, made.text
    assert made.json()["label"] == "Shouty encoder" and made.json()["source"].startswith("id: shouty\n")

    assert "shouty" in [m["id"] for m in bea.get("/api/pane-types").json()]
    assert "shouty" in bea.get("/api/auth/me").json()["pane_types"]
    tools = next(c for c in bea.get("/api/catalogue").json()["categories"] if c["name"] == "Tools")
    assert "shouty" in tools["pane_types"]
    assert "shouty" not in [m["id"] for m in others.get("/api/pane-types").json()]
    assert "shouty" in [m["id"] for m in client.get("/api/pane-types").json()]  # admins use every pane

    # An edit is everyone's at once; Delete takes it away, grants and all.
    assert bea.put("/api/builder/panes/shouty", json={"source": ENCODER.replace("Shouty encoder", "Loud encoder")}).json()["label"] == "Loud encoder"
    assert pane_manifest.get("shouty").label == "Loud encoder"
    assert bea.delete("/api/builder/panes/shouty").status_code == 204
    assert "shouty" not in [m["id"] for m in bea.get("/api/pane-types").json()]
    with SessionLocal() as db:
        assert db.query(models.GroupPaneGrant).filter_by(pane_type="shouty").count() == 0


def test_the_agent_uses_a_built_pane_like_any_other(mcp):
    assert client.post("/api/builder/panes", json={"id": "shouty", "source": ENCODER}).status_code == 201
    token = _token()
    kinds = [k["kind"] for k in call(mcp, token, "get_context")["pane_kinds"]]
    assert "shouty" in kinds
    made = call(mcp, token, "create_session", title="Loud", panes=[{"kind": "shouty"}])
    ran = call(mcp, token, "run_pane", session_id=made["session_id"], pane_id="shouty", inputs={"input": "hi"})
    assert "aGk=" in str(ran), ran


def test_another_replica_sees_a_save_by_its_generation():
    assert client.post("/api/builder/panes", json={"id": "shouty", "source": ENCODER}).status_code == 201
    pane_manifest.set_built({})  # as a replica that hasn't loaded since
    builder._generation = None
    with SessionLocal() as db:
        builder.refresh(db)
    assert pane_manifest.get("shouty") is not None


def test_a_built_pane_is_kept_in_the_store_and_comes_back(remote):
    _configure(remote)
    made = client.post("/api/builder/panes", json={"id": "shouty", "source": ENCODER}).json()
    assert made["id"] == "devops:shouty"
    _sync()
    kept = _show(remote, "panes/shouty.yaml")
    assert kept.startswith("id: devops:shouty\n") and yaml.safe_load(kept)["label"] == "Shouty encoder"
    assert "panes" in yaml.safe_load(_show(remote, "plugin.yaml"))["contributes"]

    with SessionLocal() as db:
        db.query(models.StoreItem).filter_by(kind="pane").delete()
        db.query(models.BuiltPaneType).delete()
        db.commit()
        builder.load(db)
    assert pane_manifest.get("devops:shouty") is None
    store.startup()
    with SessionLocal() as db:
        builder.load(db)
    assert pane_manifest.get("devops:shouty").label == "Shouty encoder"


# ---------------------------------------------------------------- the agent builds (5-2, D107)


def test_the_agent_reads_what_a_definition_can_say_and_checks_a_draft(mcp):
    token = _token()
    ref = call(mcp, token, "build_reference", kind="pane")
    assert "label" in ref["manifest"] and "request (AWS)" in ref and "request (HTTP)" in ref and "base64.convert" in ref["live_functions"]
    assert "aws.dynamodb.scan" in ref["handlers"] and "tool-base64" in ref["examples"]
    example = call(mcp, token, "read_definition", kind="pane", definition_id="tool-base64")
    assert "live: base64.convert" in example["source"]

    bad = call(mcp, token, "check_definition", kind="pane", source=ENCODER.replace("live: base64.convert", "handler: no.such"))
    assert bad["ok"] is False and bad["errors"][0]["line"] == 11
    # A new one's id is the editor's own field: the draft isn't faulted for lacking it.
    assert call(mcp, token, "check_definition", kind="pane", source=ENCODER) == {"ok": True, "errors": []}

    from tests.test_platform_tools import call_error

    # Refused as a failed step, not answered as one that went through ("Put a
    # draft in the editor ✓" over a refusal was taken as done).
    refused = call_error(mcp, token, "propose_definition", kind="pane", source="label: x\n", summary="A start.")
    assert "Nothing was put in the editor" in refused and "layout" in refused
    proposed = call(mcp, token, "propose_definition", kind="pane", source=ENCODER, summary="A shouting encoder.")
    assert proposed["propose"] == {"kind": "pane", "source": ENCODER, "summary": "A shouting encoder."}
    # Nothing was saved: the user's Save is what saves.
    assert client.get("/api/builder/panes").json() == []

    wf = call(mcp, token, "build_reference", kind="workflow")
    assert "steps" in wf["definition"] and any(p["pane"] == "tool-base64" for p in wf["panes"])
    assert call(mcp, token, "check_definition", kind="workflow", source="label: W\nsteps:\n  - id: a\n    note: hi\n")["ok"]
    broken = call(mcp, token, "check_definition", kind="workflow", source="label: W\nsteps:\n  - id: a\n    pane: nope\n    action: x\n")
    assert broken["ok"] is False


def test_the_agent_builds_only_what_its_user_may(mcp):
    from tests.test_platform_tools import call_error

    plain = _group("Plain", pane_types=["tool-base64"], agent_enabled=True)
    _member("pat", plain)
    builders = _group("Builders", builder_enabled=True, pane_types=["tool-base64"], agent_enabled=True)
    _member("bea", builders)
    with SessionLocal() as db:
        pat = db.query(models.User).filter_by(username="pat").one().id
        bea = db.query(models.User).filter_by(username="bea").one().id
    assert "isn't turned on" in call_error(mcp, _token(pat), "build_reference", kind="pane")
    assert "isn't turned on" in call_error(mcp, _token(pat), "propose_definition", kind="pane", source=ENCODER, summary="x")
    # A builder builds pane types, and since 5-3 workflows (D121); someone else neither.
    assert call(mcp, _token(bea), "check_definition", kind="pane", source=ENCODER)["ok"]
    assert call(mcp, _token(bea), "build_reference", kind="workflow")["kind"] == "workflow"
    assert "for admins and builders" in call_error(mcp, _token(pat), "build_reference", kind="workflow")


def test_with_a_store_the_yaml_may_name_it_without_its_namespace(remote):
    """The id typed in the editor is saved in the store's namespace (D78); the
    YAML naming it by that name alone was refused as a different id."""
    assert client.get("/api/builder/schema").json()["namespace"] is None
    _configure(remote)
    assert client.get("/api/builder/schema").json()["namespace"] == "devops"
    made = client.post("/api/builder/panes", json={"id": "lambda", "source": "id: lambda\n" + ENCODER})
    assert made.status_code == 201, made.text
    assert made.json()["id"] == "devops:lambda" and made.json()["source"].startswith("id: devops:lambda\n")
    other = client.post("/api/builder/panes", json={"id": "loud", "source": "id: quiet\n" + ENCODER})
    assert other.status_code == 400 and "Its id is devops:loud" in other.text


def test_a_draft_with_an_id_line_is_still_checked_in_full():
    """Its id line, held to "draft", failed first and Check dropped that
    error -- so nothing after it was checked, and any mistake read as none."""
    bad = "id: lambda\n" + ENCODER.replace("live: base64.convert", "handler: no.such")
    out = client.post("/api/builder/check", json={"source": bad}).json()
    assert out["ok"] is False and "There is no handler no.such" in out["errors"][0]["message"]
    # Against the Id typed for it: the same name is fine, another isn't.
    assert client.post("/api/builder/check", json={"source": "id: lambda\n" + ENCODER, "new_id": "lambda"}).json()["ok"]
    other = client.post("/api/builder/check", json={"source": "id: other\n" + ENCODER, "new_id": "lambda"}).json()
    assert other["ok"] is False and "Its id is lambda" in other["errors"][0]["message"]
