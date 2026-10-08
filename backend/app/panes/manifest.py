"""Pane manifests (PLATFORM_PLAN.md §15.2, D39): one YAML file per pane type,
the one description of a pane that the renderer draws, the agent reads and
-- from Phase 7 -- a plugin ships.

The model is strict (`extra="forbid"`) and cross-checked, so a manifest with
a typo fails startup and the tests naming its file and field, instead of
drawing a pane that silently lacks an input.
"""

from functools import lru_cache
from pathlib import Path
from typing import Any, Literal, Optional, Union

import yaml
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

MANIFEST_DIR = Path(__file__).parent / "manifests"

# What an input holds. The agent's converters are keyed by these
# (platform_tools/panes.convert), and the renderer by the same names.
InputType = Literal[
    "text",
    "int",
    "choice",
    "bool",
    "environments",
    "environment",
    "log_groups",
    "opensearch_indices",
    "headers",
    "credential",
    "connection",
]

Render = Literal["text", "code", "json", "table", "diff", "badge", "error"]
OutputAction = Literal["copy", "export", "attach", "select"]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class By(_Strict):
    """A string that depends on an input: `{by: mode, values: {encode: Text, decode: Base64}}`."""

    by: str
    values: dict[str, str]


Text = Union[str, By]


class When(_Strict):
    """Shows a layout item only when an input equals a value, or an output is present."""

    input: Optional[str] = None
    equals: Optional[Any] = None
    output: Optional[str] = None
    present: Optional[bool] = None


class ManifestInput(_Strict):
    """One input. `{now}` in a text default is the current Unix time when the
    pane first draws it (JWT's sample payload carries an `iat`)."""

    key: str
    type: InputType
    label: Optional[Text] = None
    # For the agent (get_context) and as the field's tooltip in the pane.
    help: str = ""
    placeholder: Optional[Text] = None
    default: Any = None
    choices: list[Any] = []
    # How a choice's values are shown, where that differs from the value.
    choice_labels: dict[str, str] = {}
    # A choice drawn as one button per value rather than a select.
    buttons: bool = False
    min: Optional[int] = None
    max: Optional[int] = None
    # A multi-line box this many rows high; a one-line box when absent.
    rows: Optional[int] = None
    # A one-line box this many pixels wide, rather than as wide as it may be.
    width: Optional[int] = None
    # Kept out of session state, the agent and run records: a pasted token,
    # a secret. Lives only in the tab's memory, as JWT's always has.
    sensitive: bool = False
    # Whether the agent sees it. A sensitive input never is.
    agent: bool = True
    connection_type: Optional[str] = None
    # Where the input lived before the pane moved to the v2 state shape.
    legacy_key: Optional[str] = None


class ManifestAction(_Strict):
    id: str
    run_label: Optional[Text] = None
    busy_label: Optional[str] = None
    # Exactly one of these says what running it does.
    handler: Optional[str] = None  # a Python function, by name (platform_tools/panes.HANDLERS)
    live: Optional[str] = None  # a live function (D43): reruns as the inputs change
    request: Optional[dict[str, Any]] = None  # a declarative HTTP request (§15.7)
    # A run that reaches outside the platform, which the agent may not start
    # until the approval step exists.
    effects: Optional[Literal["external"]] = None
    # A live action reruns on every change of an input by default; "click"
    # waits for its button (JWT's Generate token). Not called `on`: YAML 1.1
    # reads that key as the boolean true.
    run_on: Literal["change", "click"] = "change"

    @model_validator(mode="after")
    def _one_kind(self) -> "ManifestAction":
        kinds = [k for k in ("handler", "live", "request") if getattr(self, k) is not None]
        if len(kinds) != 1:
            raise ValueError(f"action {self.id} needs exactly one of handler, live or request, not {kinds or 'none'}")
        return self


class ManifestOutput(_Strict):
    key: str
    render: Render
    label: Optional[Text] = None
    actions: list[OutputAction] = []
    # Code shown in a read-only box this many rows high; as preformatted
    # text when absent.
    rows: Optional[int] = None
    # For a badge: each value's text and tone (ok | error | none).
    badges: dict[str, dict[str, str]] = {}
    # Component settings, e.g. the diff's view comes from an input.
    config: dict[str, Any] = {}
    inspect: bool = False
    legacy_key: Optional[str] = None


class LayoutItem(_Strict):
    """One thing in a card: an input, an output, an action's button, a line
    of text, or a row/toolbar of other items."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    input: Optional[str] = None
    output: Optional[str] = None
    action: Optional[str] = None
    text: Optional[str] = None
    # Items side by side, each taking an equal share ("row"), or packed in a
    # toolbar line ("toolbar").
    row: Optional[list["LayoutItem"]] = None
    toolbar: Optional[list["LayoutItem"]] = None
    when: Optional[When] = None
    # Shown in place of an output that has nothing yet.
    empty: Optional[str] = None
    # A Copy button for this output ("Copied" for a moment after). `copy` in
    # the YAML; renamed here, where it would shadow BaseModel.copy.
    copy_of: Optional[str] = Field(default=None, alias="copy")


class Card(_Strict):
    title: Text
    when: Optional[When] = None
    # Items at the right of the card's title: a Copy button, a view select.
    aside: list[LayoutItem] = []
    items: list[LayoutItem] = []


class Inspect(_Strict):
    rows: str
    detail: Optional[str] = None
    help: str = ""


class AgentInfo(_Strict):
    # What run_pane says this kind does, or why the agent can't run it.
    run: str = ""


class Manifest(_Strict):
    id: str
    label: str
    # Where it comes in the catalogue and in the agent's list of kinds.
    order: int = 100
    group: Literal["Services", "Tools", "Platform"] = "Tools"
    flag: str
    about: str
    help: str = ""
    description: str = ""
    # "v2": its keys are in./out./view. (§15.4). Absent: the pane's own code
    # still reads its legacy keys, until its PR ports it.
    state: Optional[Literal["v2"]] = None
    # Drawn by the generic renderer (ManifestPane). False for a pane whose
    # React component still draws it.
    rendered: bool = False
    inputs: list[ManifestInput] = []
    actions: list[ManifestAction] = []
    outputs: list[ManifestOutput] = []
    layout: list[Card] = []
    implies: Optional[str] = None
    inspect: Optional[Inspect] = None
    agent: AgentInfo = Field(default_factory=AgentInfo)

    @model_validator(mode="after")
    def _references(self) -> "Manifest":
        inputs = {i.key for i in self.inputs}
        outputs = {o.key for o in self.outputs}
        actions = {a.id for a in self.actions}
        if len(inputs) != len(self.inputs) or len(outputs) != len(self.outputs):
            raise ValueError("input and output keys must be unique")
        if inputs & outputs:
            raise ValueError(f"{sorted(inputs & outputs)} is both an input and an output")

        def check_text(t: Optional[Text]) -> None:
            if isinstance(t, By) and t.by not in inputs:
                raise ValueError(f"'by: {t.by}' names no input")

        def check_when(w: Optional[When]) -> None:
            if w is None:
                return
            if w.input is not None and w.input not in inputs:
                raise ValueError(f"'when: input {w.input}' names no input")
            if w.output is not None and w.output not in outputs:
                raise ValueError(f"'when: output {w.output}' names no output")

        def check_item(item: LayoutItem) -> None:
            if item.input is not None and item.input not in inputs:
                raise ValueError(f"the layout names an input {item.input} that isn't declared")
            if item.output is not None and item.output not in outputs:
                raise ValueError(f"the layout names an output {item.output} that isn't declared")
            if item.action is not None and item.action not in actions:
                raise ValueError(f"the layout names an action {item.action} that isn't declared")
            if item.copy_of is not None and item.copy_of not in outputs:
                raise ValueError(f"the layout copies an output {item.copy_of} that isn't declared")
            check_when(item.when)
            for child in (item.row or []) + (item.toolbar or []):
                check_item(child)

        for i in self.inputs:
            check_text(i.label)
            check_text(i.placeholder)
            if i.type == "choice" and not i.choices:
                raise ValueError(f"choice input {i.key} has no choices")
            if i.type == "connection" and not i.connection_type:
                raise ValueError(f"connection input {i.key} needs a connection_type")
        for card in self.layout:
            check_text(card.title)
            check_when(card.when)
            for item in card.aside + card.items:
                check_item(item)
        for o in self.outputs:
            check_text(o.label)
        if self.rendered and not self.layout:
            raise ValueError("a rendered pane needs a layout")
        if self.rendered and self.state != "v2":
            raise ValueError("a rendered pane stores the v2 shape (state: v2)")
        return self

    def agent_inputs(self) -> list[ManifestInput]:
        return [i for i in self.inputs if i.agent and not i.sensitive]

    def legacy_map(self) -> dict[str, str]:
        """Old key -> new key, for a v2 pane's one-time migration (§15.4)."""
        if self.state != "v2":
            return {}
        out = {}
        for i in self.inputs:
            if not i.sensitive:
                out[i.legacy_key or i.key] = f"in.{i.key}"
        for o in self.outputs:
            if o.legacy_key:
                out[o.legacy_key] = f"out.{o.key}"
        return out


class ManifestError(ValueError):
    pass


def _load(path: Path) -> Manifest:
    try:
        data = yaml.safe_load(path.read_text())
        manifest = Manifest.model_validate(data)
    except (yaml.YAMLError, ValidationError) as e:
        raise ManifestError(f"{path.name}: {e}") from None
    if manifest.id != path.stem:
        raise ManifestError(f"{path.name}: its id is '{manifest.id}', but the file is named after '{path.stem}'")
    return manifest


@lru_cache(maxsize=1)
def manifests() -> dict[str, Manifest]:
    """Every pane type's manifest, by id, in catalogue order. Loaded once."""
    loaded = [_load(path) for path in sorted(MANIFEST_DIR.glob("*.yaml"))]
    return {m.id: m for m in sorted(loaded, key=lambda m: (m.order, m.id))}


def get(type_: str) -> Optional[Manifest]:
    return manifests().get(type_)
