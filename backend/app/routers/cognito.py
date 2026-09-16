from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import cognito_client, schemas
from ..db import get_db
from ..resolve import ResolveError, resolve_environment, resolve_role_name

router = APIRouter(prefix="/api/cognito", tags=["cognito"])


@router.get("/user-pools", response_model=schemas.CognitoUserPoolsResponse)
def list_user_pools(environment_id: int, db: Session = Depends(get_db)):
    try:
        environment = resolve_environment(db, environment_id)
        role_name = resolve_role_name(db, environment)
    except ResolveError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    try:
        pools = cognito_client.list_user_pools(environment.account_id, environment.region, role_name)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Failed to list user pools: {e}") from e

    return schemas.CognitoUserPoolsResponse(user_pools=[schemas.CognitoUserPoolInfo(**p) for p in pools])


@router.post("/users", response_model=schemas.CognitoUserSearchResponse)
def search_users(payload: schemas.CognitoUserSearchRequest, db: Session = Depends(get_db)):
    try:
        environment = resolve_environment(db, payload.environment_id)
        role_name = resolve_role_name(db, environment)
    except ResolveError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    try:
        result = cognito_client.search_users(
            environment.account_id,
            environment.region,
            role_name,
            payload.user_pool_id,
            payload.query_string,
            payload.limit,
            payload.pagination_token,
        )
    except Exception as e:  # noqa: BLE001
        raise HTTPException(
            status_code=502, detail=f"Failed to search users in pool '{payload.user_pool_id}': {e}"
        ) from e

    return schemas.CognitoUserSearchResponse(**result)
