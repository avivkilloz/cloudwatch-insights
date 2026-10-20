"""A Clear button and the changes a model reaches for (D126): asked to add a
Clear to an EC2 pane, a real model wrote a "clear" action with nothing to run,
`resets: [rows]`, and top-level keys named `[40]` it then couldn't remove --
it was shown the draft numbered and asked to delete "lines 72-74"."""

import pytest

from app import builder, yaml_edit
from tests.test_row_detail import EC2


def _check(source: str) -> list[str]:
    try:
        builder.parse(source, "ec2")
    except builder.BuilderError as e:
        return [x["message"] for x in e.errors]
    return []


def test_a_clear_button_is_a_cards_and_an_action_with_nothing_to_run_says_so():
    with_clear = EC2.replace("  - title: Instances\n", "  - title: Instances\n    clear: [rows]\n")
    assert _check(with_clear) == []
    action = EC2.replace("outputs:\n", "  - {id: clear, run_label: Clear, resets: [out.rows]}\noutputs:\n", 1)
    assert any("it's the card's `clear: [output keys]`" in m for m in _check(action)), _check(action)
    bare = EC2.replace("    resets: [view.expanded]\n", "    resets: [rows]\n")
    assert any("did you mean out.rows?" in m for m in _check(bare)), _check(bare)
    assert "clear: [output keys]" in str(builder.reference(None, "pane", _admin())["rules"])


def _admin():
    from app import models
    from app.db import SessionLocal

    with SessionLocal() as db:
        user = db.query(models.User).filter_by(username="admin").one()
        user.group  # loaded while the session is open
        return user


def test_lines_are_changed_as_shown_bottom_up_and_must_still_read():
    src = "label: A\nactions:\n  - id: list\n'[40]': x\n'[46]': y\ndescription: d\n"
    out = yaml_edit.apply_all(src, [{"op": "lines", "from": 4, "to": 4, "text": ""},
                                    {"op": "lines", "from": 5, "to": 5, "text": ""},
                                    {"op": "set", "path": "label", "value": "B"}])
    assert out == "label: B\nactions:\n  - id: list\ndescription: d\n"
    # A line given alone, and lines written as a list; an insert after line 1.
    assert yaml_edit.apply_all("a: 1\nb: 2\n", [{"line": 2, "text": "b: 3"}]) == "a: 1\nb: 3\n"
    assert yaml_edit.apply_all("a: 1\nb: 2\n", [{"op": "lines", "from": 2, "to": 1, "text": ["c: 0"]}]) == \
        "a: 1\nc: 0\nb: 2\n"
    with pytest.raises(yaml_edit.EditError, match="lines 9 to 9 aren't all in it"):
        yaml_edit.apply_all("a: 1\n", [{"op": "lines", "from": 9, "to": 9, "text": ""}])
    with pytest.raises(yaml_edit.EditError, match="doesn't read as YAML"):
        yaml_edit.apply_all("a: 1\nb: 2\n", [{"op": "lines", "from": 1, "to": 1, "text": "a: [1"}])


@pytest.mark.parametrize("path, says", [
    ("[40]", "the top is a mapping, not a list, so [40] picks nothing in it"),
    ("40", "the top is a mapping, not a list"),
])
def test_an_item_asked_of_a_mapping_is_never_made_a_key(path, says):
    with pytest.raises(yaml_edit.EditError, match=says.replace("[", r"\[").replace("]", r"\]")):
        yaml_edit.apply_all("label: A\n", [{"op": "set", "path": path, "value": 1}])
    # Brackets name a list's item, as JSON paths write one.
    src = "actions:\n  - id: list\n  - id: other\n"
    assert "main: true" in yaml_edit.apply_all(src, [{"op": "set", "path": "actions[1]/main", "value": True}]).split(
        "other")[1]
    # A key that really is written so can still go.
    assert yaml_edit.apply_all("a: 1\n'[40]': x\n", [{"op": "remove", "path": "[40]"}]) == "a: 1\n"
