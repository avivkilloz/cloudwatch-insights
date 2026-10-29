"""The catalogue with categories (PLATFORM_PLAN.md §19.2, D66): categories are
data, a pane's suggestion only places it until an admin does, renaming keeps
the key, deleting moves the panes, favourites and hiding are each person's,
and everyone sees every pane type -- one none of their environments can run
marked so, never left out (D160)."""

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


def _member(username: str, environment_ids: list[int] | None = None) -> TestClient:
    g = client.post("/api/user-groups", json={"name": f"{username}-g", "environment_ids": environment_ids or []}).json()
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


def test_only_admins_arrange_and_everyone_sees_every_pane():
    alice = _member("alice")
    body = alice.get("/api/catalogue").json()
    mine = {t for c in body["categories"] for t in c["pane_types"]}
    assert {"tool-base64", "iot", "logs-cloudwatch", "tool-http"} <= mine
    assert mine == {t for c in client.get("/api/catalogue").json()["categories"] for t in c["pane_types"]}
    assert alice.post("/api/catalogue/categories", json={"name": "Mine"}).status_code == 403
    assert alice.put("/api/catalogue/layout", json={"categories": []}).status_code == 403


def test_favourites_and_hidden_are_each_persons():
    alice = _member("alice")
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


def test_a_category_says_what_it_is():
    cats = _by_name(client.get("/api/catalogue").json())
    assert cats["Services"]["description"].startswith("A window onto an AWS service")
    made = _by_name(client.post("/api/catalogue/categories", json={"name": "Tracing", "description": " Spans and traces. "}).json())
    assert made["Tracing"]["description"] == "Spans and traces."
    plain = _by_name(client.post("/api/catalogue/categories", json={"name": "Databases"}).json())
    assert plain["Databases"]["description"] == ""

    # A rename leaves the description alone unless it's given; "" clears even a default.
    tools = cats["Tools"]["id"]
    assert _by_name(client.put(f"/api/catalogue/categories/{tools}", json={"name": "Utilities"}).json())["Utilities"]["description"].startswith("Self-contained")
    cleared = client.put(f"/api/catalogue/categories/{tools}", json={"name": "Utilities", "description": ""}).json()
    assert _by_name(cleared)["Utilities"]["description"] == ""
    long = client.put(f"/api/catalogue/categories/{tools}", json={"name": "Utilities", "description": "x" * 301})
    assert long.status_code == 400 and "300 characters" in long.json()["detail"]


def test_a_pane_no_environment_can_run_is_marked_not_hidden():
    """Without an AWS connection anywhere they can see, the AWS panes say so;
    a tool needs nothing, and the HTTP client's Target may be left unset."""
    alice = _member("alice")
    body = alice.get("/api/catalogue").json()
    marked = body["no_environment"]
    assert "iot" in marked and "logs-cloudwatch" in marked and "tables" in marked
    assert "AWS" in marked["iot"] and "yet" in marked["iot"]
    assert "tool-base64" not in marked and "tool-http" not in marked
    assert "iot" in {t for c in body["categories"] for t in c["pane_types"]}

    env = client.post("/api/environments", json={"name": "Prod", "account_id": "1", "region": "us-east-1"}).json()
    bob = _member("bob", [env["id"]])
    assert "iot" not in bob.get("/api/catalogue").json()["no_environment"]

