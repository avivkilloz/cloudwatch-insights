from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import audit, auth, connections, credential_store, models, pane_access, schemas
from ..db import get_db

router = APIRouter(prefix="/api/user-groups", tags=["user-groups"])


def _group_out(db: Session, group: models.UserGroup) -> schemas.UserGroupOut:
    environment_ids = [link.environment_id for link in group.environment_links]
    user_count = db.query(models.User).filter(models.User.group_id == group.id).count()
    # Access to panes is the grants (D65); the booleans are what they add up to.
    flags = pane_access.legacy_flags(group)
    return schemas.UserGroupOut(
        id=group.id,
        name=group.name,
        # The role of the group's default AWS identity (D31), in the field
        # the old shape had for it.
        role_name=connections.group_role_name(db, group),
        is_admin=group.is_admin,
        **flags,
        aggregator_enabled=group.aggregator_enabled,
        agent_enabled=group.agent_enabled,
        builder_enabled=group.builder_enabled,
        environment_ids=environment_ids,
        user_count=user_count,
        pane_types=sorted(pane_access.granted(group)),
    )


def _set_panes(db: Session, group: models.UserGroup, pane_types: list[str] | None, flags: dict) -> None:
    """The exact list when one is sent, else the booleans as shorthand."""
    try:
        if pane_types is not None:
            pane_access.set_grants(db, group, pane_types)
        else:
            pane_access.apply_legacy(db, group, flags)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from None


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
    data = payload.model_dump(exclude={"environment_ids", "role_name", "pane_types"})
    group = models.UserGroup(**data)
    db.add(group)
    db.flush()
    _set_environment_access(db, group, payload.environment_ids)
    _set_panes(db, group, payload.pane_types, {f: data[f] for f in pane_access.LEGACY_FLAGS})
    if payload.role_name:
        connections.set_group_role(db, _admin, group, payload.role_name)
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
    pane_types = data.pop("pane_types", None)
    flags = {f: data[f] for f in pane_access.LEGACY_FLAGS if f in data}
    if pane_types is not None or flags:
        _set_panes(db, group, pane_types, flags)
    if "role_name" in data:
        connections.set_group_role(db, _admin, group, data.pop("role_name"))
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


# ------------------------------------------------------------------- identities (D31)


def _identity_out(ident: models.GroupIdentity) -> schemas.GroupIdentityOut:
    return schemas.GroupIdentityOut(
        connection_type_id=ident.connection_type_id,
        connection_id=ident.connection_id,
        credential_id=ident.credential_id,
        connection_label=connections.label(ident.connection) if ident.connection else None,
        credential_name=ident.credential.name,
        credential_type=ident.credential.type.label,
    )


def _identities(db: Session, group: models.UserGroup) -> list[schemas.GroupIdentityOut]:
    rows = (
        db.query(models.GroupIdentity)
        .filter(models.GroupIdentity.group_id == group.id)
        .order_by(models.GroupIdentity.connection_type_id, models.GroupIdentity.connection_id.nullsfirst())
        .all()
    )
    return [_identity_out(r) for r in rows]


@router.get("/{group_id}/identities", response_model=list[schemas.GroupIdentityOut])
def list_group_identities(group_id: int, db: Session = Depends(get_db), _admin: models.User = Depends(auth.require_admin)):
    group = db.get(models.UserGroup, group_id)
    if not group:
        raise HTTPException(status_code=404, detail="Group not found")
    return _identities(db, group)


@router.put("/{group_id}/identities", response_model=list[schemas.GroupIdentityOut])
def set_group_identities(
    group_id: int,
    payload: schemas.GroupIdentitiesIn,
    db: Session = Depends(get_db),
    admin: models.User = Depends(auth.require_admin),
):
    """Replaces who the group is on each kind of connection: a default per
    connection type and overrides per connection. Each must be a credential
    the group can use (its own, or a global one granted to it, D15) of a type
    the connection type accepts; both are checked again on every use."""
    group = db.get(models.UserGroup, group_id)
    if not group:
        raise HTTPException(status_code=404, detail="Group not found")
    seen = set()
    rows = []
    for item in payload.identities:
        conn_type = db.get(models.ConnectionType, item.connection_type_id)
        if conn_type is None:
            raise HTTPException(status_code=400, detail=f"There is no connection type '{item.connection_type_id}'.")
        key = (item.connection_type_id, item.connection_id)
        if key in seen:
            raise HTTPException(status_code=400, detail="Each connection type and connection can have one identity.")
        seen.add(key)
        if item.connection_id is not None:
            conn = db.get(models.Connection, item.connection_id)
            if conn is None or conn.type_id != conn_type.id:
                raise HTTPException(status_code=400, detail=f"There is no {conn_type.label} connection {item.connection_id}.")
        cred = db.get(models.Credential, item.credential_id)
        if cred is None or not credential_store.usable_by_group(db, group, cred):
            raise HTTPException(
                status_code=400,
                detail=f"{group.name} can't use that credential: it must be the group's own or granted to it.",
            )
        if not connections.accepts(conn_type, cred.type):
            raise HTTPException(
                status_code=400, detail=f"A {cred.type.label} credential can't be an identity on {conn_type.label} connections."
            )
        rows.append(item)
    db.query(models.GroupIdentity).filter(models.GroupIdentity.group_id == group.id).delete()
    db.flush()
    for item in rows:
        db.add(
            models.GroupIdentity(
                group_id=group.id,
                connection_type_id=item.connection_type_id,
                connection_id=item.connection_id,
                credential_id=item.credential_id,
            )
        )
    audit.record(
        db, actor=admin, action="identity.set", object_type="user_group", object_id=group.id, group_id=group.id,
        detail={"identities": [{"type": i.connection_type_id, "connection": i.connection_id, "credential": i.credential_id} for i in rows]},
    )
    db.commit()
    return _identities(db, group)
