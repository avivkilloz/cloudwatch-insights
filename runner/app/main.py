"""The runner (PLATFORM_PLAN.md §25, D131): where a builder's code runs,
never in the backend. One endpoint, behind a token only the backend has; no
database, no secrets, no cloud credentials -- a job brings its code, its
inputs and a token good for its own calls back to the platform, and that is
all it can use."""

from __future__ import annotations

import hmac
import logging
import os
from contextlib import asynccontextmanager
from typing import Any, Optional

from fastapi import FastAPI, Header, HTTPException
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import jobs

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


class JobIn(BaseModel):
    code: str = Field(max_length=MAX_CODE)
    inputs: Any = None
    callback: Optional[Callback] = None
    timeout: Optional[int] = None


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


@app.post("/jobs")
async def run_job(job: JobIn, authorization: Optional[str] = Header(default=None)) -> dict:
    if not TOKEN:
        raise HTTPException(status_code=503, detail="The runner has no RUNNER_TOKEN, so it takes no jobs.")
    given = (authorization or "").removeprefix("Bearer ").strip()
    if not hmac.compare_digest(given.encode(), TOKEN.encode()):
        raise HTTPException(status_code=401, detail="That isn't the runner's token.")
    try:
        outcome = await run_in_threadpool(
            jobs.run, job.code, job.inputs, job.callback.model_dump() if job.callback else None, job.timeout)
    except jobs.Busy as e:
        raise HTTPException(status_code=503, detail=str(e)) from None
    except Exception as e:  # noqa: BLE001 -- said to the backend, which shows it to the builder
        log.exception("A job couldn't be run")
        raise HTTPException(status_code=500, detail=f"The runner couldn't run the job ({type(e).__name__}: {e}).") \
            from None
    return outcome.as_dict()
