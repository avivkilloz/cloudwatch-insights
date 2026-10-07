from dataclasses import dataclass
from typing import Optional

from sqlalchemy.orm import Session

from . import aws_client, connections, credential_store, models


class ResolveError(Exception):
    pass


def user_can_access_environment(db: Session, current_user: models.User, environment: models.Environment) -> bool:
    return group_can_access_environment(db, current_user.group, environment)


def group_can_access_environment(
    db: Session, group: Optional[models.UserGroup], environment: models.Environment
) -> bool:
    if not group:
        return False
    if group.is_admin:
        return True
    return (
        db.query(models.GroupEnvironmentAccess)
        .filter(
            models.GroupEnvironmentAccess.group_id == group.id,
            models.GroupEnvironmentAccess.environment_id == environment.id,
        )
        .first()
        is not None
    )


@dataclass
class Target:
    """A connection the caller can use, as the routers need it: `id` and
    `name` are what a result is labelled with ("Prod", or "Prod · iot"
    where an environment holds several), `config` is its type's settings."""

    connection: models.Connection
    name: str

    @property
    def id(self) -> int:
        return self.connection.id

    @property
    def environment(self) -> models.Environment:
        return self.connection.environment

    @property
    def config(self) -> dict:
        return dict(self.connection.config or {})

    @property
    def account_id(self) -> str:
        return str(self.config.get("account_id", ""))

    @property
    def region(self) -> str:
        return str(self.config.get("region", ""))


def resolve_target(db: Session, connection_id: int, current_user: models.User, type_id: str = connections.AWS) -> Target:
    """A connection of `type_id` in an environment the caller's group sees.

    Payloads still call these `environment_id` (D34): every environment id
    stored before connections existed is also its AWS connection's id."""
    conn = db.get(models.Connection, connection_id)
    if conn is None or conn.type_id != type_id or not user_can_access_environment(db, current_user, conn.environment):
        # Same message whether it doesn't exist or the user's group just
        # can't see it -- no need to reveal which.
        raise ResolveError(f"Environment {connection_id} is not configured")
    return Target(connection=conn, name=connections.label(conn))


def resolve_identity_values(
    db: Session, target: Target, current_user: models.User, as_group: Optional[models.UserGroup] = None
) -> tuple[models.CredentialType, dict]:
    """Who the caller is on this connection (D31), decrypted: their group's
    override for it, else their group's default for its type, else the
    connection's own credential. Each use goes through credential_store,
    so it is checked, audited (at most hourly, D36) and masked. `as_group`
    asks for another group's identity: an admin's "Test as…"."""
    group = as_group if as_group is not None else current_user.group
    ident = connections.group_identity(db, group, target.connection)
    credential_id = ident.credential_id if ident else target.connection.credential_id
    kind = target.connection.type.label if target.connection.type else target.connection.type_id
    if credential_id is None:
        who = f"Your group ({group.name if group else 'none'})"
        if target.connection.type_id == connections.AWS:
            raise ResolveError(
                f"{who} has no AWS role for {target.name}: ask an admin to set its role name "
                "(its AWS identity) in Settings → User groups."
            )
        raise ResolveError(
            f"{who} has no identity for {target.name} ({kind}): ask an admin to set one in Settings → User groups."
        )
    try:
        type_row, values = credential_store.resolve(
            db,
            credential_id,
            actor=current_user,
            purpose=f"{kind}: {target.name}",
            coalesce=as_group is None,
            as_group=as_group,
        )
    except credential_store.CredentialAccessError:
        raise ResolveError(
            f"Your group's identity for {target.name} isn't available to it any more: "
            "ask an admin to check Settings → User groups."
        ) from None
    except (credential_store.CredentialsOff, credential_store.CredentialError) as e:
        raise ResolveError(str(e)) from None
    if target.connection.type and not connections.accepts(target.connection.type, type_row):
        raise ResolveError(f"A {type_row.label} credential can't be an identity on {kind} connections.")
    return type_row, values


def resolve_identity(
    db: Session, target: Target, current_user: models.User, as_group: Optional[models.UserGroup] = None
) -> aws_client.Identity:
    """resolve_identity_values, for an AWS connection: the role to assume or the keys to use."""
    type_row, values = resolve_identity_values(db, target, current_user, as_group)
    if type_row.id == "aws_access_keys":
        return aws_client.Identity(
            access_key_id=values.get("access_key_id"),
            secret_access_key=values.get("secret_access_key"),
            session_token=values.get("session_token") or None,
        )
    return aws_client.Identity(role_name=values.get("role_name"), external_id=values.get("external_id") or None)


def require_flag(current_user: models.User, flag: str, label: str) -> None:
    """The per-page group boolean (logs_enabled, opensearch_enabled, iot_enabled,
    tables_enabled, buckets_enabled, cognito_enabled) that decides whether the
    frontend offers a page at all. The per-service routers only ever checked
    environment visibility and the group's IAM role -- this is the "closing
    that gap in the routers" CLAUDE.md names: without it, a group whose UI
    never shows a page (but that does have an environment and a role) could
    still reach that page's API directly, by hand or through anything else
    that calls these routers, including a future platform_tools function that
    forgot its own kind_for/_flagged check. The Admin group always passes,
    same as environment visibility."""
    group = current_user.group
    if group and (group.is_admin or getattr(group, flag, False)):
        return
    raise ResolveError(f"Your group doesn't have {label} turned on.")
