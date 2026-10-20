"""Paths into a reply, for a request's `rows` (D67, D110): fields joined by
dots, a digit or `[0]` an item of a list, and `[Key=Name]` the first item of a
list whose field holds that value -- AWS keeps tags as a list of
{Key, Value}, so a Name column was out of reach (`Tags[Key=Name].Value`).

Not JMESPath: a model writes `Tags[?Key=='Name'].Value | [0]` from the AWS
CLI's --query, so that filter (and its `| [0]`) is read as the same
selector, and anything else of JMESPath's (pipes, wildcards, functions) is
refused in a sentence saying what a path can be -- a path that silently
matched nothing made an empty column and no reason why."""

import re
from typing import Any, Union

# ("key", name) | ("index", n) | ("match", field, value)
Part = Union[tuple[str, str], tuple[str, int], tuple[str, str, str]]

SYNTAX = ("a path is fields joined by dots: Tags[Key=Name].Value takes the Name tag's value (the first item of "
          "Tags whose Key is Name), Items[0] or Items.0 the first item -- not JMESPath, so no |, *, [] or functions")

_SELECTOR = re.compile(r"""^\??\s*([\w@:\-]+)\s*==?\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`|([^'"`]*?))\s*$""")


class PathError(ValueError):
    pass


def parts(path: str) -> list[Part]:
    """A path's steps, or PathError saying what a path can be."""
    # `[?Key=='Name'].Value | [0]`: the filter already takes the first item.
    if "[" in path:
        path = re.sub(r"\s*\|\s*\[0\]\s*$", "", path)
    out: list[Part] = []
    key = ""
    i = 0
    while i < len(path):
        c = path[i]
        if c == ".":
            if key.strip():
                out.append(("key", key.strip()))
            key = ""
        elif c == "[":
            end = path.find("]", i)
            if end < 0:
                raise PathError(f"{path!r} opens a [ it doesn't close: {SYNTAX}.")
            if key.strip():
                out.append(("key", key.strip()))
            key = ""
            inner = path[i + 1:end].strip()
            if inner.isdigit():
                out.append(("index", int(inner)))
            else:
                m = _SELECTOR.match(inner)
                if not m:
                    raise PathError(f"{path!r} has [{inner}], which isn't [field=value] or [0]: {SYNTAX}.")
                value = next(g for g in m.groups()[1:] if g is not None)
                out.append(("match", m.group(1), value.strip()))
            i = end
        elif c in "|*(){}":
            raise PathError(f"{path!r}: {SYNTAX}.")
        else:
            key += c
        i += 1
    if key.strip():
        out.append(("key", key.strip()))
    return out


_MISSING = object()


def step(value: Any, part: Part) -> Any:
    """One step into a value, or _MISSING."""
    if part[0] == "key":
        name = part[1]
        if isinstance(value, dict) and name in value:
            return value[name]
        if isinstance(value, list) and str(name).isdigit() and int(name) < len(value):
            return value[int(name)]
        return _MISSING
    if part[0] == "index":
        return value[part[1]] if isinstance(value, list) and part[1] < len(value) else _MISSING
    if isinstance(value, list):
        field, wanted = part[1], part[2]
        for item in value:
            if isinstance(item, dict) and field in item and _text(item[field]) == wanted:
                return item
    return _MISSING


def _text(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def describe(part: Part) -> str:
    if part[0] == "key":
        return str(part[1])
    if part[0] == "index":
        return f"[{part[1]}]"
    return f"[{part[1]}={part[2]}]"


def missing(value: Any) -> bool:
    return value is _MISSING
