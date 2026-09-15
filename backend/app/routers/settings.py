from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from .. import models, schemas
from ..db import get_db

router = APIRouter(prefix="/api/settings", tags=["settings"])

DEFAULT_ROLE_NAME_KEY = "default_role_name"


@router.get("", response_model=schemas.SettingsOut)
def get_settings(db: Session = Depends(get_db)):
    setting = db.get(models.Setting, DEFAULT_ROLE_NAME_KEY)
    return schemas.SettingsOut(default_role_name=setting.value if setting else None)


@router.put("", response_model=schemas.SettingsOut)
def update_settings(payload: schemas.SettingsUpdate, db: Session = Depends(get_db)):
    setting = db.get(models.Setting, DEFAULT_ROLE_NAME_KEY)
    if setting is None:
        setting = models.Setting(key=DEFAULT_ROLE_NAME_KEY, value=payload.default_role_name)
        db.add(setting)
    else:
        setting.value = payload.default_role_name
    db.commit()
    return schemas.SettingsOut(default_role_name=setting.value)
