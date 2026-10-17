"""The blob store (PLATFORM_PLAN.md §8.2, D7, D91): files too big for a row --
a workflow step's whole outputs, a run's artifacts -- with only their
metadata in Postgres (`models.Blob`).

Two backends, chosen by the deployment (Helm's `storage:`):
- `filesystem` (the default): a directory, `STORAGE_PATH`. Every replica must
  see the same one, so more than one replica needs a ReadWriteMany volume;
  the chart refuses ReadWriteOnce with several.
- `s3`: any S3-compatible store (`STORAGE_S3_BUCKET`, `_REGION`, `_ENDPOINT`,
  `_PREFIX`), as the platform's own AWS identity (IRSA on EKS) -- never a
  group's.

The store is never browsed: a download goes through the backend, which checks
the row's owner first (`routers/blobs.py`)."""

from __future__ import annotations

import datetime
import hashlib
import logging
import os
import uuid
from pathlib import Path
from typing import Optional, Protocol

from sqlalchemy.orm import Session

from . import models

log = logging.getLogger("blobs")

# The most a blob may hold; a step's outputs past it are cut down to fit.
MAX_BYTES = 64 * 1024 * 1024
DEFAULT_RETENTION_DAYS = 90


class BlobError(RuntimeError):
    """The store couldn't keep or give back a file, said so a person can act on it."""


class Backend(Protocol):
    def put(self, key: str, data: bytes, content_type: str) -> None: ...
    def get(self, key: str) -> bytes: ...
    def delete(self, key: str) -> None: ...


class FilesystemBackend:
    def __init__(self, root: str) -> None:
        self.root = Path(root)

    def _path(self, key: str) -> Path:
        path = (self.root / key).resolve()
        # Keys are ours (`runs/<id>/<uuid>`), but a key is still never a way out of the root.
        if self.root.resolve() not in path.parents:
            raise BlobError(f"'{key}' isn't a key in the store.")
        return path

    def put(self, key: str, data: bytes, content_type: str) -> None:
        path = self._path(key)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            # Written aside and renamed, so a reader never sees half a file.
            partial = path.with_name(path.name + ".partial")
            partial.write_bytes(data)
            os.replace(partial, path)
        except OSError as e:
            raise BlobError(f"The file store at {self.root} couldn't keep a file: {e.strerror or e}.") from None

    def get(self, key: str) -> bytes:
        try:
            return self._path(key).read_bytes()
        except FileNotFoundError:
            raise BlobError("That file isn't in the store any more.") from None
        except OSError as e:
            raise BlobError(f"The file store couldn't read a file: {e.strerror or e}.") from None

    def delete(self, key: str) -> None:
        try:
            self._path(key).unlink(missing_ok=True)
        except OSError:
            log.warning("Couldn't delete %s from the file store", key, exc_info=True)


class S3Backend:
    def __init__(self, bucket: str, region: Optional[str], endpoint: Optional[str], prefix: str) -> None:
        import boto3

        self.bucket, self.prefix = bucket, prefix.strip("/")
        self.client = boto3.client("s3", region_name=region or None, endpoint_url=endpoint or None)

    def _key(self, key: str) -> str:
        return f"{self.prefix}/{key}" if self.prefix else key

    def put(self, key: str, data: bytes, content_type: str) -> None:
        try:
            self.client.put_object(Bucket=self.bucket, Key=self._key(key), Body=data, ContentType=content_type)
        except Exception as e:  # noqa: BLE001 - botocore's own words: no bucket, no permission, no network
            raise BlobError(f"The S3 file store (bucket {self.bucket}) couldn't keep a file: {e}") from None

    def get(self, key: str) -> bytes:
        try:
            return self.client.get_object(Bucket=self.bucket, Key=self._key(key))["Body"].read()
        except Exception as e:  # noqa: BLE001
            raise BlobError(f"The S3 file store (bucket {self.bucket}) couldn't give a file back: {e}") from None

    def delete(self, key: str) -> None:
        try:
            self.client.delete_object(Bucket=self.bucket, Key=self._key(key))
        except Exception:  # noqa: BLE001 - deleting is best-effort; retention catches what's left
            log.warning("Couldn't delete %s from the S3 file store", key, exc_info=True)


_backend: Optional[tuple[tuple, Backend]] = None


def config() -> tuple:
    kind = (os.environ.get("STORAGE_TYPE") or "filesystem").strip().lower()
    if kind == "s3":
        return (
            "s3",
            os.environ.get("STORAGE_S3_BUCKET", ""),
            os.environ.get("STORAGE_S3_REGION"),
            os.environ.get("STORAGE_S3_ENDPOINT"),
            os.environ.get("STORAGE_S3_PREFIX", ""),
        )
    return ("filesystem", os.environ.get("STORAGE_PATH") or "/data/files")


def backend() -> Backend:
    """The configured backend, read from the environment each time (a test
    changes it), built once per configuration."""
    global _backend
    wanted = config()
    if _backend is None or _backend[0] != wanted:
        if wanted[0] == "s3":
            if not wanted[1]:
                raise BlobError("STORAGE_TYPE is s3 but no STORAGE_S3_BUCKET is set.")
            built: Backend = S3Backend(wanted[1], wanted[2], wanted[3], wanted[4])
        else:
            built = FilesystemBackend(wanted[1])
        _backend = (wanted, built)
    return _backend[1]


def describe() -> str:
    wanted = config()
    return f"S3 bucket {wanted[1]}" if wanted[0] == "s3" else f"the directory {wanted[1]}"


def retention_days() -> int:
    try:
        return max(1, int(os.environ.get("STORAGE_RETENTION_DAYS") or DEFAULT_RETENTION_DAYS))
    except ValueError:
        return DEFAULT_RETENTION_DAYS


def put(
    db: Session,
    data: bytes,
    *,
    name: str,
    content_type: str,
    kind: str,
    run_id: Optional[int] = None,
    position: Optional[int] = None,
    owner_id: Optional[int] = None,
    group_id: Optional[int] = None,
) -> models.Blob:
    """Keeps `data` and adds its row to the caller's transaction. Written to
    the store first: a row never points at nothing (a file without a row is
    only space, and retention can't see it, but nothing reads it either)."""
    if len(data) > MAX_BYTES:
        raise BlobError(f"{name} is {len(data) // (1024 * 1024)} MiB; a file may be at most {MAX_BYTES // (1024 * 1024)} MiB.")
    blob_id = uuid.uuid4().hex
    key = f"runs/{run_id}/{blob_id}" if run_id is not None else f"other/{blob_id}"
    backend().put(key, data, content_type)
    row = models.Blob(
        id=blob_id, key=key, name=name, content_type=content_type, size=len(data),
        sha256=hashlib.sha256(data).hexdigest(), kind=kind, run_id=run_id, position=position,
        owner_id=owner_id, group_id=group_id,
        expires_at=datetime.datetime.utcnow() + datetime.timedelta(days=retention_days()),
    )
    db.add(row)
    return row


def read(row: models.Blob) -> bytes:
    data = backend().get(row.key)
    if hashlib.sha256(data).hexdigest() != row.sha256:
        raise BlobError(f"{row.name} in the store isn't the file that was kept (its checksum differs).")
    return data


def remove(db: Session, rows: list[models.Blob]) -> None:
    """Deletes the files and their rows (the caller commits)."""
    store = backend()
    for row in rows:
        store.delete(row.key)
        db.delete(row)


def clean(db: Session) -> int:
    """Deletes what has outlived its retention; the runner calls it hourly."""
    expired = (
        db.query(models.Blob)
        .filter(models.Blob.expires_at.isnot(None), models.Blob.expires_at < datetime.datetime.utcnow())
        .limit(500)
        .all()
    )
    remove(db, expired)
    db.commit()
    return len(expired)
