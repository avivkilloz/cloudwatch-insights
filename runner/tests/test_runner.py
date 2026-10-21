"""The runner (D131-D133): a job's code runs in a process of its own, under
limits, as a uid of its own slot, with nothing but the standard library and
the SDK -- and reaches the world only through its callback."""

import json
import os
import shutil
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

os.environ["RUNNER_TOKEN"] = "test-token"

from fastapi.testclient import TestClient  # noqa: E402

from app import jobs  # noqa: E402
from app.main import app  # noqa: E402

client = TestClient(app)
AUTH = {"Authorization": "Bearer test-token"}
ROOT = os.geteuid() == 0


def job(code: str, inputs=None, **extra) -> dict:
    resp = client.post("/jobs", json={"code": code, "inputs": inputs or {}, **extra}, headers=AUTH)
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_a_job_returns_what_run_returns_and_what_it_printed_is_its_log():
    out = job("def run(inputs, ctx):\n    print('hello')\n    ctx.log('n =', inputs['n'])\n"
              "    return {'rows': [{'n': inputs['n'] * 2}]}\n", {"n": 21})
    assert out["ok"] is True and out["outputs"] == {"rows": [{"n": 42}]}
    assert "hello" in out["logs"] and "n = 21" in out["logs"]


@pytest.mark.parametrize("code, says, line", [
    ("def run(inputs, ctx):\n    return {'a': 1\n", "SyntaxError", 2),
    ("def run(inputs, ctx):\n    x = 1\n    return inputs['missing']\n", "KeyError: 'missing'", 3),
    ("x = 1\n", "defines no run(inputs, ctx)", None),
    ("import fastapi\ndef run(inputs, ctx):\n    return {}\n", "No module named 'fastapi'", 1),
    ("def run(inputs, ctx):\n    return {'when': object()}\n", None, None),
])
def test_what_goes_wrong_is_said_with_its_line(code, says, line):
    out = job(code)
    if says is None:
        # Not JSON: kept as its text rather than lost.
        assert out["ok"] is True and out["outputs"]["when"].startswith("<object object")
        return
    assert out["ok"] is False and says in out["error"], out
    assert out["line"] == line


def test_limits_stop_a_job_that_runs_on_eats_memory_or_writes_without_end():
    slow = job("def run(inputs, ctx):\n    while True:\n        pass\n", timeout=2)
    assert slow["ok"] is False and "ran past its 2 s" in slow["error"]
    greedy = job("def run(inputs, ctx):\n    data = 'x' * (2 * 1024 ** 3)\n    return {}\n")
    assert greedy["ok"] is False and "Memory" in greedy["error"], greedy
    loud = job("def run(inputs, ctx):\n    while True:\n        print('x' * 10000)\n", timeout=20)
    assert loud["ok"] is False and len(loud["logs"]) <= jobs.LOG_BYTES + 2, loud["error"]


def test_a_job_sees_no_environment_and_none_of_the_runners_secrets():
    out = job("import os\ndef run(inputs, ctx):\n    return {'env': dict(os.environ), 'uid': os.getuid()}\n")
    assert "RUNNER_TOKEN" not in out["outputs"]["env"] and set(out["outputs"]["env"]) <= {"HOME", "TMPDIR", "PATH", "LANG"}
    if ROOT:
        assert out["isolated"] is True and out["outputs"]["uid"] >= jobs.UID_BASE
        # Not the runner's process, not a file only root may read.
        leak = job("def run(inputs, ctx):\n    return {'env': open('/proc/1/environ').read()}\n")
        assert leak["ok"] is False and "Permission" in leak["error"], leak


@pytest.mark.skipif(not ROOT, reason="slots drop to their own uids only when the runner is root")
def test_two_jobs_at_once_are_two_uids_and_cant_read_each_others_files():
    results: list = []
    writer = ("import os, time\ndef run(inputs, ctx):\n    open('secret', 'w').write('mine')\n"
              "    time.sleep(2)\n    return {'home': os.getcwd(), 'uid': os.getuid()}\n")

    def first():
        results.append(job(writer))

    t = threading.Thread(target=first)
    t.start()
    import time
    time.sleep(0.8)
    snoop = job("import glob, os\ndef run(inputs, ctx):\n    found = []\n"
                "    for path in glob.glob('/tmp/job*/home/secret'):\n"
                "        try:\n            found.append(open(path).read())\n"
                "        except OSError as e:\n            found.append(type(e).__name__)\n"
                "    return {'found': found, 'uid': os.getuid()}\n")
    t.join()
    assert snoop["ok"], snoop
    assert "mine" not in snoop["outputs"]["found"], snoop
    assert snoop["outputs"]["uid"] != results[0]["outputs"]["uid"]


@pytest.mark.skipif(not ROOT, reason="slots drop to uids of their own only when the runner is root")
def test_nothing_a_job_starts_or_writes_outlives_it():
    # A process that leaves the job's group would still be there, as the
    # slot's uid, when the next job in that slot runs.
    left = job("import os, time\ndef run(inputs, ctx):\n    open('kept', 'w').write('x')\n"
               "    if os.fork() == 0:\n        os.setsid()\n        time.sleep(60)\n        os._exit(0)\n"
               "    return {'home': os.getcwd(), 'uid': os.getuid()}\n")
    assert left["ok"], left
    uid = left["outputs"]["uid"]
    import time
    time.sleep(0.3)
    alive = [p for p in os.listdir("/proc") if p.isdigit() and _uid_of(p) == uid]
    assert alive == [], alive
    assert not os.path.exists(left["outputs"]["home"])


def _uid_of(pid: str):
    """A live process's uid; a killed one not yet reaped (a zombie) is gone."""
    try:
        with open(f"/proc/{pid}/status") as f:
            fields = dict(line.split(":", 1) for line in f if ":" in line)
    except OSError:
        return None
    if fields.get("State", "").strip().startswith("Z"):
        return None
    return int(fields["Uid"].split()[0])


def test_the_sdk_calls_back_with_the_jobs_token_and_nothing_else():
    seen: list = []

    class Platform(BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802 -- the stdlib's name
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            seen.append((self.headers["Authorization"], body))
            if body["kind"] == "aws":
                self.send_response(400)
                payload = {"detail": "Only reads."}
            else:
                self.send_response(200)
                payload = {"status": 200, "headers": {}, "body": json.dumps({"items": [{"id": "d1"}]})}
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(payload).encode())

        def log_message(self, *args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Platform)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        url = f"http://127.0.0.1:{server.server_address[1]}/api/runner/calls"
        out = job("from platform_sdk import CallError\n"
                  "def run(inputs, ctx):\n"
                  "    reply = ctx.http(inputs['api'], '/devices', query={'site': 'n'})\n"
                  "    try:\n        ctx.aws(inputs['api'], 'ec2', 'TerminateInstances')\n"
                  "    except CallError as e:\n        said = str(e)\n"
                  "    return {'rows': reply.json()['items'], 'status': reply.status, 'said': said}\n",
                  {"api": 7}, callback={"url": url, "token": "job-123"})
    finally:
        server.shutdown()
    assert out["ok"], out
    assert out["outputs"] == {"rows": [{"id": "d1"}], "status": 200, "said": "Only reads."}
    assert out["calls"] == 2
    assert [a for a, _ in seen] == ["Bearer job-123", "Bearer job-123"]
    assert seen[0][1] == {"kind": "http", "connection": 7, "path": "/devices", "method": "GET", "query": {"site": "n"},
                          "headers": {}, "body": None}


def test_only_the_backend_may_start_a_job():
    assert client.post("/jobs", json={"code": "x"}).status_code == 401
    assert client.post("/jobs", json={"code": "x"}, headers={"Authorization": "Bearer nope"}).status_code == 401


@pytest.mark.skipif(not ROOT or not shutil.which("setpriv"), reason="needs root, and setpriv to drop capabilities")
def test_a_job_runs_with_only_the_capabilities_the_chart_grants():
    # Helm drops every capability but these four (runner.securityContext). A
    # root with all of them ran these tests green while every job in the
    # cluster failed: chmod on a directory already given to a slot's uid
    # needs FOWNER, which the chart doesn't grant.
    code = ("import os\ndef run(inputs, ctx):\n    open('f', 'w').write('x')\n"
            # Files it then made unreadable to itself: still swept.
            "    os.makedirs('d/e')\n    open('d/e/g', 'w').write('y')\n    os.chmod('d/e', 0)\n    os.chmod('d', 0)\n"
            "    return {'uid': os.getuid(), 'home': os.getcwd()}\n")
    script = (f"import json\nfrom app import jobs\nout = jobs.run({code!r}, {{}}, None, 10)\n"
              "print(json.dumps(out.as_dict()))\n")
    done = subprocess.run(["setpriv", "--bounding-set=-all,+setuid,+setgid,+chown,+kill", sys.executable, "-c", script],
                          cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                          capture_output=True, text=True, timeout=60)
    assert done.returncode == 0, done.stderr[-2000:]
    out = json.loads(done.stdout.strip().splitlines()[-1])
    assert out["ok"], out
    assert out["outputs"]["uid"] >= jobs.UID_BASE
    assert not os.path.exists(os.path.dirname(out["outputs"]["home"])), "its files outlived it"


def test_health_says_when_the_runner_cant_run_a_job(monkeypatch):
    from app import main

    monkeypatch.setattr(main.jobs, "run", lambda *a, **k: (_ for _ in ()).throw(PermissionError("Operation not permitted")))
    problem = main.self_check()
    assert problem and "PermissionError" in problem
    monkeypatch.setitem(main._problem, "problem", problem)
    resp = client.get("/health")
    assert resp.status_code == 503 and resp.json()["status"] == "broken" and "PermissionError" in resp.json()["problem"]
