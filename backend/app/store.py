"""The store repo: what is built here is kept as a plugin (PLATFORM_PLAN.md
§20.4, §21, D70, D80).

Definitions made in the platform -- today the credential and connection
types admins define -- are written through to a git repo in exactly a
plugin repo's layout (`plugin.yaml`, `credential-types/`, `connection-types/`),
so they outlive the deployment, travel between deployments, and can be
installed elsewhere as a plugin. Only what a plugin could ship goes there:
never a credential's values, connections, users, grants, sessions or runs,
which stay in Postgres.

How it is kept honest:
- **The items stay in their own tables**; `store_items` only tracks each one
  -- its file, and the blob of that file as this platform last wrote or read
  it. A remote file that isn't that blob any more was edited in the repo
  since: the next write of the item is a conflict, shown to an admin, never an
  overwrite.
- **A change and its pending commit are one transaction**: `record()` adds a
  `store_outbox` row beside the change, before the caller commits.
- **One writer at a time**, any replica: `flush()` holds a Postgres advisory
  lock while it works in a private clone (`gitrepo.Repo`) -- fetch, reset,
  apply the outbox in order, commit as the person who saved, push; a refused
  push (someone pushed meanwhile) is fetched and replayed.
- **Git never blocks a save**: unreachable, the rows wait, the items say
  `pending` with the reason, and a background task retries.
- **On start the repo restores what the database lacks** (`restore()`), unless
  it was deleted here and the delete isn't pushed yet; the first time a repo
  is configured, what this deployment already had is added to it ("adopted").

Configured by Helm (env, a mounted secret) or, when Helm leaves it unset, by an
admin in Settings → Store (the token or key a credential of the store).
"""

from __future__ import annotations

import asyncio
import contextlib
import dataclasses
import datetime
import hashlib
import logging
import os
import re
import tempfile
import uuid
from pathlib import Path
from typing import Any, Callable, Iterator, Optional

import yaml
from sqlalchemy import event, text
from sqlalchemy.orm import Session

from . import audit, connections, credential_store, credential_types, gitrepo, models
from .db import SessionLocal, engine

log = logging.getLogger("store")

# Any number unique to this lock among the platform's advisory locks.
LOCK_KEY = 704_211_901
NAMESPACE_RE = re.compile(r"^[a-z][a-z0-9_-]{0,23}$")
_NAME_RE = re.compile(r"^[a-z][a-z0-9_]{1,63}$")
COMMITTER = ("Platform", "platform@localhost")
STATE_KEYS = ("url", "branch", "path", "namespace", "author_domain", "username", "credential_id", "known_hosts")
# Credential types a store's token or key can be (Settings → Store).
AUTH_TYPES = ("api_token", "username_password", "secret_text", "ssh_key")


class StoreError(ValueError):
    """Something about the store a person can act on."""


# ------------------------------------------------------------------- kinds


@dataclasses.dataclass(frozen=True)
class Kind:
    """One kind of item the store keeps: the one place that knows its file."""

    key: str
    directory: str
    contributes: str
    noun: str
    model: type
    dump: Callable[[Any], dict]
    load: Callable[[Session, dict, Any, Optional[models.User]], Any]
    remove: Callable[[Session, Any], None]
    builtin: Callable[[Any], bool]
    # Seeded by the platform (a manifest's connection type): left out of
    # adoption, and the repo's copy wins over the seed on a restore.
    seeded: Callable[[Any], bool]
    label: Callable[[Any], str]
    # The file itself, for a kind kept as it was written (a workflow's YAML,
    # comments and all) rather than dumped from its row. Its `load` then finds
    # the file's text under `__source__`.
    file: Optional[Callable[[Any], str]] = None


def _content(kind: "Kind", row: Any) -> str:
    return kind.file(row) if kind.file is not None else render(kind.dump(row))


def _clean(d: dict) -> dict:
    return {k: v for k, v in d.items() if v not in (None, "", [], {})}


def _dump_credential_type(row: models.CredentialType) -> dict:
    return _clean({
        "id": row.id, "label": row.label, "description": row.description, "version": row.version,
        "fields": row.fields, "output_template": row.output_template, "inject": row.inject,
        "http_test": row.http_test,
    })


def _load_credential_type(db: Session, data: dict, row: Optional[models.CredentialType],
                          actor: Optional[models.User]) -> models.CredentialType:
    type_id = str(data.get("id") or "")
    if not valid_id(type_id, credential_types.TYPE_ID_RE):
        raise StoreError(f"'{type_id}' isn't a credential type id.")
    label = str(data.get("label") or "").strip()
    if not label:
        raise StoreError(f"Credential type {type_id} has no label.")
    try:
        fields, template, inject, http_test = credential_types.validate_definition(
            data.get("fields") or [], data.get("output_template"), data.get("inject"), data.get("http_test")
        )
    except credential_types.CredentialTypeError as e:
        raise StoreError(f"Credential type {type_id}: {e}") from None
    if row is None:
        row = models.CredentialType(id=type_id, builtin=False, version=max(1, int(data.get("version") or 1)))
        db.add(row)
        old_fields = None
    else:
        if row.builtin:
            raise StoreError(f"{row.label} is built in; the repo can't change it.")
        old_fields = row.fields
    row.label, row.description = label, data.get("description") or None
    row.fields, row.output_template, row.inject, row.http_test = fields, template, inject, http_test
    if old_fields is not None and old_fields != fields:
        row.version += 1
        if actor is not None:
            credential_store.reshape_for_type(db, actor, row, old_fields)
    row.updated_at = datetime.datetime.utcnow()
    return row


def _remove_credential_type(db: Session, row: models.CredentialType) -> None:
    used = db.query(models.Credential).filter(models.Credential.type_id == row.id).count()
    if used:
        raise StoreError(f"{used} credential{'s' if used != 1 else ''} use {row.label}: delete or replace them first.")
    db.delete(row)


def _dump_connection_type(row: models.ConnectionType) -> dict:
    return _clean({
        "id": row.id, "label": row.label, "description": row.description,
        "fields": [f for f in row.fields or [] if f.get("key") != "base_url"],
        "identity_types": row.identity_types,
    })


def _load_connection_type(db: Session, data: dict, row: Optional[models.ConnectionType],
                          _actor: Optional[models.User]) -> models.ConnectionType:
    type_id = str(data.get("id") or "")
    if not valid_id(type_id, connections.TYPE_ID_RE):
        raise StoreError(f"'{type_id}' isn't a connection type id.")
    label = str(data.get("label") or "").strip()
    if not label:
        raise StoreError(f"Connection type {type_id} has no label.")
    try:
        fields = connections.type_fields([f for f in data.get("fields") or [] if f.get("key") != "base_url"])
        if row is not None:
            connections.check_removed_fields(db, row, fields)
    except connections.ConnectionConfigError as e:
        raise StoreError(f"Connection type {type_id}: {e}") from None
    identity = [str(t) for t in data.get("identity_types") or [connections.ANY_INJECT]]
    if row is None:
        row = models.ConnectionType(id=type_id, builtin=False, origin=None)
        db.add(row)
    elif row.builtin:
        raise StoreError(f"{row.label} is built in; the repo can't change it.")
    row.label, row.description, row.fields, row.identity_types = label, data.get("description") or None, fields, identity
    return row


def _remove_connection_type(db: Session, row: models.ConnectionType) -> None:
    used = db.query(models.Connection).filter(models.Connection.type_id == row.id).count()
    if used:
        raise StoreError(f"{used} connection{'s are' if used != 1 else ' is'} of {row.label}: delete them first.")
    db.delete(row)


def _load_workflow(db: Session, data: dict, row: Optional[models.Workflow],
                   _actor: Optional[models.User]) -> models.Workflow:
    from . import workflows

    workflow_id = str(data.get("id") or "")
    if not valid_id(workflow_id, workflows.ID_RE):
        raise StoreError(f"'{workflow_id}' isn't a workflow id.")
    source = str(data.get("__source__") or "")
    try:
        definition = workflows.parse(source)
    except workflows.WorkflowError as e:
        raise StoreError(f"Workflow {workflow_id}: {e}") from None
    if row is None:
        row = models.Workflow(id=workflow_id)
        db.add(row)
    row.label, row.description, row.source = definition.label, definition.description, source
    row.definition = definition.model_dump(by_alias=True, exclude_none=True)
    row.updated_at = datetime.datetime.utcnow()
    return row


def _remove_workflow(db: Session, row: models.Workflow) -> None:
    db.delete(row)


def _load_template(db: Session, data: dict, row: Optional[models.PublishedTemplate],
                   actor: Optional[models.User]) -> models.PublishedTemplate:
    from . import templates

    return templates.load(db, data, row, actor)


def _dump_template(row: models.PublishedTemplate) -> dict:
    from . import templates

    return templates.dump(row)


KINDS: dict[str, Kind] = {
    k.key: k
    for k in (
        Kind(
            key="credential_type", directory="credential-types", contributes="credential_types",
            noun="credential type", model=models.CredentialType, dump=_dump_credential_type,
            load=_load_credential_type, remove=_remove_credential_type, builtin=lambda r: bool(r.builtin),
            seeded=lambda r: False, label=lambda r: r.label,
        ),
        Kind(
            key="workflow", directory="workflows", contributes="workflows", noun="workflow",
            model=models.Workflow, dump=lambda r: {}, load=_load_workflow, remove=_remove_workflow,
            builtin=lambda r: False, seeded=lambda r: False, label=lambda r: r.label, file=lambda r: r.source,
        ),
        Kind(
            key="template", directory="templates", contributes="templates", noun="template",
            model=models.PublishedTemplate, dump=_dump_template, load=_load_template,
            remove=lambda db, row: db.delete(row), builtin=lambda r: False, seeded=lambda r: False,
            label=lambda r: r.label,
        ),
        Kind(
            key="connection_type", directory="connection-types", contributes="connection_types",
            noun="connection type", model=models.ConnectionType, dump=_dump_connection_type,
            load=_load_connection_type, remove=_remove_connection_type, builtin=lambda r: bool(r.builtin),
            seeded=lambda r: bool(r.origin and r.origin.startswith("manifest:")), label=lambda r: r.label,
        ),
    )
}


def render(data: dict) -> str:
    return yaml.safe_dump(data, sort_keys=False, allow_unicode=True, default_flow_style=False, width=100)


# ------------------------------------------------------------------- ids (D78)


def split_id(item_id: str) -> tuple[Optional[str], str]:
    ns, sep, name = item_id.partition(":")
    return (ns, name) if sep else (None, item_id)


def valid_id(item_id: str, name_re: re.Pattern) -> bool:
    ns, name = split_id(item_id)
    return (ns is None or bool(NAMESPACE_RE.match(ns))) and bool(name_re.match(name))


def full_id(db: Session, requested: str, name_re: re.Pattern) -> str:
    """The id a new item gets: in the store's namespace when a store is
    configured (`grafana` -> `devops:grafana`), as asked otherwise. Built-ins
    and items made before keep their bare ids -- this only names new ones."""
    requested = (requested or "").strip()
    ns, name = split_id(requested)
    if not name_re.match(name) or (ns is not None and not NAMESPACE_RE.match(ns)):
        raise StoreError(
            f"'{requested}' can't be an id: a lowercase letter, then lowercase letters, digits or _"
            " -- optionally after a namespace and a colon."
        )
    store_ns = namespace(db)
    out = requested if store_ns is None else f"{store_ns}:{name}"
    if len(out) > 64:
        raise StoreError(f"'{out}' is too long for an id: 64 characters at most, namespace included.")
    if store_ns is None:
        return requested
    if ns is not None and ns != store_ns:
        raise StoreError(f"What is made here is in the store's namespace, {store_ns}: call it {store_ns}:{name}.")
    return f"{store_ns}:{name}"


# ------------------------------------------------------------------- configuration


@dataclasses.dataclass
class Config:
    url: str
    branch: str
    path: str
    namespace: str
    author_domain: str
    source: str  # "helm" | "settings"
    username: str = ""
    credential_id: Optional[int] = None
    known_hosts: str = ""
    configured_by: Optional[int] = None

    @property
    def key(self) -> str:
        return f"{self.url}#{self.branch}:{self.path}"

    def file(self, *parts: str) -> str:
        return "/".join(p for p in (self.path, *parts) if p)


def _setting(db: Session, key: str) -> Optional[str]:
    row = db.get(models.Setting, f"store.{key}")
    return row.value if row else None


def _set_setting(db: Session, key: str, value: Optional[str]) -> None:
    row = db.get(models.Setting, f"store.{key}")
    if value is None:
        if row is not None:
            db.delete(row)
    elif row is None:
        db.add(models.Setting(key=f"store.{key}", value=value))
    else:
        row.value = value


def helm_configured() -> bool:
    return bool((os.environ.get("STORE_GIT_URL") or "").strip())


def config(db: Session) -> Optional[Config]:
    """The store's configuration: Helm's (env) when it sets a URL, else what an
    admin saved in Settings; None when there is no store."""
    if helm_configured():
        return Config(
            url=os.environ["STORE_GIT_URL"].strip(),
            branch=(os.environ.get("STORE_GIT_BRANCH") or "main").strip(),
            path=(os.environ.get("STORE_GIT_PATH") or "").strip().strip("/"),
            namespace=(os.environ.get("STORE_NAMESPACE") or "").strip(),
            author_domain=(os.environ.get("STORE_AUTHOR_DOMAIN") or "platform.local").strip(),
            username=(os.environ.get("STORE_GIT_USERNAME") or "").strip(),
            source="helm",
        )
    url = _setting(db, "url")
    if not url:
        return None
    cred = _setting(db, "credential_id")
    by = _setting(db, "configured_by")
    return Config(
        url=url, branch=_setting(db, "branch") or "main", path=_setting(db, "path") or "",
        namespace=_setting(db, "namespace") or "", author_domain=_setting(db, "author_domain") or "platform.local",
        username=_setting(db, "username") or "", credential_id=int(cred) if cred else None,
        known_hosts=_setting(db, "known_hosts") or "", configured_by=int(by) if by else None, source="settings",
    )


def namespace(db: Session) -> Optional[str]:
    cfg = config(db)
    return cfg.namespace if cfg and NAMESPACE_RE.match(cfg.namespace) else None


def _check(cfg: Config) -> None:
    try:
        gitrepo.check_url(cfg.url)
    except ValueError as e:
        raise StoreError(str(e)) from None
    if not NAMESPACE_RE.match(cfg.namespace or ""):
        raise StoreError("The store needs a namespace: a lowercase letter, then letters, digits, _ or - (up to 24).")
    if not re.match(r"^[A-Za-z0-9._/-]{1,100}$", cfg.branch) or ".." in cfg.branch:
        raise StoreError(f"'{cfg.branch}' isn't a branch name.")
    if cfg.path and (".." in cfg.path.split("/") or not re.match(r"^[A-Za-z0-9._/-]+$", cfg.path)):
        raise StoreError(f"'{cfg.path}' isn't a path in the repo.")


def _secret_file(name: str) -> str:
    directory = os.environ.get("STORE_GIT_SECRET_DIR") or ""
    if not directory:
        return ""
    path = Path(directory) / name
    return path.read_text() if path.is_file() else ""


def _auth(db: Session, cfg: Config) -> gitrepo.Auth:
    if cfg.source == "helm":
        return gitrepo.Auth(
            username=cfg.username, password=_secret_file("token").strip(),
            ssh_key=_secret_file("ssh-privatekey"), known_hosts=_secret_file("known_hosts"),
        )
    if cfg.credential_id is None:
        return gitrepo.Auth(known_hosts=cfg.known_hosts)
    actor = db.get(models.User, cfg.configured_by) if cfg.configured_by else None
    if actor is None:
        raise StoreError("The admin who chose the store's credential no longer exists: choose it again.")
    try:
        type_row, values = credential_store.resolve(
            db, cfg.credential_id, actor=actor, purpose="Store repo", actor_kind="store", coalesce=True
        )
    except (credential_store.CredentialAccessError, credential_store.CredentialsOff, credential_store.CredentialError) as e:
        raise StoreError(f"The store's credential can't be used: {e}") from None
    if type_row.id == "ssh_key":
        return gitrepo.Auth(ssh_key=_unlocked_key(values), known_hosts=cfg.known_hosts)
    password = values.get("token") or values.get("password") or values.get("value") or ""
    return gitrepo.Auth(username=values.get("username") or cfg.username, password=str(password))


def _unlocked_key(values: dict) -> str:
    """An SSH key without its passphrase, for the one command: ssh can't ask."""
    key, passphrase = str(values.get("private_key") or ""), values.get("passphrase")
    if not passphrase:
        return key
    from cryptography.hazmat.primitives import serialization

    loaded = serialization.load_ssh_private_key(key.encode(), password=str(passphrase).encode())
    return loaded.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.OpenSSH, serialization.NoEncryption()
    ).decode()


def _repo(db: Session, cfg: Config) -> gitrepo.Repo:
    base = Path(os.environ.get("STORE_WORKDIR") or Path(tempfile.gettempdir()) / "platform-store")
    workdir = base / hashlib.sha1(cfg.key.encode()).hexdigest()[:12] / "clone"
    try:
        return gitrepo.Repo(cfg.url, cfg.branch, workdir, _auth(db, cfg))
    except ValueError as e:
        raise StoreError(str(e)) from None


# ------------------------------------------------------------------- recording a change


def _path_for(db: Session, cfg: Config, kind: Kind, item_id: str) -> str:
    ns, name = split_id(item_id)
    stem = name if ns in (None, cfg.namespace) else f"{ns}--{name}"
    path = cfg.file(kind.directory, f"{stem}.yaml")
    taken = {p for (p,) in db.query(models.StoreItem.path).filter(models.StoreItem.kind == kind.key)}
    if path in taken and ns is not None:
        path = cfg.file(kind.directory, f"{ns}--{name}.yaml")
    return path


def record(db: Session, kind_key: str, item_id: str, op: str, actor: Optional[models.User],
           message: Optional[str] = None, batch: Optional[str] = None) -> None:
    """Queues a change of one item for the store, in the caller's transaction
    (call it before committing). A no-op without a store, so every save path
    can call it unconditionally."""
    try:
        cfg = config(db)
        if cfg is not None:
            _check(cfg)
    except StoreError:
        return
    if cfg is None:
        return
    kind = KINDS[kind_key]
    item = db.query(models.StoreItem).filter_by(kind=kind_key, item_id=item_id).first()
    content = None
    if op == "write":
        row = db.get(kind.model, item_id)
        if row is None or kind.builtin(row):
            return
        content = _content(kind, row)
    elif item is None:
        return  # never written to the repo, so nothing to delete there
    if item is None:
        item = models.StoreItem(kind=kind_key, item_id=item_id, path=_path_for(db, cfg, kind, item_id), state="pending")
        db.add(item)
        db.flush()
        verb = "Add"
    else:
        verb = "Delete" if op == "delete" else "Change"
        if item.state != "conflict":
            item.state = "pending"
        item.error = None
        item.updated_at = datetime.datetime.utcnow()
    db.add(models.StoreOutbox(
        kind=kind_key, item_id=item_id, op=op, content=content, batch=batch,
        message=message or f"{verb} {kind.noun} {item_id}",
        author=actor.username if actor is not None else "platform",
    ))
    event.listen(db, "after_commit", lambda _s: manager.kick(), once=True)


# ------------------------------------------------------------------- the one writer


@contextlib.contextmanager
def _locked() -> Iterator[bool]:
    with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
        got = bool(conn.execute(text("SELECT pg_try_advisory_lock(:k)"), {"k": LOCK_KEY}).scalar())
        try:
            yield got
        finally:
            if got:
                conn.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": LOCK_KEY})


def _now() -> str:
    return datetime.datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


def _status(db: Session, error: Optional[str]) -> None:
    _set_setting(db, "last_error", error)
    if error is None:
        _set_setting(db, "last_sync_at", _now())
    else:
        _set_setting(db, "last_error_at", _now())


def _plugin_yaml(repo: gitrepo.Repo, cfg: Config) -> None:
    """`plugin.yaml` as §7.1 has it, listing what the repo holds. Anything
    else in it (a name, a version, another kind's list someone added by hand)
    is kept."""
    path = cfg.file("plugin.yaml")
    try:
        current = yaml.safe_load(repo.read(path) or "") or {}
    except yaml.YAMLError:
        current = {}
    data = dict(current) if isinstance(current, dict) else {}
    data["id"] = cfg.namespace
    data.setdefault("name", cfg.namespace)
    data.setdefault("version", "0.0.0")
    contributes = dict(data.get("contributes") or {})
    for kind in KINDS.values():
        stems = [Path(p).stem for p in repo.files(cfg.file(kind.directory))]
        if stems:
            contributes[kind.contributes] = stems
        else:
            contributes.pop(kind.contributes, None)
    data["contributes"] = contributes
    text_out = render(data)
    if repo.read(path) != text_out:
        repo.write(path, text_out)


def flush() -> dict[str, Any]:
    """Pushes the outbox, if this replica can take the lock. Safe to call any
    time from anywhere; the background task does, and so does "Sync now"."""
    with _locked() as got:
        if not got:
            return {"busy": True}
        db = SessionLocal()
        try:
            return _flush(db)
        finally:
            db.close()


def _flush(db: Session) -> dict[str, Any]:
    try:
        cfg = config(db)
        if cfg is None:
            return {"configured": False}
        _check(cfg)
        rows = db.query(models.StoreOutbox).order_by(models.StoreOutbox.id).all()
        if not rows:
            return {"pushed": 0}
        repo = _repo(db, cfg)
    except StoreError as e:
        _fail_pending(db, str(e))
        return {"error": str(e)}
    for _attempt in range(3):
        try:
            repo.sync()
            done, blobs, conflicts = _apply(db, cfg, repo, rows)
            if done:
                repo.push()
            _settle(db, done, blobs, conflicts)
            _status(db, None)
            db.commit()
            return {"pushed": len(done), "conflicts": len(conflicts)}
        except gitrepo.Rejected:
            log.info("The store repo moved on during a push; fetching and replaying.")
            continue
        except gitrepo.GitError as e:
            db.rollback()
            _fail_pending(db, str(e))
            return {"error": str(e)}
    db.rollback()
    _fail_pending(db, "The repo kept moving on during pushes; trying again shortly.")
    return {"error": "busy remote"}


def _fail_pending(db: Session, error: str) -> None:
    log.warning("Store: %s", error)
    for item in db.query(models.StoreItem).filter(models.StoreItem.state == "pending"):
        item.error = error
    _status(db, error)
    db.commit()


def _apply(db: Session, cfg: Config, repo: gitrepo.Repo, rows: list[models.StoreOutbox]):
    """Applies the outbox to the clone, a commit per row (or per batch). Nothing
    in the database changes here: a refused push replays this from scratch."""
    items = {(i.kind, i.item_id): i for i in db.query(models.StoreItem)}
    blobs: dict[tuple[str, str], Optional[str]] = {}
    conflicts: dict[tuple[str, str], Optional[str]] = {}
    done: list[models.StoreOutbox] = []
    staged: list[models.StoreOutbox] = []

    def commit() -> None:
        if not staged:
            return
        _plugin_yaml(repo, cfg)
        first = staged[0]
        repo.commit(first.message, first.author, f"{first.author}@{cfg.author_domain}", COMMITTER)
        done.extend(staged)
        staged.clear()

    for i, row in enumerate(rows):
        key = (row.kind, row.item_id)
        item = items.get(key)
        if item is None:
            done.append(row)  # its item is gone (a store reset): nothing to write
            continue
        if key in conflicts:
            continue
        expected = blobs[key] if key in blobs else item.blob
        if item.state == "conflict" and key not in blobs:
            conflicts[key] = item.theirs
            continue
        if repo.blob(item.path) != expected:
            conflicts[key] = repo.blob(item.path)
            continue
        repo.write(item.path, row.content if row.op == "write" else None)
        blobs[key] = repo.hash(row.content) if row.op == "write" else None
        staged.append(row)
        following = rows[i + 1] if i + 1 < len(rows) else None
        if not (row.batch and following is not None and following.batch == row.batch):
            commit()
    commit()
    return done, blobs, conflicts


def _settle(db: Session, done: list[models.StoreOutbox], blobs: dict, conflicts: dict) -> None:
    done_ids = {r.id for r in done}
    for row in done:
        db.delete(row)
    db.flush()
    for (kind, item_id), blob in blobs.items():
        item = db.query(models.StoreItem).filter_by(kind=kind, item_id=item_id).with_for_update().first()
        if item is None:
            continue
        waiting = db.query(models.StoreOutbox).filter_by(kind=kind, item_id=item_id).filter(
            ~models.StoreOutbox.id.in_(done_ids or {0})
        ).count()
        if blob is None and not waiting:
            db.delete(item)
            continue
        item.blob = blob
        item.state = "pending" if waiting else "synced"
        item.error = None
        item.theirs = None
        item.updated_at = datetime.datetime.utcnow()
    for (kind, item_id), theirs in conflicts.items():
        item = db.query(models.StoreItem).filter_by(kind=kind, item_id=item_id).first()
        if item is None:
            continue
        item.state, item.theirs = "conflict", theirs
        item.error = "Changed in the repo since this platform last wrote it: keep yours or take the repo's."
        item.updated_at = datetime.datetime.utcnow()


# ------------------------------------------------------------------- restoring


def restore(db: Session, actor: Optional[models.User] = None) -> list[str]:
    """Brings in what the repo holds and this database lacks; the first time
    a repo is configured, also queues what this deployment already had. Returns
    what it did, a line each, for the log."""
    cfg = config(db)
    if cfg is None:
        return []
    _check(cfg)
    lines: list[str] = []
    with _locked() as got:
        if not got:
            return ["Another replica is working on the store; it restores."]
        repo = _repo(db, cfg)
        try:
            exists = repo.sync()
        except gitrepo.GitError as e:
            _status(db, str(e))
            db.commit()
            raise StoreError(str(e)) from None
        tracked = {(i.kind, i.item_id) for i in db.query(models.StoreItem)}
        deleting = {(r.kind, r.item_id) for r in db.query(models.StoreOutbox).filter_by(op="delete")}
        if exists:
            for kind in KINDS.values():
                for path in repo.files(cfg.file(kind.directory)):
                    line = _restore_one(db, repo, kind, path, tracked, deleting, actor)
                    if line:
                        lines.append(line)
        db.flush()  # the session doesn't autoflush: adoption must see what was restored
        if _setting(db, "adopted") != cfg.key:
            lines.extend(_adopt(db, actor))
            _set_setting(db, "adopted", cfg.key)
        db.commit()
    return lines


def _restore_one(db: Session, repo: gitrepo.Repo, kind: Kind, path: str, tracked: set, deleting: set,
                 actor: Optional[models.User]) -> Optional[str]:
    raw = repo.read(path) or ""
    try:
        data = yaml.safe_load(raw) or {}
    except yaml.YAMLError as e:
        return f"Skipped {path}: not YAML ({e})."
    if isinstance(data, dict):
        data["__source__"] = raw
    item_id = str(data.get("id") or "") if isinstance(data, dict) else ""
    if not item_id:
        return f"Skipped {path}: it has no id."
    key = (kind.key, item_id)
    if key in tracked or key in deleting:
        return None
    remote = repo.blob(path)
    row = db.get(kind.model, item_id)
    try:
        if row is None or kind.seeded(row):
            with db.begin_nested():
                kind.load(db, data, row, actor)
            db.add(models.StoreItem(kind=kind.key, item_id=item_id, path=path, blob=remote, state="synced"))
            return f"Restored {kind.noun} {item_id} from {path}."
    except StoreError as e:
        return f"Skipped {path}: {e}"
    if kind.builtin(row):
        return f"Skipped {path}: {item_id} is built in."
    mine = repo.hash(_content(kind, row))
    same = mine == remote
    db.add(models.StoreItem(
        kind=kind.key, item_id=item_id, path=path, blob=remote if same else None,
        theirs=None if same else remote, state="synced" if same else "conflict",
        error=None if same else "Both this platform and the repo have it, differently: keep yours or take the repo's.",
    ))
    return None if same else f"{kind.noun.capitalize()} {item_id} differs from {path}: a conflict to resolve."


def _adopt(db: Session, actor: Optional[models.User]) -> list[str]:
    """Queues every item this deployment made that the repo doesn't track, as
    one commit."""
    batch = f"adopt-{uuid.uuid4().hex[:8]}"
    tracked = {(i.kind, i.item_id) for i in db.query(models.StoreItem)}
    count = 0
    for kind in KINDS.values():
        for row in db.query(kind.model).all():
            if kind.builtin(row) or kind.seeded(row) or (kind.key, row.id) in tracked:
                continue
            record(db, kind.key, row.id, "write", actor, message="Add what this deployment already had", batch=batch)
            db.flush()
            count += 1
    return [f"Queued {count} item(s) this deployment already had."] if count else []


def startup() -> None:
    """At start: restore from the repo and push what is pending. A store that
    can't be reached is reported and the platform starts anyway."""
    db = SessionLocal()
    try:
        cfg = config(db)
        if cfg is None:
            return
        try:
            for line in restore(db):
                log.warning("Store: %s", line)
        except StoreError as e:
            log.warning("Store: can't reach the repo at start (%s); carrying on, and retrying.", e)
            return
    finally:
        db.close()
    result = flush()
    if result.get("error"):
        log.warning("Store: %s", result["error"])


# ------------------------------------------------------------------- resolving conflicts


def item(db: Session, kind_key: str, item_id: str) -> models.StoreItem:
    if kind_key not in KINDS:
        raise StoreError(f"The store keeps no {kind_key}.")
    row = db.query(models.StoreItem).filter_by(kind=kind_key, item_id=item_id).first()
    if row is None:
        raise StoreError("The store doesn't track that item.")
    return row


def sides(db: Session, kind_key: str, item_id: str) -> dict[str, Optional[str]]:
    """Both versions of a conflicted item, as files, for an admin to compare."""
    tracked = item(db, kind_key, item_id)
    kind = KINDS[kind_key]
    row = db.get(kind.model, item_id)
    cfg = config(db)
    if cfg is None:
        raise StoreError("There is no store.")
    with _locked() as got:
        if not got:
            raise StoreError("The store is busy; try again in a moment.")
        repo = _repo(db, cfg)
        try:
            repo.sync()
        except gitrepo.GitError as e:
            raise StoreError(str(e)) from None
        theirs = repo.read(tracked.path)
    return {"mine": _content(kind, row) if row is not None else None, "theirs": theirs, "path": tracked.path}


def resolve(db: Session, kind_key: str, item_id: str, take: str, actor: models.User) -> None:
    """Ends a conflict: `mine` writes this platform's version over the repo's,
    `theirs` loads the repo's into this platform (or deletes the item here if
    the repo deleted it)."""
    tracked = item(db, kind_key, item_id)
    if tracked.state != "conflict":
        raise StoreError("That item isn't in conflict.")
    kind = KINDS[kind_key]
    cfg = config(db)
    if cfg is None:
        raise StoreError("There is no store.")
    with _locked() as got:
        if not got:
            raise StoreError("The store is busy; try again in a moment.")
        repo = _repo(db, cfg)
        try:
            repo.sync()
        except gitrepo.GitError as e:
            raise StoreError(str(e)) from None
        remote = repo.blob(tracked.path)
        row = db.get(kind.model, item_id)
        if take == "mine":
            # Expecting the repo's current blob is what lets the next push
            # write over it -- and a further edit there conflicts again.
            tracked.blob, tracked.theirs, tracked.state, tracked.error = remote, None, "pending", None
            waiting = db.query(models.StoreOutbox).filter_by(kind=kind_key, item_id=item_id).count()
            if not waiting:
                record(db, kind_key, item_id, "write" if row is not None else "delete", actor,
                       message=f"Keep this platform's {kind.noun} {item_id}")
        elif take == "theirs":
            db.query(models.StoreOutbox).filter_by(kind=kind_key, item_id=item_id).delete()
            if remote is None:
                if row is not None:
                    kind.remove(db, row)
                db.delete(tracked)
            else:
                raw = repo.read(tracked.path) or ""
                try:
                    data = yaml.safe_load(raw) or {}
                except yaml.YAMLError as e:
                    raise StoreError(f"The repo's file isn't YAML: {e}") from None
                if isinstance(data, dict):
                    data["__source__"] = raw
                if str(data.get("id") or "") != item_id:
                    raise StoreError(f"The repo's {tracked.path} is now {data.get('id')!r}, not {item_id}.")
                kind.load(db, data, row, actor)
                tracked.blob, tracked.theirs, tracked.state, tracked.error = remote, None, "synced", None
        else:
            raise StoreError("Take 'mine' or 'theirs'.")
        audit.record(db, actor=actor, action="store.resolve", object_type=kind_key, object_id=item_id,
                     detail={"take": take})
        db.commit()


# ------------------------------------------------------------------- settings and status


def configure(db: Session, values: dict[str, Any], actor: models.User) -> list[str]:
    """Saves Settings → Store (when Helm hasn't set it), then restores and
    adopts. A different repo, branch or path starts tracking afresh."""
    if helm_configured():
        raise StoreError("The store is set by the deployment (Helm) and can't be changed here.")
    before = config(db)
    cfg = Config(
        url=str(values.get("url") or "").strip(), branch=str(values.get("branch") or "main").strip(),
        path=str(values.get("path") or "").strip().strip("/"), namespace=str(values.get("namespace") or "").strip(),
        author_domain=str(values.get("author_domain") or "platform.local").strip(),
        username=str(values.get("username") or "").strip(),
        credential_id=int(values["credential_id"]) if values.get("credential_id") else None,
        known_hosts=str(values.get("known_hosts") or ""), source="settings", configured_by=actor.id,
    )
    _check(cfg)
    if cfg.credential_id is not None:
        cred = db.get(models.Credential, cfg.credential_id)
        if cred is None:
            raise StoreError("That credential doesn't exist.")
        if cred.type_id not in AUTH_TYPES:
            raise StoreError("The store's credential must be an API token, a username and password, a secret or an SSH key.")
    if before is not None and before.namespace and before.namespace != cfg.namespace and _items_named(db, before.namespace):
        raise StoreError(f"Items are already named {before.namespace}:…; the namespace can't change under them.")
    if before is None or before.key != cfg.key:
        _forget(db)
    for key in STATE_KEYS:
        value = getattr(cfg, key)
        _set_setting(db, key, None if value in (None, "") else str(value))
    _set_setting(db, "configured_by", str(actor.id))
    audit.record(db, actor=actor, action="store.configure", object_type="store", object_id="repo",
                 detail={"url": cfg.url, "branch": cfg.branch, "path": cfg.path, "namespace": cfg.namespace})
    db.commit()
    # Saved either way: a repo that can't be reached now may be a moment away,
    # and the status says why (last_error) until it can.
    try:
        return restore(db, actor)
    except StoreError as e:
        return [f"Couldn't reach the repo yet: {e}"]


def _items_named(db: Session, ns: str) -> bool:
    return any(db.query(k.model).filter(k.model.id.like(f"{ns}:%")).count() for k in KINDS.values())


def _forget(db: Session) -> None:
    db.query(models.StoreOutbox).delete()
    db.query(models.StoreItem).delete()
    for key in ("adopted", "last_error", "last_error_at", "last_sync_at"):
        _set_setting(db, key, None)


def unconfigure(db: Session, actor: models.User) -> None:
    if helm_configured():
        raise StoreError("The store is set by the deployment (Helm) and can't be removed here.")
    _forget(db)
    for key in (*STATE_KEYS, "configured_by"):
        _set_setting(db, key, None)
    audit.record(db, actor=actor, action="store.unconfigure", object_type="store", object_id="repo", detail={})
    db.commit()


def state_of(db: Session, kind_key: str) -> dict[str, str]:
    """Each tracked item of a kind's state, for the type lists' badges."""
    return {i.item_id: i.state for i in db.query(models.StoreItem).filter_by(kind=kind_key)}


def status(db: Session) -> dict[str, Any]:
    cfg = config(db)
    out: dict[str, Any] = {
        "configured": cfg is not None, "source": cfg.source if cfg else None, "locked": helm_configured(),
        "url": cfg.url if cfg else None, "branch": cfg.branch if cfg else None, "path": cfg.path if cfg else None,
        "namespace": cfg.namespace if cfg else None, "author_domain": cfg.author_domain if cfg else None,
        "username": cfg.username if cfg else None, "known_hosts": cfg.known_hosts if cfg else None,
        "credential_id": cfg.credential_id if cfg else None, "credential_name": None,
        "auth": None, "problem": None,
        "last_sync_at": _setting(db, "last_sync_at"), "last_error": _setting(db, "last_error"),
        "pending": db.query(models.StoreOutbox).count(), "items": [],
    }
    if cfg is None:
        return out
    try:
        _check(cfg)
    except StoreError as e:
        out["problem"] = str(e)
    if cfg.source == "helm":
        out["auth"] = "token" if _secret_file("token").strip() else "ssh key" if _secret_file("ssh-privatekey") else "none"
    elif cfg.credential_id is not None:
        cred = db.get(models.Credential, cfg.credential_id)
        out["credential_name"] = cred.name if cred else None
        out["auth"] = "ssh key" if cred is not None and cred.type_id == "ssh_key" else "token"
    else:
        out["auth"] = "none"
    for tracked in db.query(models.StoreItem).order_by(models.StoreItem.kind, models.StoreItem.item_id):
        kind = KINDS.get(tracked.kind)
        row = db.get(kind.model, tracked.item_id) if kind else None
        out["items"].append({
            "kind": tracked.kind, "noun": kind.noun if kind else tracked.kind, "item_id": tracked.item_id,
            "label": kind.label(row) if kind and row is not None else tracked.item_id, "path": tracked.path,
            "state": tracked.state, "error": tracked.error,
        })
    return out


# ------------------------------------------------------------------- the background writer


class Manager:
    """Pushes the outbox soon after a change, and retries with backoff while
    git is away. One per replica; the advisory lock makes them take turns."""

    IDLE_SECONDS = 60.0
    BACKOFF = (5.0, 15.0, 30.0, 60.0, 120.0, 300.0)

    def __init__(self) -> None:
        self.loop: Optional[asyncio.AbstractEventLoop] = None
        self._event: Optional[asyncio.Event] = None
        self._task: Optional[asyncio.Task] = None

    def kick(self) -> None:
        if self.loop is not None and self._event is not None:
            self.loop.call_soon_threadsafe(self._event.set)

    async def _run(self) -> None:
        failures = 0
        while True:
            wait = self.BACKOFF[min(failures, len(self.BACKOFF) - 1)] if failures else self.IDLE_SECONDS
            try:
                await asyncio.wait_for(self._event.wait(), timeout=wait)
            except asyncio.TimeoutError:
                pass
            self._event.clear()
            try:
                result = await asyncio.to_thread(_flush_if_pending)
                failures = failures + 1 if result.get("error") else 0
            except Exception:  # noqa: BLE001 -- the loop must outlive any one failure
                log.exception("Store: flushing failed")
                failures += 1

    def start(self) -> None:
        self.loop = asyncio.get_running_loop()
        self._event = asyncio.Event()
        self._task = self.loop.create_task(self._run())
        self.kick()

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
        self.loop = None


def _flush_if_pending() -> dict[str, Any]:
    db = SessionLocal()
    try:
        if db.query(models.StoreOutbox).count() == 0:
            return {}
    finally:
        db.close()
    return flush()


manager = Manager()
