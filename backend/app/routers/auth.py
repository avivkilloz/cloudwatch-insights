import os

from fastapi import APIRouter, Cookie, Depends, HTTPException, Response
from sqlalchemy.orm import Session

from .. import auth, models, schemas
from ..db import get_db

router = APIRouter(prefix="/api/auth", tags=["auth"])

COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "true").lower() != "false"
# Avatars are stored inline as a data: URL, same as Setting.app_logo_url --
# this bounds how much any one (self-service, unlike the admin-only logo)
# upload can bloat the users table.
MAX_AVATAR_URL_LENGTH = 300_000


def _set_session_cookie(response: Response, session: models.Session) -> None:
    response.set_cookie(
        key=auth.SESSION_COOKIE_NAME,
        value=session.id,
        httponly=True,
        secure=COOKIE_SECURE,
        samesite="lax",
        max_age=int(auth.SESSION_TTL.total_seconds()),
        path="/",
    )


@router.post("/login", response_model=schemas.UserOut)
def login(payload: schemas.LoginRequest, response: Response, db: Session = Depends(get_db)):
    user = db.query(models.User).filter(models.User.username == payload.username).first()
    if not user or not auth.verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid username or password")
    session = auth.create_session(db, user)
    _set_session_cookie(response, session)
    return auth.user_out(user)


@router.post("/logout", status_code=204)
def logout(
    response: Response,
    db: Session = Depends(get_db),
    session_id: str | None = Cookie(default=None, alias=auth.SESSION_COOKIE_NAME),
):
    if session_id:
        auth.delete_session(db, session_id)
    response.delete_cookie(key=auth.SESSION_COOKIE_NAME, path="/")
    return None


@router.get("/me", response_model=schemas.UserOut)
def me(current_user: models.User = Depends(auth.get_current_user)):
    return auth.user_out(current_user)


@router.put("/profile", response_model=schemas.UserOut)
def update_own_profile(
    payload: schemas.ProfileUpdate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    if payload.avatar_url and len(payload.avatar_url) > MAX_AVATAR_URL_LENGTH:
        raise HTTPException(status_code=400, detail="Image is too large")
    current_user.avatar_url = payload.avatar_url
    db.commit()
    db.refresh(current_user)
    return auth.user_out(current_user)


@router.put("/password", response_model=schemas.UserOut)
def change_own_password(
    payload: schemas.ChangePasswordRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    if not auth.verify_password(payload.current_password, current_user.password_hash):
        raise HTTPException(status_code=400, detail="Current password is incorrect")
    current_user.password_hash = auth.hash_password(payload.new_password)
    db.commit()
    db.refresh(current_user)
    return auth.user_out(current_user)
