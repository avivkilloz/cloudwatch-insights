"""The broker (PLATFORM_PLAN.md §25, D133): where code in the runner calls
back to the platform. A call carries its job's token (runner_client), not a
cookie or a user's own credential, and is made as the person running the
code through `outbound` -- a declarative request's own path. The token dies
with its job."""

from typing import Any, Optional

from fastapi import APIRouter, Body, Depends, Header, HTTPException
from sqlalchemy.orm import Session

from .. import models, outbound, runner_client
from ..db import get_db

router = APIRouter(prefix="/api/runner", tags=["runner"])

# A job's calls, all told (the SDK counts too; this is the one that holds).
MAX_CALLS = 200


@router.post("/calls")
def call(payload: dict[str, Any] = Body(...), authorization: Optional[str] = Header(default=None),
         db: Session = Depends(get_db)) -> dict:
    token = (authorization or "").removeprefix("Bearer ").strip()
    job = runner_client.job_for(db, token) if token else None
    if job is None:
        raise HTTPException(status_code=401, detail="This call isn't from a running job of the platform's.")
    user = db.get(models.User, job.user_id)
    if user is None:
        raise HTTPException(status_code=401, detail="The job's user is gone.")
    # In the database, not job.calls += 1: a job's calls can come at once (threads).
    db.query(models.RunnerJob).filter_by(id=job.id).update({models.RunnerJob.calls: models.RunnerJob.calls + 1},
                                                           synchronize_session=False)
    db.commit()
    db.refresh(job)
    if job.calls > MAX_CALLS:
        raise HTTPException(status_code=429, detail=f"A job makes at most {MAX_CALLS} calls.")
    try:
        if payload.get("kind") == "http":
            return outbound.http(db, user, payload, job.may_change)
        if payload.get("kind") == "aws":
            return outbound.aws(db, user, payload)
    except outbound.OutboundError as e:
        raise HTTPException(status_code=e.status, detail=str(e)) from None
    raise HTTPException(status_code=400, detail="A call is http (ctx.http) or aws (ctx.aws).")
