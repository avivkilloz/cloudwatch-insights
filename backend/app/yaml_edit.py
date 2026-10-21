"""Changes to a definition's YAML by path, each one a splice (D116) -- the
Python twin of the form editor's `pages/builderYaml.ts` (D115).

The agent changed a draft with find-and-replace edits (D114). A model has to
copy the find text exactly -- indentation, quoting, the inline mappings --
and a real one kept missing ("isn't in the draft"), reading the draft again
and again and stopping halfway through IoT's jobs and rules. Here a change
names *where* (`outputs/jobs`, `layout/Results/items`, `actions/list/request`)
and *what* (plain data), never the text around it:

    {"op": "set", "path": "actions/list/request/output", "value": "jobs"}
    {"op": "add", "path": "outputs", "value": {"key": "jobs", "render": "table"}}
    {"op": "add", "path": "layout", "value": {...}, "before": "Results"}
    {"op": "remove", "path": "layout/Results/items/output=certResults"}

A path's parts are mapping keys or list items. An item is named by its
index, `field=value`, or a bare value matched against what identifies items
in a definition (key, id, title, name, the input/output/action a layout item
shows) -- so the model writes the names it reads, never counts lines.

Each change is applied to the data first -- what it *means* -- and then
written as a splice over the one key or item it touches, comments and
wrapping elsewhere kept. The spliced text is read back and must mean exactly
that data; when it doesn't (an edge of YAML the splice didn't foresee), the
whole top-level section is written out again instead, and failing that the
change is refused. A change can't silently mean something else.
"""

from __future__ import annotations

import copy
import json
import re
from typing import Any, Optional, Union

import yaml

Path = list[Union[str, int]]

# What names an item of a list, for a bare path part: in order, the first
# such field an item has.
IDENTIFIERS = ("key", "id", "title", "name", "input", "output", "action", "chart", "pane")


class EditError(ValueError):
    """A change that can't be made; the message says why and what's there."""


class _Dumper(yaml.SafeDumper):
    """Lists indented under their key (`  - a`), as the definitions are written."""

    def increase_indent(self, flow: bool = False, indentless: bool = False) -> Any:
        return super().increase_indent(flow, False)


def _block(dumper: yaml.SafeDumper, data: str) -> yaml.ScalarNode:
    # Text over several lines as a `|` block (D139): set as a quoted string,
    # Python came out as one line of \n's no one could read or fix.
    if "\n" in data:
        return dumper.represent_scalar("tag:yaml.org,2002:str", data, style="|")
    return dumper.represent_scalar("tag:yaml.org,2002:str", data)


_Dumper.add_representer(str, _block)


def _one_line(value: Any) -> bool:
    """A scalar that can be written in another's place on its line."""
    return _is_scalar(value) and not (isinstance(value, str) and "\n" in value)


def _dump(value: Any) -> str:
    return yaml.dump(value, Dumper=_Dumper, sort_keys=False, default_flow_style=False, width=120, allow_unicode=True)


def _scalar_text(value: Any) -> str:
    text = yaml.dump(value, Dumper=_Dumper, default_flow_style=True, width=10**9, allow_unicode=True)
    text = text.removesuffix("\n").removesuffix("\n...").strip()
    return json.dumps(value) if "\n" in text else text


def _flow_text(value: Any) -> Optional[str]:
    """A list or mapping as inline YAML, or None when it's too long for one line."""
    text = yaml.dump(value, Dumper=_Dumper, default_flow_style=True, sort_keys=False, width=10**9, allow_unicode=True).strip()
    return text if "\n" not in text and len(text) <= 100 else None


def _is_scalar(value: Any) -> bool:
    return value is None or isinstance(value, (str, int, float, bool))


# ---------------------------------------------------------------- paths


def parse_path(path: Union[str, list]) -> list[str]:
    if isinstance(path, list):
        return [str(p) for p in path]
    parts = [p.strip() for p in str(path).strip().strip("/").split("/")]
    if not parts or not all(parts):
        raise EditError(f"The path {path!r} is empty or has an empty part; write it like outputs/jobs.")
    # `actions[2]/label`, as JSON paths write an item: the list, then `[2]`.
    out: list[str] = []
    for part in parts:
        m = re.fullmatch(r"([^\[\]]+)((?:\[[^\[\]]*\])+)", part)
        if m:
            out.append(m.group(1))
            out += re.findall(r"\[[^\[\]]*\]", m.group(2))
        else:
            out.append(part)
    return out


def _bracketed(part: str) -> Optional[str]:
    """`[2]` or `[key=jobs]`: an item of a list, as its brackets say."""
    return part[1:-1].strip() if len(part) > 1 and part[0] == "[" and part[-1] == "]" else None


def _label(item: Any) -> str:
    if isinstance(item, dict):
        for field in IDENTIFIERS:
            if field in item and _is_scalar(item[field]):
                return f"{field}={item[field]}"
        return "{" + ", ".join(list(item)[:3]) + "}"
    return repr(item)


def _find(items: list, part: str, where: str) -> int:
    if part.lstrip("-").isdigit():
        index = int(part)
        if -len(items) <= index < len(items):
            return index % len(items)
        raise EditError(f"{where} has {len(items)} items; there is no item {part}.")
    if "=" in part:
        field, _, value = part.partition("=")
        matches = [i for i, it in enumerate(items) if isinstance(it, dict) and str(it.get(field.strip())) == value.strip()]
    else:
        matches = [
            i for i, it in enumerate(items)
            if (isinstance(it, dict) and any(str(it.get(f)) == part for f in IDENTIFIERS if _is_scalar(it.get(f))))
            or (_is_scalar(it) and str(it) == part)
        ]
    if len(matches) == 1:
        return matches[0]
    there = ", ".join(_label(it) for it in items) or "nothing"
    if not matches:
        raise EditError(f"{where} has no item {part!r}. It holds: {there}.")
    raise EditError(f"{where} has {len(matches)} items matching {part!r}; name one as field=value ({there}).")


def resolve(data: Any, parts: list[str], last_may_be_new: bool = False) -> Path:
    """The path's parts as mapping keys and list indexes into `data`. The
    last part may name a key that isn't there yet (`set` adds it)."""
    out: Path = []
    node = data
    parts = _dotted(data, list(parts))
    for n, part in enumerate(parts):
        where = "/".join(parts[:n]) or "the top"
        last = n == len(parts) - 1
        if isinstance(node, dict):
            if part not in node and (_bracketed(part) is not None or part.isdigit()):
                # An item of a list asked of a mapping: never a new key named
                # `[40]` (a model's, which then sat at the top unremovable).
                keys = ", ".join(map(str, node)) or "nothing"
                raise EditError(f"{where} is a mapping, not a list, so {part} picks nothing in it; its keys: {keys}.")
            if part not in node:
                if last and last_may_be_new:
                    out.append(part)
                    return out
                keys = ", ".join(map(str, node)) or "nothing"
                raise EditError(f"{where} has no {part!r}. It holds: {keys}.")
            out.append(part)
            node = node[part]
        elif isinstance(node, list):
            index = _find(node, _bracketed(part) if _bracketed(part) is not None else part, where)
            out.append(index)
            node = node[index]
        else:
            raise EditError(f"{where} is {_scalar_text(node)}, not a mapping or a list, so it has no {part!r}.")
    return out


def _dotted(data: Any, parts: list[str]) -> list[str]:
    """A part written with dots, as the check names a place
    (`outputs.0.config.detail`), is that path: a model copied the check's
    `layout.2.items` into a change, and `set` made a top-level key of that
    name, which the next check refused and the next change copied again.
    Only where no key is named so and its first piece is one."""
    out: list[str] = []
    node: Any = data
    for n, part in enumerate(parts):
        pieces = part.split(".")
        if (isinstance(node, dict) and part not in node and len(pieces) > 1 and all(pieces)
                and pieces[0] in node):
            return out + _dotted(node, pieces + parts[n + 1:])
        out.append(part)
        if isinstance(node, dict):
            node = node.get(part)
        elif isinstance(node, list):
            index = _bracketed(part) if _bracketed(part) is not None else part
            node = node[int(index)] if index.lstrip("-").isdigit() and -len(node) <= int(index) < len(node) else None
        else:
            node = None
    return out


def _get(data: Any, path: Path) -> Any:
    for part in path:
        data = data[part]
    return data


# ---------------------------------------------------------------- what a change means


def _meaning(data: Any, change: dict) -> tuple[Any, str, Path, Any]:
    """The data after the change, and the change made concrete: (new data,
    op, path of keys and indexes, value or the index to insert before)."""
    op = change.get("op")
    parts = parse_path(change.get("path", ""))
    new = copy.deepcopy(data)
    if op == "set":
        if "value" not in change:
            raise EditError("A set needs a value.")
        try:
            path = resolve(new, parts, last_may_be_new=True)
        except EditError:
            # A missing parent mapping is made: set actions/x/request/rows/at
            # on a request without rows -- never a key named like an item.
            if _bracketed(parts[-1]) is not None or parts[-1].isdigit():
                raise
            path = resolve(new, parts[:-1], last_may_be_new=True)
            parent_path, key = path, parts[-1]
            parent = _ensure(new, parent_path)
            if not isinstance(parent, dict):
                raise
            parent[key] = change["value"]
            return new, "set", [*parent_path, key], change["value"]
        _get(new, path[:-1])[path[-1]] = change["value"]
        return new, "set", path, change["value"]
    if op == "add":
        if "value" not in change:
            raise EditError("An add needs a value: the item to add to the list.")
        try:
            path = resolve(new, parts)
            target = _get(new, path)
        except EditError:
            path = resolve(new, parts, last_may_be_new=True)
            target = None
            if path[-1] in _get(new, path[:-1]):
                raise
        if target is None:
            _get(new, path[:-1])[path[-1]] = []
            target = _get(new, path)
        if not isinstance(target, list):
            raise EditError(f"{'/'.join(parts)} isn't a list, so nothing can be added to it; set one of its keys.")
        before = change.get("before")
        index = len(target) if before in (None, "") else _find(target, str(before), "/".join(parts))
        target.insert(index, change["value"])
        return new, "add", path, index
    if op == "remove":
        path = resolve(new, parts)
        parent = _get(new, path[:-1])
        del parent[path[-1]]
        return new, "remove", path, None
    raise EditError(f'A change\'s op is "set", "add" or "remove", not {op!r}.')


def _ensure(data: Any, path: Path) -> Any:
    """The mapping at `path`, made (empty) where it isn't there."""
    node = data
    for part in path:
        if isinstance(node, dict) and node.get(part) is None:
            node[part] = {}
        node = node[part]
    return node


# ---------------------------------------------------------------- the text


def _line_start(src: str, pos: int) -> int:
    return src.rfind("\n", 0, pos) + 1


def _line_end(src: str, pos: int) -> int:
    """Just past the end of the line `pos` is on, its newline included."""
    i = src.find("\n", pos)
    return len(src) if i < 0 else i + 1


def _column(src: str, pos: int) -> int:
    return pos - _line_start(src, pos)


def _indent(text: str, by: int) -> str:
    pad = " " * by
    return "".join(pad + line if line.strip() else line for line in text.splitlines(keepends=True))


def _empty(node: yaml.Node) -> bool:
    return isinstance(node, yaml.ScalarNode) and node.start_mark.index == node.end_mark.index


def _end(src: str, node: yaml.Node) -> int:
    """Where a node's own text ends (exclusive): its last character, not the
    comments or blank lines PyYAML's end mark can run on over."""
    if isinstance(node, yaml.ScalarNode):
        end = node.end_mark.index
        if node.style in ("|", ">"):
            while end > node.start_mark.index and src[end - 1] in " \t\r\n":
                end -= 1
        return end
    if node.flow_style or not node.value:
        return node.end_mark.index
    if isinstance(node, yaml.MappingNode):
        key, value = node.value[-1]
        return key.end_mark.index if _empty(value) else _end(src, value)
    return _end(src, node.value[-1])


def _pair_span(src: str, key: yaml.Node, value: yaml.Node) -> tuple[int, int]:
    """A pair's lines -- from its key, when the key shares its line with a
    list item's dash (`- text: >-`), so the dash stays."""
    last = key.end_mark.index if _empty(value) else _end(src, value)
    start = _line_start(src, key.start_mark.index)
    if src[start:key.start_mark.index].strip():
        start = key.start_mark.index
    return start, _line_end(src, max(last, key.end_mark.index) - 1)


def _pair_text(src: str, key: yaml.Node, start: int, name: str, value: Any) -> str:
    """`name: value` to go at `start`, indented as the key is: its first line
    not again when it follows a dash."""
    text = _indent(_dump({name: value}), _column(src, key.start_mark.index))
    return text.lstrip(" ") if start == key.start_mark.index and _column(src, start) else text


def _item_span(src: str, seq: yaml.SequenceNode, index: int) -> tuple[int, int]:
    item = seq.value[index]
    start = _line_start(src, item.start_mark.index)
    if index + 1 < len(seq.value):
        return start, _line_start(src, seq.value[index + 1].start_mark.index)
    return start, _line_end(src, _end(src, item) - 1)


def _dash_column(src: str, seq: yaml.SequenceNode) -> int:
    start = _line_start(src, seq.value[0].start_mark.index)
    line = src[start:_line_end(src, start)]
    return len(line) - len(line.lstrip(" "))


def _nodes(root: yaml.Node, path: Path) -> list[yaml.Node]:
    """The nodes along a path, root first. An alias (`*name`) is the node it
    names, written elsewhere: a change through one would land there."""
    out = [root]
    node = root
    for part in path:
        if isinstance(node, yaml.MappingNode):
            pair = next(((k, v) for k, v in node.value if isinstance(k, yaml.ScalarNode) and k.value == str(part)), None)
            if pair is None:
                break
            child = pair[1]
        elif isinstance(node, yaml.SequenceNode) and isinstance(part, int) and part < len(node.value):
            child = node.value[part]
        else:
            break
        if child.start_mark.index < node.start_mark.index:
            raise EditError("That part is an alias (*name) of another; change it where it's defined (&name).")
        out.append(child)
        node = child
    return out


def _pair(mapping: yaml.MappingNode, key: Any) -> Optional[tuple[yaml.Node, yaml.Node]]:
    return next(((k, v) for k, v in mapping.value if isinstance(k, yaml.ScalarNode) and k.value == str(key)), None)


def _splice(src: str, root: yaml.Node, new: Any, op: str, path: Path, extra: Any) -> Optional[str]:
    """The change written over the one key or item it touches, or None when
    its place is written inline (a flow mapping) -- the caller writes the
    whole of what holds it instead."""
    nodes = _nodes(root, path[:-1])
    if len(nodes) != len(path):
        return None  # a parent made by the change: written whole, above
    parent, last = nodes[-1], path[-1]
    if op == "set" and _one_line(_get(new, path)):
        # A scalar over a scalar is written in its place, even inline
        # (`choice_labels: { things: Things }`).
        if isinstance(parent, yaml.MappingNode):
            old = (_pair(parent, last) or (None, None))[1]
        elif isinstance(parent, yaml.SequenceNode) and isinstance(last, int):
            old = parent.value[last]
        else:
            old = None
        if isinstance(old, yaml.ScalarNode) and old.style in (None, "", "'", '"') and not _empty(old):
            return src[:old.start_mark.index] + _scalar_text(_get(new, path)) + src[old.end_mark.index:]
    if op == "set" and isinstance(_get(new, path), (list, dict)) and not isinstance(parent, yaml.SequenceNode):
        # An inline list or mapping replaced is written inline again
        # (`choices: [things, certificates, rules]`), as long as it fits a line.
        old = (_pair(parent, last) or (None, None))[1] if isinstance(parent, yaml.MappingNode) else None
        if isinstance(old, (yaml.SequenceNode, yaml.MappingNode)) and old.flow_style:
            text = _flow_text(_get(new, path))
            if text is not None:
                return src[:old.start_mark.index] + text + src[old.end_mark.index:]
    if getattr(parent, "flow_style", False):
        return None
    if op == "add":
        seq = _nodes(root, path)
        if len(seq) != len(path) + 1 or not isinstance(seq[-1], yaml.SequenceNode) or seq[-1].flow_style or not seq[-1].value:
            return None
        seq_node: yaml.SequenceNode = seq[-1]
        index: int = extra
        text = _indent(_dump([_get(new, path)[index]]), _dash_column(src, seq_node))
        if index < len(seq_node.value):
            at = _line_start(src, seq_node.value[index].start_mark.index)
        else:
            at = _item_span(src, seq_node, len(seq_node.value) - 1)[1]
            if at == len(src) and not src.endswith("\n"):
                text = "\n" + text
        return src[:at] + text + src[at:]
    if isinstance(parent, yaml.SequenceNode):
        index = int(last)
        start, end = _item_span(src, parent, index)
        if op == "remove":
            return None if len(parent.value) == 1 else src[:start] + src[end:]
        old = parent.value[index]
        value = _get(new, path)
        if _one_line(value) and isinstance(old, yaml.ScalarNode) and not old.style and not _empty(old):
            return src[:old.start_mark.index] + _scalar_text(value) + src[old.end_mark.index:]
        text = _indent(_dump([value]), _dash_column(src, parent))
        return src[:start] + text + src[end:]
    if not isinstance(parent, yaml.MappingNode):
        return None
    pair = _pair(parent, last)
    if op == "remove":
        if pair is None:
            return None
        if len(parent.value) == 1 and len(path) > 1:
            return None  # the mapping would be left as nothing: written whole
        start, end = _pair_span(src, *pair)
        return src[:start] + src[end:]
    value = _get(new, path)
    if pair is not None:
        key, old = pair
        if _one_line(value) and isinstance(old, yaml.ScalarNode) and old.style in (None, "", "'", '"') and not _empty(old):
            return src[:old.start_mark.index] + _scalar_text(value) + src[old.end_mark.index:]
        start, end = _pair_span(src, key, old)
        return src[:start] + _pair_text(src, key, start, str(last), value) + src[end:]
    if not parent.value:
        return None
    first_key, _ = parent.value[0]
    last_key, last_value = parent.value[-1]
    at = _pair_span(src, last_key, last_value)[1]
    text = _indent(_dump({str(last): value}), _column(src, first_key.start_mark.index))
    if at == len(src) and not src.endswith("\n"):
        text = "\n" + text
    return src[:at] + text + src[at:]


def _rewrite(src: str, root: yaml.Node, new: Any, path: Path) -> Optional[str]:
    """The whole of what holds `path`, written out again: the nearest key or
    item above it whose own parent is written as block YAML."""
    for depth in range(len(path) - 1, 0, -1):
        holder = path[:depth]
        if len(_nodes(root, holder)) != depth + 1:
            continue
        spliced = _splice(src, root, new, "set", holder, None)
        if spliced is not None:
            return spliced
    return None


def _means(text: str, data: Any) -> bool:
    try:
        return yaml.safe_load(text) == data
    except yaml.YAMLError:
        return False


# What a model writes for an op, as what it means.
OPS = {"set": "set", "replace": "set", "update": "set", "change": "set", "modify": "set",
       "add": "add", "append": "add", "insert": "add", "remove": "remove", "delete": "remove"}

SHAPE = ('{"op": "set" | "add" | "remove", "path": "outputs/jobs/render", "value": plain data}, or by line '
         '{"op": "lines", "from": 72, "to": 74, "text": "what goes there (empty to delete)"}')


def _as_data(value: Any, path: str, data: Any) -> Any:
    """A value a model wrote as YAML or JSON text (`"[things, rules]"`,
    `"{'id': 'search', 'main': True}"`) where a list or a mapping goes: the
    data it says. Left as text where text belongs -- over a string, or where
    it doesn't read as a list or a mapping."""
    if not isinstance(value, str) or not value.strip().startswith(("{", "[")):
        return value
    try:
        current = _get(data, resolve(data, parse_path(path)))
    except (EditError, KeyError, IndexError, TypeError):
        current = None
    if isinstance(current, str):
        return value
    for reader in (yaml.safe_load, _literal):
        try:
            parsed = reader(value)
        except Exception:  # noqa: BLE001 -- not that kind of text; try the next reading
            continue
        if isinstance(parsed, (dict, list)):
            return parsed
    return value


def _literal(text: str) -> Any:
    import ast

    return ast.literal_eval(text)


def normalise(change: Any, data: Any = None) -> dict:
    """A change as `apply` takes it, from the shapes models write (D120):
    `{"path", "new"}` with no op is a set, a path ending `/-` is an add to
    that list (`actions/-`), `replace`/`append`/`delete` are set/add/remove,
    and a list or mapping written as text is that data. A real model sent
    `{"path", "old", "new"}` three rounds running, each refused for its op,
    so nothing it meant ever reached the check."""
    if not isinstance(change, dict):
        raise EditError(f"A change is {SHAPE}, not {json.dumps(change)[:80]}.")
    out = dict(change)
    if _is_lines(out):
        return _line_change(out)
    if "value" not in out:
        for alias in ("new", "new_value", "to", "with"):
            if alias in out:
                out["value"] = out[alias]
                break
    raw = out.get("path")
    # A path given as its parts is those parts (its text was "['label']").
    path = "/".join(str(p) for p in raw) if isinstance(raw, list) else str(raw or "").strip()
    op = OPS.get(str(out.get("op") or "").strip().lower())
    if path.endswith("/-"):
        # JSON Patch's "the end of this list".
        path = path[:-2]
        if op in (None, "set"):
            op = "add"
    if op is None:
        if out.get("op"):
            raise EditError(f'A change\'s op is "set", "add" or "remove", not {out["op"]!r}: {SHAPE}.')
        if "value" in out:
            op = "set"
        else:
            raise EditError(f"A change needs an op and, to set or add, a value: {SHAPE}.")
    clean: dict = {"op": op, "path": path}
    if op != "remove":
        if "value" not in out:
            raise EditError(f"A change that does {op} needs a value: {SHAPE}.")
        clean["value"] = _as_data(out["value"], path, data) if data is not None else out["value"]
    if out.get("before") not in (None, ""):
        clean["before"] = out["before"]
    return clean


def _is_lines(change: dict) -> bool:
    op = str(change.get("op") or "").strip().lower()
    return op in ("lines", "replace_lines", "delete_lines", "insert_lines") or (
        not change.get("path") and any(k in change for k in ("from", "line")))


def _line_change(out: dict) -> dict:
    """`{"op": "lines", "from", "to", "text"}`: lines `from`..`to` of the
    draft as shown (numbered from 1, both kept in) replaced by `text` -- empty
    to delete them, `to` one before `from` to insert. The draft is shown to
    the model numbered and the check names lines, so a model asked to delete
    "lines 72-74" wrote `remove lines.72` and three paths that weren't."""
    try:
        start = int(out.get("from", out.get("line")))
        end = int(out.get("to", start))
    except (TypeError, ValueError):
        raise EditError(f"A change by line names its lines as numbers: {SHAPE}.") from None
    text = out.get("text", out.get("value", ""))
    if isinstance(text, list):
        text = "\n".join(str(t) for t in text)
    if not isinstance(text, str):
        raise EditError(f"A change by line gives its new lines as text: {SHAPE}.")
    return {"op": "lines", "from": start, "to": end, "text": text}


def _apply_lines(source: str, change: dict) -> str:
    lines = source.split("\n")
    if lines and lines[-1] == "":
        lines = lines[:-1]
    start, end = change["from"], change["to"]
    if not (1 <= start <= len(lines) + 1 and start - 1 <= end <= len(lines)):
        raise EditError(f"The draft has {len(lines)} lines; lines {start} to {end} aren't all in it.")
    new = change["text"].split("\n") if change["text"] else []
    if new and new[-1] == "":
        new = new[:-1]
    text = "\n".join(lines[:start - 1] + new + lines[end:]) + "\n"
    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError as e:
        raise EditError(f"With lines {start}-{end} changed so, the draft doesn't read as YAML: {e}") from None
    if not isinstance(data, dict):
        raise EditError(f"With lines {start}-{end} changed so, the draft isn't a mapping at the top.")
    twice = _duplicate(yaml.compose(text))
    if twice:
        # YAML keeps the last of two keys without a word: a line left behind
        # (an item's `run_label` after its `- id` went) renamed another
        # action's button.
        key, line = twice
        raise EditError(f"With lines {start}-{end} changed so, line {line} says {key} a second time in one mapping; "
                        "change the lines that belong with it too.")
    return text


def _duplicate(node: Optional[yaml.Node]) -> Optional[tuple[str, int]]:
    """A key said twice in one mapping, and the line it's said again on."""
    if isinstance(node, yaml.MappingNode):
        seen: set = set()
        for key, value in node.value:
            name = getattr(key, "value", None)
            if isinstance(name, str):
                if name in seen:
                    return name, key.start_mark.line + 1
                seen.add(name)
            found = _duplicate(value)
            if found:
                return found
    elif isinstance(node, yaml.SequenceNode):
        for item in node.value:
            found = _duplicate(item)
            if found:
                return found
    return None


def apply(source: str, change: dict) -> str:
    """The text with one change made, or EditError saying why it can't be."""
    if not isinstance(change, dict):
        raise EditError(f"A change is {SHAPE}.")
    if _is_lines(change):
        return _apply_lines(source, _line_change(change))
    try:
        data = yaml.safe_load(source) if source.strip() else {}
        root = yaml.compose(source) if source.strip() else None
    except yaml.YAMLError as e:
        raise EditError(f"The draft doesn't read as YAML, so it can't be changed by path: {e}") from None
    if not isinstance(data, dict):
        raise EditError("The draft isn't a mapping at the top.")
    new, op, path, extra = _meaning(data, normalise(change, data))
    if root is None:
        return _dump(new)
    candidates = [_splice(source, root, new, op, path, extra)]
    if op == "add" and len(_nodes(root, path)) == len(path) + 1:
        candidates.append(_splice(source, root, new, "set", path, None))  # the list, written whole
    candidates.append(_rewrite(source, root, new, path))
    # The top-level section, written out again: always possible.
    top = path[0]
    if top in new and _pair(root, top) is not None:
        key, value = _pair(root, top)
        start, end = _pair_span(source, key, value)
        candidates.append(source[:start] + _pair_text(source, key, start, str(top), new[top]) + source[end:])
    elif top in new:
        candidates.append(source + ("" if source.endswith("\n") else "\n") + _dump({top: new[top]}))
    else:
        key, value = _pair(root, top)
        start, end = _pair_span(source, key, value)
        candidates.append(source[:start] + source[end:])
    for text in candidates:
        if text is not None and _means(text, new):
            return text
    raise EditError("That change couldn't be written into the YAML as it is; set the whole section instead.")


def apply_all(source: str, changes: list[dict]) -> str:
    """Every change, in order, or none: the first that can't be made is
    named (`Change 2: …`)."""
    if not isinstance(changes, list) or not changes:
        raise EditError("Give at least one change.")
    # Changes by line name lines of the draft as it was shown: made first,
    # the last lines first, so each one's numbers still hold.
    by_line = [(i, normalise(c)) for i, c in enumerate(changes, 1) if isinstance(c, dict) and _is_lines(c)]
    for i, change in sorted(by_line, key=lambda pair: -pair[1]["from"]):
        try:
            source = _apply_lines(source, change)
        except EditError as e:
            raise EditError(f"Change {i} (lines {change['from']}-{change['to']}): {e}") from None
    for i, change in enumerate(changes, 1):
        if isinstance(change, dict) and _is_lines(change):
            continue
        try:
            source = apply(source, change)
        except EditError as e:
            what = f"{change.get('op') or 'no op'} {change.get('path')}" if isinstance(change, dict) else "?"
            raise EditError(f"Change {i} ({what}): {e}") from None
    return source
