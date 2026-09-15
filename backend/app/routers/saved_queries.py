from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import models, schemas
from ..db import get_db

router = APIRouter(prefix="/api/saved-queries", tags=["saved-queries"])


@router.get("", response_model=list[schemas.SavedQueryOut])
def list_saved_queries(db: Session = Depends(get_db)):
    return db.query(models.SavedQuery).order_by(models.SavedQuery.name).all()


@router.post("", response_model=schemas.SavedQueryOut, status_code=201)
def create_saved_query(payload: schemas.SavedQueryCreate, db: Session = Depends(get_db)):
    saved = models.SavedQuery(**payload.model_dump())
    db.add(saved)
    db.commit()
    db.refresh(saved)
    return saved


@router.delete("/{saved_query_id}", status_code=204)
def delete_saved_query(saved_query_id: int, db: Session = Depends(get_db)):
    saved = db.get(models.SavedQuery, saved_query_id)
    if not saved:
        raise HTTPException(status_code=404, detail="Saved query not found")
    db.delete(saved)
    db.commit()
    return None
