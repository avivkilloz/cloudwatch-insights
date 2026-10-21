"""The store keeps a pane, a step and a workflow each in a folder of its own
(D140): the definition and the Python files beside it, the folder's git tree
its version -- and a repo from before folders restores, then moves once."""

from pathlib import Path

import yaml

from app import builder, gitrepo, models, step_types, store
from app.db import SessionLocal
from tests.conftest import client
from tests.test_store import _configure, _edit_in_the_repo, _env, _git, _log, _show, _sync, remote  # noqa: F401

PANE = """label: Devices
inputs:
  - {key: connection, type: connection, connection_type: http_api}
actions:
  - id: list
    main: true
    code: {file: devices.py}
outputs:
  - {key: rows, render: table}
layout:
  - title: Devices
    items:
      - input: connection
      - toolbar:
          - action: list
      - output: rows
"""
FILES = {
    "devices.py": "from shape import tidy\n\n\ndef run(inputs, ctx):\n    return {'rows': tidy([])}\n",
    "shape.py": "def tidy(rows):\n    return rows\n",
}


def _tree(remote: Path, path: str) -> str:
    return _git("--git-dir", str(remote), "rev-parse", f"main:{path}").strip()


def _item(kind: str, item_id: str) -> models.StoreItem:
    with SessionLocal() as db:
        return db.query(models.StoreItem).filter_by(kind=kind, item_id=item_id).one()


def test_a_pane_with_code_is_a_folder_of_its_files_and_comes_back(remote):
    _configure(remote)
    made = client.post("/api/builder/panes", json={"id": "devices", "source": PANE, "files": FILES})
    assert made.status_code == 201, made.text
    _sync()
    assert _show(remote, "panes/devices/pane.yaml").startswith("id: devops:devices\n")
    assert _show(remote, "panes/devices/shape.py") == FILES["shape.py"]
    assert yaml.safe_load(_show(remote, "plugin.yaml"))["contributes"]["panes"] == ["devices"]
    item = _item("pane", "devops:devices")
    # Its version is the folder's tree, as git has it.
    assert (item.path, item.state) == ("panes/devices", "synced")
    assert item.blob == _tree(remote, "panes/devices")
    assert gitrepo.tree_hash({**FILES, "pane.yaml": _show(remote, "panes/devices/pane.yaml")}) == item.blob

    # A file it no longer has leaves the folder.
    tidied = FILES["devices.py"].replace("from shape import tidy\n\n\n", "").replace("tidy([])", "[]")
    assert client.put("/api/builder/panes/devops:devices",
                      json={"source": PANE, "files": {"devices.py": tidied}}).status_code == 200
    _sync()
    assert _show(remote, "panes/devices/shape.py") is None and _show(remote, "panes/devices/devices.py") == tidied

    # Lost here, and restored from the repo with its files.
    with SessionLocal() as db:
        db.query(models.StoreItem).delete()
        db.query(models.GroupPaneGrant).filter_by(pane_type="devops:devices").delete()
        db.query(models.BuiltPaneType).delete()
        db.commit()
    store.startup()
    with SessionLocal() as db:
        row = db.get(models.BuiltPaneType, "devops:devices")
        assert row is not None and row.files == {"devices.py": tidied}
        builder.load(db)
    assert _item("pane", "devops:devices").state == "synced"


def test_an_edit_to_any_of_its_files_in_the_repo_is_a_conflict(remote, tmp_path):
    _configure(remote)
    made = client.post("/api/builder/steps", json={"id": "online", "source": step_types.CODE_EXAMPLE,
                                                   "files": step_types.CODE_EXAMPLE_FILES})
    assert made.status_code == 201, made.text
    _sync()
    _edit_in_the_repo(remote, tmp_path, "steps/online/online.py", lambda s: s.replace('"online")', '"up")'))
    edited_here = {"online.py": step_types.CODE_EXAMPLE_FILES["online.py"].replace('"online")', '"seen")')}
    client.put("/api/builder/steps/devops:online", json={"source": step_types.CODE_EXAMPLE, "files": edited_here})
    status = _sync()
    assert status["result"]["conflicts"] == 1 and _item("step", "devops:online").state == "conflict"
    sides = client.get("/api/store/items/step/devops:online").json()
    assert "# ---- online.py ----" in sides["mine"] and '"seen")' in sides["mine"] and '"up")' in sides["theirs"]
    resp = client.post("/api/store/items/step/devops:online/resolve", json={"take": "theirs"})
    assert resp.status_code == 200, resp.text
    with SessionLocal() as db:
        assert '"up")' in db.get(models.BuiltStepType, "devops:online").files["online.py"]
    assert _item("step", "devops:online").state == "synced"


def test_a_repo_from_before_folders_restores_and_is_moved_once(remote, tmp_path):
    # The old layout, written by hand: a pane and a workflow in files of their own.
    other = tmp_path / "old"
    _git("clone", "--quiet", f"file://{remote}", str(other))
    (other / "panes").mkdir()
    (other / "panes" / "plain.yaml").write_text("id: devops:plain\n" + PANE.replace(
        "    code: {file: devices.py}\n", "    code: |\n      def run(inputs, ctx):\n          return {'rows': []}\n"))
    (other / "workflows").mkdir()
    (other / "workflows" / "hello.yaml").write_text(
        "id: devops:hello\nlabel: Hello\nsteps:\n  - id: say\n    note: Hello.\n")
    _git("add", "-A", cwd=other)
    _git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "Old layout", cwd=other)
    _git("push", "--quiet", "origin", "HEAD:main", cwd=other)

    _configure(remote)
    with SessionLocal() as db:
        assert db.get(models.BuiltPaneType, "devops:plain") is not None
        assert db.get(models.Workflow, "devops:hello") is not None
    _sync()
    assert _show(remote, "panes/plain.yaml") is None and _show(remote, "workflows/hello.yaml") is None
    assert _show(remote, "panes/plain/pane.yaml").startswith("id: devops:plain\n")
    assert _show(remote, "workflows/hello/workflow.yaml").startswith("id: devops:hello\n")
    moves = [s for _a, _e, s in _log(remote) if s == "Move panes, steps and workflows into folders of their own"]
    assert len(moves) == 1
    assert (_item("pane", "devops:plain").path, _item("workflow", "devops:hello").path) == (
        "panes/plain", "workflows/hello")
    # Once: nothing is left to move.
    store.startup()
    _sync()
    assert len([s for _a, _e, s in _log(remote) if s.startswith("Move ")]) == 1
    contributes = yaml.safe_load(_show(remote, "plugin.yaml"))["contributes"]
    assert contributes["panes"] == ["plain"] and contributes["workflows"] == ["hello"]
