from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import auth, models, schemas
from ..db import get_db

router = APIRouter(prefix="/api/user-groups", tags=["user-groups"])


def _group_out(db: Session, group: models.UserGroup) -> schemas.UserGroupOut:
    environment_ids = [link.environment_id for link in group.environment_links]
    user_count = db.query(models.User).filter(models.User.group_id == group.id).count()
    return schemas.UserGroupOut(
        id=group.id,
        name=group.name,
        role_name=group.role_name,
        is_admin=group.is_admin,
        logs_enabled=group.logs_enabled,
        opensearch_enabled=group.opensearch_enabled,
        iot_enabled=group.iot_enabled,
        tables_enabled=group.tables_enabled,
        buckets_enabled=group.buckets_enabled,
        cognito_enabled=group.cognito_enabled,
        aggregator_enabled=group.aggregator_enabled,
        tools_enabled=group.tools_enabled,
        environment_ids=environment_ids,
        user_count=user_count,
    )


def _set_environment_access(db: Session, group: models.UserGroup, environment_ids: list[int]) -> None:
    db.query(models.GroupEnvironmentAccess).filter(models.GroupEnvironmentAccess.group_id == group.id).delete()
    valid_ids = {
        e.id for e in db.query(models.Environment.id).filter(models.Environment.id.in_(environment_ids)).all()
    }
    for environment_id in valid_ids:
        db.add(models.GroupEnvironmentAccess(group_id=group.id, environment_id=environment_id))


@router.get("", response_model=list[schemas.UserGroupOut])
def list_user_groups(db: Session = Depends(get_db), _admin: models.User = Depends(auth.require_admin)):
    groups = db.query(models.UserGroup).order_by(models.UserGroup.name).all()
    return [_group_out(db, g) for g in groups]


@router.post("", response_model=schemas.UserGroupOut, status_code=201)
def create_user_group(
    payload: schemas.UserGroupCreate, db: Session = Depends(get_db), _admin: models.User = Depends(auth.require_admin)
):
    if db.query(models.UserGroup).filter(models.UserGroup.name == payload.name).first():
        raise HTTPException(status_code=400, detail="A group with that name already exists")
    data = payload.model_dump(exclude={"environment_ids"})
    group = models.UserGroup(**data)
    db.add(group)
    db.flush()
    _set_environment_access(db, group, payload.environment_ids)
    db.commit()
    db.refresh(group)
    return _group_out(db, group)


@router.put("/{group_id}", response_model=schemas.UserGroupOut)
def update_user_group(
    group_id: int,
    payload: schemas.UserGroupUpdate,
    db: Session = Depends(get_db),
    _admin: models.User = Depends(auth.require_admin),
):
    group = db.get(models.UserGroup, group_id)
    if not group:
        raise HTTPException(status_code=404, detail="Group not found")
    data = payload.model_dump(exclude_unset=True)
    environment_ids = data.pop("environment_ids", None)
    for key, value in data.items():
        setattr(group, key, value)
    if environment_ids is not None:
        _set_environment_access(db, group, environment_ids)
    db.commit()
    db.refresh(group)
    return _group_out(db, group)


@router.delete("/{group_id}", status_code=204)
def delete_user_group(
    group_id: int, db: Session = Depends(get_db), _admin: models.User = Depends(auth.require_admin)
):
    group = db.get(models.UserGroup, group_id)
    if not group:
        raise HTTPException(status_code=404, detail="Group not found")
    if group.is_admin:
        raise HTTPException(status_code=400, detail="The Admin group can't be deleted")
    if db.query(models.User).filter(models.User.group_id == group.id).count() > 0:
        raise HTTPException(status_code=400, detail="Move or remove this group's users before deleting it")
    db.delete(group)
    db.commit()
    return None
