from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import auth, models, schemas
from ..db import get_db

router = APIRouter(prefix="/api/environments", tags=["environments"])


@router.get("", response_model=list[schemas.EnvironmentOut])
def list_environments(
    db: Session = Depends(get_db), current_user: models.User = Depends(auth.get_current_user)
):
    query = db.query(models.Environment)
    group = current_user.group
    if not group or not group.is_admin:
        group_id = group.id if group else -1
        query = query.join(
            models.GroupEnvironmentAccess,
            models.GroupEnvironmentAccess.environment_id == models.Environment.id,
        ).filter(models.GroupEnvironmentAccess.group_id == group_id)
    return query.order_by(models.Environment.name).all()


@router.post("", response_model=schemas.EnvironmentOut, status_code=201)
def create_environment(
    payload: schemas.EnvironmentCreate, db: Session = Depends(get_db), _admin: models.User = Depends(auth.require_admin)
):
    environment = models.Environment(**payload.model_dump())
    db.add(environment)
    db.commit()
    db.refresh(environment)
    return environment


@router.put("/{environment_id}", response_model=schemas.EnvironmentOut)
def update_environment(
    environment_id: int,
    payload: schemas.EnvironmentUpdate,
    db: Session = Depends(get_db),
    _admin: models.User = Depends(auth.require_admin),
):
    environment = db.get(models.Environment, environment_id)
    if not environment:
        raise HTTPException(status_code=404, detail="Environment not found")
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(environment, key, value)
    db.commit()
    db.refresh(environment)
    return environment


@router.delete("/{environment_id}", status_code=204)
def delete_environment(
    environment_id: int, db: Session = Depends(get_db), _admin: models.User = Depends(auth.require_admin)
):
    environment = db.get(models.Environment, environment_id)
    if not environment:
        raise HTTPException(status_code=404, detail="Environment not found")
    db.delete(environment)
    db.commit()
    return None
