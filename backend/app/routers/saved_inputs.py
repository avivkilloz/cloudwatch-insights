"""Saved inputs (PLATFORM_PLAN.md D46, §16.3.4): a pane's inputs under a
name, by pane type, for "Save as…" / "Load…" on every manifest pane and
Settings → Library. Each user's own, like templates.

What is stored is what the pane's manifest says is an input and isn't
`sensitive`, whatever the browser sends: a JWT pasted into a pane can never
end up here, even from a client that doesn't know the rule."""

from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import auth, models, schemas
from ..db import get_db
from ..panes import manifest as pane_manifest

router = APIRouter(prefix="/api/saved-inputs", tags=["saved-inputs"])


def _keep(pane_type: str, inputs: dict[str, Any]) -> dict[str, Any]:
    manifest = pane_manifest.get(pane_type)
    if manifest is None:
        raise HTTPException(status_code=400, detail=f"There is no pane type '{pane_type}'.")
    allowed = {i.key for i in manifest.inputs if not i.sensitive}
    return {k: v for k, v in inputs.items() if k in allowed}


def _own(db: Session, saved_id: int, user: models.User) -> models.SavedInput:
    saved = db.get(models.SavedInput, saved_id)
    if saved is None or saved.user_id != user.id:
        raise HTTPException(status_code=404, detail="Those saved inputs don't exist, or aren't yours.")
    return saved


@router.get("", response_model=list[schemas.SavedInputOut])
def list_saved_inputs(
    pane_type: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    query = db.query(models.SavedInput).filter(models.SavedInput.user_id == current_user.id)
    if pane_type:
        query = query.filter(models.SavedInput.pane_type == pane_type)
    return query.order_by(models.SavedInput.pane_type, models.SavedInput.name).all()


@router.post("", response_model=schemas.SavedInputOut, status_code=201)
def create_saved_inputs(
    payload: schemas.SavedInputCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    saved = models.SavedInput(
        user_id=current_user.id,
        pane_type=payload.pane_type,
        name=payload.name.strip(),
        inputs=_keep(payload.pane_type, payload.inputs),
    )
    db.add(saved)
    db.commit()
    db.refresh(saved)
    return saved


@router.put("/{saved_id}", response_model=schemas.SavedInputOut)
def update_saved_inputs(
    saved_id: int,
    payload: schemas.SavedInputUpdate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    saved = _own(db, saved_id, current_user)
    if payload.name is not None:
        saved.name = payload.name.strip()
    if payload.inputs is not None:
        saved.inputs = _keep(saved.pane_type, payload.inputs)
    db.commit()
    db.refresh(saved)
    return saved


@router.delete("/{saved_id}", status_code=204)
def delete_saved_inputs(
    saved_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    db.delete(_own(db, saved_id, current_user))
    db.commit()
