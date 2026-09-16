from sqlalchemy.orm import Session

from . import models
from .routers.settings import DEFAULT_ROLE_NAME_KEY


class ResolveError(Exception):
    pass


def resolve_environment(db: Session, environment_id: int) -> models.Environment:
    environment = db.get(models.Environment, environment_id)
    if not environment:
        raise ResolveError(f"Environment {environment_id} is not configured")
    return environment


def resolve_role_name(db: Session, environment: models.Environment) -> str:
    if environment.role_name:
        return environment.role_name
    setting = db.get(models.Setting, DEFAULT_ROLE_NAME_KEY)
    if setting and setting.value:
        return setting.value
    raise ResolveError(
        f"No role name configured for environment '{environment.name}' and no default role name is set"
    )
