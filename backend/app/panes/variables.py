"""Session variables (PLATFORM_PLAN.md §18.7, D60): a few controls at the
session's level -- an environment, a time range -- that every pane with a
matching input follows, the way a Grafana dashboard's variables drive its
panels.

Which inputs a variable binds is worked out from the manifest by input type,
never named per pane, so a plugin's pane follows them with nothing of its own:
an Environment binds every AWS `connection`/`connections` input, a Time range
the three inputs a layout's `time_range` item names.

The value is copied into the pane's inputs, never resolved on read: inputs
stay the one truth, so a refresh, the agent's runs, templates and saved inputs
see an ordinary value. The browser's twin is `frontend/src/panes/variables.ts`.
"""

from typing import Any, Iterable, Optional

from . import manifest as pane_manifest

# The session state key, and the variables it may define.
VARIABLES_KEY = "variables"
ENVIRONMENT = "environment"
TIME = "time"
NAMES = (ENVIRONMENT, TIME)


def unlinked_key(pane_id: str) -> str:
    """The variables a pane doesn't follow (D60: following is the default)."""
    return f"{pane_id}.unlinked"


def _time_ranges(items: Iterable[pane_manifest.LayoutItem]) -> Iterable[dict[str, str]]:
    for item in items:
        if item.time_range:
            yield item.time_range
        for children in (item.row, item.toolbar, item.line):
            yield from _time_ranges(children or [])


def targets(manifest: pane_manifest.Manifest) -> dict[str, dict[str, str]]:
    """Per variable, the inputs it binds: input key -> what of the variable
    goes there ("value", "list" for a several-connections input, or a time
    range's "preset"/"start"/"end")."""
    out: dict[str, dict[str, str]] = {}
    environment = {
        i.key: ("list" if i.type == "connections" else "value")
        for i in manifest.inputs
        if i.type in ("connection", "connections") and i.connection_type == "aws"
    }
    if environment:
        out[ENVIRONMENT] = environment
    for card in manifest.layout:
        for time_range in _time_ranges([*card.aside, *card.items]):
            out[TIME] = {key: part for part, key in time_range.items()}
            break
        if TIME in out:
            break
    return out


def defined(state: dict) -> dict[str, Any]:
    raw = state.get(VARIABLES_KEY)
    return {k: v for k, v in raw.items() if k in NAMES} if isinstance(raw, dict) else {}


def unlinked(state: dict, pane_id: str) -> list[str]:
    raw = state.get(unlinked_key(pane_id))
    return [v for v in raw if isinstance(v, str)] if isinstance(raw, list) else []


def bound_values(manifest: pane_manifest.Manifest, variables: dict[str, Any], skip: Iterable[str] = ()) -> dict[str, Any]:
    """Input key -> the value a variable gives it, for every defined variable
    with a value that this pane follows."""
    out: dict[str, Any] = {}
    skipped = set(skip)
    for name, inputs in targets(manifest).items():
        if name in skipped or name not in variables:
            continue
        value = variables[name]
        if name == ENVIRONMENT:
            if value is None or value == "":
                continue
            for key, how in inputs.items():
                out[key] = [value] if how == "list" else value
        elif name == TIME and isinstance(value, dict):
            for key, part in inputs.items():
                if part in value:
                    out[key] = value[part]
    return out


def follows(state: dict, pane_id: str, manifest: pane_manifest.Manifest) -> dict[str, list[str]]:
    """Variable -> the pane's inputs that take their value from it now."""
    variables = defined(state)
    skip = set(unlinked(state, pane_id))
    return {
        name: sorted(inputs)
        for name, inputs in targets(manifest).items()
        if name in variables and name not in skip and bound_values(manifest, {name: variables[name]})
    }


def apply(state: dict, pane_id: str, manifest: pane_manifest.Manifest) -> list[str]:
    """Copies the variables this pane follows into its inputs, in place;
    returns the input keys that changed."""
    changed = []
    values = bound_values(manifest, defined(state), unlinked(state, pane_id))
    for key, value in values.items():
        stored = f"{pane_id}.in.{key}"
        if state.get(stored) != value:
            state[stored] = value
            changed.append(key)
    return changed


def variable_of(manifest: pane_manifest.Manifest, input_key: str) -> Optional[str]:
    """The variable that would bind this input, if any."""
    for name, inputs in targets(manifest).items():
        if input_key in inputs:
            return name
    return None
