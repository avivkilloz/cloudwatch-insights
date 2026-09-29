from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import auth, models, schemas
from ..db import get_db

router = APIRouter(prefix="/api/users", tags=["users"])


@router.get("", response_model=list[schemas.UserOut])
def list_users(db: Session = Depends(get_db), _admin: models.User = Depends(auth.require_admin)):
    users = db.query(models.User).order_by(models.User.username).all()
    return [auth.user_out(u) for u in users]


@router.get("/suggest", response_model=list[schemas.UserSuggestion])
def suggest_users(
    prefix: str = "",
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    """Usernames starting with `prefix`, for the session card's invite field --
    open to any authenticated user (not `require_admin` like `list_users`),
    since the invite endpoint it feeds already lets any user invite any other
    user by exact username, in any group: this only makes that existing
    reach discoverable instead of requiring an exact guess. Deliberately a
    UserSuggestion (id/username only), never the full UserOut, and capped
    rather than a browsable full listing."""
    prefix = prefix.strip()
    if not prefix:
        return []
    matches = (
        db.query(models.User)
        .filter(models.User.username.ilike(f"{prefix}%"), models.User.id != current_user.id)
        .order_by(models.User.username)
        .limit(8)
        .all()
    )
    return [schemas.UserSuggestion(id=u.id, username=u.username) for u in matches]


@router.post("", response_model=schemas.UserOut, status_code=201)
def create_user(
    payload: schemas.UserCreate, db: Session = Depends(get_db), _admin: models.User = Depends(auth.require_admin)
):
    if db.query(models.User).filter(models.User.username == payload.username).first():
        raise HTTPException(status_code=400, detail="That username is already taken")
    group = db.get(models.UserGroup, payload.group_id)
    if not group:
        raise HTTPException(status_code=400, detail="That group does not exist")
    user = models.User(username=payload.username, password_hash=auth.hash_password(payload.password), group_id=group.id)
    db.add(user)
    db.commit()
    db.refresh(user)
    return auth.user_out(user)


@router.put("/{user_id}", response_model=schemas.UserOut)
def update_user(
    user_id: int,
    payload: schemas.UserUpdate,
    db: Session = Depends(get_db),
    admin: models.User = Depends(auth.require_admin),
):
    user = db.get(models.User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    data = payload.model_dump(exclude_unset=True)
    if "group_id" in data:
        new_group = db.get(models.UserGroup, data["group_id"])
        if not new_group:
            raise HTTPException(status_code=400, detail="That group does not exist")
        if user.id == admin.id and not new_group.is_admin:
            raise HTTPException(status_code=400, detail="You can't remove yourself from the Admin group")
        if user.group.is_admin and not new_group.is_admin:
            _ensure_not_last_admin(db, exclude_user_id=user.id)
        user.group_id = new_group.id
    if data.get("password"):
        user.password_hash = auth.hash_password(data["password"])
    db.commit()
    db.refresh(user)
    return auth.user_out(user)


@router.delete("/{user_id}", status_code=204)
def delete_user(
    user_id: int, db: Session = Depends(get_db), admin: models.User = Depends(auth.require_admin)
):
    user = db.get(models.User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if user.id == admin.id:
        raise HTTPException(status_code=400, detail="You can't delete your own account")
    if user.group.is_admin:
        _ensure_not_last_admin(db, exclude_user_id=user.id)
    db.delete(user)
    db.commit()
    return None


def _ensure_not_last_admin(db: Session, exclude_user_id: int) -> None:
    remaining = (
        db.query(models.User)
        .join(models.UserGroup)
        .filter(models.UserGroup.is_admin.is_(True), models.User.id != exclude_user_id)
        .count()
    )
    if remaining == 0:
        raise HTTPException(status_code=400, detail="This would leave no users in the Admin group")
