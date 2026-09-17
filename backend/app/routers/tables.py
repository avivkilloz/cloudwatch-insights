from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import auth, dynamodb_client, models, schemas
from ..db import get_db
from ..resolve import ResolveError, resolve_environment, resolve_role_name

router = APIRouter(prefix="/api/tables", tags=["tables"])


@router.get("/list", response_model=schemas.DynamoTablesResponse)
def list_tables(
    environment_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    try:
        environment = resolve_environment(db, environment_id, current_user)
        role_name = resolve_role_name(current_user)
    except ResolveError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    try:
        tables = dynamodb_client.list_tables(environment.account_id, environment.region, role_name)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Failed to list tables: {e}") from e

    return schemas.DynamoTablesResponse(tables=tables)


@router.post("/describe", response_model=schemas.DynamoTableInfo)
def describe_table(
    payload: schemas.DynamoTableDescribeRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    try:
        environment = resolve_environment(db, payload.environment_id, current_user)
        role_name = resolve_role_name(current_user)
    except ResolveError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    try:
        info = dynamodb_client.describe_table(
            environment.account_id, environment.region, role_name, payload.table_name
        )
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Failed to describe table '{payload.table_name}': {e}") from e

    return schemas.DynamoTableInfo(**info)


@router.post("/scan", response_model=schemas.DynamoScanResponse)
def scan_table(
    payload: schemas.DynamoScanRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    try:
        environment = resolve_environment(db, payload.environment_id, current_user)
        role_name = resolve_role_name(current_user)
    except ResolveError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    try:
        result = dynamodb_client.scan_items(
            environment.account_id,
            environment.region,
            role_name,
            payload.table_name,
            payload.query_string,
            payload.limit,
            payload.exclusive_start_key,
        )
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Failed to scan table '{payload.table_name}': {e}") from e

    return schemas.DynamoScanResponse(**result)
