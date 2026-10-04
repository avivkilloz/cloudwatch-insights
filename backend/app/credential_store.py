"""Stored credentials: the one place secrets are encrypted, decrypted and
checked for who may use them (PLATFORM_PLAN.md §13).

Nothing here hands a secret to a caller except `resolve()` and the test,
both server-side, both audited, and both registering what they decrypted
with masking.py for the rest of the request. Every other function deals in
metadata: names, types, public fields and *which* secret fields are set.
"""

import datetime
import json
from typing import Any, Optional

from sqlalchemy import or_
from sqlalchemy.orm import Query, Session

from . import audit, credential_types, crypto, masking, models

GLOBAL, GROUP = "global", "group"


class CredentialsOff(Exception):
    """No usable master key, so nothing can be encrypted or decrypted."""


class CredentialError(ValueError):
    """A request about a credential that can't be done, said so a user can act."""


class CredentialAccessError(PermissionError):
    """The caller's group may not use this credential."""


# ------------------------------------------------------------------- keys


def keyring() -> crypto.Keyring:
    try:
        ring = crypto.load_keyring()
    except crypto.KeyringError as e:
        raise CredentialsOff(f"Credentials are off: {e}") from None
    if ring is None:
        raise CredentialsOff("Credentials are off: no master key is configured. See DEPLOYMENT.md.")
    return ring


def status() -> dict:
    try:
        ring = keyring()
    except CredentialsOff as e:
        return {"enabled": False, "reason": str(e)}
    return {"enabled": True, "reason": None, "key_id": ring.current}


def _aad(cred: models.Credential) -> bytes:
    return f"credential:{cred.id}:{cred.type_id}:{cred.type_version}".encode()


def _seal(cred: models.Credential, secrets: dict, ring: crypto.Keyring) -> None:
    secrets = {k: v for k, v in secrets.items() if v is not None}
    if not secrets:
        cred.secret_ciphertext = cred.secret_nonce = cred.wrapped_dek = None
        cred.kek_id = None
        cred.secret_fields_set = []
        return
    sealed = crypto.seal(json.dumps(secrets).encode(), _aad(cred), ring)
    cred.secret_ciphertext, cred.secret_nonce = sealed.ciphertext, sealed.nonce
    cred.wrapped_dek, cred.kek_id = sealed.wrapped_dek, sealed.kek_id
    cred.secret_fields_set = sorted(secrets)


def _open(cred: models.Credential, ring: crypto.Keyring) -> dict:
    if not cred.secret_ciphertext:
        return {}
    sealed = crypto.Sealed(cred.secret_ciphertext, cred.secret_nonce, cred.wrapped_dek, cred.kek_id)
    try:
        return json.loads(crypto.open_sealed(sealed, _aad(cred), ring))
    except crypto.DecryptError as e:
        raise CredentialError(f"Credential '{cred.name}' can't be decrypted. {e}") from None


# ------------------------------------------------------------------- who sees what


def visible(db: Session, user: models.User) -> Query:
    """Admins see every credential. Anyone else sees their own group's, and
    the global ones granted to their group -- never another group's."""
    query = db.query(models.Credential)
    group = user.group
    if group is not None and group.is_admin:
        return query
    group_id = group.id if group else -1
    granted = db.query(models.CredentialGrant.credential_id).filter(models.CredentialGrant.group_id == group_id)
    return query.filter(
        or_(
            (models.Credential.scope == GROUP) & (models.Credential.group_id == group_id),
            (models.Credential.scope == GLOBAL) & models.Credential.id.in_(granted),
        )
    )


def usable(db: Session, user: models.User, cred: models.Credential) -> bool:
    return visible(db, user).filter(models.Credential.id == cred.id).first() is not None


def _type(db: Session, type_id: str) -> models.CredentialType:
    row = db.get(models.CredentialType, type_id)
    if row is None:
        raise CredentialError(f"There is no credential type '{type_id}'.")
    return row


def _check_name(db: Session, name: str, scope: str, group_id: Optional[int], exclude_id: Optional[int] = None) -> None:
    name = name.strip()
    if not name:
        raise CredentialError("A credential needs a name.")
    clash = db.query(models.Credential).filter(
        models.Credential.name == name,
        models.Credential.scope == scope,
        models.Credential.group_id.is_(None) if group_id is None else models.Credential.group_id == group_id,
    )
    if exclude_id is not None:
        clash = clash.filter(models.Credential.id != exclude_id)
    if clash.first() is not None:
        where = "globally" if scope == GLOBAL else "in this group"
        raise CredentialError(f"A credential named '{name}' already exists {where}.")


def _scope(db: Session, scope: str, group_id: Optional[int]) -> Optional[int]:
    if scope == GLOBAL:
        return None
    if scope != GROUP:
        raise CredentialError("Scope must be 'global' or 'group'.")
    if group_id is None or db.get(models.UserGroup, group_id) is None:
        raise CredentialError("A group credential needs the group it belongs to.")
    return group_id


# ------------------------------------------------------------------- writes


def create(
    db: Session,
    actor: models.User,
    *,
    name: str,
    type_id: str,
    scope: str,
    group_id: Optional[int],
    description: Optional[str],
    values: dict,
) -> models.Credential:
    ring = keyring()
    type_row = _type(db, type_id)
    group_id = _scope(db, scope, group_id)
    _check_name(db, name, scope, group_id)
    try:
        public, secret = credential_types.split_values(type_row.fields, values)
    except credential_types.CredentialTypeError as e:
        raise CredentialError(str(e)) from None
    missing = credential_types.missing_required(type_row.fields, public, set(secret))
    if missing:
        raise CredentialError(f"Fill in {', '.join(missing)}.")
    cred = models.Credential(
        name=name.strip(),
        type_id=type_row.id,
        type_version=type_row.version,
        description=description,
        scope=scope,
        group_id=group_id,
        public_fields=public,
        secret_fields_set=[],
        created_by_id=actor.id,
        updated_by_id=actor.id,
    )
    db.add(cred)
    db.flush()  # the id is part of the ciphertext's associated data
    _seal(cred, secret, ring)
    audit.record(
        db, actor=actor, action="credential.create", object_type="credential", object_id=cred.id,
        group_id=group_id, detail={"name": cred.name, "type": type_row.id, "scope": scope},
    )
    db.commit()
    db.refresh(cred)
    return cred


def update(
    db: Session,
    actor: models.User,
    cred: models.Credential,
    *,
    name: Optional[str] = None,
    description: Optional[str] = None,
    values: Optional[dict] = None,
    clear: Optional[list[str]] = None,
) -> models.Credential:
    """A secret field left out of `values` (or sent empty) keeps its value;
    `clear` empties fields; public fields that are sent replace theirs."""
    ring = keyring()
    type_row = _type(db, cred.type_id)
    changed: list[str] = []
    if name is not None and name.strip() != cred.name:
        _check_name(db, name, cred.scope, cred.group_id, exclude_id=cred.id)
        cred.name = name.strip()
        changed.append("name")
    if description is not None and description != cred.description:
        cred.description = description
        changed.append("description")
    secrets = _open(cred, ring)
    public = dict(cred.public_fields or {})
    try:
        new_public, new_secret = credential_types.split_values(type_row.fields, values or {})
    except credential_types.CredentialTypeError as e:
        raise CredentialError(str(e)) from None
    for key in clear or []:
        if key not in {f["key"] for f in type_row.fields}:
            raise CredentialError(f"This type has no field {key}.")
        if public.pop(key, None) is not None or secrets.pop(key, None) is not None:
            changed.append(key)
    for key, value in new_public.items():
        if public.get(key) != value:
            public[key] = value
            changed.append(key)
    for key, value in new_secret.items():
        if secrets.get(key) != value:
            secrets[key] = value
            changed.append(key)
    # Values that belong to fields the type no longer has are dropped; a
    # public value whose field became secret moves into the ciphertext.
    keys = {f["key"]: f for f in type_row.fields}
    for key in list(public):
        if key not in keys:
            del public[key]
        elif keys[key]["secret"]:
            secrets[key] = public.pop(key)
    secrets = {k: v for k, v in secrets.items() if k in keys}
    missing = credential_types.missing_required(type_row.fields, public, set(secrets))
    if missing:
        raise CredentialError(f"Fill in {', '.join(missing)}.")
    cred.public_fields = public
    cred.type_version = type_row.version
    _seal(cred, secrets, ring)
    cred.updated_by_id = actor.id
    cred.updated_at = datetime.datetime.utcnow()
    audit.record(
        db, actor=actor, action="credential.update", object_type="credential", object_id=cred.id,
        group_id=cred.group_id, detail={"changed": sorted(set(changed))},
    )
    db.commit()
    db.refresh(cred)
    return cred


def delete(db: Session, actor: models.User, cred: models.Credential) -> None:
    # Phase 2's connections will reference credentials; deleting one in use
    # is refused here, naming what uses it, once anything can.
    audit.record(
        db, actor=actor, action="credential.delete", object_type="credential", object_id=cred.id,
        group_id=cred.group_id, detail={"name": cred.name, "type": cred.type_id},
    )
    db.delete(cred)
    db.commit()


def grant(db: Session, actor: models.User, cred: models.Credential, group_id: int) -> None:
    if cred.scope != GLOBAL:
        raise CredentialError("Only global credentials are granted; a group credential already belongs to its group.")
    group = db.get(models.UserGroup, group_id)
    if group is None:
        raise CredentialError("That group doesn't exist.")
    if db.get(models.CredentialGrant, (cred.id, group_id)) is None:
        db.add(models.CredentialGrant(credential_id=cred.id, group_id=group_id, granted_by_id=actor.id))
        audit.record(
            db, actor=actor, action="credential.grant", object_type="credential", object_id=cred.id,
            group_id=group_id, detail={"group": group.name},
        )
        db.commit()


def revoke(db: Session, actor: models.User, cred: models.Credential, group_id: int) -> None:
    row = db.get(models.CredentialGrant, (cred.id, group_id))
    if row is not None:
        group = db.get(models.UserGroup, group_id)
        db.delete(row)
        audit.record(
            db, actor=actor, action="credential.revoke", object_type="credential", object_id=cred.id,
            group_id=group_id, detail={"group": group.name if group else group_id},
        )
        db.commit()


# ------------------------------------------------------------------- using secrets


def _values(cred: models.Credential, ring: crypto.Keyring) -> dict:
    secrets = _open(cred, ring)
    masking.register(secrets)
    return {**(cred.public_fields or {}), **secrets}


def test(db: Session, actor: models.User, cred: models.Credential) -> tuple[Optional[bool], str]:
    ring = keyring()
    type_row = _type(db, cred.type_id)
    values = _values(cred, ring)
    try:
        ok, message = credential_types.test(type_row, values)
    except credential_types.CredentialTypeError as e:
        ok, message = False, str(e)
    message = masking.mask(message)
    cred.last_tested_at = datetime.datetime.utcnow()
    cred.last_test_ok, cred.last_test_message = ok, message
    audit.record(
        db, actor=actor, action="credential.test", object_type="credential", object_id=cred.id,
        group_id=cred.group_id, detail={"ok": ok, "message": message},
    )
    db.commit()
    return ok, message


def resolve(
    db: Session, credential_id: int, *, actor: models.User, purpose: str, actor_kind: Optional[str] = None
) -> tuple[models.CredentialType, dict]:
    """The decrypted values of a credential the actor's group may use, with
    the use audited (`purpose` says by what, e.g. "HTTP client in session
    'Checkout'"). The only way a consumer gets a secret."""
    ring = keyring()
    cred = db.get(models.Credential, credential_id)
    if cred is None or not usable(db, actor, cred):
        # The same answer either way: no need to tell anyone that a
        # credential they may not use exists.
        raise CredentialAccessError("That credential doesn't exist or isn't available to your group.")
    type_row = _type(db, cred.type_id)
    values = _values(cred, ring)
    cred.last_used_at = datetime.datetime.utcnow()
    audit.record(
        db, actor=actor, action="credential.use", object_type="credential", object_id=cred.id,
        group_id=actor.group_id, detail={"purpose": purpose}, actor_kind=actor_kind,
    )
    db.commit()
    # The commit expires the type row; loaded again here, the caller can read
    # it (to render or inject) after its own session has closed.
    db.refresh(type_row)
    return type_row, values


def rewrap_all(db: Session, ring: crypto.Keyring, to_kek: Optional[str] = None, batch: int = 200) -> int:
    """Re-wraps every credential's data key under `to_kek` (the current key by
    default), in committed batches, so an interrupted rotation resumes where
    it stopped. Returns how many were re-wrapped."""
    target = to_kek or ring.current
    if target not in ring.keys:
        raise CredentialError(f"Master key '{target}' isn't in the keyring.")
    done = 0
    while True:
        rows = (
            db.query(models.Credential)
            .filter(models.Credential.wrapped_dek.isnot(None), models.Credential.kek_id != target)
            .limit(batch)
            .all()
        )
        if not rows:
            return done
        for cred in rows:
            try:
                cred.wrapped_dek, cred.kek_id = crypto.rewrap(cred.wrapped_dek, cred.kek_id, ring, target)
            except crypto.DecryptError as e:
                raise CredentialError(f"Credential '{cred.name}' (id {cred.id}) can't be re-wrapped. {e}") from None
        db.commit()
        done += len(rows)


# ------------------------------------------------------------------- type changes


def reshape_for_type(db: Session, actor: models.User, type_row: models.CredentialType, old_fields: list[dict]) -> int:
    """After a type's fields changed: moves values whose field became secret
    into the ciphertext and drops values of removed fields, credential by
    credential. Only those affected are re-sealed. Returns how many."""
    new = {f["key"]: f for f in type_row.fields}
    old = {f["key"]: f for f in old_fields}
    to_secret = {k for k, f in new.items() if f["secret"] and k in old and not old[k]["secret"]}
    removed = set(old) - set(new)
    if not to_secret and not removed:
        return 0
    ring = keyring()
    count = 0
    for cred in db.query(models.Credential).filter(models.Credential.type_id == type_row.id).all():
        public = dict(cred.public_fields or {})
        touched = bool((set(public) | set(cred.secret_fields_set or [])) & (to_secret | removed))
        if not touched:
            continue
        secrets = _open(cred, ring)
        for key in to_secret:
            if key in public:
                secrets[key] = public.pop(key)
        for key in removed:
            public.pop(key, None)
            secrets.pop(key, None)
        cred.public_fields = public
        cred.type_version = type_row.version
        _seal(cred, secrets, ring)
        count += 1
    if count:
        audit.record(
            db, actor=actor, action="credential_type.reshape", object_type="credential_type", object_id=type_row.id,
            detail={"credentials": count, "made_secret": sorted(to_secret), "removed": sorted(removed)},
        )
    return count


def describe(cred: models.Credential) -> dict[str, Any]:
    """Everything an admin may see about a credential: never a secret."""
    return {
        "id": cred.id,
        "name": cred.name,
        "type_id": cred.type_id,
        "type_label": cred.type.label if cred.type else cred.type_id,
        "type_version": cred.type_version,
        "description": cred.description,
        "scope": cred.scope,
        "group_id": cred.group_id,
        "group_name": cred.group.name if cred.group else None,
        "public_fields": cred.public_fields or {},
        "secret_fields_set": cred.secret_fields_set or [],
        "grants": sorted(g.group_id for g in cred.grants),
        "created_at": cred.created_at,
        "updated_at": cred.updated_at,
        "last_tested_at": cred.last_tested_at,
        "last_test_ok": cred.last_test_ok,
        "last_test_message": cred.last_test_message,
        "last_used_at": cred.last_used_at,
    }
