import asyncio
from concurrent.futures import ThreadPoolExecutor

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from .. import aws_client, schemas
from ..db import get_db
from ..resolve import ResolveError, resolve_account, resolve_role_name

router = APIRouter(prefix="/api/log-groups", tags=["log-groups"])

_executor = ThreadPoolExecutor(max_workers=16)


def _fetch_one(account_id: str, account_name: str, region: str, role_name: str) -> schemas.LogGroupsResultItem:
    try:
        raw = aws_client.list_log_groups(account_id, region, role_name)
        return schemas.LogGroupsResultItem(
            account_id=account_id,
            account_name=account_name,
            region=region,
            log_groups=[schemas.LogGroupInfo(**lg) for lg in raw],
        )
    except Exception as e:  # noqa: BLE001 - surface per-target error rather than failing whole request
        return schemas.LogGroupsResultItem(
            account_id=account_id, account_name=account_name, region=region, log_groups=[], error=str(e)
        )


@router.post("", response_model=schemas.LogGroupsResponse)
async def get_log_groups(payload: schemas.LogGroupsRequest, db: Session = Depends(get_db)):
    loop = asyncio.get_event_loop()
    futures = []
    for target in payload.targets:
        try:
            account = resolve_account(db, target.account_id)
            role_name = resolve_role_name(db, account)
        except ResolveError as e:
            futures.append(
                _immediate_error(target.account_id, target.account_id, target.region, str(e))
            )
            continue
        futures.append(
            loop.run_in_executor(
                _executor, _fetch_one, target.account_id, account.name, target.region, role_name
            )
        )

    results = await asyncio.gather(*futures)
    return schemas.LogGroupsResponse(results=list(results))


async def _immediate_error(account_id: str, account_name: str, region: str, error: str):
    return schemas.LogGroupsResultItem(
        account_id=account_id, account_name=account_name, region=region, log_groups=[], error=error
    )
