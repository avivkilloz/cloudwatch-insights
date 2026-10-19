"""Workflows' harder steps (PLATFORM_PLAN.md §22.8, D87-D93): a background
run waited for (or listened to), approvals -- a gate, and always before an
action that reaches outside the platform -- who may decide, deny and expiry,
`retry` and `timeout`, rerun from a stage, outputs too big for a row kept
whole in the blob store, artifacts, and retention.

Runs are drained here (`workflows.drain`), as in test_workflows.py."""

import datetime
import json
import os
import threading
import time
from pathlib import Path

import pytest
from fastapi import HTTPException

from app import blobs, models, tools_http_client, workflows
from app.db import SessionLocal
from app.panes import handlers
from app.panes import manifest as pane_manifest
from tests.conftest import client
from tests.test_mqtt import broker  # noqa: F401 -- a fixture
from tests.test_pane_actions import aws  # noqa: F401 -- a fixture
from tests.test_pane_runs import cloudwatch  # noqa: F401 -- a fixture
from tests.test_platform_tools import _environment, _token, call, mcp  # noqa: F401 -- fixtures
from tests.test_workflows import _create, _errors, _finished, _member, _run


def _wf(source: str, workflow_id: str = "wf") -> dict:
    return _create(source, workflow_id)


def _get(run_id: int, c=client) -> dict:
    resp = c.get(f"/api/workflow-runs/{run_id}")
    assert resp.status_code == 200, resp.text
    return resp.json()


def _step(run: dict, step_id: str) -> dict:
    return next(s for s in run["steps"] if s["id"] == step_id)


@pytest.fixture
def fast_polls(monkeypatch):
    """Background runs polled at once, not every 2 s."""
    for manifest in pane_manifest.manifests().values():
        for action in manifest.actions:
            if action.poll is not None:
                monkeypatch.setattr(action.poll, "every", 0.05)


# ---------------------------------------------------------------- the definition


@pytest.mark.parametrize(
    "snippet, says",
    [
        ("    note: hi\n    artifact: { name: a, value: 1 }\n", "is a note and an artifact"),
        ("    note: hi\n    retry: 2\n", "only a pane action has retry"),
        ("    pane: tables\n    action: scan\n    listen: 5\n", "listen is for a connection"),
        ("    pane: tables\n", "needs both a pane and an action"),
        ("    approval: { by: someone }\n", "approval.by"),
        ("    pane: tables\n    action: scan\n    retry: 9\n", "retry"),
    ],
)
def test_the_new_step_fields_are_checked(snippet, says):
    errors = _errors(f"label: t\nsteps:\n  - id: s\n{snippet}")
    assert any(says in e for e in errors), errors


def test_background_runs_external_actions_and_bare_gates_are_steps_now():
    for body in (
        "    pane: logs-cloudwatch\n    action: run\n",
        "    pane: tool-http\n    action: send\n",
        "    pane: tool-mqtt\n    action: connect\n    listen: 5\n",
        "    approval: { message: 'Go on?', by: others }\n",
        "    artifact: { name: out.json, value: '{{ run.number }}' }\n",
    ):
        assert _errors(f"label: t\nsteps:\n  - id: s\n{body}") == [], body


# ---------------------------------------------------------------- background runs (D87)


def test_a_background_step_is_polled_to_its_end(cloudwatch, fast_polls):
    env = _environment()
    _wf(f"""label: Errors
steps:
  - id: q
    pane: logs-cloudwatch
    action: run
    with: {{ logGroupSelection: {{ "{env}": ["/app"] }}, queryString: "fields @message", preset: 900 }}
  - id: n
    note: "{{{{ size(steps.q.outputs.results[0].rows) }}}} rows"
""")
    done = _finished(_run("wf", {})["id"])
    assert done["status"] == "succeeded", done
    assert _step(done, "q")["outputs"]["results"][0]["status"] == "Complete"
    assert _step(done, "n")["outputs"]["text"] == "3 rows"
    assert cloudwatch["polls"] == 3 and cloudwatch["stopped"] == []


def test_a_background_step_past_its_timeout_is_stopped(cloudwatch, fast_polls, monkeypatch):
    from app import aws_client

    monkeypatch.setattr(aws_client, "get_query_results", lambda *a: {"status": "Running", "results": [], "statistics": {}})
    env = _environment()
    _wf(f"""label: Slow
steps:
  - id: q
    pane: logs-cloudwatch
    action: run
    timeout: 1
    with: {{ logGroupSelection: {{ "{env}": ["/app"] }}, queryString: "fields @message", preset: 900 }}
""")
    done = _finished(_run("wf", {})["id"])
    assert done["status"] == "failed" and "still running after 1 s" in _step(done, "q")["error"], done
    assert cloudwatch["stopped"] == ["q-1"]


def test_a_stream_step_listens_then_disconnects(broker, fast_polls):
    env = _environment()
    _wf(f"""label: Listen
steps:
  - id: listen
    pane: tool-mqtt
    action: connect
    listen: 1
    with: {{ connection: {env}, topics: ["devices/#"] }}
""")
    run = _run("wf", {})
    threading.Timer(0.4, lambda: broker[0].deliver("devices/a", b"hello")).start()
    done = _finished(run["id"])
    assert done["status"] == "succeeded", done
    outputs = _step(done, "listen")["outputs"]
    assert [m["payload"] for m in outputs["messages"]] == ["hello"]
    assert outputs.get("status") is None  # Disconnect cleared "Connected to ..."
    assert len(broker) == 1 and not broker[0].open


# ---------------------------------------------------------------- retry and timeout (D89)


def _fake_scan(monkeypatch, behave):
    calls = []

    def scan(db, user, inputs, cursor):
        calls.append(inputs.get("tableName"))
        return behave(len(calls))

    monkeypatch.setitem(handlers.ACTIONS, "aws.dynamodb.scan", scan)
    return calls


SCAN_STEP = """label: Scan
steps:
  - id: scan
    pane: tables
    action: scan
    {extra}
    with: {{ connection: {env}, tableName: Orders }}
"""


def test_retry_tries_a_failure_again_but_not_a_refusal(monkeypatch):
    env = _environment()

    def flaky(n):
        if n < 3:
            raise HTTPException(status_code=502, detail=f"DynamoDB said no ({n})")
        return {"items": [{"id": "1"}]}

    calls = _fake_scan(monkeypatch, flaky)
    _wf(SCAN_STEP.format(env=env, extra="retry: 2\n    retry_delay: 0"))
    done = _finished(_run("wf", {})["id"])
    assert done["status"] == "succeeded" and len(calls) == 3 and _step(done, "scan")["attempts"] == 3

    calls = _fake_scan(monkeypatch, lambda n: (_ for _ in ()).throw(HTTPException(status_code=403, detail="Not yours.")))
    done = _finished(_run("wf", {})["id"])
    assert done["status"] == "failed" and len(calls) == 1 and _step(done, "scan")["error"] == "Not yours."

    calls = _fake_scan(monkeypatch, lambda n: (_ for _ in ()).throw(HTTPException(status_code=502, detail="Down.")))
    done = _finished(_run("wf", {})["id"])
    assert done["status"] == "failed" and len(calls) == 3, "two retries, then it fails"


def test_a_call_past_its_timeout_is_abandoned(monkeypatch):
    env = _environment()
    _fake_scan(monkeypatch, lambda n: time.sleep(3) or {"items": []})
    _wf(SCAN_STEP.format(env=env, extra="timeout: 1"))
    began = time.monotonic()
    done = _finished(_run("wf", {})["id"])
    assert time.monotonic() - began < 2.5
    assert done["status"] == "failed" and "took longer than 1 s" in _step(done, "scan")["error"]


# ---------------------------------------------------------------- approvals (D88)


@pytest.fixture
def sent(monkeypatch) -> list:
    out: list = []

    def send(method, url, headers=None, body=None, timeout=30):
        out.append((method, url, body))
        return {"status_code": 202, "status_text": "Accepted", "headers": [], "body": "queued", "body_truncated": False,
                "elapsed_ms": 3}

    monkeypatch.setattr(tools_http_client, "send_request", send)
    return out


DEPLOY = """label: Deploy
parameters:
  - { key: version, type: text, required: true }
steps:
  - id: send
    pane: tool-http
    action: send
    with: { method: POST, url: "https://deploy.example.com/release", body: "{{ params.version }}" }
"""


def test_an_external_step_waits_for_approval_and_then_runs(sent):
    _wf(DEPLOY)
    run = _finished(_run("wf", {"version": "1.2"})["id"])
    assert run["status"] == "waiting", run
    step = _step(run, "send")
    assert step["status"] == "waiting" and sent == []
    approval = step["approval"]
    assert approval["status"] == "pending" and approval["can_decide"] and "acts outside the platform" in approval["message"]
    assert approval["details"]["inputs"]["url"] == "https://deploy.example.com/release"
    assert approval["details"]["inputs"]["body"] == "1.2"
    [waiting] = client.get("/api/approvals").json()
    assert waiting["id"] == approval["id"] and waiting["workflow_label"] == "Deploy" and waiting["run_number"] == 1

    resp = client.post(f"/api/approvals/{approval['id']}/approve", json={"comment": "go"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "queued"
    done = _finished(run["id"])
    assert done["status"] == "succeeded", done
    assert sent == [("POST", "https://deploy.example.com/release", "1.2")]
    step = _step(done, "send")
    assert step["outputs"]["response"]["status_code"] == 202
    assert step["approval"]["status"] == "approved" and step["approval"]["decided_by"] == "admin"
    assert client.get("/api/approvals").json() == []
    again = client.post(f"/api/approvals/{approval['id']}/approve")
    assert again.status_code == 409 and "already been approved" in again.json()["detail"]


GATE = """label: Gate
steps:
  - id: ok
    approval: {{ message: "Restart {{{{ run.number }}}}?"{by} }}
    {coe}
  - id: after
    note: "{{{{ steps.ok.status }}}}{{{{ steps.ok.status == 'succeeded' ? ' by ' + steps.ok.outputs.approved_by : '' }}}}"
"""


def test_deny_fails_the_step_unless_it_may_fail(sent):
    _wf(GATE.format(by="", coe=""))
    run = _finished(_run("wf", {})["id"])
    approval = _step(run, "ok")["approval"]
    assert approval["message"] == "Restart 1?"
    resp = client.post(f"/api/approvals/{approval['id']}/deny", json={"comment": "not now"})
    assert resp.status_code == 200
    done = _get(run["id"])
    assert done["status"] == "failed" and "Denied by admin: not now" in done["error"]
    assert _step(done, "after")["status"] == "cancelled"

    _wf(GATE.format(by="", coe="continue_on_error: true"), "wf2")
    run = _finished(_run("wf2", {})["id"])
    client.post(f"/api/approvals/{_step(run, 'ok')['approval']['id']}/deny")
    done = _finished(run["id"])
    assert done["status"] == "succeeded" and _step(done, "after")["outputs"]["text"] == "failed"

    _wf(GATE.format(by="", coe=""), "wf3")
    run = _finished(_run("wf3", {})["id"])
    client.post(f"/api/approvals/{_step(run, 'ok')['approval']['id']}/approve")
    done = _finished(run["id"])
    assert done["status"] == "succeeded" and _step(done, "after")["outputs"]["text"] == "succeeded by admin"


def test_who_may_decide():
    env = _environment()
    _wf(GATE.format(by=", by: others", coe=""))
    _wf(GATE.format(by=", by: admins", coe=""), "w_admins")
    gid, bob = _member("bob", ["tables"], env, grant="wf")
    client.put("/api/workflows/w_admins/grants", json={"group_ids": [gid]})
    client.post("/api/users", json={"username": "carol", "password": "pw-123456", "group_id": gid})
    from tests.test_connections import _login_as

    carol = _login_as("carol", "pw-123456")
    _, dave = _member("dave", ["tables"], env, grant="wf")

    run = _finished(_run("wf", {}, c=bob)["id"], c=bob)
    approval = _step(run, "ok")["approval"]
    assert approval["can_decide"] is False  # by: others, and bob started it
    refused = bob.post(f"/api/approvals/{approval['id']}/approve")
    assert refused.status_code == 403 and "Someone other than whoever started" in refused.json()["detail"]
    assert dave.post(f"/api/approvals/{approval['id']}/approve").status_code == 404  # another group: not theirs to see
    assert [a["id"] for a in carol.get("/api/approvals").json()] == [approval["id"]]
    assert carol.post(f"/api/approvals/{approval['id']}/approve").status_code == 200

    run = _finished(_run("w_admins", {}, c=bob)["id"], c=bob)
    approval = _step(run, "ok")["approval"]
    assert carol.post(f"/api/approvals/{approval['id']}/approve").status_code == 403
    assert carol.get("/api/approvals").json() == []
    assert client.post(f"/api/approvals/{approval['id']}/approve").status_code == 200


def test_an_approval_nobody_decides_expires_and_a_waiting_run_can_be_cancelled():
    _wf(GATE.format(by="", coe=""))
    run = _finished(_run("wf", {})["id"])
    with SessionLocal() as db:
        db.query(models.Approval).update({"expires_at": datetime.datetime.utcnow() - datetime.timedelta(seconds=1)})
        db.commit()
        workflows.sweep(db)
    done = _get(run["id"])
    assert done["status"] == "failed" and "No one decided in time" in done["error"]
    assert _step(done, "ok")["approval"]["status"] == "expired"

    run = _finished(_run("wf", {})["id"])
    assert client.post(f"/api/workflow-runs/{run['id']}/cancel").status_code == 200
    done = _get(run["id"])
    assert done["status"] == "cancelled" and _step(done, "ok")["approval"]["status"] == "cancelled"
    assert [s["status"] for s in done["steps"]] == ["cancelled", "cancelled"]


def test_the_agent_starts_a_run_that_waits_and_cannot_decide(mcp, sent):
    _wf(DEPLOY)
    token = _token()
    out = call(mcp, token, "run_workflow", workflow_id="wf", params={"version": "2"}, wait_seconds=10)
    assert out["status"] == "waiting" and "approve" in out["note"], out
    tools = {t["name"] for t in mcp.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
                                         headers={"Authorization": f"Bearer {token}",
                                                  "Accept": "application/json, text/event-stream"}).json()["result"]["tools"]}
    assert not any("approv" in name for name in tools)


# ---------------------------------------------------------------- rerun from a stage (D90)


def test_rerun_from_a_failed_stage_copies_the_ones_before(monkeypatch):
    env = _environment()
    scans = _fake_scan(monkeypatch, lambda n: {"items": [{"id": str(i)} for i in range(n + 1)]})
    calls = {"fail": True}

    def describe(db, user, inputs, cursor):
        if calls["fail"]:
            raise HTTPException(status_code=502, detail="Describe broke.")
        return {"table": {"table_name": inputs.get("tableName")}}

    monkeypatch.setitem(handlers.ACTIONS, "aws.dynamodb.describe", describe)
    _wf(f"""label: Two
steps:
  - id: scan
    pane: tables
    action: scan
    with: {{ connection: {env}, tableName: Orders }}
  - id: describe
    pane: tables
    action: describe
    with: {{ connection: {env}, tableName: Orders }}
  - id: report
    note: "{{{{ size(steps.scan.outputs.items) }}}} items"
""")
    first = _finished(_run("wf", {})["id"])
    assert first["status"] == "failed" and _step(first, "describe")["status"] == "failed"
    # The definition changes meanwhile: the rerun keeps the old run's (D90).
    client.put("/api/workflows/wf", json={"source": "label: Two\nsteps:\n  - id: other\n    note: new\n"})

    calls["fail"] = False
    resp = client.post(f"/api/workflow-runs/{first['id']}/rerun", json={"from_step": "describe"})
    assert resp.status_code == 201, resp.text
    second = _finished(resp.json()["id"])
    assert second["status"] == "succeeded" and second["rerun_from"] == "describe" and second["number"] == 2
    assert [s["id"] for s in second["steps"]] == ["scan", "describe", "report"]
    assert _step(second, "scan")["reused"] and not _step(second, "describe")["reused"]
    assert len(scans) == 1, "the scan wasn't run again"
    assert _step(second, "report")["outputs"]["text"] == "2 items"

    _, bob = _member("bob", ["tables"], env, grant="wf")
    refused = bob.post(f"/api/workflow-runs/{first['id']}/rerun", json={"from_step": "describe"})
    assert refused.status_code == 400 and "aren't yours to see" in refused.json()["detail"]
    missing = client.post(f"/api/workflow-runs/{first['id']}/rerun", json={"from_step": "nope"})
    assert missing.status_code == 400 and "no step nope" in missing.json()["detail"]


# ---------------------------------------------------------------- the blob store (D91, D92)


def _files() -> list[Path]:
    return [p for p in Path(os.environ["STORAGE_PATH"]).rglob("*") if p.is_file()]


def test_outputs_over_a_mib_are_kept_whole_in_the_blob_store(monkeypatch):
    env = _environment()
    big = [{"id": str(i), "blob": "x" * 200} for i in range(8000)]  # about 1.7 MiB
    _fake_scan(monkeypatch, lambda n: {"items": big})
    _wf(f"""label: Big
steps:
  - id: big
    pane: tables
    action: scan
    with: {{ connection: {env}, tableName: Orders }}
  - id: count
    note: "{{{{ size(steps.big.outputs.items) }}}}"
""")
    done = _finished(_run("wf", {})["id"])
    step = _step(done, "big")
    assert step["trimmed"] and len(step["outputs"]["items"]) < 8000 and step["outputs_blob"]
    assert _step(done, "count")["outputs"]["text"] == "8000", "later steps see the whole"
    whole = client.get(f"/api/blobs/{step['outputs_blob']}")
    assert whole.status_code == 200 and whole.headers["content-type"] == "application/json"
    assert len(json.loads(whole.content)["items"]) == 8000
    _, bob = _member("bob", ["tables"], env, grant="wf")
    assert bob.get(f"/api/blobs/{step['outputs_blob']}").status_code == 404

    # A rerun from the note reads the copied stage's whole outputs back.
    resp = client.post(f"/api/workflow-runs/{done['id']}/rerun", json={"from_step": "count"})
    again = _finished(resp.json()["id"])
    assert _step(again, "count")["outputs"]["text"] == "8000"
    assert _step(again, "big")["outputs_blob"] not in (None, step["outputs_blob"])


def test_an_artifact_is_a_file_of_the_run_and_goes_with_its_workflow(aws):
    env = _environment()
    _wf(f"""label: Export
steps:
  - id: scan
    pane: tables
    action: scan
    with: {{ connection: {env}, tableName: Orders }}
  - id: csv
    artifact: {{ name: "../orders {{{{ run.number }}}}.csv", value: "{{{{ steps.scan.outputs.items }}}}", format: csv }}
  - id: summary
    artifact: {{ name: summary.txt, value: "{{{{ size(steps.scan.outputs.items) }}}} items", format: text }}
""")
    before = set(_files())
    done = _finished(_run("wf", {})["id"])
    assert done["status"] == "succeeded", done
    names = [a["name"] for a in done["artifacts"]]
    assert names == ["orders 1.csv", "summary.txt"], names  # a name is never a path
    csv_file = client.get(f"/api/blobs/{done['artifacts'][0]['id']}")
    assert csv_file.status_code == 200 and csv_file.text.splitlines() == ["id", "1", "2"]
    assert "attachment" in csv_file.headers["content-disposition"]
    assert client.get(f"/api/blobs/{done['artifacts'][1]['id']}").text == "2 items"
    assert len(set(_files()) - before) == 2

    assert client.delete("/api/workflows/wf").status_code == 204
    assert set(_files()) == before, "its files went with it"
    with SessionLocal() as db:
        assert db.query(models.Blob).count() == 0


def test_retention_cleans_up_expired_files():
    _wf(f"label: A\nsteps:\n  - id: a\n    artifact: {{ name: a.txt, value: hi, format: text }}\n")
    done = _finished(_run("wf", {})["id"])
    blob_id = done["artifacts"][0]["id"]
    with SessionLocal() as db:
        assert blobs.clean(db) == 0
        db.query(models.Blob).update({"expires_at": datetime.datetime.utcnow() - datetime.timedelta(days=1)})
        db.commit()
        assert blobs.clean(db) == 1
    assert client.get(f"/api/blobs/{blob_id}").status_code == 404


def test_the_s3_backend_keeps_files_under_its_prefix(monkeypatch):
    kept: dict = {}

    class FakeS3:
        def put_object(self, Bucket, Key, Body, ContentType):
            kept[(Bucket, Key)] = Body

        def get_object(self, Bucket, Key):
            import io

            return {"Body": io.BytesIO(kept[(Bucket, Key)])}

        def delete_object(self, Bucket, Key):
            kept.pop((Bucket, Key), None)

    import boto3

    monkeypatch.setattr(boto3, "client", lambda *a, **k: FakeS3())
    monkeypatch.setenv("STORAGE_TYPE", "s3")
    monkeypatch.setenv("STORAGE_S3_BUCKET", "files")
    monkeypatch.setenv("STORAGE_S3_PREFIX", "/platform/")
    with SessionLocal() as db:
        row = blobs.put(db, b"hello", name="h.txt", content_type="text/plain", kind="artifact")
        db.flush()
        assert list(kept) == [("files", f"platform/{row.key}")]
        assert blobs.read(row) == b"hello"
        kept[("files", f"platform/{row.key}")] = b"tampered"
        with pytest.raises(blobs.BlobError, match="checksum"):
            blobs.read(row)
        blobs.remove(db, [row])
        assert kept == {}
        db.rollback()
    monkeypatch.setenv("STORAGE_TYPE", "s3")
    monkeypatch.delenv("STORAGE_S3_BUCKET")
    with pytest.raises(blobs.BlobError, match="STORAGE_S3_BUCKET"):
        blobs.backend()


# ---------------------------------------------------------------- what the samples needed


def test_a_text_input_given_a_map_gets_its_json_and_strings_can_be_joined(sent):
    """A JSON body is written as a CEL map (CEL can't write JSON itself): the
    HTTP client's text input used to get Python's repr of it. And a summary of
    rows needs join() -- the CEL strings extension."""
    _wf(r"""label: Body
steps:
  - id: send
    pane: tool-http
    action: send
    with:
      method: POST
      url: https://ops.example.com/x
      body: >-
        {{ {'reason': "disk \"full\"", 'n': [1, 2]} }}
  - id: names
    note: "{{ ['a', 'b'].join(', ') }} / {{ 'A-B'.lowerAscii() }}"
""")
    run = _finished(_run("wf", {})["id"])
    approval = _step(run, "send")["approval"]
    assert json.loads(approval["details"]["inputs"]["body"]) == {"reason": 'disk "full"', "n": [1, 2]}
    client.post(f"/api/approvals/{approval['id']}/approve")
    done = _finished(run["id"])
    assert done["status"] == "succeeded", done
    assert json.loads(sent[0][2]) == {"reason": 'disk "full"', "n": [1, 2]}
    assert _step(done, "names")["outputs"]["text"] == "a, b / a-b"


@pytest.mark.parametrize("path", sorted(Path(__file__).resolve().parents[2].joinpath("examples", "workflows").glob("*.yaml")))
def test_the_example_workflows_are_valid(path):
    assert _errors(path.read_text()) == [], path.name


# ---------------------------------------------------------------- parameters whose options load (D94)

GROUPS = """label: Groups
parameters:
  - { key: env, type: connection, connection_type: aws, label: Environment, required: true }
  - key: groups
    label: Log groups
    multiple: true
    required: true
    options_from:
      pane: logs-cloudwatch
      input: logGroupSelection
      with: { connections: "{{ [params.env] }}" }
steps:
  - id: q
    pane: logs-cloudwatch
    action: run
    with:
      logGroupSelection: "{{ {string(params.env): params.groups} }}"
      queryString: "fields @message"
"""


@pytest.mark.parametrize(
    "params, says",
    [
        ("  - { key: n, type: int, options_from: { pane: tables, input: tableName } }\n", "for a text parameter"),
        ("  - { key: t, options_from: { pane: tables, input: limit } }\n", "no input 'limit' whose options load"),
        ("  - { key: t, options_from: { pane: nope, input: x } }\n", "no pane type 'nope'"),
        ("  - { key: t, options_from: { pane: tables, input: tableName, with: { connection: '{{ params.zzz }}' } } }\n",
         "params.zzz isn't another parameter"),
        ("  - { key: t, options_from: { pane: tables, input: tableName, with: { connection: '{{ steps.a.outputs }}' } } }\n",
         "from the other parameters only"),
    ],
)
def test_a_parameters_options_source_is_checked(params, says):
    errors = _errors(f"label: t\nparameters:\n{params}steps:\n  - id: a\n    note: hi\n")
    assert any(says in e for e in errors), errors


def test_a_parameter_lists_its_options_from_a_pane_inputs_loader(monkeypatch, cloudwatch, fast_polls):
    from app import aws_client

    monkeypatch.setattr(aws_client, "list_log_groups", lambda account, region, identity: [{"name": "/app"}, {"name": "/worker"}])
    env = _environment()
    _wf(GROUPS)
    url = "/api/workflows/wf/parameters/groups/options"
    assert client.post(url, json={"params": {}}).json() == {"options": [], "needs": ["Environment"]}
    listed = client.post(url, json={"params": {"env": env}}).json()
    assert [o["value"] for o in listed["options"]] == ["/app", "/worker"] and "errors" not in listed
    assert client.post("/api/workflows/wf/parameters/env/options", json={"params": {}}).status_code == 400

    # Listed as the caller: a group without the pane gets the reason, not the groups.
    _, bob = _member("bob", ["tables"], env, grant="wf")
    refused = bob.post(url, json={"params": {"env": env}}).json()
    assert refused["options"] == [] and refused["error"]

    # Several values, a lone one taken as a list of one.
    done = _finished(_run("wf", {"env": env, "groups": ["/app", "/worker"]})["id"])
    assert done["status"] == "succeeded", done
    assert _step(done, "q")["inputs"]["logGroupSelection"] == {str(env): ["/app", "/worker"]}
    done = _finished(_run("wf", {"env": env, "groups": "/app"})["id"])
    assert _step(done, "q")["inputs"]["logGroupSelection"] == {str(env): ["/app"]}
    assert client.post("/api/workflows/wf/runs", json={"params": {"env": env, "groups": []}}).status_code == 400

    # Asked for in another case, or by part of just one name, a listed choice
    # is taken as that one (the agent was asked for "/APP"); anything else as given.
    done = _finished(_run("wf", {"env": env, "groups": ["/APP", "work", "/nope"]})["id"])
    assert done["params"]["groups"] == ["/app", "/worker", "/nope"]
    assert _step(done, "q")["inputs"]["logGroupSelection"] == {str(env): ["/app", "/worker", "/nope"]}
