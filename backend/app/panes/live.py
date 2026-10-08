"""The Python twins of the live functions (PLATFORM_PLAN.md D43).

A live pane works its outputs out in the browser as you type, with the
TypeScript in `frontend/src/panes/live.ts`. These compute the same outputs
from the same inputs, so the agent -- and later a workflow step -- can run
the pane too. `tests/test_pane_manifests.py` holds the two to the same
answers on shared fixtures (`tests/fixtures/live_functions.json`, which the
browser suite reads as well).

Each takes the pane's inputs and returns its outputs, by the manifest's
output keys; an output left out has nothing to show.
"""

import base64
import difflib
import hashlib
import hmac
import json
import re
from typing import Any, Callable

LiveFunction = Callable[[dict[str, Any]], dict[str, Any]]


def base64_convert(inputs: dict[str, Any]) -> dict[str, Any]:
    text = inputs.get("input") or ""
    if not text:
        return {}
    if (inputs.get("mode") or "encode") == "encode":
        out = base64.b64encode(text.encode("utf-8")).decode("ascii")
        if inputs.get("urlSafe"):
            out = out.replace("+", "-").replace("/", "_").rstrip("=")
        return {"output": out}
    normalized = text.strip().replace("-", "+").replace("_", "/")
    try:
        raw = base64.b64decode(normalized + "=" * (-len(normalized) % 4), validate=True)
    except ValueError:
        return {"error": "That doesn't look like valid Base64."}
    return {"output": raw.decode("utf-8", errors="replace")}


def _tokens(text: str) -> list[str]:
    """Lines with their newlines, as the browser's `diffLines` compares them:
    a last line without one differs from the same line with one."""
    return re.findall(r"[^\n]*\n|[^\n]+$", text)


def _strip(token: str) -> str:
    return token[:-1] if token.endswith("\n") else token


def diff_compute(inputs: dict[str, Any]) -> dict[str, Any]:
    """Rows of equal / modify / remove / add lines, as the diff component
    draws them, and the counts line above it. A run of removed lines next to
    added ones pairs up index-wise into "modify" rows, like a side-by-side
    view (DiffTool's buildDiffRows)."""
    left = inputs.get("left") or ""
    right = inputs.get("right") or ""
    if not left and not right:
        return {}
    a, b = _tokens(left), _tokens(right)
    rows: list[dict[str, Any]] = []
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(a=a, b=b, autojunk=False).get_opcodes():
        if tag == "equal":
            rows += [{"type": "equal", "left": _strip(t), "right": _strip(t)} for t in a[i1:i2]]
            continue
        removed, added = [_strip(t) for t in a[i1:i2]], [_strip(t) for t in b[j1:j2]]
        pairs = min(len(removed), len(added))
        rows += [{"type": "modify", "left": removed[k], "right": added[k]} for k in range(pairs)]
        rows += [{"type": "remove", "left": line} for line in removed[pairs:]]
        rows += [{"type": "add", "right": line} for line in added[pairs:]]
    removals = sum(1 for r in rows if r["type"] in ("remove", "modify"))
    additions = sum(1 for r in rows if r["type"] in ("add", "modify"))
    out: dict[str, Any] = {"diff": rows}
    if removals or additions:
        out["counts"] = (
            f"{removals} removal{'' if removals == 1 else 's'}, {additions} addition{'' if additions == 1 else 's'}"
        )
    return out


_HASH = {"HS256": hashlib.sha256, "HS384": hashlib.sha384, "HS512": hashlib.sha512}


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _b64url_decode(segment: str) -> bytes:
    return base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4))


def _hmac(alg: str, secret: str, signing_input: str) -> str:
    return _b64url(hmac.new(secret.encode("utf-8"), signing_input.encode("utf-8"), _HASH[alg]).digest())


def jwt_decode(inputs: dict[str, Any]) -> dict[str, Any]:
    token = (inputs.get("token") or "").strip()
    if not token:
        return {}
    parts = token.split(".")
    if len(parts) < 2:
        return {"decodeError": "Not a JWT -- expected at least a header and payload segment separated by '.'."}
    try:
        return {
            "decodedHeader": json.loads(_b64url_decode(parts[0])),
            "decodedPayload": json.loads(_b64url_decode(parts[1])),
        }
    except (ValueError, UnicodeDecodeError) as e:
        return {"decodeError": f"Could not decode header/payload: {e}"}


def jwt_verify(inputs: dict[str, Any]) -> dict[str, Any]:
    secret = inputs.get("verifySecret") or ""
    if not secret:
        return {}
    decoded = jwt_decode(inputs)
    header = decoded.get("decodedHeader")
    parts = (inputs.get("token") or "").strip().split(".")
    if not isinstance(header, dict) or not header.get("alg") or len(parts) != 3:
        return {"verified": "unknown"}
    if header["alg"] not in _HASH:
        return {"verified": "unsupported"}
    expected = _hmac(header["alg"], secret, f"{parts[0]}.{parts[1]}")
    return {"verified": "valid" if hmac.compare_digest(expected, parts[2]) else "invalid"}


def jwt_sign(inputs: dict[str, Any]) -> dict[str, Any]:
    alg = inputs.get("alg") or "HS256"
    try:
        header = json.loads(inputs.get("header") or "{}")
        payload = json.loads(inputs.get("payload") or "{}")
    except ValueError as e:
        return {"signError": str(e)}

    def segment(value: Any) -> str:
        return _b64url(json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))

    signing_input = f"{segment(header)}.{segment(payload)}"
    return {"signed": f"{signing_input}.{_hmac(alg, inputs.get('secret') or '', signing_input)}"}


FUNCTIONS: dict[str, LiveFunction] = {
    "base64.convert": base64_convert,
    "diff.compute": diff_compute,
    "jwt.decode": jwt_decode,
    "jwt.verify": jwt_verify,
    "jwt.sign": jwt_sign,
}
