"""What went wrong building an IoT OTA jobs pane with the Builder's agent
(a real chat): every round's change made things worse, and what it finally
proposed checked clean in places and showed nothing.

- The check named places with dots (`layout.2.items`), the model copied
  them into its changes, and `set` made top-level keys of those names
  (`layout.3:`), which the check then said weren't fields -- listing every
  field the top may have, so the model tried again the same way.
- Rows opened onto empty fields: the row action read `row.jobId` from rows
  whose column is `Job ID`, and the detail's templates read `d.job_id` from a
  DescribeJob reply that keeps it at `d.job.jobId`. Nothing checked either.

tests/fixtures/ota_jobs_broken.yaml is that draft, its row action an AWS
request (DescribeJob) so its reply can be held to."""

from pathlib import Path

import pytest

from app import builder, yaml_edit

BROKEN = (Path(__file__).parent / "fixtures" / "ota_jobs_broken.yaml").read_text()


def _problems(source: str) -> list[dict]:
    try:
        builder.preview(source, "default:iot_job_metrics", None, {})
    except builder.BuilderError as e:
        return e.errors
    return []


def test_a_change_written_with_dots_is_that_path():
    out = yaml_edit.apply_all(BROKEN, [
        {"op": "set", "path": "outputs.0.config.detail.sections.0.fields.0.value", "value": "{{ d.job.jobId }}"},
        {"op": "set", "path": "actions.1.args.jobId", "value": "row.Job ID"},
        {"op": "set", "path": "layout/2. Filter and list/items.0.toolbar.1.action", "value": "list"},
    ])
    assert "value: '{{ d.job.jobId }}'" in out and "jobId: row.Job ID" in out
    assert "outputs.0" not in out and "actions.1" not in out, "never a key named like the path"


def test_a_key_that_is_named_with_dots_is_still_that_key():
    # The key the old way made: `remove layout.3` removes it, not a card.
    out = yaml_edit.apply_all(BROKEN, [{"op": "remove", "path": "layout.3"}])
    assert "layout.3" not in out and out.count("\n  - title:") == 3
    # A column whose name has a dot is a name: set where nothing's named so.
    added = yaml_edit.apply_all(out, [{"op": "set", "path": "actions/list/request/rows/columns/v1.2", "value": "x"}])
    assert "v1.2: x" in added


def test_a_key_named_like_a_path_is_said_to_be_one():
    [error] = _problems(BROKEN)
    assert error["message"].startswith("layout.3: layout.3 is a key named like a path")
    assert '"op": "remove", "path": "layout.3"' in error["message"] and "at layout/3" in error["message"]
    assert "it may say: id, label" not in error["message"]


def test_rows_that_open_onto_nothing_are_caught_before_they_do():
    found = {e["line"]: e["message"] for e in _problems(yaml_edit.apply_all(BROKEN, [
        {"op": "remove", "path": "layout.3"}]))}
    assert "row.jobId isn't a column of the jobs rows" in found[61] and "The column is row.Job ID" in found[61]
    assert "The detail (DescribeJob's reply; `d` in a template) has no job_id" in found[79]
    assert "(it has: documentSource, job)" in found[79]
    assert "has no job_document" in found[87]
    assert len(found) == 3, found


def test_fixed_as_the_check_says_it_checks_clean():
    fixed = yaml_edit.apply_all(BROKEN, [
        {"op": "remove", "path": "layout.3"},
        {"op": "set", "path": "actions/detail/args/jobId", "value": "row.Job ID"},
        {"op": "set", "path": "outputs.0.config.detail.sections.0.fields.0.value", "value": "{{ d.job.jobId }}"},
        {"op": "set", "path": "outputs.0.config.detail.sections.2.json", "value": "documentSource"},
    ])
    assert _problems(fixed) == []


@pytest.mark.parametrize("change, said", [
    # One row, by columns: its keys are the columns.
    ({"op": "set", "path": "actions/detail/request/rows",
      "value": {"at": "job.abortConfig.criteriaList", "columns": {"Status": "action"}}}, None),
    # Code's detail is what its run returns: only running it says.
    ({"op": "set", "path": "actions/detail/request", "value": None}, None),
])
def test_only_what_can_be_known_offline_is_held_to(change, said):
    source = yaml_edit.apply_all(BROKEN, [{"op": "remove", "path": "layout.3"},
                                          {"op": "set", "path": "actions/detail/args/jobId", "value": "row.Job ID"}])
    if change["value"] is None:
        source = yaml_edit.apply_all(source, [{"op": "remove", "path": "actions/detail/request"},
                                              {"op": "set", "path": "actions/detail/code", "value": "def run(inputs, ctx):\n    return {}\n"}])
        assert _problems(source) == []
        return
    messages = [e["message"] for e in _problems(yaml_edit.apply_all(source, [change]))]
    assert any("one row) has no job_id: its columns are Status" in m for m in messages), messages
