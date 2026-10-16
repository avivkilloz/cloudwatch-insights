"""The catalogue with categories (PLATFORM_PLAN.md §19.2, D66): categories are
data, a pane's suggestion only places it until an admin does, renaming keeps
the key, deleting moves the panes, favourites and hiding are each person's,
and nobody sees a pane type their group can't use."""

from fastapi.testclient import TestClient

from app import catalogue, models
from app.db import SessionLocal
from app.main import app
from tests.conftest import client


def _login_as(username: str, password: str = "pw-123456") -> TestClient:
    c = TestClient(app)
    resp = c.post("/api/auth/login", json={"username": username, "password": password})
    assert resp.status_code == 200, resp.text
    return c


def _member(username: str, pane_types: list[str]) -> TestClient:
    g = client.post("/api/user-groups", json={"name": f"{username}-g", "pane_types": pane_types}).json()
    assert client.post("/api/users", json={"username": username, "password": "pw-123456", "group_id": g["id"]}).status_code == 201
    return _login_as(username)


def _by_name(body: dict) -> dict[str, dict]:
    return {c["name"]: c for c in body["categories"]}


def test_services_and_tools_to_start_with():
    body = client.get("/api/catalogue").json()
    names = [c["name"] for c in body["categories"]]
    assert names[:2] == ["Services", "Tools"]
    cats = _by_name(body)
    assert "logs-cloudwatch" in cats["Services"]["pane_types"]
    assert "tool-base64" in cats["Tools"]["pane_types"]
    assert body["favourites"] == [] and body["hidden"] == []


def test_arranging_places_panes_and_survives_a_changed_suggestion(monkeypatch):
    cats = _by_name(client.post("/api/catalogue/categories", json={"name": "Debugging"}).json())
    debugging, tools = cats["Debugging"]["id"], cats["Tools"]["id"]
    resp = client.put("/api/catalogue/layout", json={"categories": [
        {"id": debugging, "pane_types": ["tool-jwt", "tool-base64"]},
        {"id": tools, "pane_types": [t for t in cats["Tools"]["pane_types"] if t not in ("tool-jwt", "tool-base64")]},
    ]})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert [c["name"] for c in body["categories"]][0] == "Debugging"
    assert _by_name(body)["Debugging"]["pane_types"] == ["tool-jwt", "tool-base64"]
    # A manifest that suggests elsewhere later (an upgrade) doesn't move a placed pane.
    from app.panes import manifest as pane_manifest

    jwt = pane_manifest.manifests()["tool-jwt"]
    monkeypatch.setattr(jwt, "category", "Security")
    assert "tool-jwt" in _by_name(client.get("/api/catalogue").json())["Debugging"]["pane_types"]


def test_an_unplaced_pane_follows_its_suggestion_into_a_new_category(monkeypatch):
    from app.panes import manifest as pane_manifest

    diff = pane_manifest.manifests()["tool-diff"]
    monkeypatch.setattr(diff, "category", "Text")
    cats = _by_name(client.get("/api/catalogue").json())
    assert cats["Text"]["pane_types"] == ["tool-diff"]
    assert "tool-diff" not in cats["Tools"]["pane_types"]


def test_rename_keeps_the_key_so_the_old_name_doesnt_come_back():
    cats = _by_name(client.get("/api/catalogue").json())
    resp = client.put(f"/api/catalogue/categories/{cats['Tools']['id']}", json={"name": "Utilities"})
    assert resp.status_code == 200, resp.text
    db = SessionLocal()
    try:
        catalogue.ensure_categories(db)
    finally:
        db.close()
    names = [c["name"] for c in client.get("/api/catalogue").json()["categories"]]
    assert "Utilities" in names and "Tools" not in names


def test_names_are_unique_and_needed():
    assert client.post("/api/catalogue/categories", json={"name": "services"}).status_code == 400
    assert client.post("/api/catalogue/categories", json={"name": "  "}).status_code == 400


def test_delete_moves_its_panes():
    cats = _by_name(client.get("/api/catalogue").json())
    tools = cats["Tools"]["pane_types"]
    resp = client.delete(f"/api/catalogue/categories/{cats['Tools']['id']}", params={"move_to": cats["Services"]["id"]})
    assert resp.status_code == 200, resp.text
    after = _by_name(resp.json())
    assert "Tools" not in after
    assert after["Services"]["pane_types"][-len(tools):] == tools
    # And it stays gone: its panes are placed now, so nothing suggests it.
    db = SessionLocal()
    try:
        catalogue.ensure_categories(db)
        assert db.query(models.CatalogueCategory).filter(models.CatalogueCategory.key == "Tools").count() == 0
    finally:
        db.close()


def test_only_admins_arrange_and_members_see_only_their_panes():
    alice = _member("alice", ["tool-base64", "iot"])
    body = alice.get("/api/catalogue").json()
    assert {t for c in body["categories"] for t in c["pane_types"]} == {"tool-base64", "iot"}
    assert alice.post("/api/catalogue/categories", json={"name": "Mine"}).status_code == 403
    assert alice.put("/api/catalogue/layout", json={"categories": []}).status_code == 403


def test_favourites_and_hidden_are_each_persons():
    alice = _member("alice", ["tool-base64", "tool-diff", "iot"])
    assert alice.put("/api/catalogue/preferences/iot", json={"favourite": True}).status_code == 200
    body = alice.put("/api/catalogue/preferences/tool-diff", json={"hidden": True}).json()
    assert body["favourites"] == ["iot"] and body["hidden"] == ["tool-diff"]
    # Not the admin's.
    mine = client.get("/api/catalogue").json()
    assert mine["favourites"] == [] and mine["hidden"] == []
    # Un-hidden and un-favourited, nothing's kept.
    alice.put("/api/catalogue/preferences/tool-diff", json={"hidden": False})
    body = alice.put("/api/catalogue/preferences/iot", json={"favourite": False}).json()
    assert body["favourites"] == [] and body["hidden"] == []
    assert alice.put("/api/catalogue/preferences/nope", json={"hidden": True}).status_code == 400
