from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from urllib.parse import urlparse

from .. import auth, connections, credential_store, credential_types, iot_mqtt_signer, masking, models, schemas, tools_http_client
from ..db import get_db
from ..resolve import ResolveError, require_flag, resolve_identity, resolve_identity_values, resolve_target

router = APIRouter(prefix="/api/tools", tags=["tools"])


@router.post("/http-request", response_model=schemas.HttpToolResponse)
def send_http_request(
    payload: schemas.HttpToolRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    try:
        require_flag(current_user, "tools_enabled", "Tools")
    except ResolveError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    url = payload.url
    headers = {h.key: h.value for h in payload.headers}
    if payload.target_id is not None:
        url, headers = _through_target(db, current_user, payload, headers)
    if payload.credential_id is not None:
        # Resolved and applied here, server-side: the browser only ever named
        # the credential. resolve() checks the caller's group may use it,
        # audits the use, and registers its values for masking below.
        host = urlparse(url).hostname or url
        try:
            type_row, values = credential_store.resolve(
                db, payload.credential_id, actor=current_user, purpose=f"HTTP client: {payload.method} {host}"
            )
            url, headers = credential_types.apply_inject(type_row, values, url, headers)
        except credential_store.CredentialsOff as e:
            raise HTTPException(status_code=503, detail=str(e)) from None
        except credential_store.CredentialAccessError as e:
            raise HTTPException(status_code=404, detail=str(e)) from None
        except (credential_store.CredentialError, credential_types.CredentialTypeError) as e:
            raise HTTPException(status_code=400, detail=masking.mask(str(e))) from None
    try:
        result = tools_http_client.send_request(payload.method, url, headers=headers, body=payload.body)
    except tools_http_client.ToolRequestError as e:
        raise HTTPException(status_code=400, detail=masking.mask(str(e))) from e
    except Exception as e:  # noqa: BLE001 - surface connection/timeout/etc. errors to the caller
        raise HTTPException(status_code=502, detail=masking.mask(f"Request failed: {e}")) from e

    # A server that echoes the request (httpbin and friends) would hand the
    # injected secret straight back; whatever resolve() decrypted is masked.
    return schemas.HttpToolResponse(
        status_code=result["status_code"],
        status_text=masking.mask(result["status_text"]),
        headers=[schemas.ToolHeader(key=h["key"], value=masking.mask(h["value"])) for h in result["headers"]],
        body=masking.mask(result["body"]),
        body_truncated=result["body_truncated"],
        elapsed_ms=result["elapsed_ms"],
    )


def _through_target(
    db: Session, current_user: models.User, payload: schemas.HttpToolRequest, headers: dict[str, str]
) -> tuple[str, dict[str, str]]:
    """The URL on an HTTP API connection (D33), and its identity applied
    unless the request names a credential of its own. The joined URL still
    goes through the SSRF guard in send_request, like any other."""
    try:
        target = resolve_target(db, payload.target_id, current_user, type_id=connections.HTTP_API)
    except ResolveError as e:
        raise HTTPException(status_code=400, detail=str(e)) from None
    path = payload.url.strip()
    if urlparse(path).scheme:
        raise HTTPException(
            status_code=400,
            detail=f"With {target.name} picked, give a path (e.g. /status), not a whole URL: it goes after "
            f"{target.config['base_url']}.",
        )
    url = connections.join_url(target.config["base_url"], path)
    if payload.credential_id is not None:
        return url, headers
    # A public API needs no identity: only one that exists is applied.
    if connections.group_identity(db, current_user.group, target.connection) is None and target.connection.credential_id is None:
        return url, headers
    try:
        type_row, values = resolve_identity_values(db, target, current_user)
        return credential_types.apply_inject(type_row, values, url, headers)
    except ResolveError as e:
        raise HTTPException(status_code=400, detail=masking.mask(str(e))) from None
    except credential_types.CredentialTypeError as e:
        raise HTTPException(status_code=400, detail=masking.mask(str(e))) from None


@router.post("/mqtt/presigned-url", response_model=schemas.MqttPresignedUrlResponse)
def get_mqtt_presigned_url(
    payload: schemas.MqttPresignedUrlRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    try:
        require_flag(current_user, "tools_enabled", "Tools")
        environment = resolve_target(db, payload.environment_id, current_user)
        identity = resolve_identity(db, environment, current_user)
    except ResolveError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    try:
        result = iot_mqtt_signer.build_presigned_ws_url(environment.account_id, environment.region, identity)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Failed to build MQTT connection URL: {e}") from e

    diagnostic = iot_mqtt_signer.probe_presigned_url(result["url"])

    return schemas.MqttPresignedUrlResponse(
        endpoint=result["endpoint"],
        url=result["url"],
        expires_in=iot_mqtt_signer.DEFAULT_EXPIRES_SECONDS,
        diagnostic_status_code=diagnostic["status_code"],
        diagnostic_body=diagnostic["body"],
        diagnostic_headers=diagnostic["headers"],
    )
