from sqlalchemy.orm import Session

from . import models


class ResolveError(Exception):
    pass


def resolve_environment(db: Session, environment_id: int, current_user: models.User) -> models.Environment:
    environment = db.get(models.Environment, environment_id)
    if not environment or not user_can_access_environment(db, current_user, environment):
        # Same message whether it doesn't exist or the user's group just
        # can't see it -- no need to reveal which.
        raise ResolveError(f"Environment {environment_id} is not configured")
    return environment


def user_can_access_environment(db: Session, current_user: models.User, environment: models.Environment) -> bool:
    group = current_user.group
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


def resolve_role_name(current_user: models.User) -> str:
    group = current_user.group
    if group and group.role_name:
        return group.role_name
    raise ResolveError(
        f"No role name is configured for your group ('{group.name if group else 'none'}') -- "
        "ask an admin to set one from the Users & Groups panel in Settings."
    )


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
