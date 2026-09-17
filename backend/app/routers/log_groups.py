import asyncio
from concurrent.futures import ThreadPoolExecutor

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from .. import aws_client, auth, models, schemas
from ..db import get_db
from ..resolve import ResolveError, resolve_environment, resolve_role_name

router = APIRouter(prefix="/api/log-groups", tags=["log-groups"])

_executor = ThreadPoolExecutor(max_workers=16)


def _fetch_one(
    environment_id: int, environment_name: str, account_id: str, region: str, role_name: str
) -> schemas.LogGroupsResultItem:
    try:
        raw = aws_client.list_log_groups(account_id, region, role_name)
        return schemas.LogGroupsResultItem(
            environment_id=environment_id,
            environment_name=environment_name,
            account_id=account_id,
            region=region,
            log_groups=[schemas.LogGroupInfo(**lg) for lg in raw],
        )
    except Exception as e:  # noqa: BLE001 - surface per-target error rather than failing whole request
        return schemas.LogGroupsResultItem(
            environment_id=environment_id,
            environment_name=environment_name,
            account_id=account_id,
            region=region,
            log_groups=[],
            error=str(e),
        )


@router.post("", response_model=schemas.LogGroupsResponse)
async def get_log_groups(
    payload: schemas.LogGroupsRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    loop = asyncio.get_event_loop()
    futures = []
    for environment_id in payload.environment_ids:
        try:
            environment = resolve_environment(db, environment_id, current_user)
        except ResolveError as e:
            futures.append(_immediate_error(environment_id, str(environment_id), "", "", str(e)))
            continue
        try:
            role_name = resolve_role_name(current_user)
        except ResolveError as e:
            futures.append(
                _immediate_error(environment_id, environment.name, environment.account_id, environment.region, str(e))
            )
            continue
        futures.append(
            loop.run_in_executor(
                _executor,
                _fetch_one,
                environment_id,
                environment.name,
                environment.account_id,
                environment.region,
                role_name,
            )
        )

    results = await asyncio.gather(*futures)
    return schemas.LogGroupsResponse(results=list(results))


async def _immediate_error(environment_id: int, environment_name: str, account_id: str, region: str, error: str):
    return schemas.LogGroupsResultItem(
        environment_id=environment_id,
        environment_name=environment_name,
        account_id=account_id,
        region=region,
        log_groups=[],
        error=error,
    )
