"""The second OTA jobs chat (after D153): the Builder's agent still couldn't
finish the pane. Its final draft is tests/fixtures/ota_jobs_final -- the YAML
and the two files as the user pasted them. What went wrong, each held here:

- Its export button read `ctx.state` for the selected rows, which doesn't
  exist, and its detail fetched the job document with `ctx.http(None, url)`;
  both failed only when clicked. Check names both now, by file and line.
- Exporting rows with their detail was built in all along (`detail.include`),
  but the reference never said so -- so the model wrote an export action.
- Changes written the way the model wrote them were refused: the YAML edited
  as a file (`definition.yaml`, the pane's id), `actions[2].args`, `op: edit`.
- Trying the draft called an empty `Completed` column a problem -- the job was
  still in progress -- and the model spent its rounds "fixing" a right path.
"""

from pathlib import Path

import pytest

from app import builder, models, tools_http_client  # noqa: F401
from app.db import SessionLocal
from tests.conftest import client
from tests.test_code import stack  # noqa: F401 -- a fixture
from tests.test_platform_tools import call, mcp  # noqa: F401 -- a fixture
from tests.test_recipes import FUNCTION, RECIPES, _aws, _env, _iot

FINAL = Path(__file__).parent / "fixtures" / "ota_jobs_final"
SOURCE = (FINAL / "pane.yaml").read_text()
FILES = {name: (FINAL / name).read_text() for name in ("job_detail.py", "job_export.py")}


def _token(source: str, files: dict) -> str:
    from app.platform_tools import tokens

    with SessionLocal() as db:
        admin = db.query(models.User).filter_by(username="admin").one()
        return tokens.mint(db, admin, build={"kind": "pane", "id": None, "source": source, "files": files})


def test_code_reaching_for_what_ctx_doesnt_have_is_named_by_check():
    resp = client.post("/api/builder/check", json={"source": SOURCE, "files": FILES})
    assert resp.status_code == 200, resp.text
    found = {(e.get("file"), e.get("line")): e["message"] for e in resp.json()["errors"]}
    assert "ctx has no state" in found[("job_export.py", 3)] and "selected" in found[("job_export.py", 3)]
    assert "never a URL of its own" in found[("job_detail.py", 38)]
    assert "never a URL of its own" in found[("job_export.py", 30)]


def test_the_reference_says_export_with_detail_is_built_in_and_what_code_sees():
    with SessionLocal() as db:
        admin = db.query(models.User).filter_by(username="admin").one()
        reference = builder.reference(db, "pane", admin)
    assert "include" in reference["output config"]["table"]["detail"]
    assert any("Never write an export action" in rule for rule in reference["rules"])
    assert "never the pane's outputs, the selected rows" in reference["code (an action's)"]["what code sees"]
    recipe = RECIPES["per-row-values-in-code"]["source"]
    assert "include: " in recipe and "merge: " in recipe


def test_changes_are_read_as_the_model_wrote_them(mcp):
    fixed = {**FILES, "job_export.py": "def run(inputs, ctx):\n    return {}\n"}
    token = _token(SOURCE, fixed)
    lines = SOURCE.splitlines()
    at = next(n for n, line in enumerate(lines, 1) if line.startswith("label: "))
    # The YAML's lines, named as a file of its own.
    out = call(mcp, token, "change_definition", changes=[
        {"op": "lines", "file": "definition.yaml", "from": at, "to": at, "text": "label: IoT OTA jobs"}])
    assert out["changed"] == 1 and set(out["files"]) == set(fixed)
    # A place written with brackets and dots, and an op called edit.
    out = call(mcp, token, "change_definition", changes=[
        {"op": "remove", "path": "actions[2].resets"},
        {"op": "edit", "path": "actions[2].run_label", "value": "Export"}])
    draft = call(mcp, token, "read_draft")["text"]
    assert "label: IoT OTA jobs" in draft and "out.jobDetails" not in draft and "run_label: Export\n" in draft
    # The whole YAML, written as a file named after the pane.
    out = call(mcp, token, "change_definition", changes=[
        {"op": "file", "name": "default:iot_job_metrics", "text": SOURCE.replace("IoT OTA Jobs", "OTA")}])
    draft = call(mcp, token, "read_draft")["text"]
    assert "label: OTA" in draft and set(out["files"]) == set(fixed)


def test_empty_data_is_said_as_data_not_as_a_problem_to_fix(monkeypatch):
    # An AWS column the reply's shape has, empty in every row (a function has
    # no Version here, as a job in progress has no completedAt).
    source = RECIPES["rows-that-open"]["source"].replace("Runtime: Runtime", "Runtime: Runtime\n          Version: Version")
    _env("Prod", "111122223333")
    _aws(monkeypatch, {"111122223333": {
        "ListFunctions": {"Functions": [FUNCTION]},
        "GetFunctionConfiguration": {**FUNCTION, "Handler": "h", "Timeout": 3, "Role": "r", "Layers": []}}})
    with SessionLocal() as db:
        admin = db.query(models.User).filter_by(username="admin").one()
        out = builder.try_draft(db, admin, source, "default:lambdas", {}, "Prod")
    assert out["ok"] and out["problems"] == [], out
    assert any("Version came back empty" in n and "not a problem" in n for n in out["notes"]), out
    # The detail's State isn't in that reply either: an AWS reply, so data too.
    assert any("State" in n for n in out["notes"]), out


def test_a_detail_field_there_but_empty_is_data_and_one_not_there_is_a_problem(stack, monkeypatch):
    _env("Prod", "111122223333")
    _aws(monkeypatch, {"111122223333": _iot("111122223333", ["ota-1"])})
    recipe = RECIPES["per-row-values-in-code"]

    def tried(job_py: str) -> dict:
        with SessionLocal() as db:
            admin = db.query(models.User).filter_by(username="admin").one()
            return builder.try_draft(db, admin, recipe["source"], "default:ota", {**recipe["files"], "job.py": job_py},
                                     "Prod")

    empty = tried(recipe["files"]["job.py"].replace('"targets": targets', '"targets": None'))
    assert empty["ok"] and any("Targets (d.targets)" in n for n in empty["notes"]), empty
    gone = tried(recipe["files"]["job.py"].replace('"targets": targets, ', ""))
    assert not gone["ok"] and "Targets (d.targets)" in gone["problems"][0], gone
