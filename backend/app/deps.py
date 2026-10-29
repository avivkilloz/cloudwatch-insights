"""A definition's dependencies (PLATFORM_PLAN.md §25, D141-D143): its
`requirements.txt`, locked by Check and Save into `requirements.lock` -- both
files of its workspace, so the store and a plugin carry them as they carry
the code.

The lock is uv's (`pip compile --universal --generate-hashes`, wheels only):
every package pinned with the hashes of its wheels, for any platform, so what
was saved runs with the same packages anywhere. Its first line names the
requirements it came from; a lock that doesn't match them doesn't check, and
one that does is never locked again -- a newer release upstream doesn't move
a saved definition.

Only names are taken from requirements.txt -- no options, URLs or paths --
since uv runs here, in the backend: `-r /etc/passwd` or an index of the
writer's choosing would be this process reading or fetching for them.

Config: `DEPS_INDEX_URL` (PyPI's simple index by default; an admin's own
mirror otherwise) and `DEPS_PYTHON_VERSION` (the runner's Python, 3.12)."""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import subprocess
import tempfile
import threading
from collections import OrderedDict
from typing import Optional

from . import masking

REQUIREMENTS = "requirements.txt"
LOCK = "requirements.lock"
NAMES = (REQUIREMENTS, LOCK)

# What a code pane's or step's requirements.txt starts as: there from the
# first .py on, so where packages go is plain to whoever writes the code --
# a person or a model, which otherwise imported packages nothing installed.
# Comments only, so nothing is locked and no venv is made until it names one.
HINT = "# A package a line, as pip reads it (requests>=2.31). Check and Save lock it.\n"


def with_requirements(before: dict[str, str], after: dict[str, str]) -> dict[str, str]:
    """`after`, with a requirements.txt holding only the hint when its first
    Python file was just added and it has none."""
    if REQUIREMENTS in after or any(n.endswith(".py") for n in before) or not any(n.endswith(".py") for n in after):
        return after
    return {**after, REQUIREMENTS: HINT}


MAX_REQUIREMENTS = 100
MAX_BYTES = 20_000
LOCK_SECONDS = 120
HASH_RE = re.compile(r"--hash=sha256:([0-9a-f]{64})")
_HEADER = "# Locked by the platform from requirements.txt ({}): Check or Save locks it again when that changes."
_HEADER_RE = re.compile(r"^# Locked by the platform from requirements\.txt \(sha256:([0-9a-f]{64})\)")

# What reaching the index needs from this process's environment, and nothing
# else of it (a UV_ variable could point uv at another index or config).
_PASSED = ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy",
           "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", "UV_SYSTEM_CERTS", "UV_NATIVE_TLS")


class DepsError(Exception):
    """Requirements that can't be locked, each problem as {file, line, message}."""

    def __init__(self, message: str, errors: Optional[list[dict]] = None):
        super().__init__(message)
        self.errors = errors or [{"file": REQUIREMENTS, "line": None, "message": message}]


def index_url() -> str:
    return (os.environ.get("DEPS_INDEX_URL") or "https://pypi.org/simple").rstrip("/") + "/"


def python_version() -> str:
    return os.environ.get("DEPS_PYTHON_VERSION") or "3.12"


def cache_dir() -> str:
    """Where uv works and the index keeps its wheels: a volume of the
    backend's own in a cluster."""
    path = os.environ.get("DEPS_CACHE_DIR") or os.path.join(tempfile.gettempdir(), "deps")
    os.makedirs(path, exist_ok=True)
    return path


def _lines(text: str) -> list[tuple[int, str]]:
    """The requirement lines, each with its line number: comments and blanks gone."""
    out = []
    for n, raw in enumerate(text.splitlines(), 1):
        line = re.sub(r"(^|\s)#.*$", "", raw).strip()
        if line:
            out.append((n, line))
    return out


def requirement_lines(text: str) -> list[str]:
    return [line for _, line in _lines(text)]


def requirements_hash(text: str) -> str:
    """What a lock is of: the requirements without comments or blank lines, so
    a comment doesn't make the lock stale."""
    return "sha256:" + hashlib.sha256("\n".join(line for _, line in _lines(text)).encode()).hexdigest()


def requirement_problems(text: str) -> list[tuple[Optional[int], str]]:
    """What's wrong with a requirements.txt, each with its line."""
    from packaging.requirements import InvalidRequirement, Requirement

    if len(text.encode()) > MAX_BYTES:
        return [(None, f"requirements.txt is over {MAX_BYTES // 1000} kB.")]
    lines = _lines(text)
    if len(lines) > MAX_REQUIREMENTS:
        return [(None, f"requirements.txt names at most {MAX_REQUIREMENTS} packages.")]
    out: list[tuple[Optional[int], str]] = []
    for n, line in lines:
        if line.startswith("-"):
            out.append((n, f"{line.split()[0]} isn't taken here: a line names a package (requests>=2.31), and the "
                           "platform says where packages come from."))
            continue
        try:
            req = Requirement(line)
        except InvalidRequirement as e:
            out.append((n, f"It isn't a requirement pip reads: {e}."))
            continue
        if req.url:
            out.append((n, f"{req.name} is named with a URL; a line names a package and its versions only."))
    return out


def lock_hashes(lock: str) -> set[str]:
    return set(HASH_RE.findall(lock or ""))


def is_fresh(requirements: str, lock: Optional[str]) -> bool:
    if not lock:
        return False
    first = lock.splitlines()[0] if lock.strip() else ""
    found = _HEADER_RE.match(first)
    return bool(found) and "sha256:" + found.group(1) == requirements_hash(requirements) and bool(lock_hashes(lock))


def problems(files: dict[str, str]) -> list[tuple[str, Optional[int], str]]:
    """What's wrong with a definition's requirements and lock, each as (file,
    line, message) -- the shape `runner_client.file_problems` reports in."""
    requirements, lock = files.get(REQUIREMENTS), files.get(LOCK)
    out: list[tuple[str, Optional[int], str]] = []
    if requirements is not None:
        out += [(REQUIREMENTS, line, message) for line, message in requirement_problems(requirements)]
        if not out and _lines(requirements) and not is_fresh(requirements, lock):
            out.append((LOCK, None, "requirements.lock isn't the lock of requirements.txt as it is now: Check or Save "
                                    "locks it again."))
    elif lock is not None:
        out.append((LOCK, None, "requirements.lock has no requirements.txt beside it: remove it, or add that."))
    return out


def _uv() -> str:
    try:
        from uv import find_uv_bin

        return find_uv_bin()
    except (ImportError, FileNotFoundError):
        pass
    found = shutil.which("uv")
    if not found:
        raise DepsError("uv isn't installed beside the backend, so requirements can't be locked here: ask an admin.")
    return found


_cache: "OrderedDict[tuple[str, str], str]" = OrderedDict()
_cache_lock = threading.Lock()


def _hidden(text: str, index: str) -> str:
    # A private index's URL may carry its credentials.
    return masking.mask(text.replace(index.rstrip("/"), "<the package index>"))


def lock(requirements: str) -> str:
    """The lock of `requirements`, made with uv against the index (kept, so
    the same requirements are locked once per process)."""
    found = requirement_problems(requirements)
    if found:
        raise DepsError(found[0][1], [{"file": REQUIREMENTS, "line": line, "message": message}
                                      for line, message in found])
    key = (requirements_hash(requirements), index_url())
    with _cache_lock:
        if key in _cache:
            _cache.move_to_end(key)
            return _cache[key]
    index = index_url()
    env = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "UV_NO_CONFIG": "1", "UV_PYTHON_DOWNLOADS": "never",
           **{k: os.environ[k] for k in _PASSED if k in os.environ}}
    with tempfile.TemporaryDirectory(prefix="lock-", dir=cache_dir()) as work:
        env["HOME"] = work
        # No cache kept between locks: what's locked is kept here, by its
        # requirements, and a uv cache would only grow.
        env["UV_NO_CACHE"] = "1"
        with open(os.path.join(work, REQUIREMENTS), "w") as f:
            f.write("\n".join(line for _, line in _lines(requirements)) + "\n")
        try:
            done = subprocess.run(
                [_uv(), "pip", "compile", REQUIREMENTS, "--universal", "--generate-hashes", "--no-header",
                 "--only-binary", ":all:", "--python-version", python_version(), "--index-url", index, "--quiet"],
                cwd=work, env=env, capture_output=True, text=True, timeout=LOCK_SECONDS,
            )
        except subprocess.TimeoutExpired:
            raise DepsError(f"Locking requirements.txt took more than {LOCK_SECONDS} s.") from None
    if done.returncode != 0:
        said = "\n".join(line for line in (done.stderr or done.stdout).strip().splitlines()
                         if not line.startswith("warning:"))
        raise DepsError("requirements.txt couldn't be locked: " + (_hidden(said[-1500:], index) or
                                                                   f"uv exited with {done.returncode}."))
    text = _HEADER.format(key[0]) + "\n" + done.stdout.lstrip()
    with _cache_lock:
        _cache[key] = text
        while len(_cache) > 64:
            _cache.popitem(last=False)
    return text


def locked(files: dict[str, str]) -> dict[str, str]:
    """`files` with a lock that matches its requirements: locked now if it
    doesn't, the lock dropped when there are no requirements. Raises
    DepsError, with each problem, when they can't be."""
    files = dict(files or {})
    requirements = files.get(REQUIREMENTS)
    if requirements is None or not _lines(requirements):
        files.pop(LOCK, None)
        return files
    if is_fresh(requirements, files.get(LOCK)):
        return files
    files[LOCK] = lock(requirements)
    return files


def merged(lock_errors: list[dict], errors: list[dict]) -> list[dict]:
    """A check's problems after locking: requirements that couldn't be locked
    leave the old lock stale, so that is said once (why), not twice."""
    if not lock_errors:
        return errors
    said = {(e.get("file"), e.get("line"), e.get("message")) for e in lock_errors}
    return lock_errors + [e for e in errors if e.get("file") != LOCK and
                          (e.get("file"), e.get("line"), e.get("message")) not in said]
