import logging
import os
import secrets

from sqlalchemy.orm import Session as DbSession

from . import auth, models

logger = logging.getLogger(__name__)

ADMIN_GROUP_NAME = "Admin"
ADMIN_USERNAME = "admin"
# The role-name Setting key this app used before user groups existed --
# migrated onto the new Admin group's role_name if still present, so
# upgrading in place doesn't silently drop a working role configuration.
LEGACY_DEFAULT_ROLE_NAME_KEY = "default_role_name"


def ensure_admin_exists(db: DbSession) -> None:
    """Idempotent: creates the Admin group and its first admin user only if
    no users exist yet at all. Safe to call on every startup."""
    if db.query(models.User).first() is not None:
        return

    admin_group = db.query(models.UserGroup).filter(models.UserGroup.name == ADMIN_GROUP_NAME).first()
    if admin_group is None:
        legacy_role_name = None
        legacy_setting = db.get(models.Setting, LEGACY_DEFAULT_ROLE_NAME_KEY)
        if legacy_setting and legacy_setting.value:
            legacy_role_name = legacy_setting.value
        admin_group = models.UserGroup(name=ADMIN_GROUP_NAME, is_admin=True, role_name=legacy_role_name)
        db.add(admin_group)
        db.flush()

    password = os.environ.get("ADMIN_PASSWORD")
    if not password:
        password = secrets.token_urlsafe(18)
        logger.warning(
            "ADMIN_PASSWORD is not set -- generated a one-time password for the initial "
            "'%s' user: %s (set ADMIN_PASSWORD to control this instead, e.g. via a Helm secret)",
            ADMIN_USERNAME,
            password,
        )

    admin_user = models.User(
        username=ADMIN_USERNAME,
        password_hash=auth.hash_password(password),
        group_id=admin_group.id,
    )
    db.add(admin_user)
    db.commit()
