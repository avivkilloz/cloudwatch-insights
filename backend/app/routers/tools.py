from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import iot_mqtt_signer, schemas, tools_http_client
from ..db import get_db
from ..resolve import ResolveError, resolve_environment, resolve_role_name

router = APIRouter(prefix="/api/tools", tags=["tools"])


@router.post("/http-request", response_model=schemas.HttpToolResponse)
def send_http_request(payload: schemas.HttpToolRequest):
    headers = {h.key: h.value for h in payload.headers}
    try:
        result = tools_http_client.send_request(payload.method, payload.url, headers=headers, body=payload.body)
    except tools_http_client.ToolRequestError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:  # noqa: BLE001 - surface connection/timeout/etc. errors to the caller
        raise HTTPException(status_code=502, detail=f"Request failed: {e}") from e

    return schemas.HttpToolResponse(
        status_code=result["status_code"],
        status_text=result["status_text"],
        headers=[schemas.ToolHeader(**h) for h in result["headers"]],
        body=result["body"],
        body_truncated=result["body_truncated"],
        elapsed_ms=result["elapsed_ms"],
    )


@router.post("/mqtt/presigned-url", response_model=schemas.MqttPresignedUrlResponse)
def get_mqtt_presigned_url(payload: schemas.MqttPresignedUrlRequest, db: Session = Depends(get_db)):
    try:
        environment = resolve_environment(db, payload.environment_id)
        role_name = resolve_role_name(db, environment)
    except ResolveError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    try:
        result = iot_mqtt_signer.build_presigned_ws_url(environment.account_id, environment.region, role_name)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Failed to build MQTT connection URL: {e}") from e

    diagnostic = iot_mqtt_signer.probe_presigned_url(result["url"])

    return schemas.MqttPresignedUrlResponse(
        endpoint=result["endpoint"],
        url=result["url"],
        expires_in=iot_mqtt_signer.DEFAULT_EXPIRES_SECONDS,
        diagnostic_status_code=diagnostic["status_code"],
        diagnostic_body=diagnostic["body"],
    )
