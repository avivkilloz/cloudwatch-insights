"""A venv per lock (PLATFORM_PLAN.md §25, D143-D144): a job whose code needs
packages brings its `requirements.lock` and the index to install it from --
the backend's own, which serves only the wheels that lock names, so the
runner still reaches nothing but the backend (D133).

Built with uv, wheels only and hash-checked -- installing a wheel runs none of
its code -- as the runner's own user, once per lock: every definition with the
same lock shares it, and a job only reads it. Kept until the least recently
used go past RUNNER_VENVS_MB. A build happens when the backend asks after a
save (`POST /venvs`), or before a run that finds none -- never in a job's own
time."""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from collections import Counter
from pathlib import Path
from typing import Optional

VENVS = Path(os.environ.get("RUNNER_VENVS_DIR") or Path(tempfile.gettempdir()) / "venvs")
LIMIT_BYTES = int(os.environ.get("RUNNER_VENVS_MB", "2000")) * 1024 * 1024
BUILD_SECONDS = int(os.environ.get("RUNNER_VENV_BUILD_SECONDS", "300"))
MAX_LOCK = 200_000

_guard = threading.Lock()
_locks: dict[str, threading.Lock] = {}
# Venvs a job is running in now: never dropped from under it.
_in_use: Counter = Counter()


class BuildFailed(Exception):
    """A venv that couldn't be built, said why (uv's own words)."""


def uv_bin() -> str:
    given = os.environ.get("RUNNER_UV")
    if given:
        return given
    try:
        from uv import find_uv_bin  # the uv wheel, as the image installs it

        return find_uv_bin()
    except (ImportError, FileNotFoundError):
        pass
    found = shutil.which("uv")
    if not found:
        raise BuildFailed("uv isn't installed in the runner, so code with requirements can't run here.")
    return found


def key(lock: str) -> str:
    return hashlib.sha256(lock.encode()).hexdigest()[:40]


def _hidden(text: str, index: str) -> str:
    # The index URL carries the job's token as its password: never in a message.
    return text.replace(index, "<the platform's index>") if index else text


def _run(args: list[str], index: str) -> None:
    env = {
        "PATH": "/usr/bin:/bin",
        "HOME": str(VENVS),
        "LANG": "C.UTF-8",
        "UV_CACHE_DIR": str(VENVS / ".uv-cache"),
        # Never a Python of uv's own download: the runner's, and only that.
        "UV_PYTHON_DOWNLOADS": "never",
        "UV_NO_CONFIG": "1",
    }
    try:
        done = subprocess.run(args, env=env, capture_output=True, text=True, timeout=BUILD_SECONDS, cwd=str(VENVS))
    except subprocess.TimeoutExpired:
        raise BuildFailed(f"Installing its requirements took more than {BUILD_SECONDS} s.") from None
    if done.returncode != 0:
        said = "\n".join(line for line in (done.stderr or done.stdout).strip().splitlines()
                         if not line.startswith("warning:"))
        raise BuildFailed(_hidden(said[-1500:], index) or f"uv exited with {done.returncode}.")


def _lock_for(name: str) -> threading.Lock:
    with _guard:
        return _locks.setdefault(name, threading.Lock())


def python_for(lock: str, index: str, python: str) -> str:
    """The interpreter of the venv for `lock`, built from `index` if it isn't
    there yet. Mark it in use (`use`) for as long as a job runs in it."""
    if len(lock) > MAX_LOCK:
        raise BuildFailed("That requirements.lock is too long.")
    if not re.search(r"--hash=sha256:[0-9a-f]{64}", lock):
        raise BuildFailed("A requirements.lock pins every package with its hashes; this one has none.")
    name = key(lock)
    target = VENVS / name
    with _lock_for(name):
        ready = target / ".ready"
        if ready.exists():
            os.utime(ready)
            return str(target / "bin" / "python")
        VENVS.mkdir(parents=True, exist_ok=True)
        os.chmod(VENVS, 0o755)
        building = VENVS / f".build-{name}-{uuid.uuid4().hex[:8]}"
        lockfile = VENVS / f".{building.name}.txt"
        lockfile.write_text(lock)
        try:
            uv = uv_bin()
            _run([uv, "venv", "--quiet", "--python", python, str(building)], index)
            _run([uv, "pip", "install", "--quiet", "--python", str(building / "bin" / "python"), "--require-hashes",
                  "--no-deps", "--only-binary", ":all:", "--index-url", index, "-r", str(lockfile)], index)
            # Read by every slot's uid, written by none.
            for root, dirs, files in os.walk(building):
                for d in dirs:
                    os.chmod(os.path.join(root, d), 0o755)
                for f in files:
                    path = os.path.join(root, f)
                    if not os.path.islink(path):
                        os.chmod(path, os.stat(path).st_mode & 0o755 | 0o444)
            os.chmod(building, 0o755)
            if target.exists():
                shutil.rmtree(target, ignore_errors=True)
            os.rename(building, target)
            (target / ".ready").write_text(time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
        finally:
            shutil.rmtree(building, ignore_errors=True)
            lockfile.unlink(missing_ok=True)
    _evict(keep=name)
    return str(target / "bin" / "python")


class use:
    """While a job runs in a venv, it isn't dropped."""

    def __init__(self, python: Optional[str]):
        self.name = Path(python).parent.parent.name if python else None

    def __enter__(self) -> "use":
        if self.name:
            with _guard:
                _in_use[self.name] += 1
        return self

    def __exit__(self, *_exc) -> None:
        if self.name:
            with _guard:
                _in_use[self.name] -= 1


def _size(path: Path) -> int:
    total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            try:
                total += os.lstat(os.path.join(root, f)).st_size
            except OSError:
                pass
    return total


def _evict(keep: str) -> None:
    """The least recently used venvs, until what's kept fits RUNNER_VENVS_MB."""
    with _guard:
        busy = {name for name, n in _in_use.items() if n > 0}
    built = [p for p in VENVS.iterdir() if p.is_dir() and (p / ".ready").exists()] if VENVS.exists() else []
    sizes = {p: _size(p) for p in built}
    total = sum(sizes.values())
    for path in sorted(built, key=lambda p: (p / ".ready").stat().st_mtime):
        if total <= LIMIT_BYTES:
            break
        if path.name == keep or path.name in busy:
            continue
        shutil.rmtree(path, ignore_errors=True)
        total -= sizes[path]
