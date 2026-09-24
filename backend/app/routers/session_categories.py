"""Slack-style groups for the side panel's session list.

A category is just a name and a position -- LiveSession.category_id is what
actually puts a session in one, and that assignment travels with the session
itself through the live-sessions PUT rather than through a route here.
Deleting a category leaves its sessions in place, ungrouped (category_id is
ON DELETE SET NULL at the database level).
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .. import auth, models, schemas
from ..db import get_db

router = APIRouter(prefix="/api/session-categories", tags=["session-categories"])


def _owned(db: Session, user: models.User, category_id: int) -> models.SessionCategory:
    row = (
        db.query(models.SessionCategory)
        .filter(models.SessionCategory.user_id == user.id, models.SessionCategory.id == category_id)
        .one_or_none()
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Category not found")
    return row


@router.get("", response_model=list[schemas.SessionCategoryOut])
def list_session_categories(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    return (
        db.query(models.SessionCategory)
        .filter(models.SessionCategory.user_id == current_user.id)
        .order_by(models.SessionCategory.position, models.SessionCategory.id)
        .all()
    )


@router.post("", response_model=schemas.SessionCategoryOut, status_code=201)
def create_session_category(
    payload: schemas.SessionCategoryCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Category name can't be empty.")
    position = (
        db.query(models.SessionCategory).filter(models.SessionCategory.user_id == current_user.id).count()
    )
    category = models.SessionCategory(user_id=current_user.id, name=name, position=position)
    db.add(category)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail=f'A category named "{name}" already exists.')
    db.refresh(category)
    return category


@router.put("/{category_id}", response_model=schemas.SessionCategoryOut)
def rename_session_category(
    category_id: int,
    payload: schemas.SessionCategoryUpdate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    category = _owned(db, current_user, category_id)
    if payload.name is not None:
        name = payload.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="Category name can't be empty.")
        category.name = name
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail=f'A category named "{payload.name}" already exists.')
    db.refresh(category)
    return category


@router.post("/reorder", response_model=list[schemas.SessionCategoryOut])
def reorder_session_categories(
    payload: schemas.SessionCategoryOrder,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    rows = {
        row.id: row
        for row in db.query(models.SessionCategory).filter(models.SessionCategory.user_id == current_user.id)
    }
    for position, category_id in enumerate(payload.ids):
        row = rows.get(category_id)
        if row is not None:
            row.position = position
    db.commit()
    return list_session_categories(db=db, current_user=current_user)


@router.delete("/{category_id}", status_code=204)
def delete_session_category(
    category_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    db.delete(_owned(db, current_user, category_id))
    db.commit()
    return None
