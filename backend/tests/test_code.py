"""Code in the runner (PLATFORM_PLAN.md §25, D131-D135): a built pane's code
action and a code step type run in the real runner, as whoever runs them,
reaching a connection only through the platform -- `ctx.http` and `ctx.aws`
come back here and go out the way a declarative request does.

The runner runs as a process of its own (`../runner`), and its jobs call back
to this backend served on a port of its own, in this process -- so what the
tests monkeypatch (the HTTP sender, the AWS client) is what the calls meet."""

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

import httpx
import pytest
import uvicorn
from botocore.stub import Stubber

from app import aws_client, models, runner_client, tools_http_client, workflows
from app.db import SessionLocal
from app.main import app
from tests.conftest import client
from tests.test_builder import _group, _member
from tests.test_workflows import _finished, _run

RUNNER = Path(__file__).resolve().parents[2] / "runner"


def _port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="module")
def stack():
    """The runner, and this backend served for its jobs' calls back."""
    backend_port, runner_port = _port(), _port()
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=backend_port, lifespan="off", log_level="error"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    # Its venvs (D144) in a directory of this run's own, readable by the job's uid.
    venvs = tempfile.mkdtemp(prefix="cwi-venvs-")
    os.chmod(venvs, 0o755)
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(runner_port),
         "--log-level", "error"],
        cwd=RUNNER, env={**os.environ, "RUNNER_TOKEN": "test-runner", "RUNNER_VENVS_DIR": venvs},
    )
    for _ in range(100):
        try:
            if httpx.get(f"http://127.0.0.1:{runner_port}/health").status_code == 200 and server.started:
                break
        except httpx.HTTPError:
            pass
        time.sleep(0.1)
    env = {"RUNNER_URL": f"http://127.0.0.1:{runner_port}", "RUNNER_TOKEN": "test-runner",
           "RUNNER_CALLBACK_URL": f"http://127.0.0.1:{backend_port}"}
    os.environ.update(env)
    yield {**env, "venvs": venvs}
    for key in env:
        os.environ.pop(key, None)
    proc.terminate()
    proc.wait(10)
    server.should_exit = True
    thread.join(10)
    shutil.rmtree(venvs, ignore_errors=True)


@pytest.fixture
def api(monkeypatch):
    """An HTTP API connection, and what was sent to it."""
    env = client.post("/api/environments", json={"name": "Devices"}).json()
    conn = client.post(f"/api/environments/{env['id']}/connections", json={
        "type_id": "http_api", "name": "devices", "config": {"base_url": "https://devices.example.com/v1"}}).json()
    sent: list = []

    def fake(method, url, headers=None, body=None, timeout=30):
        sent.append({"method": method, "url": url, "body": body})
        reply = {"items": [{"id": "d1", "online": False}, {"id": "d2", "online": True}]} if method == "GET" else {"ok": 1}
        return {"status_code": 200, "status_text": "OK", "headers": [{"key": "X-Seen", "value": "yes"}],
                "body": json.dumps(reply), "body_truncated": False, "elapsed_ms": 3}

    monkeypatch.setattr(tools_http_client, "send_request", fake)
    return conn["id"], sent


PANE = """label: Devices, online first
inputs:
  - {key: connection, type: connection, connection_type: http_api}
actions:
  - id: list
    main: true
    code: |
      def run(inputs, ctx):
          reply = ctx.http(inputs["connection"], "/devices", query={"site": "north"})
          items = reply.json()["items"]
          items.sort(key=lambda d: not d["online"])
          ctx.log(len(items), "devices")
          return {"rows": items, "seen": reply.headers.get("X-Seen")}
outputs:
  - {key: rows, render: table}
  - {key: seen, render: text}
  - {key: error, render: error}
layout:
  - title: Devices
    items:
      - input: connection
      - toolbar:
          - action: list
      - output: rows
"""


def _make(source: str, type_id: str = "devices") -> None:
    resp = client.post("/api/builder/panes", json={"id": type_id, "source": source})
    assert resp.status_code == 201, resp.text


def _jobs() -> list[models.RunnerJob]:
    with SessionLocal() as db:
        return db.query(models.RunnerJob).order_by(models.RunnerJob.id).all()


# ---------------------------------------------------------------- a pane's code


def test_a_panes_code_runs_in_the_runner_as_its_user_reaching_out_through_the_platform(stack, api):
    conn, sent = api
    _make(PANE)
    out = client.post("/api/panes/devices/actions/list", json={"inputs": {"connection": conn}})
    assert out.status_code == 200, out.text
    assert [r["id"] for r in out.json()["rows"]] == ["d2", "d1"] and out.json()["seen"] == "yes"
    assert sent == [{"method": "GET", "url": "https://devices.example.com/v1/devices?site=north", "body": None}]
    [job] = _jobs()
    assert (job.purpose, job.ok, job.calls, job.may_change) == ("pane:devices/list", True, 1, False)
    assert job.finished_at is not None and job.user_id == client.get("/api/auth/me").json()["id"]
    # Its token died with it: a call back carrying it now is refused.
    stale = client.post("/api/runner/calls", json={"kind": "http"}, headers={"Authorization": "Bearer nope"})
    assert stale.status_code == 401


def test_a_panes_code_only_reads_and_returns_only_its_outputs(stack, api):
    conn, sent = api
    _make(PANE.replace('reply = ctx.http(inputs["connection"], "/devices", query={"site": "north"})',
                       'reply = ctx.http(inputs["connection"], "/devices", method="POST")'))
    refused = client.post("/api/panes/devices/actions/list", json={"inputs": {"connection": conn}})
    assert refused.status_code == 400 and "only reads, so it can't send a POST" in refused.text, refused.text
    assert "(line 2 of the code)" in refused.text and sent == []

    client.delete("/api/builder/panes/devices")
    _make(PANE.replace('return {"rows": items, "seen": reply.headers.get("X-Seen")}', 'return {"rowz": items}'))
    wrong = client.post("/api/panes/devices/actions/list", json={"inputs": {"connection": conn}})
    assert wrong.status_code == 400 and "returned rowz, which is not an output it declares" in wrong.text


def test_check_says_what_code_cant_do_at_its_line():
    def check(source: str) -> list[dict]:
        return client.post("/api/builder/check", json={"source": source}).json()["errors"]

    assert check(PANE) == []
    broken = check(PANE.replace("items.sort(key=lambda d: not d[\"online\"])", "items.sort(key=lambda d: not d[\"online\"]"))
    assert broken and broken[0]["line"] == 11 and "isn't valid Python" in broken[0]["message"], broken
    norun = check(PANE.replace("def run(inputs, ctx):", "def go(inputs, ctx):"))
    assert any("defines no run(inputs, ctx)" in e["message"] for e in norun)


def test_the_code_examples_check_clean():
    # What "Start from" puts in an editor: the step's had a ": " in a plain
    # description, which isn't YAML, and its Check failed at line 2.
    from app import builder, step_types

    assert client.post("/api/builder/check", json={"source": builder.CODE_EXAMPLE,
                                                   "files": builder.CODE_EXAMPLE_FILES}).json()["errors"] == []
    checked = client.post("/api/builder/steps/check", json={"source": step_types.CODE_EXAMPLE, "new_id": "online",
                                                            "files": step_types.CODE_EXAMPLE_FILES})
    assert checked.json() == {"ok": True, "errors": []}, checked.text


def test_a_preview_shows_the_codes_log_and_where_it_failed(stack, api):
    conn, _ = api
    ok = client.post("/api/builder/preview/actions/list", json={"source": PANE, "inputs": {"connection": conn}})
    assert ok.status_code == 200, ok.text
    assert "2 devices" in ok.json()["__logs"]
    failing = PANE.replace('ctx.log(len(items), "devices")', 'ctx.log("about to fail")\n          raise ValueError("no")')
    bad = client.post("/api/builder/preview/actions/list", json={"source": failing, "inputs": {"connection": conn}})
    assert bad.status_code == 400 and "ValueError: no (line 6 of the code)" in bad.text and "about to fail" in bad.text


def test_code_reads_aws_as_its_user_and_never_writes(stack, monkeypatch):
    env = client.post("/api/environments", json={"name": "Prod", "account_id": "111122223333", "region": "eu-west-1"})
    asked = []

    def fake(service, account_id, region, identity):
        real = aws_client.boto3.client(service, region_name=region, aws_access_key_id="x", aws_secret_access_key="y")
        stub = Stubber(real)
        stub.add_response("describe_instances", {"Reservations": [{"Instances": [{"InstanceId": "i-1"}]}]})
        stub.activate()
        asked.append((account_id, identity.role_name))
        return real

    monkeypatch.setattr(aws_client, "get_client", fake)
    code = """label: Instances
inputs:
  - {key: connection, type: connection, connection_type: aws}
actions:
  - id: list
    main: true
    code: |
      def run(inputs, ctx):
          reply = ctx.aws("Prod", "ec2", "DescribeInstances")
          ids = [i["InstanceId"] for r in reply["Reservations"] for i in r["Instances"]]
          try:
              ctx.aws("Prod", "ec2", "TerminateInstances", {"InstanceIds": ids})
              said = "terminated"
          except Exception as e:
              said = str(e)
          return {"rows": [{"id": i} for i in ids], "said": said}
outputs:
  - {key: rows, render: table}
  - {key: said, render: text}
layout:
  - title: Instances
    items:
      - output: rows
"""
    _make(code, "instances")
    out = client.post("/api/panes/instances/actions/list", json={"inputs": {"connection": env.json()["id"]}})
    assert out.status_code == 200, out.text
    assert out.json()["rows"] == [{"id": "i-1"}] and "changes something" in out.json()["said"], out.json()
    assert asked == [("111122223333", "TestRole")]


# ---------------------------------------------------------------- a code step type


STEP = """label: Restart the offline ones
inputs:
  - {key: connection, type: connection, connection_type: http_api}
changes: true
code: |
  def run(inputs, ctx):
      items = ctx.http(inputs["connection"], "/devices").json()["items"]
      offline = [d["id"] for d in items if not d["online"]]
      for device in offline:
          ctx.http(inputs["connection"], f"/devices/{device}/restart", method="POST")
      return {"restarted": offline}
"""


def test_a_code_step_that_changes_something_waits_for_a_person_then_may(stack, api):
    conn, sent = api
    made = client.post("/api/builder/steps", json={"id": "restart_offline", "source": STEP})
    assert made.status_code == 201, made.text
    assert made.json()["kind"] == "code" and made.json()["external"] is True
    source = """label: Restarts
parameters:
  - {key: api, type: connection, connection_type: http_api, required: true}
steps:
  - id: it
    step: restart_offline
    with: {connection: "{{ params.api }}"}
"""
    assert client.post("/api/workflows", json={"id": "restarts", "source": source}).status_code == 201
    run = _finished(_run("restarts", {"api": conn})["id"])
    [step] = run["steps"]
    assert run["status"] == "waiting" and sent == []
    assert client.post(f"/api/approvals/{step['approval']['id']}/approve").status_code == 200
    workflows.drain()
    done = _finished(run["id"])
    assert done["status"] == "succeeded", done
    assert done["steps"][0]["outputs"] == {"restarted": ["d1"]}
    assert [(s["method"], s["url"].rsplit("/v1", 1)[1]) for s in sent] == [("GET", "/devices"), ("POST", "/devices/d1/restart")]
    assert _jobs()[-1].may_change is True


def test_try_runs_a_draft_steps_code_as_its_builder(stack, api):
    conn, _ = api
    tried = client.post("/api/builder/steps/try", json={"source": STEP.replace("changes: true\n", "").replace(
        'ctx.http(inputs["connection"], f"/devices/{device}/restart", method="POST")', 'ctx.log("would restart", device)'),
        "inputs": {"connection": conn}})
    assert tried.status_code == 200, tried.text
    assert tried.json()["response"] == {"restarted": ["d1"]} and "would restart d1" in tried.json()["logs"]


# ---------------------------------------------------------------- without a runner, and who may


def test_without_a_runner_code_is_kept_but_not_run(api, monkeypatch):
    conn, _ = api
    for key in ("RUNNER_URL", "RUNNER_TOKEN"):
        monkeypatch.delenv(key, raising=False)
    _make(PANE)
    out = client.post("/api/panes/devices/actions/list", json={"inputs": {"connection": conn}})
    assert out.status_code == 503 and "runner, which isn't set up here" in out.text
    assert client.get("/api/builder/schema").json()["runner"] is False


def test_a_job_acts_as_its_user_and_reaches_only_their_connections(stack, api):
    conn, sent = api
    _make(PANE)
    outsider = _member("out_code", _group("Coders", builder_enabled=True, pane_types=["devices"]))
    out = outsider.post("/api/panes/devices/actions/list", json={"inputs": {"connection": conn}})
    # Their group reaches no environment: the code's call is refused as theirs.
    assert out.status_code == 400 and sent == [], out.text
    with SessionLocal() as db:
        assert runner_client.job_for(db, "anything") is None


def test_old_jobs_are_forgotten():
    import datetime

    db = SessionLocal()
    try:
        admin = db.query(models.User).filter_by(username="admin").one()
        now = datetime.datetime.utcnow()
        for n, age in enumerate((31, 1)):
            created = now - datetime.timedelta(days=age)
            db.add(models.RunnerJob(token_hash=f"{n:064d}", user_id=admin.id, purpose="pane:x/list",
                                    created_at=created, expires_at=created))
        db.commit()
        assert runner_client.prune(db) == 1
        assert [j.token_hash for j in db.query(models.RunnerJob).all()] == [f"{1:064d}"]
    finally:
        db.close()


# ---------------------------------------------------------------- code in files (D136-D138)

FILED = PANE.replace('''    code: |
      def run(inputs, ctx):
          reply = ctx.http(inputs["connection"], "/devices", query={"site": "north"})
          items = reply.json()["items"]
          items.sort(key=lambda d: not d["online"])
          ctx.log(len(items), "devices")
          return {"rows": items, "seen": reply.headers.get("X-Seen")}
''', '''    code: {file: devices.py, function: listed}
''')
FILES = {
    "devices.py": "from shape import online_first\n\n\ndef listed(inputs, ctx):\n"
                  "    reply = ctx.http(inputs['connection'], '/devices', query={'site': 'north'})\n"
                  "    ctx.log('fetched')\n"
                  "    return {'rows': online_first(reply.json()['items']), 'seen': reply.headers.get('X-Seen')}\n",
    "shape.py": "def online_first(items):\n    if not items:\n        raise ValueError('nothing came back')\n"
                "    return sorted(items, key=lambda d: not d['online'])\n",
}


def test_a_panes_code_in_files_imports_its_neighbours_and_is_kept_with_them(stack, api):
    conn, _sent = api
    assert FILED != PANE
    made = client.post("/api/builder/panes", json={"id": "devices", "source": FILED, "files": FILES})
    assert made.status_code == 201, made.text
    assert made.json()["files"] == FILES
    out = client.post("/api/panes/devices/actions/list", json={"inputs": {"connection": conn}})
    assert out.status_code == 200, out.text
    assert [r["id"] for r in out.json()["rows"]] == ["d2", "d1"]
    # Changed to fail in the helper: the error says which file and line.
    broken = {**FILES, "shape.py": FILES["shape.py"].replace("if not items:", "if True:")}
    failed = client.post("/api/builder/preview/actions/list", json={"source": FILED, "files": broken,
                                                                    "inputs": {"connection": conn}})
    assert failed.status_code == 400 and "ValueError: nothing came back (line 3 of shape.py)" in failed.text, failed.text
    assert "fetched" in failed.text  # its log, for its builder


def test_check_names_the_file_and_its_line():
    def errors(source: str, files: dict) -> list[dict]:
        return client.post("/api/builder/check", json={"source": source, "files": files}).json()["errors"]

    assert errors(FILED, FILES) == []
    bad = errors(FILED, {**FILES, "shape.py": "def online_first(items:\n    return items\n"})
    assert [(e.get("file"), e["line"]) for e in bad] == [("shape.py", 1)] and "isn't valid Python" in bad[0]["message"]
    missing = errors(FILED, {"shape.py": FILES["shape.py"]})
    assert any("There is no file devices.py beside it (its files: shape.py)" in e["message"] for e in missing), missing
    nofunc = errors(FILED.replace("function: listed", "function: listing"), FILES)
    assert [e.get("file") for e in nofunc] == ["devices.py"] and "defines no listing(inputs, ctx)" in nofunc[0]["message"]
    named = errors(FILED, {**FILES, "json.py": "x = 1\n", "Bad-Name.py": "x = 1\n"})
    said = " ".join(e["message"] for e in named)
    assert "would stand in for Python's own json module" in said and "isn't a Python module's file name" in said


def test_a_steps_code_in_a_file_is_tried_and_kept_with_it(stack, api):
    from app import step_types

    conn, _sent = api
    tried = client.post("/api/builder/steps/try", json={"source": step_types.CODE_EXAMPLE,
                                                        "files": step_types.CODE_EXAMPLE_FILES,
                                                        "inputs": {"connection": conn}})
    assert tried.status_code == 200, tried.text
    assert tried.json()["response"]["count"] == 1 and "1 online" in tried.json()["logs"]
    made = client.post("/api/builder/steps", json={"id": "online", "source": step_types.CODE_EXAMPLE,
                                                   "files": step_types.CODE_EXAMPLE_FILES})
    assert made.status_code == 201, made.text
    assert made.json()["files"] == step_types.CODE_EXAMPLE_FILES and made.json()["kind"] == "code"
    lost = client.put("/api/builder/steps/online", json={"source": step_types.CODE_EXAMPLE, "files": {}})
    assert lost.status_code == 400 and "There is no file online.py beside it" in lost.text


def test_a_draft_keeps_its_files():
    made = client.post("/api/build-drafts", json={"kind": "pane", "source": FILED, "files": FILES, "new_id": "x"})
    assert made.status_code == 201, made.text
    got = client.get(f"/api/build-drafts/{made.json()['id']}").json()
    assert got["files"] == FILES and got["source"] == FILED
    changed = client.put(f"/api/build-drafts/{made.json()['id']}", json={"files": {"devices.py": "x = 1\n"}})
    assert client.get(f"/api/build-drafts/{changed.json()['id']}").json()["files"] == {"devices.py": "x = 1\n"}


# ---------------------------------------------------------------- requirements (D141-D144)


def test_code_with_requirements_runs_with_them_installed_from_the_platforms_index(stack, monkeypatch, tmp_path):
    """Saved, its lock's venv is built ahead (POST /venvs), from wheels the
    backend fetched upstream and served the runner; the run uses it."""
    from app import deps
    from app.routers import runner as runner_router
    from tests.wheels import Index

    upstream = Index()
    monkeypatch.setenv("DEPS_INDEX_URL", upstream.url)
    monkeypatch.setenv("DEPS_CACHE_DIR", str(tmp_path))
    deps._cache.clear()
    runner_router._pages.clear()
    try:
        upstream.add("tinyshape", "1.0", {"tinyshape/__init__.py": "def rows(items):\n"
                                                                   "    return sorted(items, key=lambda d: d['id'])\n"})
        files = {"devices.py": "import tinyshape\n\n\ndef listed(inputs, ctx):\n"
                               "    return {'rows': tinyshape.rows([{'id': 'b'}, {'id': 'a'}])}\n",
                 "requirements.txt": "tinyshape\n"}
        made = client.post("/api/builder/panes", json={"id": "devices", "source": FILED, "files": files})
        assert made.status_code == 201, made.text
        assert "tinyshape==1.0" in made.json()["files"]["requirements.lock"]
        for _ in range(200):
            built = [j for j in _jobs() if j.purpose == "venv:pane:devices" and j.finished_at]
            if built:
                break
            time.sleep(0.1)
        assert built and built[0].ok, built and built[0].error
        fetched = list(upstream.fetched)
        out = client.post("/api/panes/devices/actions/list", json={"inputs": {}})
        assert out.status_code == 200, out.text
        assert [r["id"] for r in out.json()["rows"]] == ["a", "b"]
        # Built once, ahead: the run neither built nor fetched again.
        assert len([p for p in os.listdir(stack["venvs"]) if not p.startswith(".")]) == 1
        assert upstream.fetched == fetched
        # Without its requirements, the same code can't import the package.
        bare = client.post("/api/builder/preview/actions/list", json={"source": FILED, "files": {
            "devices.py": files["devices.py"]}, "inputs": {}})
        assert bare.status_code == 400 and "No module named 'tinyshape'" in bare.text, bare.text
    finally:
        upstream.close()
        deps._cache.clear()
