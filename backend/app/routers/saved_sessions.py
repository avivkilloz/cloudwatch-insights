from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import auth, models, schemas
from ..db import get_db

router = APIRouter(prefix="/api/saved-sessions", tags=["saved-sessions"])


@router.get("", response_model=list[schemas.SavedSessionOut])
def list_saved_sessions(
    page: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    query = db.query(models.SavedSession).filter(models.SavedSession.user_id == current_user.id)
    if page:
        query = query.filter(models.SavedSession.page == page)
    return query.order_by(models.SavedSession.name).all()


@router.post("", response_model=schemas.SavedSessionOut, status_code=201)
def create_saved_session(
    payload: schemas.SavedSessionCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    saved = models.SavedSession(**payload.model_dump(), user_id=current_user.id)
    db.add(saved)
    db.commit()
    db.refresh(saved)
    return saved


@router.put("/{saved_session_id}", response_model=schemas.SavedSessionOut)
def update_saved_session(
    saved_session_id: int,
    payload: schemas.SavedSessionUpdate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    saved = db.get(models.SavedSession, saved_session_id)
    if not saved or saved.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Saved session not found")
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(saved, key, value)
    db.commit()
    db.refresh(saved)
    return saved


@router.delete("/{saved_session_id}", status_code=204)
def delete_saved_session(
    saved_session_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    saved = db.get(models.SavedSession, saved_session_id)
    if not saved or saved.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Saved session not found")
    db.delete(saved)
    db.commit()
    return None
