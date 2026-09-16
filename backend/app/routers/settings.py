from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from .. import models, schemas
from ..db import get_db

router = APIRouter(prefix="/api/settings", tags=["settings"])

DEFAULT_ROLE_NAME_KEY = "default_role_name"
APP_TITLE_KEY = "app_title"
APP_LOGO_URL_KEY = "app_logo_url"

# field name -> settings-table key, for every on/off tab toggle.
TAB_ENABLED_KEYS = {
    "logs_enabled": "tab_logs_enabled",
    "iot_enabled": "tab_iot_enabled",
    "tables_enabled": "tab_tables_enabled",
    "buckets_enabled": "tab_buckets_enabled",
    "cognito_enabled": "tab_cognito_enabled",
}


def _get_value(db: Session, key: str) -> str | None:
    setting = db.get(models.Setting, key)
    return setting.value if setting else None


def _get_bool(db: Session, key: str, default: bool) -> bool:
    value = _get_value(db, key)
    return default if value is None else value == "true"


def _set_value(db: Session, key: str, value: str | None) -> None:
    setting = db.get(models.Setting, key)
    if setting is None:
        db.add(models.Setting(key=key, value=value))
    else:
        setting.value = value


def _build_settings_out(db: Session) -> schemas.SettingsOut:
    return schemas.SettingsOut(
        default_role_name=_get_value(db, DEFAULT_ROLE_NAME_KEY),
        app_title=_get_value(db, APP_TITLE_KEY),
        app_logo_url=_get_value(db, APP_LOGO_URL_KEY),
        # Missing key (e.g. on first run, or upgrading from before this
        # setting existed) means "not turned off" -- tabs default to visible.
        **{field: _get_bool(db, key, True) for field, key in TAB_ENABLED_KEYS.items()},
    )


@router.get("", response_model=schemas.SettingsOut)
def get_settings(db: Session = Depends(get_db)):
    return _build_settings_out(db)


@router.put("", response_model=schemas.SettingsOut)
def update_settings(payload: schemas.SettingsUpdate, db: Session = Depends(get_db)):
    data = payload.model_dump(exclude_unset=True)
    if "default_role_name" in data:
        _set_value(db, DEFAULT_ROLE_NAME_KEY, data["default_role_name"])
    if "app_title" in data:
        _set_value(db, APP_TITLE_KEY, data["app_title"])
    if "app_logo_url" in data:
        _set_value(db, APP_LOGO_URL_KEY, data["app_logo_url"])
    for field, key in TAB_ENABLED_KEYS.items():
        if field in data:
            _set_value(db, key, "true" if data[field] else "false")
    db.commit()
    return _build_settings_out(db)
