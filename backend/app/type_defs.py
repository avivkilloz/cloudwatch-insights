"""Credential and connection types as text (D159): the YAML the store keeps as
each one's file, so a type is built the way a pane, a step or a workflow is --
a draft of that text, checked with lines, changed a piece at a time by the
Builder's agent or Claude Code, proposed into the editor, saved by a person.

The editors stay forms (D158), with this text as their YAML view; the routes
that save a type are unchanged. What's here is what the agent and drafts
need: the text of an existing type, a starter, a check, and a reference
generated from the same constants the validation uses.
"""

import re
from typing import Any, Optional

import yaml
from sqlalchemy.orm import Session

from . import connections, credential_types, models, store

KINDS = ("credential", "connection")
STORE_KIND = {"credential": "credential_type", "connection": "connection_type"}
MODELS = {"credential": models.CredentialType, "connection": models.ConnectionType}
NOUNS = {"credential": "credential type", "connection": "connection type"}
ALLOWED = {
    "credential": ("id", "label", "description", "fields", "output_template", "inject", "http_test"),
    "connection": ("id", "label", "description", "fields"),
}

STARTERS = {
    "credential": """label: Acme API key
description: What it signs in to.
fields:
  - key: token
    label: Token
    kind: text
    secret: true
    required: true
    help: Where to find it.
inject:
  kind: header
  name: Authorization
  value: '"Bearer " + token'
""",
    "connection": """label: Acme API
description: What connections of this type reach.
fields:
  - key: tenant
    label: Tenant
    required: false
    help: Plain settings only -- a secret belongs in a credential.
""",
}


class TypeDefError(ValueError):
    def __init__(self, errors: list[dict]):
        super().__init__("; ".join(e["message"] for e in errors))
        self.errors = errors


def source_of(kind: str, row: Any) -> str:
    """An existing type's text: the store's file, its version left out (the
    platform keeps that)."""
    data = store.KINDS[STORE_KIND[kind]].dump(row)
    data.pop("version", None)
    return store.render(data)


def _line(text: str, key: str) -> Optional[int]:
    from .workflows import _line as line_of

    return line_of(text, (key,))


def _where(text: str, data: dict, message: str, keys: tuple[str, ...]) -> Optional[int]:
    """The line a check's message is most likely about: the field it names
    (its `kind` line when that's what's wrong), the top-level key it names,
    else its fields."""
    from .workflows import _line as line_of

    named = re.search(r"'([a-z][a-z0-9_]*)'", message)
    fields = data.get("fields") if isinstance(data.get("fields"), list) else []
    for i, f in enumerate(fields):
        if named and isinstance(f, dict) and f.get("key") == named.group(1):
            sub = next((k for k in ("kind", "choices", "default") if k in message and k in f), None)
            return line_of(text, ("fields", i, sub) if sub else ("fields", i))
    for key in keys:
        if key in message:
            line = _line(text, key)
            if line:
                return line
    return _line(text, "fields")


def parse(kind: str, text: str) -> dict:
    """The definition `text` says, checked as Save checks it; a TypeDefError
    with every problem and its line otherwise."""
    try:
        data = yaml.safe_load(text) if text.strip() else None
    except yaml.YAMLError as e:
        mark = getattr(e, "problem_mark", None)
        raise TypeDefError([{"line": mark.line + 1 if mark else None,
                             "message": f"It isn't YAML that reads: {getattr(e, 'problem', None) or e}."}]) from None
    if not isinstance(data, dict):
        raise TypeDefError([{"line": None, "message": f"A {NOUNS[kind]} is a mapping: label, fields…"}])
    errors = [{"line": _line(text, k), "message": f"A {NOUNS[kind]} has no '{k}'; it has {', '.join(ALLOWED[kind])}."}
              for k in data if k not in ALLOWED[kind]]
    if not str(data.get("label") or "").strip():
        errors.append({"line": None, "message": "It needs a label: the name people pick it by."})
    try:
        if kind == "credential":
            fields, template, inject, http_test = credential_types.validate_definition(
                data.get("fields") or [], data.get("output_template"), data.get("inject"), data.get("http_test"))
            data.update(fields=fields, output_template=template, inject=inject, http_test=http_test)
        else:
            data["fields"] = [f for f in connections.type_fields(
                [f for f in data.get("fields") or [] if isinstance(f, dict) and f.get("key") != "base_url"]
            ) if f["key"] != "base_url"]
    except (credential_types.CredentialTypeError, connections.ConnectionConfigError) as e:
        errors.append({"line": _where(text, data, str(e), ("output_template", "inject", "http_test", "fields")),
                       "message": str(e)})
    except (TypeError, AttributeError):
        errors.append({"line": _line(text, "fields"), "message": "fields is a list: one mapping per field."})
    if errors:
        raise TypeDefError(errors)
    return {k: v for k, v in data.items() if k in ALLOWED[kind]}


def check(kind: str, text: str) -> list[dict]:
    try:
        parse(kind, text)
    except TypeDefError as e:
        return e.errors
    return []


def read(db: Session, kind: str, type_id: str) -> Optional[dict]:
    row = db.get(MODELS[kind], type_id)
    return {"kind": kind, "id": type_id, "source": source_of(kind, row), "builtin": bool(row.builtin)} if row else None


def reference(db: Session, kind: str) -> dict:
    """What a type's definition may say, generated from what the check holds
    it to -- never hand-written docs that drift from it."""
    existing = db.query(MODELS[kind]).order_by(MODELS[kind].id).all()
    common = {
        "kind": kind,
        "what": f"A {NOUNS[kind]}: its YAML, the file the store keeps. Its id is the editor's (or open_draft's "
                "new_id), never changed once saved; a pane names a connection type by it.",
        "existing": {r.id: r.label for r in existing},
        "read": f'read_definition("{kind}", "<id>") shows any of them, built-ins included -- the closest is the '
                "best start.",
    }
    if kind == "connection":
        return {**common, "definition": {
            "label": "the name people pick it by (required)",
            "description": "what connections of this type reach",
            "fields": "plain settings every connection of it has, beside the Base URL that is always first: a list "
                      "of {key: lowercase_name, label, required: true|false, help}. Never a secret -- a secret is "
                      "a credential, and a connection is signed with any credential type that has `inject`.",
        }, "rules": [
            "A pane, step or workflow reaches it with an input of type connection (or connections) whose "
            "connection_type is its id; its requests are joined to the connection's Base URL.",
            "Fields are plain text; removing one a connection holds a value for is refused.",
        ]}
    return {**common, "definition": {
        "label": "the name people pick it by (required)",
        "description": "what it signs in to",
        "fields": "the values a credential of it holds: a list of {key, label, kind, secret, required, help, "
                  f"default, choices}}; kind is one of {', '.join(credential_types.FIELD_KINDS)}; a secret field "
                  "is never shown again once saved and has no default; choices only for kind choice.",
        "output_template": "CEL over the field keys: what a pane or step receives from a credential of it (empty: "
                           "an object of the fields)",
        "inject": "how it signs an HTTP request: {kind: header, name: Authorization, value: '\"Bearer \" + token'}, "
                  "{kind: query, name: api_key, value: key}, or {kind: basic, username: user, password: password} "
                  "-- name/value/username/password are CEL over the field keys (text in double quotes)",
        "http_test": "a request that proves a credential works: {method: GET, url: CEL, headers: {name: CEL}}; "
                     "any 2xx passes",
    }, "rules": [
        "Mark every secret secret: true -- a key, a token, a password. A secret can never be made public later.",
        "A connection of an HTTP type is signed with the credential its group chose; `inject` is what makes a "
        "credential type usable for that.",
        "Once a credential uses a builder's type, only an admin changes it: get it right before it's used.",
    ]}


# ---------------------------------------------------------------- what a definition needs (D159)


def _named(kind: str, data: Any) -> list[tuple[str, tuple]]:
    """The connection types a pane's, step's or workflow's YAML names, each
    with its path: an input's (a pane's, a step's) or a parameter's (a
    workflow's) connection_type."""
    if not isinstance(data, dict):
        return []
    where = "parameters" if kind == "workflow" else "inputs"
    out = []
    for i, item in enumerate(data.get(where) or []):
        if isinstance(item, dict) and item.get("type") in ("connection", "connections") and item.get("connection_type"):
            out.append((str(item["connection_type"]), (where, i, "connection_type")))
    return out


def needs(db: Session, kind: str, source: str) -> list[dict]:
    """The connection types a definition reaches, each said there or not:
    the editor's "Needs" line, its missing ones with "Make it"."""
    try:
        data = yaml.safe_load(source) if source.strip() else None
    except yaml.YAMLError:
        return []
    seen: dict[str, dict] = {}
    for type_id, _path in _named(kind, data):
        if type_id not in seen:
            row = db.get(models.ConnectionType, type_id)
            seen[type_id] = {"kind": "connection", "id": type_id, "label": row.label if row else None,
                             "exists": row is not None}
    return list(seen.values())


def missing_errors(db: Session, kind: str, source: str) -> list[dict]:
    """Check's say on a connection type that isn't there: it used to pass
    Check and fail only when the pane was used."""
    try:
        data = yaml.safe_load(source) if source.strip() else None
    except yaml.YAMLError:
        return []
    from .workflows import _line as line_of

    return [{"line": line_of(source, path),
             "message": f"There's no connection type '{type_id}' yet: make it in the Builder's Connections (or "
                        "name one that's there)."}
            for type_id, path in _named(kind, data) if db.get(models.ConnectionType, type_id) is None]


def same(kind: str, a: str, b: str) -> bool:
    """Whether two texts define the same type: the browser's YAML and the
    store's aren't written alike (key order, quoting, a form's own field
    shape), so a draft of a type is compared by what it means."""
    try:
        return parse(kind, a) == parse(kind, b)
    except TypeDefError:
        return a == b
