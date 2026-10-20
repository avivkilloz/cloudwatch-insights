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
import secrets
from dataclasses import dataclass, field
from typing import Any, Optional

import httpx
from sqlalchemy.orm import Session

from . import masking, models

DEFAULT_TIMEOUT = 30
MAX_TIMEOUT = 120


class CodeError(Exception):
    """The code couldn't run, or failed: said so a builder can fix it."""

    def __init__(self, message: str, status: int = 400, line: Optional[int] = None, logs: str = ""):
        super().__init__(message)
        self.status = status
        self.line = line
        self.logs = logs


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


def run(db: Session, user: models.User, code: str, inputs: Any, purpose: str, may_change: bool = False,
        timeout: Optional[int] = None) -> CodeResult:
    """Runs `code`'s `run(inputs, ctx)` in the runner as `user`; its return,
    or CodeError with what went wrong (and the line it went wrong on)."""
    if not configured():
        raise CodeError("Code runs in the platform's runner, which isn't set up here (RUNNER_URL): ask an admin.",
                        503)
    timeout = max(1, min(int(timeout or DEFAULT_TIMEOUT), MAX_TIMEOUT))
    token = secrets.token_urlsafe(32)
    now = datetime.datetime.utcnow()
    job = models.RunnerJob(token_hash=_hash(token), user_id=user.id, purpose=purpose[:300], may_change=may_change,
                           created_at=now, expires_at=now + datetime.timedelta(seconds=timeout + 30))
    db.add(job)
    db.commit()
    callback = os.environ.get("RUNNER_CALLBACK_URL", "http://127.0.0.1:8000").rstrip("/") + "/api/runner/calls"
    try:
        reply = httpx.post(
            os.environ["RUNNER_URL"].rstrip("/") + "/jobs",
            json={"code": code, "inputs": inputs, "callback": {"url": callback, "token": token}, "timeout": timeout},
            headers={"Authorization": f"Bearer {os.environ['RUNNER_TOKEN']}"},
            timeout=timeout + 15,
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
        raise CodeError(f"The runner refused the job: {detail}", 503 if reply.status_code == 503 else 502)
    out = reply.json()
    logs = masking.mask(out.get("logs") or "")
    db.refresh(job)
    _finish(db, job, bool(out.get("ok")), duration=out.get("duration_ms"), error=out.get("error"))
    if not out.get("ok"):
        line = out.get("line")
        where = f" (line {line} of the code)" if line else ""
        raise CodeError(masking.mask(f"{out.get('error') or 'The code failed'}{where}"), line=line, logs=logs)
    return CodeResult(outputs=out.get("outputs"), logs=logs, duration_ms=int(out.get("duration_ms") or 0),
                      calls=job.calls)


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
    "limits": "the standard library only; 30 s, 512 MiB; at most 200 calls; no network but ctx.http and ctx.aws",
}


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
