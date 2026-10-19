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
