"""A definition's dependencies (PLATFORM_PLAN.md §25, D141-D143): its
requirements.txt is locked by Check and Save into requirements.lock with uv,
against an index made here (tests/wheels.py) so nothing reaches PyPI; and the
platform's own index serves a job only the wheels its lock names."""

import base64
import datetime
import hashlib

import pytest

from app import deps, models, runner_client
from app.db import SessionLocal
from app.routers import runner as runner_router
from tests.conftest import client
from tests.wheels import Index

PANE = """label: Shaped
inputs:
  - {key: text, type: text}
actions:
  - id: shape
    main: true
    code: {file: shaped.py}
outputs:
  - {key: rows, render: table}
layout:
  - title: Shaped
    items:
      - input: text
      - toolbar:
          - action: shape
      - output: rows
"""
SHAPED = "import tinyshape\n\n\ndef run(inputs, ctx):\n    return {'rows': tinyshape.rows(inputs.get('text', ''))}\n"
TINY = {"tinyshape/__init__.py": "def rows(text):\n    return [{'word': w} for w in text.split()]\n"}


@pytest.fixture
def index(monkeypatch, tmp_path):
    served = Index()
    monkeypatch.setenv("DEPS_INDEX_URL", served.url)
    monkeypatch.setenv("DEPS_CACHE_DIR", str(tmp_path))
    deps._cache.clear()
    runner_router._pages.clear()
    yield served
    served.close()
    deps._cache.clear()
    runner_router._pages.clear()


def _check(files: dict, source: str = PANE) -> dict:
    resp = client.post("/api/builder/check", json={"source": source, "files": files})
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_requirements_name_packages_and_nothing_else():
    said = deps.requirement_problems("requests>=2\n# a comment\n\n-r /etc/passwd\n--index-url http://x/\n"
                                     "evil @ https://example.com/evil.whl\nnot a requirement!\n")
    lines = {line: message for line, message in said}
    assert sorted(lines) == [4, 5, 6, 7], said
    assert "-r isn't taken here" in lines[4] and "--index-url isn't taken here" in lines[5]
    assert "named with a URL" in lines[6] and "isn't a requirement pip reads" in lines[7]
    # Check says them with their file and line, before uv is ever asked.
    errors = _check({"shaped.py": SHAPED, "requirements.txt": "-r /etc/passwd\n"})["errors"]
    assert [(e["file"], e["line"]) for e in errors] == [("requirements.txt", 1)], errors


def test_check_locks_requirements_with_their_hashes_and_keeps_a_lock_that_matches(index):
    line = index.add("tinyshape", "1.0", TINY)
    out = _check({"shaped.py": SHAPED, "requirements.txt": "tinyshape\n"})
    assert out["ok"], out
    lock = out["files"]["requirements.lock"]
    assert lock.startswith("# Locked by the platform from requirements.txt (sha256:")
    assert line.split("\\")[0].strip() in lock and line.split("--hash=")[1].strip() in lock
    assert deps.is_fresh("tinyshape\n", lock)
    # Checked again with that lock: nothing to change, so no files back.
    again = _check({"shaped.py": SHAPED, "requirements.txt": "tinyshape\n# why\n", "requirements.lock": lock})
    assert again == {"ok": True, "errors": []}, again
    # A newer release upstream doesn't move a lock that still matches.
    index.add("tinyshape", "2.0", TINY)
    deps._cache.clear()
    assert "files" not in _check({"shaped.py": SHAPED, "requirements.txt": "tinyshape\n", "requirements.lock": lock})
    # Changed requirements are locked again.
    relocked = _check({"shaped.py": SHAPED, "requirements.txt": "tinyshape>=2\n", "requirements.lock": lock})
    assert "tinyshape==2.0" in relocked["files"]["requirements.lock"]


def test_what_cant_be_locked_is_said_and_a_stale_lock_never_saves(index):
    out = _check({"shaped.py": SHAPED, "requirements.txt": "nosuchpackage\n"})
    assert not out["ok"]
    [error] = out["errors"]
    assert error["file"] == "requirements.txt" and "couldn't be locked" in error["message"], error
    assert "nosuchpackage" in error["message"] and index.url not in error["message"]
    # Saving can't keep requirements with a lock that isn't theirs.
    index.add("tinyshape", "1.0", TINY)
    made = client.post("/api/builder/panes", json={"id": "shaped", "source": PANE, "files": {
        "shaped.py": SHAPED, "requirements.txt": "tinyshape\n", "requirements.lock": "# hand-made\nx==1\n"}})
    assert made.status_code == 201, made.text
    assert deps.is_fresh("tinyshape\n", made.json()["files"]["requirements.lock"])  # Save locked it again
    # A lock alone, or one beside requirements it isn't of, doesn't check.
    from app import builder

    with pytest.raises(builder.BuilderError) as alone:
        builder.preview(PANE, None, None, {"shaped.py": SHAPED, "requirements.lock": "x\n"})
    assert "has no requirements.txt beside it" in str(alone.value.errors)
    with pytest.raises(builder.BuilderError) as stale:
        builder.preview(PANE, None, None, {"shaped.py": SHAPED, "requirements.txt": "other\n",
                                           "requirements.lock": made.json()["files"]["requirements.lock"]})
    assert "isn't the lock of requirements.txt as it is now" in str(stale.value.errors)


def test_requirements_removed_take_their_lock_with_them(index):
    index.add("tinyshape", "1.0", TINY)
    locked = deps.locked({"shaped.py": SHAPED, "requirements.txt": "tinyshape\n"})
    assert set(locked) == {"shaped.py", "requirements.txt", "requirements.lock"}
    assert deps.locked({"shaped.py": SHAPED, "requirements.lock": locked["requirements.lock"]}) == {"shaped.py": SHAPED}
    assert deps.locked({"shaped.py": SHAPED, "requirements.txt": "# none yet\n",
                        "requirements.lock": locked["requirements.lock"]}) == {"shaped.py": SHAPED,
                                                                              "requirements.txt": "# none yet\n"}


def test_the_runner_is_sent_python_files_and_the_lock_never_as_a_module():
    job = runner_client.program(type("C", (), {"file": "shaped.py", "function": "run"})(),
                                {"shaped.py": SHAPED, "requirements.txt": "x\n", "requirements.lock": "y\n"})
    assert set(job["files"]) == {"shaped.py"}
    with pytest.raises(runner_client.CodeError) as stale:
        runner_client.lock_of({"requirements.txt": "x\n", "requirements.lock": "y\n"})
    assert "Check or Save locks it again" in str(stale.value)
    assert runner_client.lock_of({"shaped.py": SHAPED}) is None


# ---------------------------------------------------------------- the platform's index (D143)


def _job(lock: str, finished: bool = False) -> str:
    """A job's token, as runner_client mints one."""
    token = f"tok-{hashlib.sha256(lock.encode()).hexdigest()[:12]}-{finished}"
    now = datetime.datetime.utcnow()
    with SessionLocal() as db:
        admin = db.query(models.User).filter_by(username="admin").one()
        db.add(models.RunnerJob(token_hash=runner_client._hash(token), user_id=admin.id, purpose="venv:test",
                                created_at=now, expires_at=now + datetime.timedelta(minutes=5), deps_lock=lock,
                                finished_at=now if finished else None))
        db.commit()
    return token


def _basic(token: str) -> dict:
    return {"Authorization": "Basic " + base64.b64encode(f"job:{token}".encode()).decode()}


def test_the_index_serves_a_job_only_the_wheels_its_lock_names(index):
    index.add("tinyshape", "1.0", TINY)
    index.add("other", "1.0", {"other/__init__.py": ""})
    lock = deps.locked({"requirements.txt": "tinyshape\n"})["requirements.lock"]
    token = _job(lock)
    fetched = len(index.fetched)  # what locking read
    page = client.get("/api/runner/simple/TinyShape/", headers=_basic(token))
    assert page.status_code == 200, page.text
    [(href, sha)] = [(h, s) for h, s in __import__("re").findall(r'href="([^"#]+)#sha256=([0-9a-f]{64})"', page.text)]
    assert href == f"../../files/{sha}/tinyshape-1.0-py3-none-any.whl" and sha in lock
    # Another package, in the index but not the lock: not there for this job.
    assert client.get("/api/runner/simple/other/", headers=_basic(token)).status_code == 404
    wheel = client.get(f"/api/runner/files/{sha}/tinyshape-1.0-py3-none-any.whl", headers=_basic(token))
    assert wheel.status_code == 200 and hashlib.sha256(wheel.content).hexdigest() == sha
    # Kept: asked again, upstream isn't.
    client.get(f"/api/runner/files/{sha}/tinyshape-1.0-py3-none-any.whl", headers=_basic(token))
    assert index.fetched[fetched:] == ["tinyshape-1.0-py3-none-any.whl"]
    other_sha = hashlib.sha256(index.wheels["other"][1]).hexdigest()
    assert client.get(f"/api/runner/files/{other_sha}/other-1.0-py3-none-any.whl",
                      headers=_basic(token)).status_code == 404
    # No token, a finished job's, or a cookie: refused.
    assert client.get("/api/runner/simple/tinyshape/").status_code == 401
    assert client.get("/api/runner/simple/tinyshape/", headers=_basic(_job(lock, finished=True))).status_code == 401


def test_a_wheel_whose_bytes_arent_its_hash_is_never_kept(index):
    index.add("tinyshape", "1.0", TINY)
    lock = deps.locked({"requirements.txt": "tinyshape\n"})["requirements.lock"]
    token = _job(lock)
    sha = hashlib.sha256(index.wheels["tinyshape"][1]).hexdigest()
    # Upstream now serves other bytes under the same name, its listing still
    # claiming the hash the lock names.
    file, _data = index.wheels["tinyshape"]
    index.wheels["tinyshape"] = (file, b"not the wheel the lock names")
    runner_router._pages["tinyshape"] = (runner_router.time.monotonic(),
                                         [(file, f"{index.url.rsplit('/simple', 1)[0]}/files/{file}", sha)])
    refused = client.get(f"/api/runner/files/{sha}/{file}", headers=_basic(token))
    assert refused.status_code == 502 and "its hash differs" in refused.text
    assert not list((runner_router._wheels_dir()).glob("*.whl"))


def test_kept_wheels_past_their_room_go_least_recently_served_first(index, monkeypatch):
    index.add("tinyshape", "1.0", TINY)
    index.add("other", "1.0", {"other/__init__.py": "x = 1\n" * 50})
    lock = deps.locked({"requirements.txt": "tinyshape\nother\n"})["requirements.lock"]
    token = _job(lock)
    shas = {name: hashlib.sha256(data).hexdigest() for name, (_f, data) in index.wheels.items()}
    monkeypatch.setattr(runner_router, "KEEP_BYTES", len(index.wheels["other"][1]) + 10)
    assert client.get(f"/api/runner/files/{shas['tinyshape']}/tinyshape-1.0-py3-none-any.whl",
                      headers=_basic(token)).status_code == 200
    assert client.get(f"/api/runner/files/{shas['other']}/other-1.0-py3-none-any.whl",
                      headers=_basic(token)).status_code == 200
    assert sorted(p.stem for p in runner_router._wheels_dir().glob("*.whl")) == [shas["other"]]
