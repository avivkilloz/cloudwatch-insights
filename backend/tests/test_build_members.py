"""Who changes what's built (D161): its owner (who made it, unless handed on),
the members they add and admins -- never a whole group's builders -- while
using it is everyone's (D160). One draft per thing, shared by whoever may
change it, its chat everyone's there; a new one's draft is its starter's and
the members they add, who come with it when it's created."""

import datetime
import json

from sqlalchemy import text

from app import build_drafts, models, store
from app.db import SessionLocal, engine
from tests.conftest import client
from tests.test_builder import ENCODER, _group, _member
from tests.test_platform_tools import _token, call, call_error, mcp  # noqa: F401 -- a fixture
from tests.test_workflows import _finished, _run


def _id(username: str) -> int:
    with SessionLocal() as db:
        return db.query(models.User).filter_by(username=username).one().id


def _members(c, kind: str, target: str) -> dict:
    resp = c.get(f"/api/build-members/{kind}/{target}")
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_its_owner_and_members_change_it_and_another_builder_doesnt():
    bea = _member("bea", _group("Builders", builder_enabled=True))
    cal = _member("cal", _group("Other builders", builder_enabled=True))
    pat = _member("pat", _group("Plain"))
    assert bea.post("/api/builder/panes", json={"id": "shouty", "source": ENCODER}).status_code == 201

    refused = cal.put("/api/builder/panes/shouty", json={"source": ENCODER})
    assert refused.status_code == 400 and "Made by bea" in refused.text
    assert pat.put("/api/builder/panes/shouty", json={"source": ENCODER}).status_code == 400

    # Its owner adds someone without the Builder: being added is the grant.
    out = bea.post("/api/build-members/pane/shouty/members", json={"username": "pat"})
    assert out.status_code == 201, out.text
    listed = out.json()
    assert listed["owner"]["username"] == "bea" and [m["username"] for m in listed["members"]] == ["pat"]
    assert listed["can_manage"] is True
    louder = ENCODER.replace("Shouty encoder", "Loud encoder")
    assert pat.put("/api/builder/panes/shouty", json={"source": louder}).json()["label"] == "Loud encoder"
    assert pat.post("/api/builder/check", json={"source": louder, "id": "shouty"}).json()["ok"] is True
    assert pat.get("/api/builder/panes/shouty").json()["can_edit"] is True
    # ...and works in its draft.
    assert pat.post("/api/build-drafts", json={"kind": "pane", "target_id": "shouty", "source": louder}
                    ).status_code == 201

    # Managing it is its owner's (and admins'): a member can't add or remove others.
    assert bea.post("/api/build-members/pane/shouty/members", json={"username": "pat"}).status_code == 409
    assert bea.post("/api/build-members/pane/shouty/members", json={"username": "bea"}).status_code == 409
    assert bea.post("/api/build-members/pane/shouty/members", json={"username": "nobody"}).status_code == 404
    assert pat.post("/api/build-members/pane/shouty/members", json={"username": "cal"}).status_code == 403
    assert _members(pat, "pane", "shouty")["can_manage"] is False
    # Someone who may not change it doesn't see who may.
    assert cal.get("/api/build-members/pane/shouty").status_code == 404

    # A member leaves; the owner removes; an admin manages any.
    assert pat.delete(f"/api/build-members/pane/shouty/members/{_id('pat')}").json() == {"left": True}
    assert pat.put("/api/builder/panes/shouty", json={"source": ENCODER}).status_code == 400
    assert client.post("/api/build-members/pane/shouty/members", json={"username": "cal"}).status_code == 201
    assert cal.put("/api/builder/panes/shouty", json={"source": ENCODER}).status_code == 200
    assert bea.delete(f"/api/build-members/pane/shouty/members/{_id('cal')}").status_code == 200
    assert cal.put("/api/builder/panes/shouty", json={"source": ENCODER}).status_code == 400


def test_handing_it_on_keeps_the_old_owner_as_a_member():
    bea = _member("bea", _group("Builders", builder_enabled=True))
    cal = _member("cal", _group("Other builders", builder_enabled=True))
    made = bea.post("/api/workflows", json={"id": "hello", "source": "label: Hello\nsteps:\n  - id: say\n    note: hi\n"})
    assert made.status_code == 201, made.text
    assert cal.put("/api/build-members/workflow/hello/owner", json={"username": "cal"}).status_code == 404
    handed = bea.put("/api/build-members/workflow/hello/owner", json={"username": "cal"})
    assert handed.status_code == 200, handed.text
    assert handed.json()["owner"]["username"] == "cal"
    assert [m["username"] for m in handed.json()["members"]] == ["bea"]
    assert handed.json()["can_manage"] is False  # bea's a member now
    assert cal.get("/api/workflows/hello").json()["owner"] == "cal"
    assert bea.get("/api/workflows/hello").json()["can_edit"] is True


def test_a_credential_type_in_use_is_an_admins_whoever_owns_it():
    bea = _member("bea", _group("Builders", builder_enabled=True))
    pat = _member("pat", _group("Plain"))
    made = bea.post("/api/credential-types", json={"id": "acme_key", "label": "Acme API key", "fields": [
        {"key": "account", "label": "Account", "kind": "text", "secret": False, "required": True, "help": ""}]})
    assert made.status_code == 201, made.text
    assert made.json()["owner"] == "bea" and made.json()["locked"] is None
    assert bea.post("/api/build-members/credential/acme_key/members", json={"username": "pat"}).status_code == 201
    assert pat.patch("/api/credential-types/acme_key", json={"label": "Acme key"}).status_code == 200

    # The store's file doesn't say whose it is: that's this deployment's.
    with SessionLocal() as db:
        row = db.get(models.CredentialType, "acme_key")
        assert "owner" not in store.render(store.KINDS["credential_type"].dump(row))

    assert client.post("/api/credentials", json={"name": "Acme prod", "type_id": "acme_key", "scope": "global",
                                                 "values": {"account": "a1"}}).status_code == 201
    for c in (bea, pat):
        refused = c.patch("/api/credential-types/acme_key", json={"label": "x"})
        assert refused.status_code == 403 and "an admin changes it" in refused.json()["detail"]
        # How many, never which: those credentials are admins'.
        assert "Acme prod" not in refused.json()["detail"]
    assert client.patch("/api/credential-types/acme_key", json={"label": "Acme"}).status_code == 200


def test_a_connection_type_is_its_owners_and_members_and_everyones_to_read():
    bea = _member("bea", _group("Builders", builder_enabled=True))
    cal = _member("cal", _group("Other builders", builder_enabled=True))
    made = bea.post("/api/connection-types", json={"id": "acme", "label": "Acme API",
                                                   "fields": [{"key": "tenant", "label": "Tenant"}]})
    assert made.status_code == 201, made.text
    assert made.json()["owner"] == "bea"
    body = {"label": "Acme", "fields": [{"key": "tenant", "label": "Tenant"}]}
    assert cal.put("/api/connection-types/acme", json=body).status_code == 403
    assert bea.post("/api/build-members/connection/acme/members", json={"username": "cal"}).status_code == 201
    assert cal.put("/api/connection-types/acme", json=body).status_code == 200
    plain = _member("pat", _group("Plain"))
    assert "acme" in [t["id"] for t in plain.get("/api/connection-types").json()]
    assert plain.post("/api/connection-types", json={"id": "mine", "label": "Mine"}).status_code == 403


def test_one_draft_per_thing_shared_with_everyones_turns():
    assert client.post("/api/builder/panes", json={"id": "shouty", "source": ENCODER}).status_code == 201
    bea = _member("bea", _group("Builders", builder_enabled=True))
    assert client.post("/api/build-members/pane/shouty/members", json={"username": "bea"}).status_code == 201

    first = bea.post("/api/build-drafts", json={"kind": "pane", "target_id": "shouty", "source": ENCODER + "#bea\n",
                                                "chat": [{"id": "t1", "question": "louder?"}]})
    assert first.status_code == 201, first.text
    # The admin's tab, a second later, with only its own turn: one draft, both turns.
    again = client.post("/api/build-drafts", json={"kind": "pane", "target_id": "shouty", "source": ENCODER + "#admin\n",
                                                   "chat": [{"id": "t2", "question": "and bolder"}]})
    assert again.json()["id"] == first.json()["id"]
    [found] = bea.get("/api/build-drafts?kind=pane&target=shouty").json()
    assert found["source"].endswith("#admin\n") and [t["id"] for t in found["chat"]] == ["t1", "t2"]
    assert found["shared"] is True and found["changed"] is True
    assert first.json()["id"] in [d["id"] for d in bea.get("/api/build-drafts?kind=pane").json()]

    # A turn answered since comes back with its answer, in its place.
    put = bea.put(f"/api/build-drafts/{found['id']}", json={"chat": [{"id": "t1", "question": "louder?",
                                                                       "answer": "Done."}]})
    chat = bea.get(f"/api/build-drafts/{found['id']}").json()["chat"]
    assert put.status_code == 200 and [t.get("answer") for t in chat] == ["Done.", None]

    # Discarding a saved one's draft puts its text back; the chat is everyone's and stays.
    assert bea.delete(f"/api/build-drafts/{found['id']}").status_code == 204
    kept = bea.get(f"/api/build-drafts/{found['id']}").json()
    assert kept["changed"] is False and kept["source"].startswith("id: shouty\n") and len(kept["chat"]) == 2


def test_a_new_drafts_members_work_in_it_and_come_with_it_when_its_created():
    bea = _member("bea", _group("Builders", builder_enabled=True))
    pat = _member("pat", _group("Plain"))
    draft = bea.post("/api/build-drafts", json={"kind": "pane", "source": ENCODER, "new_id": "shouty"}).json()
    target = f"draft:{draft['id']}"
    assert pat.get(f"/api/build-drafts/{draft['id']}").status_code == 404
    added = bea.post(f"/api/build-members/pane/{target}/members", json={"username": "pat"})
    assert added.status_code == 201, added.text
    assert added.json()["owner"]["username"] == "bea" and added.json()["draft_id"] == draft["id"]

    assert draft["id"] in [d["id"] for d in pat.get("/api/build-drafts?kind=pane").json()]
    changed = pat.put(f"/api/build-drafts/{draft['id']}", json={"source": ENCODER.replace("Shouty", "Loud")})
    assert changed.status_code == 200 and changed.json()["shared"] is True
    assert pat.post(f"/api/build-members/pane/{target}/members", json={"username": "admin"}).status_code == 403
    assert pat.delete(f"/api/build-drafts/{draft['id']}").status_code == 403  # the starter's to discard

    # Created: the draft goes on as the saved one's, its members with it.
    assert bea.post("/api/builder/panes", json={"id": "shouty", "source": ENCODER}).status_code == 201
    assert bea.put(f"/api/build-drafts/{draft['id']}", json={"target_id": "shouty"}).status_code == 200
    assert [m["username"] for m in _members(bea, "pane", "shouty")["members"]] == ["pat"]
    # Asked by its old name, it's the saved one's now.
    assert _members(bea, "pane", target)["target"] == "shouty"
    assert pat.put("/api/builder/panes/shouty", json={"source": ENCODER}).status_code == 200

    # Deleting it forgets its draft and its members.
    assert bea.delete("/api/builder/panes/shouty").status_code == 204
    with SessionLocal() as db:
        assert db.query(models.BuildMember).count() == 0
        assert db.query(models.BuildDraft).count() == 0


def test_a_member_works_on_it_from_claude_code_and_another_builder_cant(mcp):
    bea = _member("bea", _group("Builders", builder_enabled=True, agent_enabled=True))
    _member("cal", _group("Other builders", builder_enabled=True, agent_enabled=True))
    _member("pat", _group("Plain", agent_enabled=True))
    assert bea.post("/api/builder/panes", json={"id": "shouty", "source": ENCODER}).status_code == 201
    assert bea.post("/api/build-members/pane/shouty/members", json={"username": "pat"}).status_code == 201

    opened = call(mcp, _token(_id("pat")), "open_draft", kind="pane", definition_id="shouty")
    again = call(mcp, _token(_id("bea")), "open_draft", kind="pane", definition_id="shouty")
    assert opened["draft_id"] == again["draft_id"]  # the one draft, whoever opens it
    changed = call(mcp, _token(_id("pat")), "change_definition", draft_id=opened["draft_id"],
                   changes=[{"op": "set", "path": "label", "value": "Pat's encoder"}])
    assert changed["ok"] is True
    [found] = bea.get("/api/build-drafts?kind=pane&target=shouty").json()
    assert "label: Pat's encoder" in found["source"]

    assert "Made by bea" in call_error(mcp, _token(_id("cal")), "open_draft", kind="pane", definition_id="shouty")
    assert "no draft" in call_error(mcp, _token(_id("cal")), "read_draft", draft_id=opened["draft_id"])
    # Reading is everyone's; a new one is a Builder's.
    assert call(mcp, _token(_id("pat")), "read_definition", kind="pane", definition_id="shouty")["source"]
    assert "groups with the Builder" in call_error(mcp, _token(_id("pat")), "open_draft", kind="pane")


def test_anyone_runs_any_workflow():
    bea = _member("bea", _group("Builders", builder_enabled=True))
    assert bea.post("/api/workflows", json={"id": "hello", "source": "label: Hello\nsteps:\n  - id: say\n    note: hi\n"}
                    ).status_code == 201
    pat = _member("pat", _group("Plain"))
    assert "hello" in [w["id"] for w in pat.get("/api/workflows").json()]
    run = _run("hello", {}, c=pat)
    assert _finished(run["id"], c=pat)["status"] == "succeeded"


def test_several_peoples_drafts_of_one_thing_fold_into_one():
    """The move to one draft per thing (D161, at startup): the newest is kept
    and the others' turns join its chat."""
    with SessionLocal() as db:
        admin = db.query(models.User).filter_by(username="admin").one().id
    bea = _member("bea", _group("Builders", builder_enabled=True))  # noqa: F841 -- a second person
    now = datetime.datetime.utcnow()
    table = models.BuildDraft.__table__
    with engine.begin() as conn:
        conn.execute(text("DROP INDEX uq_build_drafts_item"))
        conn.execute(table.insert(), [
            {"user_id": _id("bea"), "kind": "pane", "target_id": "shouty", "new_id": "", "source": "old",
             "chat": [{"id": "b1", "question": "hers"}], "created_at": now, "version": 1,
             "updated_at": now - datetime.timedelta(hours=1)},
            {"user_id": admin, "kind": "pane", "target_id": "shouty", "new_id": "", "source": "new",
             "chat": [{"id": "a1", "question": "mine"}], "created_at": now, "updated_at": now, "version": 1},
        ])
        build_drafts.fold_duplicates(conn)
        rows = conn.execute(text("SELECT source, chat FROM build_drafts WHERE target_id = 'shouty'")).all()
        conn.execute(text("CREATE UNIQUE INDEX uq_build_drafts_item ON build_drafts (kind, target_id) "
                          "WHERE target_id IS NOT NULL"))
    [(source, chat)] = rows
    chat = chat if isinstance(chat, list) else json.loads(chat)
    assert source == "new" and {t["id"] for t in chat} == {"a1", "b1"}
