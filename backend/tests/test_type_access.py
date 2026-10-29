"""Credential and connection types made by builders (D158): building a pane,
a step or a workflow often needs a type the platform doesn't have yet, so a
builder makes it -- their group's to change, an admin's too -- until a
credential uses it, when it shapes stored secrets and only an admin changes
it."""

from app import models, store
from app.db import SessionLocal
from tests.conftest import client
from tests.test_builder import _group, _member

TYPE = {"id": "acme_key", "label": "Acme API key",
        "fields": [{"key": "account", "label": "Account", "kind": "text", "secret": False, "required": True, "help": ""}]}


def test_a_builder_makes_a_credential_type_their_groups(monkeypatch):
    builders_id = _group("Builders", builder_enabled=True)
    bea = _member("bea", builders_id)
    made = bea.post("/api/credential-types", json=TYPE)
    assert made.status_code == 201, made.text
    assert made.json()["owner_group"] == "Builders" and made.json()["locked"] is None
    assert bea.post("/api/credential-types/infer", json={"example": {"user": "", "password": ""}}).status_code == 200
    changed = bea.patch("/api/credential-types/acme_key", json={"label": "Acme key"})
    assert changed.status_code == 200 and changed.json()["label"] == "Acme key"

    # Another group's builders read it, and can't change it; an admin can.
    other = _member("oli", _group("Others", builder_enabled=True))
    theirs = next(t for t in other.get("/api/credential-types").json() if t["id"] == "acme_key")
    assert "Made by Builders builders" in theirs["locked"]
    assert other.patch("/api/credential-types/acme_key", json={"label": "Mine"}).status_code == 403
    assert other.delete("/api/credential-types/acme_key").status_code == 403
    assert client.patch("/api/credential-types/acme_key", json={"description": "From admin"}).status_code == 200

    # Someone who isn't a builder makes none.
    plain = _member("pat", _group("Plain"))
    refused = plain.post("/api/credential-types", json={**TYPE, "id": "nope"})
    assert refused.status_code == 403 and "admins and builders" in refused.json()["detail"]

    # The store's file doesn't say whose it is: that's this deployment's.
    with SessionLocal() as db:
        row = db.get(models.CredentialType, "acme_key")
        assert row.owner_group_id == builders_id
        assert "owner" not in store.render(store.KINDS["credential_type"].dump(row))


def test_once_a_credential_uses_it_only_an_admin_changes_it():
    bea = _member("bea", _group("Builders", builder_enabled=True))
    assert bea.post("/api/credential-types", json=TYPE).status_code == 201
    made = client.post("/api/credentials", json={"name": "Acme prod", "type_id": "acme_key", "scope": "global",
                                                "values": {"account": "a1"}})
    assert made.status_code == 201, made.text
    listed = next(t for t in bea.get("/api/credential-types").json() if t["id"] == "acme_key")
    assert "1 credential uses it" in listed["locked"]
    for refused in (bea.patch("/api/credential-types/acme_key", json={"label": "x"}),
                    bea.delete("/api/credential-types/acme_key")):
        assert refused.status_code == 403 and "an admin changes it" in refused.json()["detail"]
        # How many, never which: those credentials are admins'.
        assert "Acme prod" not in refused.json()["detail"]
    assert client.patch("/api/credential-types/acme_key", json={"label": "Acme"}).status_code == 200


def test_a_builder_makes_and_keeps_changing_a_connection_type():
    bea = _member("bea", _group("Builders", builder_enabled=True))
    made = bea.post("/api/connection-types", json={"id": "acme", "label": "Acme API",
                                                   "fields": [{"key": "tenant", "label": "Tenant"}]})
    assert made.status_code == 201, made.text
    assert made.json()["owner_group"] == "Builders" and made.json()["locked"] is None
    # A connection of it doesn't lock it: its fields are plain, never a secret.
    env = client.post("/api/environments", json={"name": "Acme env"}).json()
    assert client.post(f"/api/environments/{env['id']}/connections", json={
        "type_id": "acme", "name": "acme", "config": {"base_url": "https://acme.example.com", "tenant": "t1"}}
    ).status_code == 201
    assert bea.put("/api/connection-types/acme", json={"label": "Acme", "fields": [
        {"key": "tenant", "label": "Tenant"}, {"key": "region", "label": "Region"}]}).status_code == 200

    other = _member("oli", _group("Others", builder_enabled=True))
    assert other.put("/api/connection-types/acme", json={"label": "Mine"}).status_code == 403
    assert _member("pat", _group("Plain")).get("/api/connection-types").status_code == 403
    assert client.put("/api/connection-types/acme", json={"label": "Acme (admin)", "fields": [
        {"key": "tenant", "label": "Tenant"}, {"key": "region", "label": "Region"}]}).status_code == 200
