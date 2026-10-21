"""Running a builder's code in the runner (PLATFORM_PLAN.md §25, D131-D135).

Each run is a `runner_jobs` row with a token of its own, minted here and
handed to the runner with the code: the code's calls back to the platform
(`routers/runner.py`) carry it, and act as the person running the code. The
token stops working when the job finishes. The backend never runs the code
itself; without `RUNNER_URL` it says so instead (D135).

Config: `RUNNER_URL` (the runner's service), `RUNNER_TOKEN` (the secret both
share) and `RUNNER_CALLBACK_URL` (how the runner's jobs reach this backend:
its service URL in a cluster)."""

from __future__ import annotations

import datetime
import hashlib
import os
import re
import secrets
import sys
from dataclasses import dataclass, field
from typing import Any, Optional

import httpx
from sqlalchemy.orm import Session

from . import masking, models

DEFAULT_TIMEOUT = 30
MAX_TIMEOUT = 120


class CodeError(Exception):
    """The code couldn't run, or failed: said so a builder can fix it."""

    def __init__(self, message: str, status: int = 400, line: Optional[int] = None, logs: str = "",
                 file: Optional[str] = None):
        super().__init__(message)
        self.status = status
        self.line = line
        self.logs = logs
        # The file it failed in (D138); None: inline code.
        self.file = file


@dataclass
class CodeResult:
    outputs: Any
    logs: str = ""
    duration_ms: int = 0
    calls: int = 0
    extra: dict = field(default_factory=dict)


def configured() -> bool:
    return bool(os.environ.get("RUNNER_URL") and os.environ.get("RUNNER_TOKEN"))


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def job_for(db: Session, token: str) -> Optional[models.RunnerJob]:
    """The live job a call back carries the token of, if any."""
    job = db.query(models.RunnerJob).filter_by(token_hash=_hash(token)).one_or_none()
    if job is None or job.finished_at is not None or job.expires_at < datetime.datetime.utcnow():
        return None
    return job


def program(code: Any, files: Optional[dict[str, str]] = None) -> dict[str, Any]:
    """What the runner is given for an action's or a step's `code`: inline
    text, or -- `code: {file, function}` (D137) -- every Python file beside
    the definition, so they import each other, and which function of which
    file to call. `code` is the entry file's text too, for a runner from
    before files. Its requirements go separately (`run`)."""
    if isinstance(code, str):
        return {"code": code}
    name, function = getattr(code, "file", None), getattr(code, "function", None) or "run"
    if isinstance(code, dict):
        name, function = code.get("file"), code.get("function") or "run"
    files = {n: t for n, t in (files or {}).items() if n.endswith(".py")}
    if name not in files:
        raise CodeError(f"There is no file {name} beside it.", 400)
    return {"code": files[name], "files": files, "entry": {"file": name, "function": function}}


def lock_of(files: Optional[dict[str, str]]) -> Optional[str]:
    """The requirements.lock a definition's code runs with, if it has
    requirements; CodeError when the lock isn't theirs (D142)."""
    from . import deps

    files = files or {}
    requirements = files.get(deps.REQUIREMENTS)
    if requirements is None or not deps.requirement_lines(requirements):
        return None
    if not deps.is_fresh(requirements, files.get(deps.LOCK)):
        raise CodeError("requirements.lock isn't the lock of requirements.txt as it is now: Check or Save locks it "
                        "again.", 400, file=deps.LOCK)
    return files[deps.LOCK]


def index_for(token: str) -> str:
    """The platform's package index as a job's uv reaches it (D143): this
    backend, the job's token as the password, so it serves only that job's
    lock."""
    from urllib.parse import urlsplit, urlunsplit

    base = urlsplit(os.environ.get("RUNNER_CALLBACK_URL", "http://127.0.0.1:8000").rstrip("/"))
    return urlunsplit((base.scheme, f"job:{token}@{base.netloc}", base.path + "/api/runner/simple/", "", ""))


def _mint(db: Session, user: models.User, purpose: str, seconds: int, may_change: bool = False,
          lock: Optional[str] = None) -> tuple[models.RunnerJob, str]:
    token = secrets.token_urlsafe(32)
    now = datetime.datetime.utcnow()
    job = models.RunnerJob(token_hash=_hash(token), user_id=user.id, purpose=purpose[:300], may_change=may_change,
                           created_at=now, expires_at=now + datetime.timedelta(seconds=seconds), deps_lock=lock)
    db.add(job)
    db.commit()
    return job, token


# How long the runner may take to build a venv before a job (its own
# RUNNER_VENV_BUILD_SECONDS), on top of the job's time.
BUILD_SECONDS = 300


def run(db: Session, user: models.User, code: Any, inputs: Any, purpose: str, may_change: bool = False,
        timeout: Optional[int] = None, files: Optional[dict[str, str]] = None) -> CodeResult:
    """Runs the code's `run(inputs, ctx)` (or the function its file names) in
    the runner as `user`; its return, or CodeError with what went wrong and
    where -- the file and line."""
    job_code = program(code, files)
    lock = lock_of(files)
    if not configured():
        raise CodeError("Code runs in the platform's runner, which isn't set up here (RUNNER_URL): ask an admin.",
                        503)
    timeout = max(1, min(int(timeout or DEFAULT_TIMEOUT), MAX_TIMEOUT))
    # A job with requirements may wait for its venv first (a new runner pod):
    # its token lives that long too, since uv reaches the index with it.
    building = BUILD_SECONDS if lock else 0
    job, token = _mint(db, user, purpose, timeout + building + 30, may_change, lock)
    if lock:
        job_code["requirements"] = {"lock": lock, "index": index_for(token)}
    callback = os.environ.get("RUNNER_CALLBACK_URL", "http://127.0.0.1:8000").rstrip("/") + "/api/runner/calls"
    try:
        reply = httpx.post(
            os.environ["RUNNER_URL"].rstrip("/") + "/jobs",
            json={**job_code, "inputs": inputs, "callback": {"url": callback, "token": token}, "timeout": timeout},
            headers={"Authorization": f"Bearer {os.environ['RUNNER_TOKEN']}"},
            timeout=timeout + building + 15,
        )
    except httpx.HTTPError as e:
        _finish(db, job, False, error=f"The runner couldn't be reached: {e}")
        raise CodeError(f"The runner couldn't be reached: {e}", 502) from None
    if reply.status_code != 200:
        try:
            detail = reply.json().get("detail")
        except ValueError:
            detail = reply.text[:200]
        _finish(db, job, False, error=str(detail))
        # The runner's own words when it has them ("The runner couldn't run the job (…)").
        message = str(detail) if str(detail).startswith("The runner") else f"The runner refused the job: {detail}"
        raise CodeError(message, 503 if reply.status_code == 503 else 502)
    out = reply.json()
    logs = masking.mask(out.get("logs") or "")
    db.refresh(job)
    _finish(db, job, bool(out.get("ok")), duration=out.get("duration_ms"), error=out.get("error"))
    if not out.get("ok"):
        line, file = out.get("line"), out.get("file")
        where = f" (line {line} of {file or 'the code'})" if line else (f" (in {file})" if file else "")
        raise CodeError(masking.mask(f"{out.get('error') or 'The code failed'}{where}"), line=line, logs=logs,
                        file=file)
    return CodeResult(outputs=out.get("outputs"), logs=logs, duration_ms=int(out.get("duration_ms") or 0),
                      calls=job.calls)


def prepare(user_id: int, files: Optional[dict[str, str]], purpose: str) -> None:
    """Asks the runner to build the venv for a definition's lock now, in the
    background (D144), so its first run doesn't wait for it. Nothing to do
    without requirements or a runner; a failure here is the run's to say."""
    import threading

    try:
        lock = lock_of(files)
    except CodeError:
        return
    if not lock or not configured():
        return

    def build() -> None:
        from .db import SessionLocal

        with SessionLocal() as db:
            user = db.get(models.User, user_id)
            if user is None:
                return
            job, token = _mint(db, user, f"venv:{purpose}", BUILD_SECONDS + 30, lock=lock)
            try:
                reply = httpx.post(os.environ["RUNNER_URL"].rstrip("/") + "/venvs",
                                   json={"lock": lock, "index": index_for(token)},
                                   headers={"Authorization": f"Bearer {os.environ['RUNNER_TOKEN']}"},
                                   timeout=BUILD_SECONDS + 15)
                out = reply.json() if reply.status_code == 200 else {"ok": False, "error": reply.text[:300]}
            except (httpx.HTTPError, ValueError) as e:
                out = {"ok": False, "error": f"The runner couldn't be reached: {e}"}
            _finish(db, job, bool(out.get("ok")), duration=(out.get("seconds") or 0) * 1000, error=out.get("error"))

    threading.Thread(target=build, name="venv-prepare", daemon=True).start()


KEEP_DAYS = 30


def prune(db: Session) -> int:
    """Forgets jobs older than KEEP_DAYS (hourly, with the blob store's
    cleanup): a code pane refreshed every 10 s is thousands of rows a day."""
    cutoff = datetime.datetime.utcnow() - datetime.timedelta(days=KEEP_DAYS)
    gone = db.query(models.RunnerJob).filter(models.RunnerJob.created_at < cutoff).delete(synchronize_session=False)
    db.commit()
    return gone


def _finish(db: Session, job: models.RunnerJob, ok: bool, duration: Any = None, error: Optional[str] = None) -> None:
    job.finished_at = datetime.datetime.utcnow()
    job.ok = ok
    job.duration_ms = int(duration) if duration is not None else None
    job.error = masking.mask(error)[:2000] if error else None
    db.commit()


# What code is given, for the editors and the agent's reference (generated
# from nothing but this: the SDK is ours, small, and said once).
SDK_DOC = {
    "where it goes": "in a Python file beside the definition (`code: {file: health.py}`, `function:` when it isn't "
                     "run): files import each other (`from helpers import window`), and a file's name is a module's "
                     "(lowercase, digits, _), never the standard library's. Inline `code: |` is for a few lines",
    "run": "def run(inputs, ctx): called with the inputs (as given); what it returns is kept -- a pane action's "
           "outputs by key (only those the pane declares), a step's outputs",
    "ctx.http(connection, path='', method='GET', query=None, headers=None, body=None)":
        "a request to a connection of an HTTP type (its id, or its name), path after its base URL, as whoever runs "
        "the code: their identity added, the reply masked. Returns .status, .headers, .text, .json(). A pane's code "
        "sends GET only; a step's with changes: true, any method after a person approves",
    "ctx.aws(connection, service, operation, params=None, paginate=False)":
        "an AWS API call that reads (botocore names: lambda, ListFunctions) on an AWS connection (its id, or its "
        "name), as whoever runs the code. Returns the reply as data",
    "ctx.log(*parts)": "a line in the job's log (print does the same)",
    "packages": "a requirements.txt file beside the code names what it imports beyond the standard library, a "
                "package a line as pip reads it (requests>=2.31, pyyaml), no options or URLs; Check and Save lock "
                "it into requirements.lock (written by the platform, never by hand) and the code runs with exactly "
                "those. Wheels only: a package with no wheel for Linux can't be used",
    "limits": "30 s, 512 MiB; at most 200 calls; no network but ctx.http and ctx.aws",
}


# A file beside a definition is a module (D138): `import helpers` finds
# helpers.py. Never one of the standard library's names or the SDK's -- the
# runner puts the files last on the path, so such a file would never load.
FILE_RE = re.compile(r"^[a-z_][a-z0-9_]{0,63}\.py$")
MAX_FILES = 20
MAX_FILE_BYTES = 200_000
_RESERVED = set(sys.stdlib_module_names) | {"platform_sdk", "bootstrap"}


def file_name_problem(name: str) -> Optional[str]:
    from . import deps

    if name in deps.NAMES:
        return None
    if not FILE_RE.match(name or ""):
        return (f"{name or '(no name)'} isn't a Python module's file name: lowercase letters, digits and _, "
                "then .py (helpers.py) -- or requirements.txt, for the packages it needs.")
    if name[:-3] in _RESERVED:
        return f"{name} would stand in for Python's own {name[:-3]} module: call it something else."
    return None


def file_problems(files: dict[str, str]) -> list[tuple[str, Optional[int], str]]:
    """What's wrong with the files beside a definition, each as (file, line,
    message): names, sizes, Python that doesn't parse."""
    import ast

    from . import deps

    out: list[tuple[str, Optional[int], str]] = []
    if len(files) > MAX_FILES:
        out.append(("", None, f"A definition has at most {MAX_FILES} files beside it."))
    for name, text in sorted(files.items()):
        problem = file_name_problem(name)
        if problem:
            out.append((name, None, problem))
            continue
        if name in deps.NAMES:
            continue  # said by deps.problems, below
        if len(text.encode()) > MAX_FILE_BYTES:
            out.append((name, None, f"{name} is over {MAX_FILE_BYTES // 1000} kB."))
            continue
        try:
            ast.parse(text, filename=name)
        except SyntaxError as e:
            out.append((name, e.lineno, f"It isn't valid Python: {e.msg}."))
    return out + deps.problems(files)


def entry_problems(code: Any, files: dict[str, str]) -> list[tuple[Optional[str], Optional[int], str]]:
    """What's wrong with what an action or a step runs, each as (file, line,
    message) -- file None for inline code, whose lines are the code's own."""
    import ast

    if isinstance(code, str):
        return [(None, line, message) for line, message in problems(code)]
    name, function = code.file, code.function or "run"
    if name not in files:
        listed = ", ".join(sorted(files)) or "none yet"
        return [(None, None, f"There is no file {name} beside it (its files: {listed}).")]
    try:
        tree = ast.parse(files[name])
    except SyntaxError:
        return []  # said once, by file_problems
    found = next((n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == function), None)
    if found is None:
        return [(name, None, f"{name} defines no {function}(inputs, ctx): that's what's called.")]
    if len(found.args.args) != 2:
        return [(name, found.lineno, f"{function} takes two arguments: {function}(inputs, ctx).")]
    return []


def problems(code: str) -> list[tuple[Optional[int], str]]:
    """What's wrong with code before it runs, each with its line in the code:
    Python that doesn't parse, or no `run(inputs, ctx)` to call (D134)."""
    import ast

    if not code.strip():
        return [(None, "The code is empty; it defines run(inputs, ctx).")]
    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        return [(e.lineno, f"The code isn't valid Python: {e.msg}.")]
    run = next((n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "run"), None)
    if run is None:
        return [(None, "The code defines no run(inputs, ctx): that's what's called, and what it returns is kept.")]
    if len(run.args.args) != 2:
        return [(run.lineno, "run takes two arguments: run(inputs, ctx).")]
    return []
