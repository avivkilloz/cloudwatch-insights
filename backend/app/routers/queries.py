import asyncio
from concurrent.futures import ThreadPoolExecutor

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from .. import aws_client, auth, models, schemas
from ..db import get_db
from ..resolve import ResolveError, resolve_environment, resolve_role_name

router = APIRouter(prefix="/api/queries", tags=["queries"])

_executor = ThreadPoolExecutor(max_workers=16)

TERMINAL_STATUSES = {"Complete", "Failed", "Cancelled", "Timeout"}


def _start_one(
    environment_id,
    environment_name,
    account_id,
    region,
    role_name,
    log_group_names,
    query_string,
    start_time,
    end_time,
    limit,
):
    try:
        query_id = aws_client.start_query(
            account_id, region, role_name, log_group_names, query_string, start_time, end_time, limit
        )
        return schemas.StartedQuery(
            environment_id=environment_id,
            environment_name=environment_name,
            account_id=account_id,
            region=region,
            query_id=query_id,
        )
    except Exception as e:  # noqa: BLE001
        return schemas.StartedQuery(
            environment_id=environment_id,
            environment_name=environment_name,
            account_id=account_id,
            region=region,
            error=str(e),
        )


@router.post("/start", response_model=schemas.StartQueryResponse)
async def start_queries(
    payload: schemas.StartQueryRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    loop = asyncio.get_event_loop()
    tasks = []
    for target in payload.targets:
        try:
            environment = resolve_environment(db, target.environment_id, current_user)
        except ResolveError as e:
            tasks.append(
                _wrap(
                    schemas.StartedQuery(
                        environment_id=target.environment_id,
                        environment_name=str(target.environment_id),
                        account_id="",
                        region="",
                        error=str(e),
                    )
                )
            )
            continue
        try:
            role_name = resolve_role_name(current_user)
        except ResolveError as e:
            tasks.append(
                _wrap(
                    schemas.StartedQuery(
                        environment_id=target.environment_id,
                        environment_name=environment.name,
                        account_id=environment.account_id,
                        region=environment.region,
                        error=str(e),
                    )
                )
            )
            continue
        tasks.append(
            loop.run_in_executor(
                _executor,
                _start_one,
                target.environment_id,
                environment.name,
                environment.account_id,
                environment.region,
                role_name,
                target.log_group_names,
                payload.query_string,
                payload.start_time,
                payload.end_time,
                payload.limit,
            )
        )
    results = await asyncio.gather(*tasks)
    return schemas.StartQueryResponse(queries=list(results))


def _results_one(environment_id, environment_name, account_id, region, role_name, query_id) -> schemas.QueryResultItem:
    try:
        data = aws_client.get_query_results(account_id, region, role_name, query_id)
        rows = [
            [schemas.ResultField(field=f["field"], value=f["value"]) for f in row]
            for row in data["results"]
        ]
        return schemas.QueryResultItem(
            environment_id=environment_id,
            environment_name=environment_name,
            account_id=account_id,
            region=region,
            query_id=query_id,
            status=data["status"],
            rows=rows,
            statistics=data.get("statistics"),
        )
    except Exception as e:  # noqa: BLE001
        return schemas.QueryResultItem(
            environment_id=environment_id,
            environment_name=environment_name,
            account_id=account_id,
            region=region,
            query_id=query_id,
            status="Failed",
            error=str(e),
        )


@router.post("/results", response_model=schemas.QueryResultsResponse)
async def get_results(
    payload: schemas.QueryResultsRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    loop = asyncio.get_event_loop()
    tasks = []
    for q in payload.queries:
        try:
            environment = resolve_environment(db, q.environment_id, current_user)
        except ResolveError as e:
            tasks.append(
                _wrap(
                    schemas.QueryResultItem(
                        environment_id=q.environment_id,
                        environment_name=str(q.environment_id),
                        account_id="",
                        region="",
                        query_id=q.query_id,
                        status="Failed",
                        error=str(e),
                    )
                )
            )
            continue
        try:
            role_name = resolve_role_name(current_user)
        except ResolveError as e:
            tasks.append(
                _wrap(
                    schemas.QueryResultItem(
                        environment_id=q.environment_id,
                        environment_name=environment.name,
                        account_id=environment.account_id,
                        region=environment.region,
                        query_id=q.query_id,
                        status="Failed",
                        error=str(e),
                    )
                )
            )
            continue
        tasks.append(
            loop.run_in_executor(
                _executor,
                _results_one,
                q.environment_id,
                environment.name,
                environment.account_id,
                environment.region,
                role_name,
                q.query_id,
            )
        )
    results = await asyncio.gather(*tasks)
    all_done = all(r.status in TERMINAL_STATUSES for r in results)
    return schemas.QueryResultsResponse(results=list(results), all_done=all_done)


def _stop_one(account_id, region, role_name, query_id):
    try:
        aws_client.stop_query(account_id, region, role_name, query_id)
    except Exception:  # noqa: BLE001 - best-effort stop
        pass


@router.post("/stop", status_code=204)
async def stop_queries(
    payload: schemas.StopQueryRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    loop = asyncio.get_event_loop()
    tasks = []
    for q in payload.queries:
        try:
            environment = resolve_environment(db, q.environment_id, current_user)
            role_name = resolve_role_name(current_user)
        except ResolveError:
            continue
        tasks.append(
            loop.run_in_executor(
                _executor, _stop_one, environment.account_id, environment.region, role_name, q.query_id
            )
        )
    if tasks:
        await asyncio.gather(*tasks)
    return None


async def _wrap(value):
    return value
