"""The store repo (PLATFORM_PLAN.md §20.4, §21, D70, D78, D80): what admins
define here is written through to git in a plugin repo's layout, comes back
from it on a start, never waits on it, and never overwrites an edit made in
the repo.

Against real git: a bare repo in a temp dir, reached by a file:// URL under
the flag the suites set (`STORE_GIT_ALLOW_FILE_URLS`). Nothing of ours is
mocked; where a test needs the remote to move under a push, it moves it with
another clone, as a person would."""

import base64
import logging
import os
import subprocess
import threading
from pathlib import Path

import pytest
import yaml

from app import crypto, gitrepo, masking, models, store
from app.db import SessionLocal
from tests.conftest import client

K1 = base64.b64encode(b"1" * 32).decode()
TOKEN = "glpat-store-token-that-must-never-show"


def _git(*args: str, cwd: Path | None = None) -> str:
    env = {"PATH": os.environ["PATH"], "HOME": str(cwd or "/tmp"), "GIT_CONFIG_NOSYSTEM": "1",
           "GIT_CONFIG_GLOBAL": os.devnull, "GIT_AUTHOR_NAME": "someone", "GIT_AUTHOR_EMAIL": "someone@example.com",
           "GIT_COMMITTER_NAME": "someone", "GIT_COMMITTER_EMAIL": "someone@example.com",
           "GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "protocol.file.allow", "GIT_CONFIG_VALUE_0": "always"}
    proc = subprocess.run(["git", *args], cwd=cwd, env=env, capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr
    return proc.stdout


@pytest.fixture(autouse=True)
def _env(monkeypatch, tmp_path):
    monkeypatch.setenv("STORE_GIT_ALLOW_FILE_URLS", "1")
    monkeypatch.setenv("STORE_WORKDIR", str(tmp_path / "work"))
    monkeypatch.setenv(crypto.KEYS_ENV, f"k1:{K1}")
    monkeypatch.setenv(crypto.CURRENT_ENV, "k1")
    for name in ("STORE_GIT_URL", "STORE_GIT_BRANCH", "STORE_GIT_PATH", "STORE_NAMESPACE", "STORE_GIT_SECRET_DIR"):
        monkeypatch.delenv(name, raising=False)
    masking.reset()


@pytest.fixture
def remote(tmp_path) -> Path:
    bare = tmp_path / "remote.git"
    _git("init", "--quiet", "--bare", "--initial-branch=main", str(bare))
    return bare


def _configure(remote: Path, **extra) -> dict:
    resp = client.put("/api/store", json={"url": f"file://{remote}", "namespace": "devops", **extra})
    assert resp.status_code == 200, resp.text
    return resp.json()


def _sync() -> dict:
    resp = client.post("/api/store/sync")
    assert resp.status_code == 200, resp.text
    return resp.json()


def _log(remote: Path) -> list[tuple[str, str]]:
    out = _git("--git-dir", str(remote), "log", "--format=%an|%ae|%s", "main")
    return [tuple(line.split("|", 2)) for line in out.splitlines()]  # type: ignore[misc]


def _show(remote: Path, path: str) -> str | None:
    proc = subprocess.run(["git", "--git-dir", str(remote), "show", f"main:{path}"], capture_output=True, text=True)
    return proc.stdout if proc.returncode == 0 else None


def _credential_type(type_id: str = "deploy_token", label: str = "Deploy token") -> dict:
    resp = client.post("/api/credential-types", json={
        "id": type_id, "label": label, "fields": [{"key": "token", "label": "Token", "secret": True, "required": True}]})
    assert resp.status_code == 201, resp.text
    return resp.json()


def _state(item_id: str, kind: str = "credential_type") -> str | None:
    items = {(i["kind"], i["item_id"]): i for i in client.get("/api/store").json()["items"]}
    item = items.get((kind, item_id))
    return item["state"] if item else None


# ---------------------------------------------------------------- writing


def test_a_type_is_committed_as_the_admin_in_a_plugin_layout(remote):
    _configure(remote)
    made = _credential_type()
    assert made["id"] == "devops:deploy_token"
    assert made["store_state"] == "pending"
    assert _sync()["result"]["pushed"] == 1
    author, email, subject = _log(remote)[0]
    assert (author, email, subject) == ("admin", "admin@platform.local", "Add credential type devops:deploy_token")
    data = yaml.safe_load(_show(remote, "credential-types/deploy_token.yaml"))
    assert data["id"] == "devops:deploy_token" and data["fields"][0]["key"] == "token"
    plugin = yaml.safe_load(_show(remote, "plugin.yaml"))
    assert plugin["id"] == "devops" and plugin["contributes"] == {"credential_types": ["deploy_token"]}
    types = {x["id"]: x for x in client.get("/api/credential-types").json()}
    assert types[made["id"]]["store_state"] == "synced"

    client.patch(f"/api/credential-types/{made['id']}", json={"label": "Deploy key"})
    _sync()
    assert _log(remote)[0][2] == "Change credential type devops:deploy_token"
    assert yaml.safe_load(_show(remote, "credential-types/deploy_token.yaml"))["label"] == "Deploy key"

    assert client.delete(f"/api/credential-types/{made['id']}").status_code == 204
    _sync()
    assert _log(remote)[0][2] == "Delete credential type devops:deploy_token"
    assert _show(remote, "credential-types/deploy_token.yaml") is None
    assert "credential_types" not in yaml.safe_load(_show(remote, "plugin.yaml"))["contributes"]
    assert _state(made["id"]) is None


def test_connection_types_too_and_under_a_path(remote):
    _configure(remote, path="platform/store")
    resp = client.post("/api/connection-types", json={"id": "grafana", "label": "Grafana", "fields": [{"key": "org_id"}]})
    assert resp.status_code == 201, resp.text
    assert resp.json()["id"] == "devops:grafana"
    _sync()
    data = yaml.safe_load(_show(remote, "platform/store/connection-types/grafana.yaml"))
    assert data["id"] == "devops:grafana" and data["label"] == "Grafana"
    # The Base URL every such type has isn't written: it is the platform's, not the type's.
    assert [f["key"] for f in data["fields"]] == ["org_id"]
    assert yaml.safe_load(_show(remote, "platform/store/plugin.yaml"))["contributes"] == {"connection_types": ["grafana"]}


def test_what_was_here_before_is_added_in_one_commit_and_seeded_types_are_not(remote):
    _credential_type("old_token", "Old token")
    client.post("/api/connection-types", json={"id": "old_api", "label": "Old API"})
    _configure(remote)
    log = _log(remote)
    assert [s for _a, _e, s in log] == ["Add what this deployment already had"]
    assert _show(remote, "credential-types/old_token.yaml") is not None
    assert _show(remote, "connection-types/old_api.yaml") is not None
    # Prometheus' type came with its manifest: its own source, not ours.
    assert _show(remote, "connection-types/prometheus.yaml") is None
    # Ids made before a store keep theirs.
    assert yaml.safe_load(_show(remote, "credential-types/old_token.yaml"))["id"] == "old_token"


def test_credentials_values_never_reach_the_repo(remote):
    _configure(remote)
    t = _credential_type()
    resp = client.post("/api/credentials", json={
        "name": "deploy", "type_id": t["id"], "scope": "global", "values": {"token": TOKEN}})
    assert resp.status_code == 201, resp.text
    _sync()
    files = _git("--git-dir", str(remote), "ls-tree", "-r", "--name-only", "main").split()
    assert files == ["credential-types/deploy_token.yaml", "plugin.yaml"]
    for path in files:
        assert TOKEN not in (_show(remote, path) or "")


# ---------------------------------------------------------------- never blocked by git


def test_unreachable_saves_anyway_and_pushes_when_back(tmp_path):
    missing = tmp_path / "later.git"
    status = _configure(missing)
    assert status["configured"] is True and status["last_error"]
    made = _credential_type()
    result = _sync()
    assert "error" in result["result"]
    assert _state(made["id"]) == "pending"
    item = next(i for i in result["items"] if i["item_id"] == made["id"])
    assert item["error"]
    _git("init", "--quiet", "--bare", "--initial-branch=main", str(missing))
    assert _sync()["result"]["pushed"] >= 1
    assert _state(made["id"]) == "synced"
    assert _show(missing, "credential-types/deploy_token.yaml") is not None


# ---------------------------------------------------------------- restoring


def _helm(monkeypatch, remote: Path) -> None:
    monkeypatch.setenv("STORE_GIT_URL", f"file://{remote}")
    monkeypatch.setenv("STORE_NAMESPACE", "devops")


def _lose_everything_but_the_repo() -> None:
    db = SessionLocal()
    try:
        db.query(models.StoreOutbox).delete()
        db.query(models.StoreItem).delete()
        db.query(models.CredentialType).filter(models.CredentialType.builtin.is_(False)).delete()
        db.query(models.ConnectionType).filter(models.ConnectionType.builtin.is_(False),
                                               models.ConnectionType.origin.is_(None)).delete()
        db.query(models.Setting).filter(models.Setting.key.like("store.%")).delete(synchronize_session=False)
        db.commit()
    finally:
        db.close()


def test_a_new_database_gets_the_types_back(monkeypatch, remote):
    _helm(monkeypatch, remote)
    store.startup()
    t = _credential_type()
    client.post("/api/connection-types", json={"id": "grafana", "label": "Grafana"})
    _sync()
    _lose_everything_but_the_repo()
    assert t["id"] not in {x["id"] for x in client.get("/api/credential-types").json()}

    store.startup()
    types = {x["id"]: x for x in client.get("/api/credential-types").json()}
    assert types[t["id"]]["label"] == "Deploy token" and types[t["id"]]["store_state"] == "synced"
    assert "devops:grafana" in {x["id"] for x in client.get("/api/connection-types").json()}
    # Restoring wrote nothing back.
    assert len(_log(remote)) == 2


def test_a_pending_delete_isnt_restored(monkeypatch, remote):
    _helm(monkeypatch, remote)
    store.startup()
    t = _credential_type()
    _sync()
    client.delete(f"/api/credential-types/{t['id']}")  # not pushed yet
    db = SessionLocal()
    try:
        store.restore(db)
    finally:
        db.close()
    assert t["id"] not in {x["id"] for x in client.get("/api/credential-types").json()}
    _sync()
    assert _show(remote, "credential-types/deploy_token.yaml") is None


def test_the_repos_copy_of_a_seeded_type_wins_on_a_restore(monkeypatch, remote):
    _helm(monkeypatch, remote)
    store.startup()
    resp = client.put("/api/connection-types/prometheus", json={"label": "Prometheus (edited)", "fields": []})
    assert resp.status_code == 200, resp.text
    _sync()
    db = SessionLocal()
    try:
        row = db.get(models.ConnectionType, "prometheus")
        row.label = "Prometheus"  # a fresh database: the seed again
        db.query(models.StoreItem).delete()
        db.query(models.Setting).filter(models.Setting.key.like("store.%")).delete(synchronize_session=False)
        db.commit()
    finally:
        db.close()
    store.startup()
    labels = {x["id"]: x["label"] for x in client.get("/api/connection-types").json()}
    assert labels["prometheus"] == "Prometheus (edited)"


# ---------------------------------------------------------------- conflicts


def _edit_in_the_repo(remote: Path, tmp_path: Path, path: str, change) -> None:
    other = tmp_path / "other"
    if not other.exists():
        _git("clone", "--quiet", f"file://{remote}", str(other))
    else:
        _git("pull", "--quiet", cwd=other)
    target = other / path
    target.write_text(change(target.read_text()))
    _git("commit", "--quiet", "-am", "Edited by hand", cwd=other)
    _git("push", "--quiet", cwd=other)


def test_an_edit_in_the_repo_is_never_overwritten(remote, tmp_path):
    _configure(remote)
    t = _credential_type()
    _sync()
    path = "credential-types/deploy_token.yaml"
    _edit_in_the_repo(remote, tmp_path, path, lambda s: s.replace("label: Deploy token", "label: Edited in git"))
    client.patch(f"/api/credential-types/{t['id']}", json={"label": "Edited here"})
    status = _sync()
    assert status["result"]["conflicts"] == 1
    assert _state(t["id"]) == "conflict"
    assert "Edited in git" in _show(remote, path)
    sides = client.get(f"/api/store/items/credential_type/{t['id']}").json()
    assert "Edited here" in sides["mine"] and "Edited in git" in sides["theirs"]

    # Keep mine: ours goes over theirs.
    resp = client.post(f"/api/store/items/credential_type/{t['id']}/resolve", json={"take": "mine"})
    assert resp.status_code == 200, resp.text
    assert "Edited here" in _show(remote, path) and _state(t["id"]) == "synced"

    # Again, and take theirs: the repo's comes in.
    _edit_in_the_repo(remote, tmp_path, path, lambda s: s.replace("label: Edited here", "label: Git again"))
    client.patch(f"/api/credential-types/{t['id']}", json={"label": "Here again"})
    _sync()
    resp = client.post(f"/api/store/items/credential_type/{t['id']}/resolve", json={"take": "theirs"})
    assert resp.status_code == 200, resp.text
    labels = {x["id"]: x["label"] for x in client.get("/api/credential-types").json()}
    assert labels[t["id"]] == "Git again" and _state(t["id"]) == "synced"
    assert "Git again" in _show(remote, path)


def test_the_same_item_on_both_sides_differently_is_a_conflict_on_configuring(remote, tmp_path):
    _configure(remote)
    _credential_type()
    _sync()
    client.delete("/api/store")
    # Another deployment's database has the same id with another label.
    db = SessionLocal()
    try:
        db.get(models.CredentialType, "devops:deploy_token").label = "Theirs differs"
        db.commit()
    finally:
        db.close()
    _configure(remote)
    assert _state("devops:deploy_token") == "conflict"


# ---------------------------------------------------------------- one writer


def test_two_writers_take_turns_and_lose_nothing(remote):
    _configure(remote)
    _credential_type("one_token", "One")
    _credential_type("two_token", "Two")
    results: list[dict] = []
    threads = [threading.Thread(target=lambda: results.append(store.flush())) for _ in range(2)]
    for th in threads:
        th.start()
    for th in threads:
        th.join()
    store.flush()
    subjects = [s for _a, _e, s in _log(remote)]
    assert subjects.count("Add credential type devops:one_token") == 1
    assert subjects.count("Add credential type devops:two_token") == 1


def test_a_push_refused_because_the_repo_moved_is_replayed(remote, tmp_path, monkeypatch):
    _configure(remote)
    _credential_type()
    real_push = gitrepo.Repo.push
    moved = {"done": False}

    def push_after_someone_else(self):
        if not moved["done"]:
            moved["done"] = True
            other = tmp_path / "meanwhile"
            _git("clone", "--quiet", f"file://{remote}", str(other))
            (other / "README.md").write_text("Someone else's change\n")
            _git("add", "README.md", cwd=other)
            _git("commit", "--quiet", "-m", "Meanwhile", cwd=other)
            _git("push", "--quiet", cwd=other)
        real_push(self)

    monkeypatch.setattr(gitrepo.Repo, "push", push_after_someone_else)
    assert _sync()["result"]["pushed"] == 1
    subjects = [s for _a, _e, s in _log(remote)]
    assert subjects[:2] == ["Add credential type devops:deploy_token", "Meanwhile"]
    assert _show(remote, "README.md") == "Someone else's change\n"


# ---------------------------------------------------------------- ids


def test_ids_without_a_store_stay_as_given():
    assert _credential_type()["id"] == "deploy_token"


def test_ids_in_another_namespace_are_refused(remote):
    _configure(remote)
    resp = client.post("/api/credential-types", json={"id": "acme:token", "label": "x", "fields": []})
    assert resp.status_code == 400 and "devops:token" in resp.json()["detail"]
    resp = client.post("/api/connection-types", json={"id": "acme:api", "label": "x"})
    assert resp.status_code == 400


def test_the_namespace_cant_change_under_items_named_in_it(remote):
    _configure(remote)
    _credential_type()
    resp = client.put("/api/store", json={"url": f"file://{remote}", "namespace": "other"})
    assert resp.status_code == 400 and "devops" in resp.json()["detail"]


# ---------------------------------------------------------------- configuration and secrets


@pytest.mark.parametrize("url, flag", [
    ("https://user:secret@git.example.com/r.git", "1"),
    ("http://git.example.com/r.git", "1"),
    ("ext::sh -c touch% /tmp/pwned", "1"),
    ("file:///tmp/r.git", ""),
])
def test_only_https_and_ssh_urls_without_credentials(monkeypatch, url, flag):
    monkeypatch.setenv("STORE_GIT_ALLOW_FILE_URLS", flag)
    resp = client.put("/api/store", json={"url": url, "namespace": "devops"})
    assert resp.status_code == 400, resp.text


def test_the_namespace_is_required():
    resp = client.put("/api/store", json={"url": "https://git.example.com/r.git", "namespace": ""})
    assert resp.status_code == 400 and "namespace" in resp.json()["detail"]


def test_a_helm_store_is_locked_here(monkeypatch, remote):
    _helm(monkeypatch, remote)
    status = client.get("/api/store").json()
    assert status["locked"] is True and status["source"] == "helm"
    assert client.put("/api/store", json={"url": f"file://{remote}", "namespace": "devops"}).status_code == 400
    assert client.delete("/api/store").status_code == 400


def test_the_token_shows_nowhere(caplog, tmp_path):
    caplog.set_level(logging.DEBUG)
    cred = client.post("/api/credentials", json={
        "name": "store token", "type_id": "api_token", "scope": "global", "values": {"token": TOKEN}})
    assert cred.status_code == 201, cred.text
    # An HTTPS remote nobody answers: the token is offered and the attempt fails.
    bodies = []
    resp = client.put("/api/store", json={
        "url": "https://127.0.0.1:9/nobody.git", "namespace": "devops", "credential_id": cred.json()["id"]})
    bodies.append(resp.text)
    assert resp.status_code == 200, resp.text
    _credential_type()
    bodies.append(client.post("/api/store/sync").text)
    bodies.append(client.get("/api/store").text)
    assert all(TOKEN not in b for b in bodies)
    assert TOKEN not in caplog.text
    clone = next((tmp_path / "work").rglob("clone"))
    assert TOKEN not in _git("remote", "-v", cwd=clone)
    assert TOKEN not in (clone / ".git" / "config").read_text()


def test_the_askpass_answers_with_the_token_only_to_git(tmp_path):
    repo = gitrepo.Repo("https://git.example.com/r.git", "main", tmp_path / "clone",
                        gitrepo.Auth(username="oauth2", password=TOKEN))
    assert TOKEN not in repr(repo.auth)
    with repo._env() as env:
        script = env["GIT_ASKPASS"]
        assert TOKEN not in script and TOKEN not in Path(script).read_text()
        ask = lambda prompt: subprocess.run([script, prompt], env=env, capture_output=True, text=True).stdout  # noqa: E731
        assert ask("Username for 'https://git.example.com': ") == "oauth2"
        assert ask("Password for 'https://oauth2@git.example.com': ") == TOKEN
    assert not Path(script).exists()


def test_admins_only(remote):
    g = client.post("/api/user-groups", json={"name": "plain", "pane_types": []}).json()
    client.post("/api/users", json={"username": "plain", "password": "pw-123456", "group_id": g["id"]})
    from fastapi.testclient import TestClient
    from app.main import app

    c = TestClient(app)
    c.post("/api/auth/login", json={"username": "plain", "password": "pw-123456"})
    assert c.get("/api/store").status_code == 403
    assert c.put("/api/store", json={"url": f"file://{remote}", "namespace": "x"}).status_code == 403


def test_a_link_in_the_repo_reaches_no_file_of_the_servers(remote, tmp_path):
    """Whoever can push to the store repo must not be able to make the backend
    read or write a server file through a symlink."""
    outside = tmp_path / "server-secret.txt"
    outside.write_text("id: devops:leak\nlabel: SERVER SECRET\nfields:\n- {key: token, label: Token}\n")
    other = tmp_path / "pusher"
    _git("clone", "--quiet", f"file://{remote}", str(other))
    (other / "credential-types").mkdir()
    (other / "credential-types" / "leak.yaml").symlink_to(outside)
    _git("add", "-A", cwd=other)
    _git("commit", "--quiet", "-m", "A link", cwd=other)
    _git("push", "--quiet", "origin", "HEAD:main", cwd=other)
    _configure(remote)
    labels = {t["label"] for t in client.get("/api/credential-types").json()}
    assert "SERVER SECRET" not in labels
    assert "SERVER SECRET" not in client.get("/api/store").text


def test_the_clone_never_writes_or_reads_through_a_link(tmp_path):
    outside = tmp_path / "server-file.txt"
    outside.write_text("untouched")
    repo = gitrepo.Repo("file:///nowhere.git", "main", tmp_path / "clone", gitrepo.Auth())
    (tmp_path / "clone" / "credential-types").mkdir(parents=True)
    (tmp_path / "clone" / "credential-types" / "x.yaml").symlink_to(outside)
    (tmp_path / "clone" / "linked").symlink_to(tmp_path)
    for path in ("credential-types/x.yaml", "linked/server-file.txt"):
        with pytest.raises(gitrepo.GitError):
            repo.write(path, "overwritten")
        with pytest.raises(gitrepo.GitError):
            repo.read(path)
    assert outside.read_text() == "untouched"
    assert repo.files("credential-types") == []
