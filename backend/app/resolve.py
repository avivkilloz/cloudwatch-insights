from sqlalchemy.orm import Session

from . import models
from .routers.settings import DEFAULT_ROLE_NAME_KEY


class ResolveError(Exception):
    pass


def resolve_account(db: Session, account_id: str) -> models.Account:
    account = db.query(models.Account).filter(models.Account.account_id == account_id).first()
    if not account:
        raise ResolveError(f"Account {account_id} is not configured")
    return account


def resolve_role_name(db: Session, account: models.Account) -> str:
    if account.role_name:
        return account.role_name
    setting = db.get(models.Setting, DEFAULT_ROLE_NAME_KEY)
    if setting and setting.value:
        return setting.value
    raise ResolveError(
        f"No role name configured for account {account.account_id} and no default role name is set"
    )
