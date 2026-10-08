from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import auth, models, s3_client, schemas
from ..db import get_db
from ..resolve import ResolveError, require_flag, resolve_identity, resolve_target

router = APIRouter(prefix="/api/buckets", tags=["buckets"])


@router.get("/list", response_model=schemas.S3BucketsResponse)
def list_buckets(
    environment_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    try:
        require_flag(current_user, "buckets_enabled", "S3")
        environment = resolve_target(db, environment_id, current_user)
        identity = resolve_identity(db, environment, current_user)
    except ResolveError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    try:
        buckets = s3_client.list_buckets(environment.account_id, environment.region, identity)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Failed to list buckets: {e}") from e

    return schemas.S3BucketsResponse(buckets=[schemas.S3BucketInfo(**b) for b in buckets])


@router.post("/browse", response_model=schemas.S3BrowseResponse)
def browse_bucket(
    payload: schemas.S3BrowseRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    try:
        require_flag(current_user, "buckets_enabled", "S3")
        environment = resolve_target(db, payload.environment_id, current_user)
        identity = resolve_identity(db, environment, current_user)
    except ResolveError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    try:
        result = s3_client.browse_bucket(
            environment.account_id,
            environment.region,
            identity,
            payload.bucket,
            payload.prefix,
            payload.search,
            payload.max_results,
            payload.continuation_token,
        )
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Failed to browse bucket '{payload.bucket}': {e}") from e

    return schemas.S3BrowseResponse(**result)
