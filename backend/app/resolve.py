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
