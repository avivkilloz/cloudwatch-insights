"""The runner (PLATFORM_PLAN.md §25, D131): where a builder's code runs,
never in the backend. One endpoint, behind a token only the backend has; no
database, no secrets, no cloud credentials -- a job brings its code, its
inputs and a token good for its own calls back to the platform, and that is
all it can use."""

from __future__ import annotations

import hmac
import os
from typing import Any, Optional

from fastapi import FastAPI, Header, HTTPException
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from . import jobs

app = FastAPI(title="Platform runner")

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
def health() -> dict:
    return {"status": "ok", "isolated": os.geteuid() == 0, "slots": jobs.CONCURRENCY}


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
    return outcome.as_dict()
