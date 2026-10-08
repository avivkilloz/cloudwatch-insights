"""Connections, environments and group identities (PLATFORM_PLAN.md §14).

A connection says *where* something is (an AWS account and region, a base
URL); an environment is a named group of them ("Prod" holding *iot* and
*eks*, D32); and a group's identity says *who* a request runs as there
(D31) -- an AWS role, an API token -- as a credential the group can use.

The IAM role used to be a column on the group and an environment used to be
one AWS account and region. `migrate_legacy()` turns both into the new model
once, keeping every id (D34), and `set_group_role()` keeps the old
`role_name` field of the user-group API working on top of it.
"""

import datetime
import re
from typing import Any, Optional
from urllib.parse import urlparse

from sqlalchemy.orm import Session

from . import audit, credential_types, models

AWS = "aws"
HTTP_API = "http_api"
# In a type's identity_types: any credential type that says how to
# authenticate an HTTP request (`inject`, §13.3).
ANY_INJECT = "@inject"

BUILTINS: list[dict] = [
    {
        "id": AWS,
        "label": "AWS",
        "description": "An AWS account and region. Requests run as the group's AWS role in that account.",
        "fields": [
            {"key": "account_id", "label": "Account ID", "kind": "text", "secret": False, "required": True,
             "help": "The 12-digit account number."},
            {"key": "region", "label": "Region", "kind": "text", "secret": False, "required": True,
             "help": "e.g. eu-west-1"},
        ],
        "identity_types": ["aws_role", "aws_access_keys"],
    },
    {
        "id": HTTP_API,
        "label": "HTTP API",
        "description": "A base URL. Requests are signed with the group's credential for it, or the connection's own.",
        "fields": [
            {"key": "base_url", "label": "Base URL", "kind": "text", "secret": False, "required": True,
             "help": "e.g. https://api.example.com/v1"},
        ],
        "identity_types": [ANY_INJECT],
    },
]

MIGRATED_MARKER = "connections_migrated"


class ConnectionConfigError(ValueError):
    """A request about a connection or identity that can't be done, said so a user can act."""


def ensure_builtins(db: Session) -> None:
    for spec in BUILTINS:
        row = db.get(models.ConnectionType, spec["id"])
        wanted = {k: spec[k] for k in ("label", "description", "fields", "identity_types")}
        if row is None:
            db.add(models.ConnectionType(id=spec["id"], builtin=True, **wanted))
            continue
        for k, v in wanted.items():
            if getattr(row, k) != v:
                setattr(row, k, v)
    db.commit()


# ------------------------------------------------------------------- types and config


def accepts(conn_type: models.ConnectionType, cred_type: models.CredentialType) -> bool:
    """Whether a credential of `cred_type` can be a group's identity on connections of `conn_type`."""
    allowed = conn_type.identity_types or []
    return cred_type.id in allowed or (ANY_INJECT in allowed and bool(cred_type.inject))


# Digits, not exactly 12: the old environment form took any account ID, and
# rejecting one that worked would break the "works exactly as today" promise.
_ACCOUNT_RE = re.compile(r"^\d+$")
_REGION_RE = re.compile(r"^[a-z]{2}(-[a-z]+)+-\d$")


def validate_config(conn_type: models.ConnectionType, config: dict) -> dict:
    keys = {f["key"] for f in conn_type.fields}
    unknown = set(config) - keys
    if unknown:
        raise ConnectionConfigError(f"{conn_type.label} connections have no {', '.join(sorted(unknown))}.")
    out = {k: (v.strip() if isinstance(v, str) else v) for k, v in config.items() if v not in (None, "")}
    missing = [f["label"] for f in conn_type.fields if f.get("required") and not out.get(f["key"])]
    if missing:
        raise ConnectionConfigError(f"Fill in {', '.join(missing)}.")
    if conn_type.id == AWS:
        if not _ACCOUNT_RE.match(str(out["account_id"])):
            raise ConnectionConfigError(f"'{out['account_id']}' isn't an AWS account ID: that's digits only.")
        if not _REGION_RE.match(str(out["region"])):
            raise ConnectionConfigError(f"'{out['region']}' isn't an AWS region, e.g. eu-west-1.")
    if conn_type.id == HTTP_API:
        parsed = urlparse(str(out["base_url"]))
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            raise ConnectionConfigError("The base URL must start with http:// or https:// and name a host.")
        out["base_url"] = str(out["base_url"]).rstrip("/")
    return out


# ------------------------------------------------------------------- names people see


def label(conn: models.Connection) -> str:
    """"Prod" when it is its environment's only connection of its type,
    "Prod · iot" when there are several -- so after the migration, when every
    environment holds one AWS connection, nothing anyone sees changes (D32)."""
    env = conn.environment
    same = [c for c in env.connections if c.type_id == conn.type_id]
    return env.name if len(same) <= 1 else f"{env.name} · {conn.name}"


def visible_environments(db: Session, user: models.User):
    query = db.query(models.Environment)
    group = user.group
    if group is not None and group.is_admin:
        return query
    group_id = group.id if group else -1
    return query.join(
        models.GroupEnvironmentAccess, models.GroupEnvironmentAccess.environment_id == models.Environment.id
    ).filter(models.GroupEnvironmentAccess.group_id == group_id)


def targets(db: Session, user: models.User, type_id: Optional[str] = None) -> list[dict]:
    """Every connection the user can use, with the name pickers show: what
    the panes and the agent choose from."""
    out = []
    for env in visible_environments(db, user).order_by(models.Environment.name).all():
        for conn in env.connections:
            if type_id and conn.type_id != type_id:
                continue
            out.append(
                {
                    "id": conn.id,
                    "label": label(conn),
                    "type_id": conn.type_id,
                    "environment_id": env.id,
                    "environment": env.name,
                    "connection": conn.name,
                    "config": dict(conn.config or {}),
                }
            )
    return out


def environment_summary(env: models.Environment) -> dict[str, Any]:
    """The old shape of an environment, kept in the API for anything that
    still reads it (D34): its account and region are its first AWS
    connection's."""
    aws = next((c for c in env.connections if c.type_id == AWS), None)
    return {
        "account_id": (aws.config or {}).get("account_id", "") if aws else "",
        "region": (aws.config or {}).get("region", "") if aws else "",
    }


# ------------------------------------------------------------------- identities


def group_identity(
    db: Session, group: Optional[models.UserGroup], conn: models.Connection
) -> Optional[models.GroupIdentity]:
    """The group's override for this connection, else its default for the type."""
    if group is None:
        return None
    base = db.query(models.GroupIdentity).filter(
        models.GroupIdentity.group_id == group.id, models.GroupIdentity.connection_type_id == conn.type_id
    )
    return (
        base.filter(models.GroupIdentity.connection_id == conn.id).first()
        or base.filter(models.GroupIdentity.connection_id.is_(None)).first()
    )


def _role_credential(
    db: Session, actor: Optional[models.User], group: models.UserGroup, role_name: str
) -> models.Credential:
    """A new "AWS role" credential belonging to `group`. Nothing in it is
    secret, so this needs no master key (D35) and writes the row directly."""
    type_row = db.get(models.CredentialType, "aws_role")
    name, n = f"{group.name} AWS role", 2
    while (
        db.query(models.Credential)
        .filter(models.Credential.scope == "group", models.Credential.group_id == group.id, models.Credential.name == name)
        .first()
    ):
        name, n = f"{group.name} AWS role {n}", n + 1
    cred = models.Credential(
        name=name,
        type_id="aws_role",
        type_version=type_row.version,
        description="The role this group assumes in AWS accounts.",
        scope="group",
        group_id=group.id,
        public_fields={"role_name": role_name},
        secret_fields_set=[],
        created_by_id=actor.id if actor else None,
        updated_by_id=actor.id if actor else None,
    )
    db.add(cred)
    db.flush()
    audit.record(
        db, actor=actor, action="credential.create", object_type="credential", object_id=cred.id,
        group_id=group.id, detail={"name": cred.name, "type": "aws_role", "scope": "group"},
    )
    return cred


def group_role_name(db: Session, group: models.UserGroup) -> Optional[str]:
    """The role name of the group's default AWS identity, when it is an AWS
    role: what the user-group API's `role_name` reports now."""
    ident = (
        db.query(models.GroupIdentity)
        .filter(
            models.GroupIdentity.group_id == group.id,
            models.GroupIdentity.connection_type_id == AWS,
            models.GroupIdentity.connection_id.is_(None),
        )
        .first()
    )
    if ident and ident.credential.type_id == "aws_role":
        return (ident.credential.public_fields or {}).get("role_name")
    return None


def set_group_role(
    db: Session, actor: Optional[models.User], group: models.UserGroup, role_name: Optional[str]
) -> None:
    """The user-group API's `role_name`, kept working (D34): sets the role of
    the group's default AWS identity -- editing the group's own AWS role
    credential when that is what the identity is, creating one otherwise --
    or, given nothing, removes the default. The caller commits."""
    role_name = (role_name or "").strip() or None
    ident = (
        db.query(models.GroupIdentity)
        .filter(
            models.GroupIdentity.group_id == group.id,
            models.GroupIdentity.connection_type_id == AWS,
            models.GroupIdentity.connection_id.is_(None),
        )
        .first()
    )
    own = (
        ident is not None
        and ident.credential.type_id == "aws_role"
        and ident.credential.scope == "group"
        and ident.credential.group_id == group.id
    )
    if role_name is None:
        if ident is not None:
            cred = ident.credential
            db.delete(ident)
            db.flush()
            if own and not db.query(models.GroupIdentity).filter(models.GroupIdentity.credential_id == cred.id).first():
                db.delete(cred)
        return
    if own:
        cred = ident.credential
        if (cred.public_fields or {}).get("role_name") != role_name:
            cred.public_fields = {**(cred.public_fields or {}), "role_name": role_name}
            cred.updated_at = datetime.datetime.utcnow()
            cred.updated_by_id = actor.id if actor else None
            audit.record(
                db, actor=actor, action="credential.update", object_type="credential", object_id=cred.id,
                group_id=group.id, detail={"changed": ["role_name"]},
            )
        return
    cred = _role_credential(db, actor, group, role_name)
    if ident is None:
        db.add(models.GroupIdentity(group_id=group.id, connection_type_id=AWS, connection_id=None, credential_id=cred.id))
    else:
        ident.credential_id = cred.id
    audit.record(
        db, actor=actor, action="identity.set", object_type="user_group", object_id=group.id, group_id=group.id,
        detail={"type": AWS, "credential": cred.name},
    )


# ------------------------------------------------------------------- the one-time migration


def migrate_legacy(db: Session) -> list[str]:
    """Once per database (a Settings marker): every environment that is an
    AWS account and region becomes that environment holding one `aws`
    connection *with the environment's own id* (D34), and every group's
    `role_name` becomes an AWS role credential of that group, set as its
    default AWS identity (D31). Returns what it did, for the startup log.

    Keyed on a marker rather than on "has no connection yet", so an admin
    who later removes an environment's connection doesn't get it back on
    the next restart."""
    if db.get(models.Setting, MIGRATED_MARKER) is not None:
        return []
    ensure_builtins(db)
    credential_types.ensure_builtins(db)
    done = []
    for env in db.query(models.Environment).order_by(models.Environment.id):
        if env.connections or not env.account_id or not env.region:
            continue
        db.add(
            models.Connection(
                id=env.id,
                environment_id=env.id,
                type_id=AWS,
                name="aws",
                config={"account_id": env.account_id, "region": env.region},
            )
        )
        done.append(f"environment {env.name}: one AWS connection, id {env.id}")
    db.flush()
    for group in db.query(models.UserGroup).order_by(models.UserGroup.id):
        if group.role_name:
            set_group_role(db, None, group, group.role_name)
            done.append(f"group {group.name}: role {group.role_name} is now its default AWS identity")
    db.add(models.Setting(key=MIGRATED_MARKER, value=datetime.datetime.utcnow().isoformat()))
    db.commit()
    return done
