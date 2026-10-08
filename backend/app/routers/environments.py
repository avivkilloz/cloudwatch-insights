"""Environments and their connections (PLATFORM_PLAN.md §14.7).

An environment is a named group of connections; the old one-account shape
(`account_id`/`region` on the environment) still works in and out (D34) --
it is the environment's first AWS connection, which takes the environment's
own id, so every id stored before connections existed keeps its meaning.
"""

import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import audit, auth, aws_client, connections, credential_types, masking, models, schemas, tools_http_client
from ..db import get_db
from ..resolve import ResolveError, Target, group_can_access_environment, resolve_identity, resolve_identity_values

router = APIRouter(prefix="/api/environments", tags=["environments"])
connections_router = APIRouter(prefix="/api/connections", tags=["environments"])
types_router = APIRouter(prefix="/api/connection-types", tags=["environments"])
targets_router = APIRouter(prefix="/api/targets", tags=["environments"])


def _connection_out(conn: models.Connection) -> schemas.ConnectionOut:
    return schemas.ConnectionOut(
        id=conn.id,
        environment_id=conn.environment_id,
        type_id=conn.type_id,
        type_label=conn.type.label if conn.type else conn.type_id,
        name=conn.name,
        label=connections.label(conn),
        config=dict(conn.config or {}),
        credential_id=conn.credential_id,
        credential_name=conn.credential.name if conn.credential else None,
        position=conn.position or 0,
    )


def _environment_out(db: Session, env: models.Environment, admin: bool) -> schemas.EnvironmentOut:
    group_ids = []
    if admin:
        group_ids = [
            row.group_id
            for row in db.query(models.GroupEnvironmentAccess).filter(
                models.GroupEnvironmentAccess.environment_id == env.id
            )
        ]
    return schemas.EnvironmentOut(
        id=env.id,
        name=env.name,
        description=env.description,
        connections=[_connection_out(c) for c in env.connections],
        group_ids=sorted(group_ids),
        **connections.environment_summary(env),
    )


def _is_admin(user: models.User) -> bool:
    return bool(user.group and user.group.is_admin)


def _environment(db: Session, environment_id: int) -> models.Environment:
    env = db.get(models.Environment, environment_id)
    if env is None:
        raise HTTPException(status_code=404, detail="Environment not found")
    return env


def _connection(db: Session, connection_id: int) -> models.Connection:
    conn = db.get(models.Connection, connection_id)
    if conn is None:
        raise HTTPException(status_code=404, detail="Connection not found")
    return conn


def _type(db: Session, type_id: str) -> models.ConnectionType:
    row = db.get(models.ConnectionType, type_id)
    if row is None:
        raise HTTPException(status_code=400, detail=f"There is no connection type '{type_id}'.")
    return row


def _check_credential(db: Session, conn_type: models.ConnectionType, credential_id: Optional[int]) -> None:
    if credential_id is None:
        return
    cred = db.get(models.Credential, credential_id)
    if cred is None:
        raise HTTPException(status_code=400, detail="That credential doesn't exist.")
    if not connections.accepts(conn_type, cred.type):
        raise HTTPException(
            status_code=400, detail=f"A {cred.type.label} credential can't be used on {conn_type.label} connections."
        )


def _new_connection(
    db: Session,
    actor: models.User,
    env: models.Environment,
    conn_type: models.ConnectionType,
    name: str,
    config: dict,
    credential_id: Optional[int] = None,
) -> models.Connection:
    name = name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Give the connection a name, e.g. iot.")
    if any(c.name == name for c in env.connections):
        raise HTTPException(status_code=400, detail=f"{env.name} already has a connection called {name}.")
    try:
        config = connections.validate_config(conn_type, config)
    except connections.ConnectionConfigError as e:
        raise HTTPException(status_code=400, detail=str(e)) from None
    _check_credential(db, conn_type, credential_id)
    conn = models.Connection(
        environment_id=env.id,
        type_id=conn_type.id,
        name=name,
        config=config,
        credential_id=credential_id,
        position=len(env.connections),
    )
    # An environment's first connection takes the environment's own id, so an
    # id that named the environment (in a URL, a saved pane) names its
    # connection too. Never taken: both come from one sequence (models.Connection).
    if not env.connections and db.get(models.Connection, env.id) is None:
        conn.id = env.id
    db.add(conn)
    db.flush()
    db.refresh(env)
    audit.record(
        db, actor=actor, action="connection.create", object_type="connection", object_id=conn.id,
        detail={"environment": env.name, "name": name, "type": conn_type.id},
    )
    return conn


def _set_groups(db: Session, env: models.Environment, group_ids: list[int]) -> None:
    db.query(models.GroupEnvironmentAccess).filter(models.GroupEnvironmentAccess.environment_id == env.id).delete()
    for group in db.query(models.UserGroup).filter(models.UserGroup.id.in_(group_ids)):
        db.add(models.GroupEnvironmentAccess(group_id=group.id, environment_id=env.id))


# ------------------------------------------------------------------- environments


@router.get("", response_model=list[schemas.EnvironmentOut])
def list_environments(db: Session = Depends(get_db), current_user: models.User = Depends(auth.get_current_user)):
    envs = connections.visible_environments(db, current_user).order_by(models.Environment.name).all()
    admin = _is_admin(current_user)
    return [_environment_out(db, e, admin) for e in envs]


@router.post("", response_model=schemas.EnvironmentOut, status_code=201)
def create_environment(
    payload: schemas.EnvironmentCreate, db: Session = Depends(get_db), admin: models.User = Depends(auth.require_admin)
):
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Give the environment a name.")
    env = models.Environment(name=name, description=payload.description or None)
    db.add(env)
    db.flush()
    audit.record(db, actor=admin, action="environment.create", object_type="environment", object_id=env.id,
                 detail={"name": name})
    if payload.account_id or payload.region:
        _new_connection(
            db, admin, env, _type(db, connections.AWS), "aws",
            {"account_id": payload.account_id, "region": payload.region},
        )
    db.commit()
    db.refresh(env)
    return _environment_out(db, env, True)


@router.put("/{environment_id}", response_model=schemas.EnvironmentOut)
@router.patch("/{environment_id}", response_model=schemas.EnvironmentOut)
def update_environment(
    environment_id: int,
    payload: schemas.EnvironmentUpdate,
    db: Session = Depends(get_db),
    admin: models.User = Depends(auth.require_admin),
):
    env = _environment(db, environment_id)
    data = payload.model_dump(exclude_unset=True)
    changed = []
    if data.get("name") is not None and data["name"].strip() and data["name"].strip() != env.name:
        env.name = data["name"].strip()
        changed.append("name")
    if "description" in data and (data["description"] or None) != env.description:
        env.description = data["description"] or None
        changed.append("description")
    if "account_id" in data or "region" in data:
        # The old shape: edit its first AWS connection, or create one.
        aws = next((c for c in env.connections if c.type_id == connections.AWS), None)
        if aws is None:
            _new_connection(
                db, admin, env, _type(db, connections.AWS), "aws",
                {"account_id": data.get("account_id"), "region": data.get("region")},
            )
        else:
            config = {**(aws.config or {}), **{k: data[k] for k in ("account_id", "region") if data.get(k)}}
            try:
                aws.config = connections.validate_config(aws.type, config)
            except connections.ConnectionConfigError as e:
                raise HTTPException(status_code=400, detail=str(e)) from None
        changed.append("connection")
    if changed:
        audit.record(db, actor=admin, action="environment.update", object_type="environment", object_id=env.id,
                     detail={"changed": changed})
    db.commit()
    db.refresh(env)
    return _environment_out(db, env, True)


@router.put("/{environment_id}/groups", response_model=schemas.EnvironmentOut)
def set_environment_groups(
    environment_id: int,
    payload: schemas.EnvironmentGroups,
    db: Session = Depends(get_db),
    admin: models.User = Depends(auth.require_admin),
):
    """Which groups see it: the same data as a group's own environment list, editable from this side."""
    env = _environment(db, environment_id)
    _set_groups(db, env, payload.group_ids)
    audit.record(db, actor=admin, action="environment.groups", object_type="environment", object_id=env.id,
                 detail={"group_ids": sorted(payload.group_ids)})
    db.commit()
    return _environment_out(db, env, True)


@router.delete("/{environment_id}", status_code=204)
def delete_environment(
    environment_id: int, db: Session = Depends(get_db), admin: models.User = Depends(auth.require_admin)
):
    env = _environment(db, environment_id)
    audit.record(db, actor=admin, action="environment.delete", object_type="environment", object_id=env.id,
                 detail={"name": env.name})
    db.delete(env)
    db.commit()
    return None


@router.post("/{environment_id}/connections", response_model=schemas.ConnectionOut, status_code=201)
def add_connection(
    environment_id: int,
    payload: schemas.ConnectionCreate,
    db: Session = Depends(get_db),
    admin: models.User = Depends(auth.require_admin),
):
    env = _environment(db, environment_id)
    conn = _new_connection(db, admin, env, _type(db, payload.type_id), payload.name, payload.config, payload.credential_id)
    db.commit()
    db.refresh(conn)
    return _connection_out(conn)


# ------------------------------------------------------------------- connections


@connections_router.patch("/{connection_id}", response_model=schemas.ConnectionOut)
def update_connection(
    connection_id: int,
    payload: schemas.ConnectionUpdate,
    db: Session = Depends(get_db),
    admin: models.User = Depends(auth.require_admin),
):
    conn = _connection(db, connection_id)
    changed = []
    if payload.name is not None and payload.name.strip() != conn.name:
        name = payload.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="Give the connection a name.")
        if any(c.name == name and c.id != conn.id for c in conn.environment.connections):
            raise HTTPException(status_code=400, detail=f"{conn.environment.name} already has a connection called {name}.")
        conn.name = name
        changed.append("name")
    if payload.config is not None:
        try:
            config = connections.validate_config(conn.type, payload.config)
        except connections.ConnectionConfigError as e:
            raise HTTPException(status_code=400, detail=str(e)) from None
        if config != conn.config:
            conn.config = config
            changed.append("config")
    if payload.clear_credential and conn.credential_id is not None:
        conn.credential_id = None
        changed.append("credential")
    elif payload.credential_id is not None and payload.credential_id != conn.credential_id:
        _check_credential(db, conn.type, payload.credential_id)
        conn.credential_id = payload.credential_id
        changed.append("credential")
    if payload.position is not None and payload.position != conn.position:
        conn.position = payload.position
        changed.append("position")
    if changed:
        conn.updated_at = datetime.datetime.utcnow()
        audit.record(db, actor=admin, action="connection.update", object_type="connection", object_id=conn.id,
                     detail={"changed": changed})
    db.commit()
    db.refresh(conn)
    return _connection_out(conn)


@connections_router.delete("/{connection_id}", status_code=204)
def delete_connection(
    connection_id: int, db: Session = Depends(get_db), admin: models.User = Depends(auth.require_admin)
):
    # Not blocked by sessions that use it: a pane pointed at it says "not
    # configured", as it does for a deleted environment, and is re-pointed.
    conn = _connection(db, connection_id)
    audit.record(db, actor=admin, action="connection.delete", object_type="connection", object_id=conn.id,
                 detail={"environment": conn.environment.name, "name": conn.name})
    db.delete(conn)
    db.commit()
    return None


@connections_router.post("/{connection_id}/test", response_model=schemas.ConnectionTestResult)
def test_connection(
    connection_id: int,
    payload: schemas.ConnectionTestRequest,
    db: Session = Depends(get_db),
    admin: models.User = Depends(auth.require_admin),
):
    """Does `group` reach this connection, with its own identity? One cheap
    call: who STS says we are, for AWS; a GET of the base URL, for an HTTP API."""
    conn = _connection(db, connection_id)
    group = db.get(models.UserGroup, payload.group_id)
    if group is None:
        raise HTTPException(status_code=404, detail="Group not found")
    target = Target(connection=conn, name=connections.label(conn))
    if not group_can_access_environment(db, group, conn.environment):
        return schemas.ConnectionTestResult(ok=False, message=f"{group.name} can't see {conn.environment.name}.")
    try:
        if conn.type_id == connections.AWS:
            identity = resolve_identity(db, target, admin, as_group=group)
            sts = aws_client.get_client("sts", target.account_id, target.region, identity)
            arn = sts.get_caller_identity()["Arn"]
            message = f"{group.name} reaches {target.name} as {arn}."
        else:
            type_row, values = resolve_identity_values(db, target, admin, as_group=group)
            url, headers = credential_types.apply_inject(type_row, values, target.config["base_url"], {})
            response = tools_http_client.send_request("GET", url, headers=headers)
            ok = 200 <= response["status_code"] < 400
            message = f"GET {target.config['base_url']} as {group.name}: HTTP {response['status_code']} {response['status_text']}"
            return schemas.ConnectionTestResult(ok=ok, message=masking.mask(message))
    except ResolveError as e:
        return schemas.ConnectionTestResult(ok=False, message=str(e))
    except Exception as e:  # noqa: BLE001 -- a failed call is a failed test, said plainly
        return schemas.ConnectionTestResult(ok=False, message=masking.mask(f"{group.name} can't reach {target.name}: {e}"))
    return schemas.ConnectionTestResult(ok=True, message=message)


# ------------------------------------------------------------------- types and targets


@types_router.get("", response_model=list[schemas.ConnectionTypeOut])
def list_connection_types(db: Session = Depends(get_db), _admin: models.User = Depends(auth.require_admin)):
    return [
        schemas.ConnectionTypeOut(
            id=t.id, label=t.label, description=t.description, fields=t.fields or [],
            identity_types=t.identity_types or [], builtin=t.builtin,
        )
        for t in db.query(models.ConnectionType).order_by(models.ConnectionType.id)
    ]


@targets_router.get("", response_model=list[schemas.TargetOut])
def list_targets(
    type: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    """The connections the caller can use, named the way pickers show them: what panes and the agent choose from."""
    return [schemas.TargetOut(**t) for t in connections.targets(db, current_user, type)]
