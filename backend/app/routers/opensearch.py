import asyncio
import json
from concurrent.futures import ThreadPoolExecutor

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import opensearch_client, schemas
from ..db import get_db
from ..resolve import ResolveError, resolve_environment, resolve_role_name

router = APIRouter(prefix="/api/opensearch", tags=["opensearch"])

_executor = ThreadPoolExecutor(max_workers=16)


def _stringify(value) -> str:
    if isinstance(value, (dict, list)):
        return json.dumps(value, default=str)
    return str(value)


def _flatten(obj: dict, prefix: str = "") -> dict:
    """Flattens nested document fields into dotted keys (e.g. "user.name"),
    the same shallow-friendly shape ResultsView already renders for
    CloudWatch's field/value rows."""
    out: dict = {}
    for key, value in obj.items():
        full_key = f"{prefix}.{key}" if prefix else key
        if isinstance(value, dict):
            out.update(_flatten(value, full_key))
        else:
            out[full_key] = value
    return out


def _hits_to_rows(hits: list[dict], domain_name: str) -> list[list[schemas.ResultField]]:
    rows = []
    for hit in hits:
        flat = _flatten(hit.get("_source") or {})
        index_name = hit.get("_index", "")
        # "@log" mirrors CloudWatch's own field of the same name, so the AI
        # assistant's existing per-source sampling (round-robining across
        # distinct @log values when a search spans multiple indices) applies
        # here for free, with no frontend changes needed.
        flat["@log"] = f"{domain_name}/{index_name}" if index_name else domain_name
        flat["@index"] = index_name
        flat["@id"] = hit.get("_id", "")
        rows.append([schemas.ResultField(field=k, value=_stringify(v)) for k, v in flat.items()])
    return rows


def _domains_one(environment_id, environment_name, account_id, region, role_name) -> schemas.OpenSearchDomainsResultItem:
    try:
        raw = opensearch_client.list_domains(account_id, region, role_name)
        return schemas.OpenSearchDomainsResultItem(
            environment_id=environment_id,
            environment_name=environment_name,
            account_id=account_id,
            region=region,
            domains=[schemas.OpenSearchDomainInfo(**d) for d in raw],
        )
    except Exception as e:  # noqa: BLE001 - surface per-target error rather than failing whole request
        return schemas.OpenSearchDomainsResultItem(
            environment_id=environment_id,
            environment_name=environment_name,
            account_id=account_id,
            region=region,
            domains=[],
            error=str(e),
        )


@router.post("/domains", response_model=schemas.OpenSearchDomainsResponse)
async def get_domains(payload: schemas.OpenSearchDomainsRequest, db: Session = Depends(get_db)):
    loop = asyncio.get_event_loop()
    futures = []
    for environment_id in payload.environment_ids:
        try:
            environment = resolve_environment(db, environment_id)
        except ResolveError as e:
            futures.append(
                _wrap(
                    schemas.OpenSearchDomainsResultItem(
                        environment_id=environment_id,
                        environment_name=str(environment_id),
                        account_id="",
                        region="",
                        domains=[],
                        error=str(e),
                    )
                )
            )
            continue
        try:
            role_name = resolve_role_name(db, environment)
        except ResolveError as e:
            futures.append(
                _wrap(
                    schemas.OpenSearchDomainsResultItem(
                        environment_id=environment_id,
                        environment_name=environment.name,
                        account_id=environment.account_id,
                        region=environment.region,
                        domains=[],
                        error=str(e),
                    )
                )
            )
            continue
        futures.append(
            loop.run_in_executor(
                _executor,
                _domains_one,
                environment_id,
                environment.name,
                environment.account_id,
                environment.region,
                role_name,
            )
        )
    results = await asyncio.gather(*futures)
    return schemas.OpenSearchDomainsResponse(results=list(results))


async def _wrap(value):
    return value


@router.post("/indices", response_model=schemas.OpenSearchIndicesResponse)
def get_indices(payload: schemas.OpenSearchIndicesRequest, db: Session = Depends(get_db)):
    try:
        environment = resolve_environment(db, payload.environment_id)
        role_name = resolve_role_name(db, environment)
    except ResolveError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    try:
        raw = opensearch_client.list_indices(
            environment.account_id, environment.region, role_name, payload.domain_endpoint
        )
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Failed to list indices: {e}") from e

    return schemas.OpenSearchIndicesResponse(indices=[schemas.OpenSearchIndexInfo(**i) for i in raw])


def _search_one(environment_id, environment_name, account_id, region, role_name, target, payload) -> schemas.OpenSearchResultItem:
    try:
        data = opensearch_client.search(
            account_id,
            region,
            role_name,
            target.domain_endpoint,
            target.indices,
            payload.query_string,
            payload.start_time,
            payload.end_time,
            payload.timestamp_field,
            payload.limit,
        )
        return schemas.OpenSearchResultItem(
            environment_id=environment_id,
            environment_name=environment_name,
            account_id=account_id,
            region=region,
            domain_name=target.domain_name,
            indices=target.indices,
            status="Complete",
            rows=_hits_to_rows(data["hits"], target.domain_name),
            total_hits=data.get("total"),
        )
    except Exception as e:  # noqa: BLE001
        return schemas.OpenSearchResultItem(
            environment_id=environment_id,
            environment_name=environment_name,
            account_id=account_id,
            region=region,
            domain_name=target.domain_name,
            indices=target.indices,
            status="Failed",
            error=str(e),
        )


@router.post("/search", response_model=schemas.OpenSearchSearchResponse)
async def search(payload: schemas.OpenSearchSearchRequest, db: Session = Depends(get_db)):
    loop = asyncio.get_event_loop()
    futures = []
    for target in payload.targets:
        try:
            environment = resolve_environment(db, target.environment_id)
        except ResolveError as e:
            futures.append(
                _wrap(
                    schemas.OpenSearchResultItem(
                        environment_id=target.environment_id,
                        environment_name=str(target.environment_id),
                        account_id="",
                        region="",
                        domain_name=target.domain_name,
                        indices=target.indices,
                        status="Failed",
                        error=str(e),
                    )
                )
            )
            continue
        try:
            role_name = resolve_role_name(db, environment)
        except ResolveError as e:
            futures.append(
                _wrap(
                    schemas.OpenSearchResultItem(
                        environment_id=target.environment_id,
                        environment_name=environment.name,
                        account_id=environment.account_id,
                        region=environment.region,
                        domain_name=target.domain_name,
                        indices=target.indices,
                        status="Failed",
                        error=str(e),
                    )
                )
            )
            continue
        futures.append(
            loop.run_in_executor(
                _executor,
                _search_one,
                target.environment_id,
                environment.name,
                environment.account_id,
                environment.region,
                role_name,
                target,
                payload,
            )
        )
    results = await asyncio.gather(*futures)
    return schemas.OpenSearchSearchResponse(results=list(results))
