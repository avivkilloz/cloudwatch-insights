"""Downloads from the blob store (D91): checked against what the file belongs
to before a byte leaves -- a run's files are its readers' (D84)."""

from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from sqlalchemy.orm import Session

from .. import auth, blobs, models, workflows
from ..db import get_db

router = APIRouter(prefix="/api/blobs", tags=["blobs"])


@router.get("/{blob_id}")
def download(blob_id: str, db: Session = Depends(get_db), user: models.User = Depends(auth.get_current_user)):
    row = db.get(models.Blob, blob_id)
    run = db.get(models.WorkflowRun, row.run_id) if row is not None and row.run_id else None
    if row is None or run is None or not workflows.can_read(user, run):
        # The same answer for "no such file" and "not yours": an id says nothing.
        raise HTTPException(status_code=404, detail="There is no such file for you.")
    try:
        data = blobs.read(row)
    except blobs.BlobError as e:
        raise HTTPException(status_code=502, detail=str(e)) from None
    return Response(
        content=data,
        media_type=row.content_type,
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{quote(row.name)}",
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, no-store",
        },
    )
