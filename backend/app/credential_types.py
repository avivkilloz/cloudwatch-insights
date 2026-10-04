"""Credential types: what a kind of secret looks like (PLATFORM_PLAN.md §13.3).

A type is data -- a list of fields, each public or secret -- so an admin can
define one in the UI for their own pane, from a pasted JSON example, without
a release. The built-ins below are seeded rows of exactly that shape
(`ensure_builtins`), locked, plus the few checks that need code.

Three optional parts are written in CEL (PLATFORM_PLAN.md D8), evaluated over
the fields, never Python: CEL has no loops, no side effects and no access to
anything but the values it is handed, so an admin-written template is as
safe to run as a built-in one.

- `output_template`: the JSON a consumer receives, when the flat object of
  fields isn't the shape it wants.
- `inject`: how a credential of this type authenticates an HTTP request.
- `http_test`: a request that checks a credential works, sent through the
  same SSRF guard as the HTTP client tool.
"""

import base64
import binascii
import datetime
import functools
import hashlib
import json
import os
import re
from typing import Any, Optional
from urllib.parse import urlencode, urlparse, urlunparse

from cel_expr_python import cel
from sqlalchemy.orm import Session

from . import models

FIELD_KINDS = ("text", "multiline", "number", "bool", "choice", "json", "file")
MAX_FIELDS = 50
MAX_TEXT = 65_536
# PLATFORM_PLAN.md D28: until the blob store exists, a secret file lives in
# the credential's own ciphertext, in Postgres.
MAX_FILE_BYTES = 1024 * 1024

_KEY_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
TYPE_ID_RE = re.compile(r"^[a-z][a-z0-9_]{1,63}$")
# Words CEL reserves, plus `fields`, which every expression gets as the map
# of all values -- a field can't be named after any of them.
_RESERVED = {
    "true", "false", "null", "in", "as", "break", "const", "continue", "else", "for", "function", "if",
    "import", "let", "loop", "package", "namespace", "return", "var", "void", "while", "fields",
}
_SECRET_NAME_RE = re.compile(r"pass|secret|token|private|credential|pwd|apikey|api_key")
HTTP_METHODS = ("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS")


class CredentialTypeError(ValueError):
    """A type definition, or a value for one, that can't be accepted -- with a
    message an admin can act on."""


# ------------------------------------------------------------------- CEL


@functools.lru_cache(maxsize=512)
def _compiled(keys: tuple[str, ...], expression: str):
    variables = {key: cel.Type.DYN for key in keys}
    variables["fields"] = cel.Type.Map(cel.Type.STRING, cel.Type.DYN)
    env = cel.NewEnv(variables=variables)
    try:
        return env.compile(expression)
    except RuntimeError as e:
        raise CredentialTypeError(f"The expression `{expression}` doesn't compile: {_cel_message(str(e))}") from None


def _cel_message(raw: str) -> str:
    # "INVALID_ARGUMENT: ERROR: <input>:1:7: Syntax error: ..." -> the useful part.
    raw = raw.split("ERROR: <input>:", 1)[-1]
    return raw.split("\n", 1)[0].strip()


def check_expression(keys: list[str], expression: str) -> None:
    _compiled(tuple(sorted(keys)), expression)


def evaluate(keys: list[str], expression: str, values: dict[str, Any]) -> Any:
    data = {key: values.get(key) for key in keys}
    data["fields"] = {k: v for k, v in data.items() if v is not None}
    result = _compiled(tuple(sorted(keys)), expression).eval(data=data)
    if result.type() == cel.Type.ERROR:
        raise CredentialTypeError(f"`{expression}` failed: {result.plain_value()}")
    return result.plain_value()


# ------------------------------------------------------------------- definitions


def validate_fields(fields: Any) -> list[dict]:
    """The field list, normalised, or a CredentialTypeError saying what's wrong."""
    if not isinstance(fields, list) or not fields:
        raise CredentialTypeError("A credential type needs at least one field.")
    if len(fields) > MAX_FIELDS:
        raise CredentialTypeError(f"A credential type can have at most {MAX_FIELDS} fields.")
    out: list[dict] = []
    seen: set[str] = set()
    for raw in fields:
        if not isinstance(raw, dict):
            raise CredentialTypeError("Each field must be an object with at least a key and a kind.")
        key = str(raw.get("key") or "")
        if not _KEY_RE.match(key):
            raise CredentialTypeError(
                f"'{key}' isn't a valid field key: start with a lowercase letter, then lowercase letters, digits "
                "or _ (at most 64)."
            )
        if key in _RESERVED:
            raise CredentialTypeError(f"'{key}' is a reserved word in expressions; choose another key.")
        if key in seen:
            raise CredentialTypeError(f"Two fields have the key '{key}'.")
        seen.add(key)
        kind = raw.get("kind") or "text"
        if kind not in FIELD_KINDS:
            raise CredentialTypeError(f"Field '{key}' has kind '{kind}'; the kinds are {', '.join(FIELD_KINDS)}.")
        field = {
            "key": key,
            "label": str(raw.get("label") or key.replace("_", " ").capitalize())[:100],
            "kind": kind,
            "secret": bool(raw.get("secret", False)),
            "required": bool(raw.get("required", False)),
            "help": str(raw.get("help") or "")[:500],
        }
        if kind == "choice":
            choices = raw.get("choices")
            if not isinstance(choices, list) or not choices or not all(isinstance(c, str) and c for c in choices):
                raise CredentialTypeError(f"Field '{key}' is a choice, so it needs a list of choices.")
            field["choices"] = choices
        default = raw.get("default")
        if default not in (None, ""):
            if field["secret"]:
                raise CredentialTypeError(f"Field '{key}' is secret, so it can't have a default (a default is visible).")
            field["default"] = convert_value(field, default)
        out.append(field)
    return out


def validate_definition(
    fields: Any, output_template: Optional[str], inject: Any, http_test: Any
) -> tuple[list[dict], Optional[str], Optional[dict], Optional[dict]]:
    fields = validate_fields(fields)
    keys = [f["key"] for f in fields]
    template = (output_template or "").strip() or None
    if template:
        check_expression(keys, template)
    return fields, template, _validate_inject(inject, keys), _validate_http_test(http_test, keys)


def _validate_inject(inject: Any, keys: list[str]) -> Optional[dict]:
    if not inject:
        return None
    if not isinstance(inject, dict) or inject.get("kind") not in ("header", "basic", "query"):
        raise CredentialTypeError("inject needs a kind: header, basic or query.")
    kind = inject["kind"]
    if kind == "basic":
        out = {"kind": "basic", "username": str(inject.get("username") or ""), "password": str(inject.get("password") or "")}
        for part in ("username", "password"):
            if not out[part]:
                raise CredentialTypeError(f"Basic authentication needs a {part} expression (usually just the field's key).")
            check_expression(keys, out[part])
        return out
    name, name_from = str(inject.get("name") or ""), str(inject.get("name_from") or "")
    if not name and not name_from:
        raise CredentialTypeError(f"A {kind} injection needs the {kind}'s name (or name_from, a field holding it).")
    if name_from and name_from not in keys:
        raise CredentialTypeError(f"name_from is '{name_from}', which isn't one of this type's fields.")
    value = str(inject.get("value") or "")
    if not value:
        raise CredentialTypeError(f"A {kind} injection needs a value expression, e.g. \"Bearer \" + token.")
    check_expression(keys, value)
    out = {"kind": kind, "value": value}
    out["name_from" if name_from else "name"] = name_from or name
    return out


def _validate_http_test(test: Any, keys: list[str]) -> Optional[dict]:
    if not test:
        return None
    if not isinstance(test, dict) or not test.get("url"):
        raise CredentialTypeError("http_test needs at least a url expression.")
    method = str(test.get("method") or "GET").upper()
    if method not in HTTP_METHODS:
        raise CredentialTypeError(f"http_test's method must be one of {', '.join(HTTP_METHODS)}.")
    check_expression(keys, str(test["url"]))
    headers = test.get("headers") or {}
    if not isinstance(headers, dict):
        raise CredentialTypeError("http_test's headers must map header names to expressions.")
    for expression in headers.values():
        check_expression(keys, str(expression))
    return {"method": method, "url": str(test["url"]), "headers": {str(k): str(v) for k, v in headers.items()}}


# ------------------------------------------------------------------- values


def convert_value(field: dict, value: Any) -> Any:
    """A value for `field` in the shape it is stored in, or CredentialTypeError."""
    key, kind = field["key"], field["kind"]
    if kind in ("text", "multiline"):
        if not isinstance(value, str):
            raise CredentialTypeError(f"'{field['label']}' must be text.")
        if len(value) > MAX_TEXT:
            raise CredentialTypeError(f"'{field['label']}' is longer than {MAX_TEXT} characters.")
        return value
    if kind == "number":
        if isinstance(value, bool):
            raise CredentialTypeError(f"'{field['label']}' must be a number.")
        if isinstance(value, (int, float)):
            return value
        try:
            return float(value) if "." in str(value) else int(value)
        except (TypeError, ValueError):
            raise CredentialTypeError(f"'{field['label']}' must be a number.") from None
    if kind == "bool":
        if not isinstance(value, bool):
            raise CredentialTypeError(f"'{field['label']}' must be true or false.")
        return value
    if kind == "choice":
        if value not in field.get("choices", []):
            raise CredentialTypeError(f"'{field['label']}' must be one of {', '.join(field.get('choices', []))}.")
        return value
    if kind == "json":
        if isinstance(value, str):
            try:
                return json.loads(value)
            except ValueError as e:
                raise CredentialTypeError(f"'{field['label']}' isn't valid JSON: {e}.") from None
        return value
    if kind == "file":
        if not isinstance(value, str):
            raise CredentialTypeError(f"'{field['label']}' must be the file's content, base64-encoded.")
        try:
            size = len(base64.b64decode(value, validate=True))
        except (binascii.Error, ValueError):
            raise CredentialTypeError(f"'{field['label']}' isn't valid base64.") from None
        if size > MAX_FILE_BYTES:
            raise CredentialTypeError(f"'{field['label']}' is {size} bytes; files are limited to 1 MiB for now.")
        return value
    raise CredentialTypeError(f"Field '{key}' has an unknown kind.")


def split_values(fields: list[dict], values: dict) -> tuple[dict, dict]:
    """Converts `values` field by field and splits them into the public and
    the secret ones. Unknown keys are refused, so a typo isn't stored as a
    field nobody can see."""
    by_key = {f["key"]: f for f in fields}
    unknown = [k for k in values if k not in by_key]
    if unknown:
        raise CredentialTypeError(f"This type has no field {', '.join(sorted(unknown))}.")
    public, secret = {}, {}
    for key, value in values.items():
        field = by_key[key]
        if value is None or (value == "" and field["kind"] not in ("text", "multiline")):
            continue
        if value == "" and field["secret"]:
            continue  # an empty secret means "leave it as it is"
        (secret if field["secret"] else public)[key] = convert_value(field, value)
    return public, secret


def missing_required(fields: list[dict], public: dict, secret_keys: set[str]) -> list[str]:
    return [
        f["label"]
        for f in fields
        if f["required"] and (f["key"] not in secret_keys if f["secret"] else public.get(f["key"]) in (None, ""))
    ]


def render(type_row: models.CredentialType, values: dict) -> Any:
    """What a consumer receives: the output template's result, or the flat
    object of fields (defaults filled in) when there is none."""
    fields = type_row.fields
    full = {f["key"]: values.get(f["key"], f.get("default")) for f in fields}
    if not type_row.output_template:
        return {k: v for k, v in full.items() if v is not None}
    return evaluate([f["key"] for f in fields], type_row.output_template, full)


def apply_inject(
    type_row: models.CredentialType, values: dict, url: str, headers: dict[str, str]
) -> tuple[str, dict[str, str]]:
    """`url` and `headers` with this credential's authentication added."""
    inject = type_row.inject
    if not inject:
        raise CredentialTypeError(f"Credentials of type '{type_row.label}' don't say how to authenticate a request.")
    keys = [f["key"] for f in type_row.fields]
    full = {f["key"]: values.get(f["key"], f.get("default")) for f in type_row.fields}
    headers = dict(headers)
    if inject["kind"] == "basic":
        user = str(evaluate(keys, inject["username"], full))
        password = str(evaluate(keys, inject["password"], full))
        headers["Authorization"] = "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode()
        return url, headers
    name = inject.get("name") or str(full.get(inject.get("name_from"), "") or "")
    if not name:
        raise CredentialTypeError("The field naming the header or parameter is empty.")
    value = str(evaluate(keys, inject["value"], full))
    if inject["kind"] == "header":
        headers[name] = value
        return url, headers
    parsed = urlparse(url)
    query = parsed.query + ("&" if parsed.query else "") + urlencode({name: value})
    return urlunparse(parsed._replace(query=query)), headers


# ------------------------------------------------------------------- inferring a type from an example


def infer(example: Any) -> dict:
    """The "paste an example" shortcut: one field per value of `example`
    (nested objects flattened into `parent_child` keys), a guess at which are
    secret, non-secret values as defaults -- and, when the keys had to change
    to be valid or the example was nested, an output template that rebuilds
    the original shape, so a consumer still receives exactly what was pasted."""
    if not isinstance(example, dict) or not example:
        raise CredentialTypeError("Paste a JSON object, e.g. {\"username\": \"\", \"password\": \"\"}.")
    fields: list[dict] = []
    used: set[str] = set()
    reshaped = False

    def key_for(path: list[str]) -> str:
        nonlocal reshaped
        raw = "_".join(path)
        key = re.sub(r"[^a-z0-9_]", "_", re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", raw).lower()).strip("_")
        if not key or not key[0].isalpha():
            key = "f_" + key
        if key in _RESERVED:
            key += "_value"
        key = key[:64]
        base, n = key, 2
        while key in used:
            key = f"{base}_{n}"[:64]
            n += 1
        used.add(key)
        if key != raw:
            reshaped = True
        return key

    def walk(obj: dict, path: list[str], depth: int) -> str:
        nonlocal reshaped
        parts = []
        for name, value in obj.items():
            here = [*path, str(name)]
            if isinstance(value, dict) and value and depth < 3:
                reshaped = True
                parts.append(f"{json.dumps(str(name))}: {walk(value, here, depth + 1)}")
                continue
            key = key_for(here)
            secret = bool(_SECRET_NAME_RE.search(key))
            if isinstance(value, bool):
                kind = "bool"
            elif isinstance(value, (int, float)):
                kind = "number"
            elif isinstance(value, (dict, list)):
                kind = "json"
            else:
                kind = "multiline" if isinstance(value, str) and "\n" in value else "text"
            field = {"key": key, "label": str(name), "kind": kind, "secret": secret, "required": True}
            if not secret and value not in (None, "", [], {}):
                field["default"] = value if kind != "json" else json.dumps(value)
                field["required"] = False
            fields.append(field)
            parts.append(f"{json.dumps(str(name))}: {key}")
        return "{" + ", ".join(parts) + "}"

    template = walk(example, [], 0)
    fields = validate_fields(fields)
    return {"fields": fields, "output_template": template if reshaped else None}


# ------------------------------------------------------------------- checks


def _check_json(values: dict) -> tuple[bool, str]:
    value = values.get("value")
    described = f"an object with {len(value)} keys" if isinstance(value, dict) else type(value).__name__
    return True, f"Valid JSON ({described})."


def _check_ssh_key(values: dict) -> tuple[bool, str]:
    from cryptography.hazmat.primitives import serialization

    data = str(values.get("private_key") or "").encode()
    password = str(values["passphrase"]).encode() if values.get("passphrase") else None
    try:
        try:
            key = serialization.load_ssh_private_key(data, password=password)
        except ValueError:
            key = serialization.load_pem_private_key(data, password=password)
    except (ValueError, TypeError) as e:
        return False, f"The private key doesn't load: {e}"
    public = key.public_key().public_bytes(serialization.Encoding.OpenSSH, serialization.PublicFormat.OpenSSH)
    kind, blob = public.split()[:2]
    digest = base64.b64encode(hashlib.sha256(base64.b64decode(blob)).digest()).decode().rstrip("=")
    return True, f"{kind.decode()} key, SHA256:{digest}"


def _check_certificate(values: dict) -> tuple[bool, str]:
    from cryptography import x509
    from cryptography.hazmat.primitives import serialization

    try:
        cert = x509.load_pem_x509_certificate(str(values.get("certificate") or "").encode())
    except ValueError as e:
        return False, f"The certificate doesn't parse: {e}"
    password = str(values["passphrase"]).encode() if values.get("passphrase") else None
    try:
        key = serialization.load_pem_private_key(str(values.get("private_key") or "").encode(), password=password)
    except (ValueError, TypeError) as e:
        return False, f"The private key doesn't load: {e}"
    spki = (serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    if key.public_key().public_bytes(*spki) != cert.public_key().public_bytes(*spki):
        return False, "The private key doesn't belong to this certificate."
    expires = cert.not_valid_after_utc
    now = datetime.datetime.now(datetime.timezone.utc)
    subject = cert.subject.rfc4514_string()
    if expires < now:
        return False, f"{subject}: expired on {expires:%Y-%m-%d}."
    days = (expires - now).days
    warning = f" Expires in {days} days." if days <= 30 else ""
    return True, f"{subject}, valid until {expires:%Y-%m-%d}.{warning}"


def _check_aws_access_keys(values: dict) -> tuple[bool, str]:
    import boto3
    from botocore.exceptions import BotoCoreError, ClientError

    try:
        identity = boto3.client(
            "sts",
            aws_access_key_id=values.get("access_key_id"),
            aws_secret_access_key=values.get("secret_access_key"),
            aws_session_token=values.get("session_token") or None,
            region_name=os.environ.get("AWS_REGION") or "us-east-1",
        ).get_caller_identity()
    except ClientError as e:
        return False, e.response.get("Error", {}).get("Message") or str(e)
    except BotoCoreError as e:
        return False, str(e)
    return True, f"Account {identity.get('Account')}, {identity.get('Arn')}"


CHECKS = {
    "secret_json": _check_json,
    "ssh_key": _check_ssh_key,
    "certificate": _check_certificate,
    "aws_access_keys": _check_aws_access_keys,
}


def run_http_test(type_row: models.CredentialType, values: dict) -> tuple[bool, str]:
    from . import tools_http_client

    test = type_row.http_test
    keys = [f["key"] for f in type_row.fields]
    full = {f["key"]: values.get(f["key"], f.get("default")) for f in type_row.fields}
    url = str(evaluate(keys, test["url"], full))
    headers = {name: str(evaluate(keys, expr, full)) for name, expr in (test.get("headers") or {}).items()}
    if type_row.inject:
        url, headers = apply_inject(type_row, values, url, headers)
    try:
        response = tools_http_client.send_request(test["method"], url, headers=headers)
    except tools_http_client.ToolRequestError as e:
        return False, str(e)
    except Exception as e:  # noqa: BLE001 -- a network failure is a failed test, said plainly
        return False, f"The request failed: {e}"
    status = f"HTTP {response['status_code']} {response['status_text']}"
    return 200 <= response["status_code"] < 300, status


def test(type_row: models.CredentialType, values: dict) -> tuple[Optional[bool], str]:
    """(ok, message); ok is None when the type has no test at all."""
    check = CHECKS.get(type_row.id) if type_row.builtin else None
    if check is not None:
        return check(values)
    if type_row.http_test:
        return run_http_test(type_row, values)
    return None, "This type has no test."


# ------------------------------------------------------------------- built-ins


def _f(key: str, label: str, kind: str = "text", secret: bool = False, required: bool = False, **extra: Any) -> dict:
    return {"key": key, "label": label, "kind": kind, "secret": secret, "required": required, "help": "", **extra}


BUILTINS: list[dict] = [
    {
        "id": "secret_text",
        "label": "Secret text",
        "description": "One secret value: a password, a token, anything.",
        "fields": [_f("value", "Value", "multiline", secret=True, required=True)],
    },
    {
        "id": "secret_json",
        "label": "Secret JSON",
        "description": "A JSON document kept secret, e.g. a service account file.",
        "fields": [_f("value", "JSON", "json", secret=True, required=True)],
    },
    {
        "id": "secret_file",
        "label": "Secret file",
        "description": "A file kept secret (up to 1 MiB).",
        "fields": [_f("filename", "File name", required=True), _f("content", "File", "file", secret=True, required=True)],
    },
    {
        "id": "username_password",
        "label": "Username and password",
        "description": "A login. Authenticates HTTP requests with Basic authentication.",
        "fields": [_f("username", "Username", required=True), _f("password", "Password", secret=True, required=True)],
        "inject": {"kind": "basic", "username": "username", "password": "password"},
    },
    {
        "id": "api_token",
        "label": "API token",
        "description": "A token sent in a header, by default 'Authorization: Bearer <token>'.",
        "fields": [
            _f("token", "Token", secret=True, required=True),
            _f("header", "Header", default="Authorization"),
            _f("scheme", "Scheme", default="Bearer", help="Put before the token. Leave empty to send the token alone."),
        ],
        "inject": {"kind": "header", "name_from": "header", "value": 'scheme == null || scheme == "" ? token : scheme + " " + token'},
    },
    {
        "id": "ssh_key",
        "label": "SSH key",
        "description": "A private key, with its user name and passphrase.",
        "fields": [
            _f("username", "Username"),
            _f("private_key", "Private key", "multiline", secret=True, required=True),
            _f("passphrase", "Passphrase", secret=True),
        ],
    },
    {
        "id": "certificate",
        "label": "Certificate",
        "description": "A PEM certificate with its private key, e.g. for mutual TLS.",
        "fields": [
            _f("certificate", "Certificate (PEM)", "multiline", required=True),
            _f("private_key", "Private key (PEM)", "multiline", secret=True, required=True),
            _f("passphrase", "Passphrase", secret=True),
            _f("ca_chain", "CA chain (PEM)", "multiline"),
        ],
    },
    {
        "id": "aws_access_keys",
        "label": "AWS access keys",
        "description": "An access key pair, optionally with a session token.",
        "fields": [
            _f("access_key_id", "Access key ID", required=True),
            _f("secret_access_key", "Secret access key", secret=True, required=True),
            _f("session_token", "Session token", "multiline", secret=True),
        ],
    },
]
BUILTIN_IDS = {b["id"] for b in BUILTINS}


def ensure_builtins(db: Session) -> None:
    """Keeps the seeded built-in rows in step with BUILTINS: inserted when
    missing, updated (and their version bumped) when the code changed them."""
    for spec in BUILTINS:
        fields, template, inject, http_test = validate_definition(
            spec["fields"], spec.get("output_template"), spec.get("inject"), spec.get("http_test")
        )
        row = db.get(models.CredentialType, spec["id"])
        wanted = {
            "label": spec["label"],
            "description": spec.get("description"),
            "fields": fields,
            "output_template": template,
            "inject": inject,
            "http_test": http_test,
        }
        if row is None:
            db.add(models.CredentialType(id=spec["id"], version=1, builtin=True, **wanted))
            continue
        changed = {k: v for k, v in wanted.items() if getattr(row, k) != v}
        if changed:
            for k, v in changed.items():
                setattr(row, k, v)
            if "fields" in changed:
                row.version += 1
            row.builtin = True
            row.updated_at = datetime.datetime.utcnow()
    db.commit()
