"""The broker (PLATFORM_PLAN.md §25, D133): where code in the runner calls
back to the platform. A call carries its job's token (runner_client), not a
cookie or a user's own credential, and is made as the person running the
code through `outbound` -- a declarative request's own path. The token dies
with its job."""

import base64
import hashlib
import html
import os
import re
import threading
import time
from pathlib import Path
from typing import Any, Optional

import httpx
from fastapi import APIRouter, Body, Depends, Header, HTTPException
from fastapi.responses import FileResponse, HTMLResponse
from sqlalchemy.orm import Session

from .. import deps, masking, models, outbound, runner_client
from ..db import get_db

router = APIRouter(prefix="/api/runner", tags=["runner"])

# A job's calls, all told (the SDK counts too; this is the one that holds).
MAX_CALLS = 200


@router.post("/calls")
def call(payload: dict[str, Any] = Body(...), authorization: Optional[str] = Header(default=None),
         db: Session = Depends(get_db)) -> dict:
    token = (authorization or "").removeprefix("Bearer ").strip()
    job = runner_client.job_for(db, token) if token else None
    if job is None:
        raise HTTPException(status_code=401, detail="This call isn't from a running job of the platform's.")
    user = db.get(models.User, job.user_id)
    if user is None:
        raise HTTPException(status_code=401, detail="The job's user is gone.")
    # In the database, not job.calls += 1: a job's calls can come at once (threads).
    db.query(models.RunnerJob).filter_by(id=job.id).update({models.RunnerJob.calls: models.RunnerJob.calls + 1},
                                                           synchronize_session=False)
    db.commit()
    db.refresh(job)
    if job.calls > MAX_CALLS:
        raise HTTPException(status_code=429, detail=f"A job makes at most {MAX_CALLS} calls.")
    try:
        if payload.get("kind") == "http":
            return outbound.http(db, user, payload, job.may_change)
        if payload.get("kind") == "aws":
            return outbound.aws(db, user, payload)
    except outbound.OutboundError as e:
        raise HTTPException(status_code=e.status, detail=str(e)) from None
    raise HTTPException(status_code=400, detail="A call is http (ctx.http) or aws (ctx.aws).")


# ---------------------------------------------------------------- the package index (D143)
#
# What a job's uv installs its requirements.lock from: a PEP 503 simple index
# over DEPS_INDEX_URL, served only to a job's token, and only the wheels whose
# hashes its lock names -- so the runner's way out stays this backend, and a
# job can't use it to fetch anything else. Wheels are fetched upstream once,
# checked against their hash, and kept (DEPS_CACHE_DIR).

_NAME_RE = re.compile(r"[-_.]+")
_WHEEL_RE = re.compile(r"^[A-Za-z0-9_.+!-]+\.whl$")
_PAGE_SECONDS = 600
MAX_WHEEL_BYTES = 500 * 1024 * 1024
# Kept wheels past this are dropped, least recently served first: their
# volume (Helm backend.deps.cacheSize) also holds uv's cache.
KEEP_BYTES = int(os.environ.get("DEPS_WHEELS_MB", "1500")) * 1024 * 1024
_pages: dict[str, tuple[float, list[tuple[str, str, str]]]] = {}
_pages_lock = threading.Lock()
_fetching: dict[str, threading.Lock] = {}


def _deps_job(authorization: Optional[str], db: Session) -> models.RunnerJob:
    """The job a request to the index is from: uv sends the index URL's
    credentials (job:<token>) as Basic auth."""
    token = ""
    if (authorization or "").startswith("Basic "):
        try:
            token = base64.b64decode(authorization[6:]).decode().partition(":")[2]
        except (ValueError, UnicodeDecodeError):
            token = ""
    job = runner_client.job_for(db, token) if token else None
    if job is None or not job.deps_lock:
        raise HTTPException(status_code=401, detail="The package index serves the platform's jobs only.",
                            headers={"WWW-Authenticate": 'Basic realm="packages"'})
    return job


def _normal(name: str) -> str:
    return _NAME_RE.sub("-", name).lower()


def _upstream(project: str) -> list[tuple[str, str, str]]:
    """The files the index lists for a project, each (filename, url, sha256)."""
    from urllib.parse import urldefrag, urljoin

    now = time.monotonic()
    with _pages_lock:
        kept = _pages.get(project)
        if kept and now - kept[0] < _PAGE_SECONDS:
            return kept[1]
    url = deps.index_url() + project + "/"
    try:
        reply = httpx.get(url, headers={"Accept": "application/vnd.pypi.simple.v1+json, text/html;q=0.1"},
                          timeout=30, follow_redirects=True)
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=masking.mask(f"The package index couldn't be reached: {e}")) from None
    if reply.status_code == 404:
        return []
    if reply.status_code != 200:
        raise HTTPException(status_code=502, detail=f"The package index answered {reply.status_code} for {project}.")
    found: list[tuple[str, str, str]] = []
    if "json" in reply.headers.get("content-type", ""):
        for f in reply.json().get("files", []):
            sha = (f.get("hashes") or {}).get("sha256")
            if sha and f.get("filename") and f.get("url"):
                found.append((f["filename"], urljoin(str(reply.url), f["url"]), sha))
    else:
        for href, text in re.findall(r'<a\s[^>]*href="([^"]+)"[^>]*>([^<]+)</a>', reply.text):
            link, fragment = urldefrag(urljoin(str(reply.url), html.unescape(href)))
            if fragment.startswith("sha256="):
                found.append((text.strip(), link, fragment[7:]))
    with _pages_lock:
        _pages[project] = (now, found)
    return found


def _wheels_dir() -> Path:
    path = Path(deps.cache_dir()) / "wheels"
    path.mkdir(parents=True, exist_ok=True)
    return path


@router.get("/simple/{project}/", response_class=HTMLResponse)
@router.get("/simple/{project}", response_class=HTMLResponse, include_in_schema=False)
def simple_page(project: str, authorization: Optional[str] = Header(default=None),
                db: Session = Depends(get_db)) -> HTMLResponse:
    allowed = deps.lock_hashes(_deps_job(authorization, db).deps_lock)
    name = _normal(project)
    links = [f'<a href="../../files/{sha}/{html.escape(file)}#sha256={sha}">{html.escape(file)}</a><br>'
             for file, _url, sha in _upstream(name) if sha in allowed and _WHEEL_RE.match(file)]
    if not links:
        raise HTTPException(status_code=404, detail=f"{name} isn't in this job's requirements.lock.")
    return HTMLResponse(f"<!DOCTYPE html><html><body>{''.join(links)}</body></html>")


@router.get("/files/{sha}/{filename}")
def wheel_file(sha: str, filename: str, authorization: Optional[str] = Header(default=None),
               db: Session = Depends(get_db)) -> FileResponse:
    job = _deps_job(authorization, db)
    if sha not in deps.lock_hashes(job.deps_lock) or not _WHEEL_RE.match(filename):
        raise HTTPException(status_code=404, detail="That file isn't in this job's requirements.lock.")
    kept = _wheels_dir() / f"{sha}.whl"
    with _pages_lock:
        guard = _fetching.setdefault(sha, threading.Lock())
    with guard:
        if not kept.exists():
            _fetch(sha, filename, kept)
            _trim(keep=kept)
        else:
            os.utime(kept)
    return FileResponse(kept, media_type="application/octet-stream", filename=filename)


def _trim(keep: Path) -> None:
    kept = sorted(_wheels_dir().glob("*.whl"), key=lambda p: p.stat().st_mtime)
    total = sum(p.stat().st_size for p in kept)
    for path in kept:
        if total <= KEEP_BYTES:
            break
        if path != keep:
            total -= path.stat().st_size
            path.unlink(missing_ok=True)


def _fetch(sha: str, filename: str, kept: Path) -> None:
    """The wheel from upstream into `kept`, only if its bytes have that hash."""
    project = _normal(filename.split("-")[0])
    url = next((u for f, u, s in _upstream(project) if s == sha), None)
    if url is None or not url.startswith(("https://", "http://")):
        raise HTTPException(status_code=404, detail=f"The package index has no {filename} with that hash.")
    digest = hashlib.sha256()
    size = 0
    partial = kept.with_suffix(f".{os.getpid()}.part")
    try:
        with httpx.stream("GET", url, timeout=60, follow_redirects=True) as reply, open(partial, "wb") as out:
            if reply.status_code != 200:
                raise HTTPException(status_code=502, detail=f"The package index answered {reply.status_code} for "
                                                            f"{filename}.")
            for chunk in reply.iter_bytes():
                size += len(chunk)
                if size > MAX_WHEEL_BYTES:
                    raise HTTPException(status_code=502, detail=f"{filename} is over {MAX_WHEEL_BYTES >> 20} MiB.")
                digest.update(chunk)
                out.write(chunk)
        if digest.hexdigest() != sha:
            raise HTTPException(status_code=502, detail=f"{filename} from the package index isn't the file its lock "
                                                        "names (its hash differs).")
        os.replace(partial, kept)
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=masking.mask(f"{filename} couldn't be fetched: {e}")) from None
    finally:
        partial.unlink(missing_ok=True)
