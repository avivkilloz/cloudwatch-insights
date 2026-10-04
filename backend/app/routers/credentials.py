"""Credentials, credential types and the audit log over HTTP (PLATFORM_PLAN.md
§13.5).

Admins manage everything here (D24). Anyone signed in can read the types
(for a form) and the names of the credentials their group may use (to pick
one). No route returns a secret value, to admins included (D25): a secret
field is reported only as set or not, and replacing it is the only way to
change it.
"""

import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from .. import audit, auth, credential_store, credential_types, models, schemas
from ..db import get_db

types_router = APIRouter(prefix="/api/credential-types", tags=["credentials"])
router = APIRouter(prefix="/api/credentials", tags=["credentials"])
audit_router = APIRouter(prefix="/api/audit", tags=["audit"])


def _is_admin(user: models.User) -> bool:
    return bool(user.group and user.group.is_admin)


def _fail(e: Exception) -> HTTPException:
    if isinstance(e, credential_store.CredentialsOff):
        return HTTPException(status_code=503, detail=str(e))
    if isinstance(e, credential_store.CredentialAccessError):
        return HTTPException(status_code=404, detail=str(e))
    return HTTPException(status_code=400, detail=str(e))


_EXPECTED = (
    credential_store.CredentialsOff,
    credential_store.CredentialError,
    credential_store.CredentialAccessError,
    credential_types.CredentialTypeError,
)


# ------------------------------------------------------------------- types


def _type_out(db: Session, row: models.CredentialType) -> schemas.CredentialTypeOut:
    in_use = db.query(models.Credential).filter(models.Credential.type_id == row.id).count()
    has_test = bool(row.http_test) or (row.builtin and row.id in credential_types.CHECKS)
    return schemas.CredentialTypeOut(
        id=row.id,
        label=row.label,
        description=row.description,
        version=row.version,
        fields=row.fields,
        output_template=row.output_template,
        inject=row.inject,
        http_test=row.http_test,
        builtin=row.builtin,
        in_use=in_use,
        has_test=has_test,
    )


@types_router.get("", response_model=list[schemas.CredentialTypeOut])
def list_types(db: Session = Depends(get_db), _user: models.User = Depends(auth.get_current_user)):
    rows = db.query(models.CredentialType).order_by(models.CredentialType.builtin.desc(), models.CredentialType.label).all()
    return [_type_out(db, row) for row in rows]


@types_router.post("/infer")
def infer_type(payload: schemas.CredentialTypeInfer, _admin: models.User = Depends(auth.require_admin)):
    try:
        return credential_types.infer(payload.example)
    except credential_types.CredentialTypeError as e:
        raise _fail(e) from None


@types_router.post("/preview")
def preview_type(payload: schemas.CredentialTypePreview, _admin: models.User = Depends(auth.require_admin)):
    """The output template's result for sample values -- the editor's live
    preview. Only sample values typed into the editor go in; nothing stored."""
    try:
        fields = credential_types.validate_fields(payload.fields)
        row = models.CredentialType(fields=fields, output_template=(payload.output_template or "").strip() or None)
        public, secret = credential_types.split_values(fields, payload.values)
        return {"output": credential_types.render(row, {**public, **secret})}
    except credential_types.CredentialTypeError as e:
        raise _fail(e) from None


@types_router.post("", response_model=schemas.CredentialTypeOut, status_code=201)
def create_type(
    payload: schemas.CredentialTypeIn, db: Session = Depends(get_db), admin: models.User = Depends(auth.require_admin)
):
    type_id = payload.id.strip()
    if not credential_types.TYPE_ID_RE.match(type_id):
        raise HTTPException(
            status_code=400,
            detail="A type id starts with a lowercase letter, then lowercase letters, digits or _ (2 to 64).",
        )
    if db.get(models.CredentialType, type_id) is not None:
        raise HTTPException(status_code=409, detail=f"A credential type '{type_id}' already exists.")
    try:
        fields, template, inject, http_test = credential_types.validate_definition(
            payload.fields, payload.output_template, payload.inject, payload.http_test
        )
    except credential_types.CredentialTypeError as e:
        raise _fail(e) from None
    row = models.CredentialType(
        id=type_id,
        label=payload.label.strip(),
        description=payload.description,
        version=1,
        fields=fields,
        output_template=template,
        inject=inject,
        http_test=http_test,
        builtin=False,
        created_by_id=admin.id,
        updated_by_id=admin.id,
    )
    db.add(row)
    audit.record(db, actor=admin, action="credential_type.create", object_type="credential_type", object_id=type_id,
                 detail={"label": row.label, "fields": [f["key"] for f in fields]})
    db.commit()
    db.refresh(row)
    return _type_out(db, row)


@types_router.patch("/{type_id}", response_model=schemas.CredentialTypeOut)
def update_type(
    type_id: str,
    payload: schemas.CredentialTypeUpdate,
    db: Session = Depends(get_db),
    admin: models.User = Depends(auth.require_admin),
):
    row = db.get(models.CredentialType, type_id)
    if row is None:
        raise HTTPException(status_code=404, detail="That credential type doesn't exist.")
    if row.builtin:
        raise HTTPException(status_code=403, detail="Built-in types can't be edited. Copy it to make your own.")
    data = payload.model_dump(exclude_unset=True)
    old_fields = row.fields
    try:
        fields, template, inject, http_test = credential_types.validate_definition(
            data.get("fields", row.fields),
            data.get("output_template", row.output_template),
            data.get("inject", row.inject),
            data.get("http_test", row.http_test),
        )
    except credential_types.CredentialTypeError as e:
        raise _fail(e) from None

    old = {f["key"]: f for f in old_fields}
    new = {f["key"]: f for f in fields}
    exposed = [k for k in new if k in old and old[k]["secret"] and not new[k]["secret"]]
    if exposed:
        raise HTTPException(
            status_code=400,
            detail=f"{', '.join(exposed)} {'is' if len(exposed) == 1 else 'are'} secret and can't be made public: "
            "stored values were promised to stay hidden.",
        )
    removed = set(old) - set(new)
    if removed and not payload.confirm_remove:
        holders = [
            c.name
            for c in db.query(models.Credential).filter(models.Credential.type_id == type_id).all()
            if (set((c.public_fields or {})) | set(c.secret_fields_set or [])) & removed
        ]
        if holders:
            raise HTTPException(
                status_code=409,
                detail=f"Removing {', '.join(sorted(removed))} discards their values in: {', '.join(sorted(holders))}. "
                "Send confirm_remove to go ahead.",
            )

    fields_changed = fields != old_fields
    if "label" in data and data["label"]:
        row.label = data["label"].strip()
    if "description" in data:
        row.description = data["description"]
    row.fields, row.output_template, row.inject, row.http_test = fields, template, inject, http_test
    if fields_changed:
        row.version += 1
    row.updated_by_id = admin.id
    row.updated_at = datetime.datetime.utcnow()
    try:
        reshaped = credential_store.reshape_for_type(db, admin, row, old_fields) if fields_changed else 0
    except _EXPECTED as e:
        db.rollback()
        raise _fail(e) from None
    audit.record(db, actor=admin, action="credential_type.update", object_type="credential_type", object_id=type_id,
                 detail={"changed": sorted(k for k in data if k != "confirm_remove"), "version": row.version,
                         "credentials_reshaped": reshaped})
    db.commit()
    db.refresh(row)
    return _type_out(db, row)


@types_router.delete("/{type_id}", status_code=204)
def delete_type(type_id: str, db: Session = Depends(get_db), admin: models.User = Depends(auth.require_admin)):
    row = db.get(models.CredentialType, type_id)
    if row is None:
        raise HTTPException(status_code=404, detail="That credential type doesn't exist.")
    if row.builtin:
        raise HTTPException(status_code=403, detail="Built-in types can't be deleted.")
    users = db.query(models.Credential).filter(models.Credential.type_id == type_id).all()
    if users:
        names = ", ".join(sorted(c.name for c in users)[:10])
        raise HTTPException(
            status_code=409,
            detail=f"{len(users)} credential{'s' if len(users) != 1 else ''} use this type ({names}). "
            "Delete or replace them first.",
        )
    db.delete(row)
    audit.record(db, actor=admin, action="credential_type.delete", object_type="credential_type", object_id=type_id,
                 detail={"label": row.label})
    db.commit()
    return None


# ------------------------------------------------------------------- credentials


def _get(db: Session, credential_id: int) -> models.Credential:
    cred = db.get(models.Credential, credential_id)
    if cred is None:
        raise HTTPException(status_code=404, detail="That credential doesn't exist.")
    return cred


@router.get("/status", response_model=schemas.CredentialsStatus)
def credentials_status(_user: models.User = Depends(auth.get_current_user)):
    return credential_store.status()


@router.get("")
def list_credentials(db: Session = Depends(get_db), user: models.User = Depends(auth.get_current_user)):
    rows = credential_store.visible(db, user).order_by(models.Credential.scope, models.Credential.name).all()
    if _is_admin(user):
        return [schemas.CredentialOut(**credential_store.describe(c)) for c in rows]
    return [
        schemas.CredentialSummary(id=c.id, name=c.name, type_id=c.type_id, type_label=c.type.label, scope=c.scope)
        for c in rows
    ]


@router.post("", response_model=schemas.CredentialOut, status_code=201)
def create_credential(
    payload: schemas.CredentialIn, db: Session = Depends(get_db), admin: models.User = Depends(auth.require_admin)
):
    try:
        cred = credential_store.create(
            db,
            admin,
            name=payload.name,
            type_id=payload.type_id,
            scope=payload.scope,
            group_id=payload.group_id,
            description=payload.description,
            values=payload.values,
        )
    except _EXPECTED as e:
        db.rollback()
        raise _fail(e) from None
    return schemas.CredentialOut(**credential_store.describe(cred))


@router.get("/{credential_id}", response_model=schemas.CredentialOut)
def get_credential(credential_id: int, db: Session = Depends(get_db), _admin: models.User = Depends(auth.require_admin)):
    return schemas.CredentialOut(**credential_store.describe(_get(db, credential_id)))


@router.patch("/{credential_id}", response_model=schemas.CredentialOut)
def update_credential(
    credential_id: int,
    payload: schemas.CredentialUpdate,
    db: Session = Depends(get_db),
    admin: models.User = Depends(auth.require_admin),
):
    cred = _get(db, credential_id)
    try:
        cred = credential_store.update(
            db, admin, cred, name=payload.name, description=payload.description, values=payload.values,
            clear=payload.clear,
        )
    except _EXPECTED as e:
        db.rollback()
        raise _fail(e) from None
    return schemas.CredentialOut(**credential_store.describe(cred))


@router.delete("/{credential_id}", status_code=204)
def delete_credential(
    credential_id: int, db: Session = Depends(get_db), admin: models.User = Depends(auth.require_admin)
):
    credential_store.delete(db, admin, _get(db, credential_id))
    return None


@router.post("/{credential_id}/test", response_model=schemas.CredentialTestOut)
def test_credential(credential_id: int, db: Session = Depends(get_db), admin: models.User = Depends(auth.require_admin)):
    try:
        ok, message = credential_store.test(db, admin, _get(db, credential_id))
    except _EXPECTED as e:
        db.rollback()
        raise _fail(e) from None
    return schemas.CredentialTestOut(ok=ok, message=message)


@router.post("/{credential_id}/grants/{group_id}", status_code=204)
def grant_credential(
    credential_id: int, group_id: int, db: Session = Depends(get_db), admin: models.User = Depends(auth.require_admin)
):
    try:
        credential_store.grant(db, admin, _get(db, credential_id), group_id)
    except _EXPECTED as e:
        db.rollback()
        raise _fail(e) from None
    return None


@router.delete("/{credential_id}/grants/{group_id}", status_code=204)
def revoke_credential(
    credential_id: int, group_id: int, db: Session = Depends(get_db), admin: models.User = Depends(auth.require_admin)
):
    credential_store.revoke(db, admin, _get(db, credential_id), group_id)
    return None


# ------------------------------------------------------------------- audit


@audit_router.get("", response_model=list[schemas.AuditEventOut])
def list_audit(
    object: str = Query(..., description="type:id, e.g. credential:12"),
    limit: int = Query(200, ge=1, le=1000),
    db: Session = Depends(get_db),
    _admin: models.User = Depends(auth.require_admin),
):
    object_type, sep, object_id = object.partition(":")
    if not sep or not object_type or not object_id:
        raise HTTPException(status_code=400, detail="object must look like 'credential:12'.")
    return (
        db.query(models.AuditEvent)
        .filter(models.AuditEvent.object_type == object_type, models.AuditEvent.object_id == object_id)
        .order_by(models.AuditEvent.at.desc(), models.AuditEvent.id.desc())
        .limit(limit)
        .all()
    )
