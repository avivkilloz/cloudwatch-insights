"""The catalogue panes are picked from (PLATFORM_PLAN.md §19.2, D66): its
categories in order, each person's favourites and hidden, and the admin's
arranging of it. Every pane type is everyone's (D160); what a group is given
is its environments, so a pane none of them can run is marked, not hidden."""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import auth, catalogue, connections, models
from ..db import get_db

router = APIRouter(prefix="/api/catalogue", tags=["catalogue"])


class CategoryOut(BaseModel):
    id: int
    name: str
    description: str = ""
    pane_types: list[str]


class CatalogueOut(BaseModel):
    categories: list[CategoryOut]
    favourites: list[str]
    hidden: list[str]
    # Pane types that need a kind of connection none of the person's
    # environments has (D160): offered, and said so, rather than left out --
    # an admin adding the connection makes them work without anything else.
    no_environment: dict[str, str] = {}


class CategoryIn(BaseModel):
    name: str
    # Left out on a rename, the description stays as it is.
    description: Optional[str] = None


class LayoutCategory(BaseModel):
    id: int
    pane_types: list[str]


class LayoutIn(BaseModel):
    categories: list[LayoutCategory]


class PreferenceIn(BaseModel):
    favourite: Optional[bool] = None
    hidden: Optional[bool] = None


def _out(db: Session, user: models.User) -> CatalogueOut:
    is_admin = bool(user.group and user.group.is_admin)
    categories = []
    for c, types in catalogue.arrangement(db):
        # An empty category is noise to anyone but the admin arranging them.
        if types or is_admin:
            categories.append(CategoryOut(id=c.id, name=c.name, description=catalogue.description(c), pane_types=types))
    favourites, hidden = catalogue.preferences(db, user)
    known = {t for _c, types in catalogue.arrangement(db) for t in types}
    return CatalogueOut(
        categories=categories,
        favourites=[t for t in favourites if t in known],
        hidden=[t for t in hidden if t in known],
        no_environment=catalogue.no_environment(db, user, connections.targets(db, user)),
    )


def _guard(fn):
    try:
        return fn()
    except catalogue.CatalogueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from None


@router.get("", response_model=CatalogueOut)
def get_catalogue(db: Session = Depends(get_db), user: models.User = Depends(auth.get_current_user)):
    return _out(db, user)


@router.put("/preferences/{pane_type}", response_model=CatalogueOut)
def set_preference(
    pane_type: str,
    payload: PreferenceIn,
    db: Session = Depends(get_db),
    user: models.User = Depends(auth.get_current_user),
):
    """A favourite, or hidden: one person's own layer over the catalogue."""
    _guard(lambda: catalogue.set_preference(db, user, pane_type, payload.favourite, payload.hidden))
    return _out(db, user)


@router.post("/categories", response_model=CatalogueOut, status_code=201)
def create_category(payload: CategoryIn, db: Session = Depends(get_db), admin: models.User = Depends(auth.require_admin)):
    _guard(lambda: catalogue.create(db, payload.name, payload.description))
    return _out(db, admin)


@router.put("/categories/{category_id}", response_model=CatalogueOut)
def rename_category(
    category_id: int, payload: CategoryIn, db: Session = Depends(get_db), admin: models.User = Depends(auth.require_admin)
):
    _guard(lambda: catalogue.rename(db, category_id, payload.name, payload.description))
    return _out(db, admin)


@router.delete("/categories/{category_id}", response_model=CatalogueOut)
def delete_category(
    category_id: int, move_to: int, db: Session = Depends(get_db), admin: models.User = Depends(auth.require_admin)
):
    """Deletes a category; its panes go to the end of `move_to`."""
    _guard(lambda: catalogue.delete(db, category_id, move_to))
    return _out(db, admin)


@router.put("/layout", response_model=CatalogueOut)
def set_layout(payload: LayoutIn, db: Session = Depends(get_db), admin: models.User = Depends(auth.require_admin)):
    """The whole arrangement, as the admin left it: every pane listed is
    placed, so a manifest's suggestion no longer moves it."""
    _guard(lambda: catalogue.set_layout(db, [(c.id, c.pane_types) for c in payload.categories]))
    return _out(db, admin)
