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
    "connections",
    "topics",
]

Render = Literal[
    "text", "code", "json", "table", "diff", "badge", "error", "list", "files", "tags", "http_response", "attach",
    "logs", "run", "histogram", "stream",
]
OutputAction = Literal["copy", "export", "attach", "select"]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class By(_Strict):
    """A string that depends on an input: `{by: mode, values: {encode: Text, decode: Base64}}`."""

    by: str
    values: dict[str, str]


Text = Union[str, By]


class When(_Strict):
    """Shows a layout item only when an input equals a value (or isn't one of
    `not_in`: the HTTP client's Body, for a method that has one), an input or
    an output is present (set, and not empty), or an action's last run
    failed (`error`: the HTTP client's error card)."""

    input: Optional[str] = None
    equals: Optional[Any] = None
    not_in: Optional[list[Any]] = None
    output: Optional[str] = None
    present: Optional[bool] = None
    error: Optional[str] = None


class Examples(_Strict):
    """Example values for a text input, by another input's value (IoT's
    queries by mode): what "Show examples" lists, each with a Use button."""

    by: str
    values: dict[str, list[str]]


class Options(_Strict):
    """A choice whose options come from a server action (a loader) rather than
    the manifest: today's "Load tables" then "Choose table…". The loader
    returns `{"options": [{"value", "label"}]}`. Options live in the tab's
    memory, never the session (D47)."""

    action: str
    # The loader's button, and its text while loading. No button: the loader
    # runs when the select is first drawn with its dependencies set.
    load_label: Optional[str] = None
    busy_label: Optional[str] = None
    # The select's empty option ("Choose table…").
    placeholder: Optional[str] = None
    # A two-level picker (`log_groups`, `opensearch_indices`): the loader
    # returns `{"groups": [...]}`, one per connection; `children` is the
    # action that lists one item's own options (a domain's indices), and
    # `filter` the filter box's placeholder.
    children: Optional[str] = None
    filter: Optional[str] = None


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
    options: Optional[Options] = None
    # What a change to this input clears, as state keys relative to the pane
    # (`in.search`, `out.items`, `view.expanded`): today's hand-written
    # clearing when a table is picked, declared. The agent's writes clear the
    # same keys (platform_tools/server._apply_inputs).
    resets: list[str] = []
    # Enter in this one-line box runs this action.
    submit: Optional[str] = None
    # A choice that sets other inputs too, by value: IoT's mode puts its own
    # default query in. Applied after `resets`; an input set in the same
    # change (the agent's, a saved item's) wins.
    choice_sets: dict[str, dict[str, Any]] = {}
    # A connection that may be left unset: its empty option is `placeholder`
    # ("Any URL") rather than a prompt to choose. The input isn't drawn at
    # all while the group has no connection of its type.
    optional: bool = False
    examples: Optional[Examples] = None
    # A one-line box in a `line` that takes the rest of it, at least this wide.
    grow: Optional[int] = None
    # Said beside the input while it's set ("The URL is a path after its base URL.").
    hint: Optional[str] = None
    # A `headers` editor's wording: the name box's placeholder and the add
    # button ({key: Header name, add: Add header}).
    pairs: dict[str, str] = {}


class Page(_Strict):
    """Cursor paging ("Load more"): the action returns the next cursor under
    the output named `cursor`; running it again with that cursor appends the
    `append` outputs and adds up the `sum` ones, and leaves the rest of the
    pane's results (and so the row selection) alone."""

    cursor: str
    append: list[str] = []
    sum: list[str] = []
    label: str = "Load more"
    busy_label: str = "Loading…"


class Poll(_Strict):
    """A long-running action (D51): its handler starts the work and returns
    `handles`; the server polls them with `handler` (returning outputs and
    `done`) while the session is watched, and `stop` ends them early."""

    handler: str
    stop: str
    # Seconds between polls while someone is looking (a stream wants 1).
    every: float = 2.0
    # Stopped this long after the last viewer left: a scan no one will read
    # costs money; an idle connection only holds a slot, but still goes.
    unwatched_stop: float = 600.0
    # Outputs the poll adds to rather than replaces -- its new items go in
    # front of what the session holds -- each with the most it keeps (D54).
    append: dict[str, int] = {}
    # How long the agent waits on it before answering from what arrived; a
    # stream never finishes, so waiting the whole 90 s would be wasted.
    agent_wait: Optional[float] = None


class ManifestView(_Strict):
    """A key for how the pane looks (expanded rows, the diff's view): session
    state, synced to every viewer and settable by the agent (D48)."""

    key: str
    default: Any = None
    legacy_key: Optional[str] = None
    # What the value is, when it is more than a string or a list of row
    # keys: "chart" is a chart spec (D53), checked when the agent sets it.
    kind: Optional[Literal["chart"]] = None


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
    # A server action that runs when one of these inputs is changed by the
    # person using the pane: picking a table describes it, picking a bucket
    # browses it, clicking a folder (which sets `prefix`) opens it.
    on_change: list[str] = []
    # The inputs it can't run without, and what to say when one is missing.
    requires: dict[str, str] = {}
    page: Optional[Page] = None
    # Cleared by a fresh run (not by Load more), like an input's `resets`.
    resets: list[str] = []
    # A background run restarted, as whoever changed them, when these inputs
    # change while it is going -- its appended outputs kept (D54).
    restart_on: list[str] = []
    # The most of its runs one user may have going at once.
    max_running: Optional[int] = None
    # The Stop button's words ("Disconnect").
    stop_label: Optional[str] = None
    # The action run_pane runs for the agent. A pane's on_change actions whose
    # inputs are set run first, as picking them in the pane would have.
    main: bool = False
    # Run in the background and polled by the server (§16.9.1): the run is
    # written into the session as `out.run`, its results as it goes.
    poll: Optional[Poll] = None
    # An action for one row of a list (§16.4.2): its inputs are these paths
    # into the row and its group (`row.thing_name`, `group.environment_id`),
    # not the pane's inputs. Paths, not templates, so the server works out
    # the same inputs for the agent's inspect_row.
    args: dict[str, str] = {}

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
    # Items in one line spaced as a row is, each drawn inline (a picker's
    # label beside it): the HTTP client's method, URL and Send.
    line: Optional[list["LayoutItem"]] = None
    when: Optional[When] = None
    # Shown in place of an output that has nothing yet.
    empty: Optional[str] = None
    # A Copy button for this output ("Copied" for a moment after). `copy` in
    # the YAML; renamed here, where it would shadow BaseModel.copy.
    copy_of: Optional[str] = Field(default=None, alias="copy")
    # Where an action's error is shown, as a paragraph, instead of beside its
    # button (a loader's error goes under its card's toolbar).
    error: Optional[str] = None
    # "Showing results fetched … ago" for this action's last run, with "Run
    # again" unless `rerun: false`.
    restored: Optional[str] = None
    rerun: bool = True
    # Breadcrumbs over a path input (S3's prefix): the root button shows
    # `crumbs_root` (an input), each segment sets the path input.
    crumbs: Optional[str] = None
    crumbs_root: Optional[str] = None
    # A button that sets inputs and runs an action: "Clear search".
    button: Optional[str] = None
    sets: dict[str, Any] = {}
    runs: Optional[str] = None
    # A list output's Load more, where the layout puts it.
    more: Optional[str] = None
    # An action's button drawn as a secondary one (S3's Search).
    secondary: bool = False
    # "Loading…" while this action runs.
    busy: Optional[str] = None
    # Where the pane's short-lived messages ("S3 URI copied to clipboard") go.
    flash: bool = False
    # The Show/Hide examples button of this input's `examples`, and the list.
    examples: Optional[str] = None
    # The Stop button of a background action's run (§16.9.1).
    stop: Optional[str] = None
    # A logs pane's time range: its preset, start and end inputs as one control.
    time_range: Optional[dict[str, str]] = None
    # "Sort by" a field of this output's rows, and the direction: the
    # output's `sort` view keys, its fields the choices.
    sort: Optional[str] = None
    # A chart over this output's rows (D53): its type, x, y and series are
    # picked in the pane and kept in the output's `chart` view key.
    chart: Optional[str] = None


class Card(_Strict):
    # None: the card's one output draws its own title row (the HTTP
    # client's Response, whose status sits beside it).
    title: Optional[Text] = None
    when: Optional[When] = None
    # Items at the right of the card's title: a Copy button, a view select.
    aside: list[LayoutItem] = []
    items: list[LayoutItem] = []


class Inspect(_Strict):
    # A registered row lister (platform_tools/panes.ROW_LISTERS). None: the
    # rows of the manifest's list outputs, and the detail its list declares.
    rows: Optional[str] = None
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
    views: list[ManifestView] = []
    # Legacy keys the v2 migration drops rather than moves: what the pane no
    # longer keeps in the session (picker options, D47).
    legacy_drop: list[str] = []

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
            if w.error is not None and w.error not in actions:
                raise ValueError(f"'when: error {w.error}' names no action")

        def check_item(item: LayoutItem) -> None:
            if item.input is not None and item.input not in inputs:
                raise ValueError(f"the layout names an input {item.input} that isn't declared")
            if item.output is not None and item.output not in outputs:
                raise ValueError(f"the layout names an output {item.output} that isn't declared")
            if item.action is not None and item.action not in actions:
                raise ValueError(f"the layout names an action {item.action} that isn't declared")
            if item.sort is not None and item.sort not in outputs:
                raise ValueError(f"the layout sorts an output {item.sort} that isn't declared")
            if item.chart is not None:
                charted = next((o for o in self.outputs if o.key == item.chart), None)
                if charted is None:
                    raise ValueError(f"the layout charts an output {item.chart} that isn't declared")
                view = charted.config.get("chart")
                if not any(v.key == view and v.kind == "chart" for v in self.views):
                    raise ValueError(f"output {item.chart} is charted, so its config needs `chart:` naming a chart view")
            if item.copy_of is not None and item.copy_of not in outputs:
                raise ValueError(f"the layout copies an output {item.copy_of} that isn't declared")
            for ref in (item.error, item.restored, item.runs, item.more, item.busy, item.stop):
                if ref is not None and ref not in actions:
                    raise ValueError(f"the layout names an action {ref} that isn't declared")
            for ref in [item.crumbs, item.crumbs_root, item.examples, *item.sets, *(item.time_range or {}).values()]:
                if ref is not None and ref not in inputs:
                    raise ValueError(f"the layout names an input {ref} that isn't declared")
            check_when(item.when)
            for child in (item.row or []) + (item.toolbar or []) + (item.line or []):
                check_item(child)

        views = {v.key for v in self.views}

        def check_key(ref: str) -> None:
            part, _, key = ref.partition(".")
            known = {"in": inputs, "out": outputs | {"ranAt", "resultsVersion"}, "view": views}.get(part)
            if known is None or key not in known:
                raise ValueError(f"'{ref}' names no input (in.), output (out.) or view key (view.)")

        for a in self.actions:
            for ref in a.on_change:
                if ref not in inputs:
                    raise ValueError(f"action {a.id} names an input {ref} that isn't declared")
            for ref in a.requires:
                # A row action requires its own args, not the pane's inputs.
                if ref not in (a.args if a.args else inputs):
                    raise ValueError(f"action {a.id} requires {ref}, which isn't one of its inputs")
            for path in a.args.values():
                if path.partition(".")[0] not in ("row", "group"):
                    raise ValueError(f"action {a.id}'s arg {path!r} must be a path into row. or group.")
            for ref in a.resets:
                check_key(ref)
            for ref in a.restart_on:
                if ref not in inputs:
                    raise ValueError(f"action {a.id} restarts on an input {ref} that isn't declared")
            for ref in (a.poll.append if a.poll else {}):
                if ref not in outputs:
                    raise ValueError(f"action {a.id} appends to an output {ref} that isn't declared")
            if a.page:
                for ref in [a.page.cursor, *a.page.append, *a.page.sum]:
                    if ref not in outputs:
                        raise ValueError(f"action {a.id} pages an output {ref} that isn't declared")
        if sum(1 for a in self.actions if a.main) > 1:
            raise ValueError("only one action can be the main one")
        for i in self.inputs:
            check_text(i.label)
            check_text(i.placeholder)
            for ref in i.resets:
                check_key(ref)
            if i.options is not None and i.options.action not in actions:
                raise ValueError(f"input {i.key}'s options come from an action {i.options.action} that isn't declared")
            if i.options is not None and i.options.children is not None and i.options.children not in actions:
                raise ValueError(f"input {i.key}'s children come from an action {i.options.children} that isn't declared")
            if i.type == "choice" and not i.choices:
                raise ValueError(f"choice input {i.key} has no choices")
            if i.type in ("connection", "connections") and not i.connection_type:
                raise ValueError(f"connection input {i.key} needs a connection_type")
            for value, sets in i.choice_sets.items():
                if value not in i.choices:
                    raise ValueError(f"input {i.key}'s choice_sets names {value!r}, which isn't one of its choices")
                for ref in sets:
                    if ref not in inputs:
                        raise ValueError(f"input {i.key}'s choice_sets sets {ref}, which isn't an input")
            if i.examples is not None and i.examples.by not in inputs:
                raise ValueError(f"input {i.key}'s examples are by {i.examples.by}, which isn't an input")
        for card in self.layout:
            if card.title is None and not (
                len(card.items) == 1 and (card.items[0].output or card.items[0].error) and not card.aside
            ):
                raise ValueError("a card without a title holds exactly one output or error, which draws its own")
            check_text(card.title)
            check_when(card.when)
            for item in card.aside + card.items:
                check_item(item)
        for o in self.outputs:
            check_text(o.label)
            detail = o.config.get("detail")
            if isinstance(detail, dict) and detail.get("action") not in {a.id for a in self.actions if a.args}:
                raise ValueError(f"output {o.key}'s detail needs a row action (one with args), not {detail.get('action')!r}")
        if self.rendered and not self.layout:
            raise ValueError("a rendered pane needs a layout")
        if self.rendered and self.state != "v2":
            raise ValueError("a rendered pane stores the v2 shape (state: v2)")
        return self

    def agent_inputs(self) -> list[ManifestInput]:
        return [i for i in self.inputs if i.agent and not i.sensitive]

    def legacy_map(self) -> dict[str, str]:
        """Old key -> new key, for a v2 pane's migration (§15.4). Every run's
        bookkeeping moves too: a pane drawn by hand kept `ranAt` and
        `resultsVersion` beside its results."""
        if self.state != "v2":
            return {}
        out = {"ranAt": "out.ranAt", "resultsVersion": "out.resultsVersion"}
        for i in self.inputs:
            if not i.sensitive:
                out[i.legacy_key or i.key] = f"in.{i.key}"
        for o in self.outputs:
            if o.legacy_key:
                out[o.legacy_key] = f"out.{o.key}"
        for v in self.views:
            if v.legacy_key:
                out[v.legacy_key] = f"view.{v.key}"
        return out

    def main_action(self) -> Optional[ManifestAction]:
        return next((a for a in self.actions if a.main), None)


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
