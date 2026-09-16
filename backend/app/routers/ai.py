import httpx
from fastapi import APIRouter, HTTPException

from .. import ai_assistant, schemas

router = APIRouter(prefix="/api/ai", tags=["ai"])

# Cap how many result rows go into a request to keep the payload (and the
# resulting token cost) bounded -- the frontend already caps this before
# sending, this is a second, authoritative limit on the backend.
MAX_SAMPLE_ROWS = 50


@router.get("/status", response_model=schemas.AiStatus)
def get_status():
    return schemas.AiStatus(configured=ai_assistant.is_configured())


@router.post("/assist", response_model=schemas.AiAssistResponse)
def assist(payload: schemas.AiAssistRequest):
    try:
        reply = ai_assistant.chat(
            payload.mode,
            [m.model_dump() for m in payload.messages],
            query_string=payload.query_string,
            sample_rows=payload.sample_rows[:MAX_SAMPLE_ROWS],
            row_count=payload.row_count,
        )
    except ai_assistant.AiNotConfiguredError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"AI assistant request failed: {e}") from e

    suggested_query = ai_assistant.extract_code_block(reply) if payload.mode == "build_query" else None
    return schemas.AiAssistResponse(reply=reply, suggested_query=suggested_query)
