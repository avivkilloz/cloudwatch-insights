"""Drafts of what's being built (D125): saved as their builder types, listed
beside what's built, opened again with their Building chat -- each person's
own, one per existing thing, gone with it."""

from tests.conftest import client
from tests.test_builder import ENCODER, _group, _member


def test_a_new_pane_types_draft_is_kept_with_its_chat_and_listed_as_its_builders():
    bea = _member("bea_d", _group("Draft builders", builder_enabled=True, pane_types=["tool-base64"]))
    made = bea.post("/api/build-drafts", json={"kind": "pane", "source": ENCODER, "new_id": " shouty "})
    assert made.status_code == 201, made.text
    draft = made.json()
    assert draft["label"] == "Shouty encoder" and draft["new_id"] == "shouty" and draft["target_id"] is None

    turn = {"id": "t1", "question": "make it louder", "answer": "Done.", "steps": []}
    changed = bea.put(f"/api/build-drafts/{draft['id']}", json={"source": ENCODER.replace("Shouty", "Loud"),
                                                                 "chat": [turn]})
    assert changed.status_code == 200 and changed.json()["label"] == "Loud encoder" and changed.json()["turns"] == 1
    opened = bea.get(f"/api/build-drafts/{draft['id']}").json()
    assert opened["source"].startswith("label: Loud encoder") and opened["chat"] == [turn]
    assert [d["id"] for d in bea.get("/api/build-drafts?kind=pane").json()] == [draft["id"]]
    assert bea.get("/api/build-drafts?kind=workflow").json() == []

    # Nobody else's: not listed, read or changed -- an admin's neither.
    assert client.get("/api/build-drafts").json() == []
    assert client.get(f"/api/build-drafts/{draft['id']}").status_code == 404
    assert client.put(f"/api/build-drafts/{draft['id']}", json={"source": "x"}).status_code == 404
    assert bea.delete(f"/api/build-drafts/{draft['id']}").status_code == 204
    assert bea.get("/api/build-drafts").json() == []


def test_only_whoever_may_build_it_keeps_a_draft():
    plain = _member("pat_d", _group("Plain drafts", pane_types=["tool-base64"]))
    for kind in ("pane", "step", "workflow"):
        assert plain.post("/api/build-drafts", json={"kind": kind, "source": "label: x"}).status_code == 403
    assert client.post("/api/build-drafts", json={"kind": "dashboard", "source": "x"}).status_code == 400


def test_an_existing_ones_draft_is_one_per_person_and_goes_with_it():
    assert client.post("/api/builder/panes", json={"id": "shouty", "source": ENCODER}).status_code == 201
    assert client.post("/api/build-drafts", json={"kind": "pane", "target_id": "nope", "source": ENCODER}
                       ).status_code == 404
    first = client.post("/api/build-drafts", json={"kind": "pane", "target_id": "shouty", "source": ENCODER + "#1\n"})
    again = client.post("/api/build-drafts", json={"kind": "pane", "target_id": "shouty", "source": ENCODER + "#2\n"})
    assert first.json()["id"] == again.json()["id"]
    [found] = client.get("/api/build-drafts?kind=pane&target=shouty").json()
    assert found["source"].endswith("#2\n") and found["chat"] == []

    assert client.delete("/api/builder/panes/shouty").status_code == 204
    assert client.get("/api/build-drafts").json() == []


def test_a_long_chat_keeps_its_newest_turns():
    big = [{"id": f"t{i}", "answer": "x" * 200_000} for i in range(8)]
    made = client.post("/api/build-drafts", json={"kind": "workflow", "source": "label: W\nsteps: []\n", "chat": big})
    assert made.status_code == 201
    kept = client.get(f"/api/build-drafts/{made.json()['id']}").json()["chat"]
    assert 0 < len(kept) < 8 and kept[-1]["id"] == "t7"


def test_once_created_a_new_ones_draft_keeps_its_chat_as_the_created_ones():
    turn = {"id": "t1", "question": "an encoder", "answer": "Here.", "steps": []}
    draft = client.post("/api/build-drafts", json={"kind": "pane", "source": ENCODER, "new_id": "shouty",
                                                   "chat": [turn]}).json()
    saved = client.post("/api/builder/panes", json={"id": "shouty", "source": ENCODER}).json()
    moved = client.put(f"/api/build-drafts/{draft['id']}", json={"target_id": "shouty", "source": saved["source"]})
    assert moved.status_code == 200, moved.text
    assert moved.json()["target_id"] == "shouty" and moved.json()["changed"] is False
    [found] = client.get("/api/build-drafts?kind=pane&target=shouty").json()
    assert found["chat"] == [turn]
    # Changed again, it's a change; it can't be moved onto another one.
    assert client.put(f"/api/build-drafts/{draft['id']}", json={"source": ENCODER + "#x\n"}).json()["changed"] is True
    assert client.put(f"/api/build-drafts/{draft['id']}", json={"target_id": "other"}).status_code == 400
