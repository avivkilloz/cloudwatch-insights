import asyncio
from concurrent.futures import ThreadPoolExecutor

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import auth, iot_client, models, schemas
from ..db import get_db
from ..resolve import ResolveError, resolve_environment, resolve_role_name

router = APIRouter(prefix="/api/iot", tags=["iot"])

_executor = ThreadPoolExecutor(max_workers=16)


def _search_one(
    environment_id: int,
    environment_name: str,
    account_id: str,
    region: str,
    role_name: str,
    query_string: str,
    max_results: int,
) -> schemas.IotSearchResultItem:
    try:
        raw = iot_client.search_things(account_id, region, role_name, query_string, max_results)
        return schemas.IotSearchResultItem(
            environment_id=environment_id,
            environment_name=environment_name,
            account_id=account_id,
            region=region,
            things=[schemas.IotThingSummary(**t) for t in raw],
        )
    except Exception as e:  # noqa: BLE001 - surface per-environment error rather than failing whole request
        return schemas.IotSearchResultItem(
            environment_id=environment_id,
            environment_name=environment_name,
            account_id=account_id,
            region=region,
            things=[],
            error=str(e),
        )


@router.post("/search", response_model=schemas.IotSearchResponse)
async def search_things(
    payload: schemas.IotSearchRequest,
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
                _search_one,
                environment_id,
                environment.name,
                environment.account_id,
                environment.region,
                role_name,
                payload.query_string,
                payload.max_results or 50,
            )
        )

    results = await asyncio.gather(*futures)
    return schemas.IotSearchResponse(results=list(results))


async def _immediate_error(environment_id: int, environment_name: str, account_id: str, region: str, error: str):
    return schemas.IotSearchResultItem(
        environment_id=environment_id,
        environment_name=environment_name,
        account_id=account_id,
        region=region,
        things=[],
        error=error,
    )


@router.post("/things/detail", response_model=schemas.IotThingDetail)
def get_thing_detail(
    payload: schemas.IotThingDetailRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    try:
        environment = resolve_environment(db, payload.environment_id, current_user)
        role_name = resolve_role_name(current_user)
    except ResolveError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    try:
        detail = iot_client.get_thing_detail(environment.account_id, environment.region, role_name, payload.thing_name)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Failed to load thing '{payload.thing_name}': {e}") from e

    return schemas.IotThingDetail(**detail)


@router.get("/saved-searches", response_model=list[schemas.IotSavedSearchOut])
def list_saved_searches(
    db: Session = Depends(get_db), current_user: models.User = Depends(auth.get_current_user)
):
    return (
        db.query(models.IotSavedSearch)
        .filter(models.IotSavedSearch.user_id == current_user.id)
        .order_by(models.IotSavedSearch.name)
        .all()
    )


@router.post("/saved-searches", response_model=schemas.IotSavedSearchOut, status_code=201)
def create_saved_search(
    payload: schemas.IotSavedSearchCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    saved = models.IotSavedSearch(**payload.model_dump(), user_id=current_user.id)
    db.add(saved)
    db.commit()
    db.refresh(saved)
    return saved


@router.put("/saved-searches/{saved_search_id}", response_model=schemas.IotSavedSearchOut)
def update_saved_search(
    saved_search_id: int,
    payload: schemas.IotSavedSearchUpdate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    saved = db.get(models.IotSavedSearch, saved_search_id)
    if not saved or saved.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Saved search not found")
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(saved, key, value)
    db.commit()
    db.refresh(saved)
    return saved


@router.delete("/saved-searches/{saved_search_id}", status_code=204)
def delete_saved_search(
    saved_search_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    saved = db.get(models.IotSavedSearch, saved_search_id)
    if not saved or saved.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Saved search not found")
    db.delete(saved)
    db.commit()
    return None


def _search_certs_one(
    environment_id: int,
    environment_name: str,
    account_id: str,
    region: str,
    role_name: str,
    query_string: str,
    max_results: int,
) -> schemas.IotCertificateSearchResultItem:
    try:
        raw = iot_client.search_certificates(account_id, region, role_name, query_string, max_results)
        return schemas.IotCertificateSearchResultItem(
            environment_id=environment_id,
            environment_name=environment_name,
            account_id=account_id,
            region=region,
            certificates=[schemas.IotCertificateInfo(**c) for c in raw],
        )
    except Exception as e:  # noqa: BLE001 - surface per-environment error rather than failing whole request
        return schemas.IotCertificateSearchResultItem(
            environment_id=environment_id,
            environment_name=environment_name,
            account_id=account_id,
            region=region,
            certificates=[],
            error=str(e),
        )


@router.post("/certificates/search", response_model=schemas.IotCertificateSearchResponse)
async def search_certificates(
    payload: schemas.IotCertificateSearchRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    loop = asyncio.get_event_loop()
    futures = []
    for environment_id in payload.environment_ids:
        try:
            environment = resolve_environment(db, environment_id, current_user)
        except ResolveError as e:
            futures.append(_immediate_cert_error(environment_id, str(environment_id), "", "", str(e)))
            continue
        try:
            role_name = resolve_role_name(current_user)
        except ResolveError as e:
            futures.append(
                _immediate_cert_error(
                    environment_id, environment.name, environment.account_id, environment.region, str(e)
                )
            )
            continue
        futures.append(
            loop.run_in_executor(
                _executor,
                _search_certs_one,
                environment_id,
                environment.name,
                environment.account_id,
                environment.region,
                role_name,
                payload.query_string,
                payload.max_results or 50,
            )
        )

    results = await asyncio.gather(*futures)
    return schemas.IotCertificateSearchResponse(results=list(results))


async def _immediate_cert_error(environment_id: int, environment_name: str, account_id: str, region: str, error: str):
    return schemas.IotCertificateSearchResultItem(
        environment_id=environment_id,
        environment_name=environment_name,
        account_id=account_id,
        region=region,
        certificates=[],
        error=error,
    )


@router.post("/certificates/detail", response_model=schemas.IotCertificateDetail)
def get_certificate_detail(
    payload: schemas.IotCertificateDetailRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    try:
        environment = resolve_environment(db, payload.environment_id, current_user)
        role_name = resolve_role_name(current_user)
    except ResolveError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    try:
        detail = iot_client.get_certificate_detail(
            environment.account_id, environment.region, role_name, payload.certificate_id
        )
    except Exception as e:  # noqa: BLE001
        raise HTTPException(
            status_code=502, detail=f"Failed to load certificate '{payload.certificate_id}': {e}"
        ) from e

    return schemas.IotCertificateDetail(**detail)
