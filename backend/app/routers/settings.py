from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from .. import auth, models, schemas
from ..db import get_db

router = APIRouter(prefix="/api/settings", tags=["settings"])

APP_TITLE_KEY = "app_title"
APP_LOGO_URL_KEY = "app_logo_url"


def _get_value(db: Session, key: str) -> str | None:
    setting = db.get(models.Setting, key)
    return setting.value if setting else None


def _set_value(db: Session, key: str, value: str | None) -> None:
    setting = db.get(models.Setting, key)
    if setting is None:
        db.add(models.Setting(key=key, value=value))
    else:
        setting.value = value


def _build_settings_out(db: Session) -> schemas.SettingsOut:
    return schemas.SettingsOut(
        app_title=_get_value(db, APP_TITLE_KEY),
        app_logo_url=_get_value(db, APP_LOGO_URL_KEY),
    )


@router.get("", response_model=schemas.SettingsOut)
def get_settings(db: Session = Depends(get_db)):
    # Deliberately public (no auth) -- just branding (title/logo), not
    # access-controlled data, and the login page itself needs it before
    # anyone is logged in.
    return _build_settings_out(db)


@router.put("", response_model=schemas.SettingsOut)
def update_settings(
    payload: schemas.SettingsUpdate, db: Session = Depends(get_db), _admin: models.User = Depends(auth.require_admin)
):
    data = payload.model_dump(exclude_unset=True)
    if "app_title" in data:
        _set_value(db, APP_TITLE_KEY, data["app_title"])
    if "app_logo_url" in data:
        _set_value(db, APP_LOGO_URL_KEY, data["app_logo_url"])
    db.commit()
    return _build_settings_out(db)
