"""Every field a definition may have says what it means in the Builder's
reference (D151, panes/manifest_docs.py): listed with only its type
(`submit: Optional[str]`, `choice_sets`), a field left a model guessing from
the examples. A field added without words, or words left behind by a field
that went, fails here."""

import pytest

from app import builder, step_types, workflows
from app.panes import manifest as m
from app.panes import manifest_docs

MODELS = [m.Manifest, m.ManifestInput, m.ManifestAction, m.ManifestOutput, m.Card, m.LayoutItem, m.When, m.Options,
          m.Page, m.Poll, m.ManifestView, m.CodeFile, m.Examples, m.By, m.Inspect, m.AgentInfo,
          workflows.Definition, workflows.Param, workflows.Step, workflows.OptionsFrom, workflows.ApprovalSpec,
          workflows.ArtifactSpec, step_types.Definition, step_types.HttpRequest]


def _names(model) -> set[str]:
    return {f.alias or name for name, f in model.model_fields.items()}


@pytest.mark.parametrize("model", MODELS, ids=lambda c: f"{c.__module__.rsplit('.', 1)[-1]}.{c.__name__}")
def test_every_field_says_what_it_means(model):
    missing = sorted(n for n in _names(model) if not manifest_docs.describe(model.__name__, n))
    assert not missing, f"{model.__name__}: say what these mean in panes/manifest_docs.py: {missing}"


def test_no_words_for_fields_that_are_gone():
    by_name: dict[str, set[str]] = {}
    for model in MODELS:
        by_name.setdefault(model.__name__, set()).update(_names(model))
    stale = {name: sorted(set(fields) - by_name.get(name, set())) for name, fields in manifest_docs.FIELDS.items()}
    assert not {k: v for k, v in stale.items() if v}, stale
    assert set(manifest_docs.INPUT_TYPES) == set(m.InputType.__args__)
    assert set(manifest_docs.RENDERS) == set(m.Render.__args__)


def test_the_reference_says_each_fields_meaning_beside_its_type():
    fields = builder._fields(m.ManifestInput)
    assert fields["submit"].startswith("Optional[str] -- Enter in this one-line box runs this action")
    assert fields["key"].startswith("str (required) -- its name")
    assert "copy" in builder._fields(m.LayoutItem) and "with" in builder._fields(workflows.Step)
