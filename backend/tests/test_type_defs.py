"""Credential and connection types as text (D159): built the way a pane is --
a draft of the store's YAML, checked with lines, changed by the Builder's
agent or Claude Code, proposed, saved by a person -- and a pane, step or
workflow that names a connection type that isn't there says so at Check,
and lists what it needs."""

from app import models, type_defs
from app.db import SessionLocal
from tests.conftest import client
from tests.test_access_tokens import _call, _error, _make
from tests.test_builder import ENCODER, _group, _member
from tests.test_platform_tools import mcp  # noqa: F401 -- a fixture


def test_a_type_is_its_yaml_checked_with_lines():
    for kind in type_defs.KINDS:
        assert type_defs.check(kind, type_defs.STARTERS[kind]) == [], kind
    with SessionLocal() as db:
        for row in db.query(models.CredentialType).all():
            assert type_defs.check("credential", type_defs.source_of("credential", row)) == [], row.id
    bad = type_defs.STARTERS["credential"].replace("kind: text", "kind: password") + "colour: red\n"
    errors = type_defs.check("credential", bad)
    by_message = {e["message"]: e["line"] for e in errors}
    assert any("has no 'colour'" in m and line == bad.splitlines().index("colour: red") + 1 for m, line in by_message.items())
    # At the field's own kind line, not the top of the list.
    assert any("kind 'password'" in m and line == bad.splitlines().index("    kind: password") + 1
               for m, line in by_message.items()), errors
    unread = type_defs.check("connection", "label: x\nfields: [\n")
    assert unread and "isn't YAML that reads" in unread[0]["message"] and unread[0]["line"]


def test_claude_code_builds_a_credential_type_in_a_draft(mcp):
    token = _make()["token"]
    reference = _call(mcp, token, "build_reference", kind="credential")
    assert "inject" in reference["definition"] and "api_token" in reference["existing"]
    assert "source" in _call(mcp, token, "read_definition", kind="credential", definition_id="api_token")

    draft_id = _call(mcp, token, "open_draft", kind="credential", new_id="acme_key")["draft_id"]
    out = _call(mcp, token, "change_definition", draft_id=draft_id, changes=[
        {"op": "set", "path": "label", "value": "Acme key"},
        {"op": "set", "path": "fields/token/kind", "value": "password"}])
    assert out["ok"] is False and "kind 'password'" in out["errors"][0]["message"]
    out = _call(mcp, token, "change_definition", draft_id=draft_id, changes=[
        {"op": "set", "path": "fields/token/kind", "value": "text"}])
    assert out["ok"], out
    assert "files of its own" in _error(mcp, token, "change_definition", draft_id=draft_id,
                                        changes=[{"op": "file", "name": "x.py", "text": "X = 1\n"}])
    proposed = _call(mcp, token, "propose_definition", draft_id=draft_id, summary="An Acme key.")
    assert proposed["ok"] and "Builder → Credentials → Acme key" in proposed["note"]
    draft = client.get(f"/api/build-drafts/{draft_id}").json()
    assert draft["kind"] == "credential" and "label: Acme key" in draft["source"] and draft["new_id"] == "acme_key"
    # Nothing saved: the type is made from the editor, by a person.
    assert all(t["label"] != "Acme key" for t in client.get("/api/credential-types").json())


def test_a_draft_of_an_existing_type_is_its_text_and_held_to_who_may_change_it():
    made = client.post("/api/connection-types", json={"id": "acme", "label": "Acme API",
                                                      "fields": [{"key": "tenant", "label": "Tenant"}]})
    assert made.status_code == 201, made.text
    with SessionLocal() as db:
        text = type_defs.source_of("connection", db.get(models.ConnectionType, "acme"))
    assert "label: Acme API" in text and "base_url" not in text
    draft = client.post("/api/build-drafts", json={"kind": "connection", "target_id": "acme", "source": text})
    assert draft.status_code == 201 and draft.json()["changed"] is False
    # Another group's builder can't make a draft of an admin's type.
    other = _member("oli", _group("Others", builder_enabled=True))
    assert other.post("/api/build-drafts", json={"kind": "connection", "target_id": "acme", "source": text}
                      ).status_code == 404
    assert other.post("/api/build-drafts", json={"kind": "connection", "source": "label: Mine\n"}).status_code == 201
    # Deleting the type forgets everyone's drafts of it.
    assert client.delete("/api/connection-types/acme").status_code == 204
    assert all(d["target_id"] != "acme" for d in client.get("/api/build-drafts?kind=connection").json())


PANE = ENCODER.replace("inputs:\n", "inputs:\n  - {key: target, type: connection, connection_type: acme_api}\n", 1)


def test_a_pane_naming_a_connection_type_thats_not_there_says_so_and_lists_what_it_needs():
    checked = client.post("/api/builder/check", json={"source": PANE}).json()
    assert checked["ok"] is False
    [missing] = [e for e in checked["errors"] if "acme_api" in e["message"]]
    assert "make it in the Builder's Connections" in missing["message"]
    assert missing["line"] == PANE.splitlines().index("  - {key: target, type: connection, connection_type: acme_api}") + 1
    assert client.post("/api/builder/needs", json={"kind": "pane", "source": PANE}).json() == [
        {"kind": "connection", "id": "acme_api", "label": None, "exists": False}]
    assert client.post("/api/connection-types", json={"id": "acme_api", "label": "Acme API"}).status_code == 201
    assert client.post("/api/builder/check", json={"source": PANE}).json()["ok"] is True
    assert client.post("/api/builder/needs", json={"kind": "pane", "source": PANE}).json()[0]["exists"] is True
