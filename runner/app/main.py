"""The runner (PLATFORM_PLAN.md §25, D131): where a builder's code runs,
never in the backend. One endpoint, behind a token only the backend has; no
database, no secrets, no cloud credentials -- a job brings its code, its
inputs and a token good for its own calls back to the platform, and that is
all it can use."""

from __future__ import annotations

import hmac
import logging
import os
import time
from contextlib import asynccontextmanager
from typing import Any, Optional

from fastapi import FastAPI, Header, HTTPException
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import jobs, venvs

log = logging.getLogger("runner")

# What running one trivial job at start-up found: None while it's fine.
_problem: dict[str, Optional[str]] = {"problem": None}


def self_check() -> Optional[str]:
    """Runs one job the way every job runs. A runner that can't -- its
    capabilities, its /tmp, its interpreter -- says so on /health (and its
    readiness probe fails) instead of answering every job with a 500."""
    try:
        outcome = jobs.run("def run(inputs, ctx):\n    return {'ok': True}\n", None, None, 10)
    except Exception as e:  # noqa: BLE001 -- whatever it is, it's the answer
        log.exception("The runner can't run a job")
        return f"{type(e).__name__}: {e}"
    if not outcome.ok:
        return outcome.error or "A trivial job failed."
    return None


@asynccontextmanager
async def lifespan(_app: FastAPI):
    _problem["problem"] = await run_in_threadpool(self_check)
    if _problem["problem"]:
        log.error("The runner can't run jobs: %s", _problem["problem"])
    yield


app = FastAPI(title="Platform runner", lifespan=lifespan)

MAX_CODE = 200_000


class Callback(BaseModel):
    url: str
    token: str


class Entry(BaseModel):
    file: str
    function: str = "run"


class Requirements(BaseModel):
    # The definition's requirements.lock, and the index to install it from:
    # the backend's, with this job's token (D143).
    lock: str = Field(max_length=200_000)
    index: str = Field(max_length=2000)


class JobIn(BaseModel):
    # Inline code, or -- code kept in files (D138) -- the files and which
    # function of which to call. Both may come: a runner from before files
    # runs `code` (the entry file's text).
    code: str = Field(default="", max_length=MAX_CODE)
    files: Optional[dict[str, str]] = None
    entry: Optional[Entry] = None
    inputs: Any = None
    callback: Optional[Callback] = None
    timeout: Optional[int] = None
    requirements: Optional[Requirements] = None


def _token() -> str:
    # Read once and kept out of every job's environment (they get none).
    return os.environ.get("RUNNER_TOKEN", "")


TOKEN = _token()


@app.get("/health")
def health():
    body = {"status": "ok", "isolated": os.geteuid() == 0, "slots": jobs.CONCURRENCY}
    if _problem["problem"]:
        return JSONResponse({**body, "status": "broken", "problem": _problem["problem"]}, status_code=503)
    return body


def _authorised(authorization: Optional[str]) -> None:
    if not TOKEN:
        raise HTTPException(status_code=503, detail="The runner has no RUNNER_TOKEN, so it takes no jobs.")
    given = (authorization or "").removeprefix("Bearer ").strip()
    if not hmac.compare_digest(given.encode(), TOKEN.encode()):
        raise HTTPException(status_code=401, detail="That isn't the runner's token.")


@app.post("/venvs")
async def build_venv(requirements: Requirements, authorization: Optional[str] = Header(default=None)) -> dict:
    """The venv for a lock, built now -- after a save, so the first run finds
    it (D144). Already there, it answers at once."""
    _authorised(authorization)
    started = time.monotonic()
    try:
        await run_in_threadpool(venvs.python_for, requirements.lock, requirements.index, jobs.PYTHON)
    except venvs.BuildFailed as e:
        return {"ok": False, "error": str(e)}
    return {"ok": True, "seconds": round(time.monotonic() - started, 1), "venv": venvs.key(requirements.lock)}


@app.post("/jobs")
async def run_job(job: JobIn, authorization: Optional[str] = Header(default=None)) -> dict:
    _authorised(authorization)
    if sum(len(t) for t in (job.files or {}).values()) > MAX_CODE * 5:
        raise HTTPException(status_code=413, detail="A job's files are at most 1 MB together.")
    try:
        outcome = await run_in_threadpool(
            jobs.run, job.code, job.inputs, job.callback.model_dump() if job.callback else None, job.timeout,
            job.files, job.entry.model_dump() if job.entry else None,
            job.requirements.model_dump() if job.requirements else None)
    except jobs.Busy as e:
        raise HTTPException(status_code=503, detail=str(e)) from None
    except jobs.BadJob as e:
        raise HTTPException(status_code=400, detail=str(e)) from None
    except Exception as e:  # noqa: BLE001 -- said to the backend, which shows it to the builder
        log.exception("A job couldn't be run")
        raise HTTPException(status_code=500, detail=f"The runner couldn't run the job ({type(e).__name__}: {e}).") \
            from None
    return outcome.as_dict()
