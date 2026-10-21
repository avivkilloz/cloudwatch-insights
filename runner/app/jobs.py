"""Running one job (PLATFORM_PLAN.md §25, D131-D132): a fresh process of
this interpreter in isolated mode, in a directory of its own, under limits,
and -- when the runner runs as root, as its image does -- as the uid of its
slot, so no job can read another's files, memory or token, or the runner's.

Its stdout and stderr are files, not pipes: a file's size is capped by
RLIMIT_FSIZE, so a job printing without end is stopped by the kernel instead
of filling the runner's memory."""

from __future__ import annotations

import json
import os
import queue
import resource
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

BOOTSTRAP = Path(__file__).resolve().parent.parent / "sdk" / "bootstrap.py"
# The interpreter behind the runner's own (a venv's python is a link to it):
# a job needs only the standard library and the SDK (`-S`), and a slot's uid
# may not be able to enter the venv's directory at all.
PYTHON = os.environ.get("RUNNER_PYTHON") or os.path.realpath(sys.executable)

DEFAULT_TIMEOUT = 30
MAX_TIMEOUT = 120
MEMORY_BYTES = int(os.environ.get("RUNNER_MEMORY_MB", "512")) * 1024 * 1024
FILE_BYTES = 16 * 1024 * 1024
RESULT_BYTES = 4 * 1024 * 1024
LOG_BYTES = 64 * 1024
CONCURRENCY = max(1, int(os.environ.get("RUNNER_CONCURRENCY", "4")))
# A uid per slot (D132): 61000, 61001, … -- none of them the runner's own.
UID_BASE = int(os.environ.get("RUNNER_UID_BASE", "61000"))
WAIT_FOR_SLOT = 10


class Busy(Exception):
    """Every slot is running a job."""


@dataclass
class Outcome:
    ok: bool
    outputs: Any = None
    error: Optional[str] = None
    line: Optional[int] = None
    logs: str = ""
    duration_ms: int = 0
    calls: int = 0
    isolated: bool = False

    def as_dict(self) -> dict:
        return {k: v for k, v in self.__dict__.items()}


_slots: "queue.Queue[int]" = queue.Queue()
for _n in range(CONCURRENCY):
    _slots.put(_n)


def _limits(timeout: int, uid: Optional[int], home: Path):
    def apply() -> None:
        resource.setrlimit(resource.RLIMIT_CPU, (timeout + 1, timeout + 2))
        resource.setrlimit(resource.RLIMIT_AS, (MEMORY_BYTES, MEMORY_BYTES))
        resource.setrlimit(resource.RLIMIT_FSIZE, (FILE_BYTES, FILE_BYTES))
        resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        if uid is not None:
            os.setgroups([])
            os.setgid(uid)
            os.setuid(uid)
            # Counted per uid: the slot's own, so the runner's threads don't count.
            resource.setrlimit(resource.RLIMIT_NPROC, (32, 32))
        # Into its home as its own uid: Popen's cwd= is entered as root, and a
        # root without DAC_READ_SEARCH (Helm) can't enter a 700 home it gave away.
        os.chdir(home)

    return apply


def _tail(path: Path, limit: int) -> str:
    size = path.stat().st_size
    with open(path, "rb") as f:
        if size > limit:
            f.seek(size - limit)
        text = f.read().decode(errors="replace")
    return ("…" + text) if size > limit else text


def run(code: str, inputs: Any, callback: Optional[dict], timeout: Optional[int] = None) -> Outcome:
    timeout = max(1, min(int(timeout or DEFAULT_TIMEOUT), MAX_TIMEOUT))
    try:
        slot = _slots.get(timeout=WAIT_FOR_SLOT)
    except queue.Empty:
        raise Busy("Every slot of the runner is busy; try again in a moment.") from None
    root = os.geteuid() == 0
    uid = UID_BASE + slot if root else None
    work = Path(tempfile.mkdtemp(prefix=f"job{slot}-"))
    # The job's own directory, and the files its output goes to -- the latter
    # the runner's, out of the job's reach.
    home = work / "home"
    home.mkdir()
    out_path, log_path = work / "result", work / "log"
    started = time.monotonic()
    try:
        os.chmod(work, 0o711 if root else 0o700)
        # Its mode before it's given away: the runner keeps no capability to
        # change a mode on what it doesn't own (no FOWNER, Helm), so a chmod
        # after the chown was refused and every job failed in a cluster.
        os.chmod(home, 0o700)
        if uid is not None:
            os.chown(home, uid, uid)
        job = json.dumps({"code": code, "inputs": inputs, "callback": callback, "timeout": timeout}, default=str)
        env = {"HOME": str(home), "TMPDIR": str(home), "PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"}
        with open(out_path, "wb") as out, open(log_path, "wb") as log:
            proc = subprocess.Popen(
                [PYTHON, "-I", "-S", str(BOOTSTRAP)],
                stdin=subprocess.PIPE, stdout=out, stderr=log, cwd="/", env=env,
                preexec_fn=_limits(timeout, uid, home), start_new_session=True, close_fds=True,
            )
            try:
                proc.communicate(job.encode(), timeout=timeout + 1)
                timed_out = False
            except subprocess.TimeoutExpired:
                timed_out = True
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait()
        duration = int((time.monotonic() - started) * 1000)
        logs = _tail(log_path, LOG_BYTES)
        if timed_out or proc.returncode in (-signal.SIGXCPU, -signal.SIGKILL) and duration >= timeout * 1000:
            return Outcome(False, error=f"The code ran past its {timeout} s and was stopped.", logs=logs,
                           duration_ms=duration, isolated=root)
        if out_path.stat().st_size > RESULT_BYTES:
            return Outcome(False, error=f"What the code returned is over {RESULT_BYTES // (1024 * 1024)} MiB.",
                           logs=logs, duration_ms=duration, isolated=root)
        text = out_path.read_text(errors="replace")
        if not text:
            why = {-signal.SIGXFSZ: "it wrote more than the files it may", -signal.SIGKILL: "it was killed",
                   -signal.SIGSEGV: "it crashed", -signal.SIGXCPU: "it used up its CPU time"}.get(
                proc.returncode, f"it exited with {proc.returncode}")
            if "MemoryError" in logs:
                why = f"it ran out of memory ({MEMORY_BYTES // (1024 * 1024)} MiB)"
            return Outcome(False, error=f"The code stopped without an answer: {why}.", logs=logs,
                           duration_ms=duration, isolated=root)
        answer = json.loads(text)
        return Outcome(bool(answer.get("ok")), outputs=answer.get("outputs"), error=answer.get("error"),
                       line=answer.get("line"), logs=logs, duration_ms=duration, calls=int(answer.get("calls") or 0),
                       isolated=root)
    finally:
        if uid is not None:
            _sweep(uid, home)
        shutil.rmtree(work, ignore_errors=True)
        _slots.put(slot)


def _as(uid: int, argv: list[str]) -> None:
    def drop() -> None:
        os.setgroups([])
        os.setgid(uid)
        os.setuid(uid)

    subprocess.run(argv, preexec_fn=drop, cwd="/", env={"PATH": "/usr/bin:/bin"}, close_fds=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10, check=False)


def _sweep(uid: int, home: Path) -> None:
    """What a job leaves is removed as its own slot's uid: anything it started
    (a process that left its group would otherwise be there for the next job
    in this slot, under the same uid, to read its token), then its files --
    which the runner, with no capability but the few it needs to drop to a
    uid (Helm), may not even be able to list."""
    try:
        # Every process of that uid (Linux leaves the caller itself out).
        _as(uid, [PYTHON, "-I", "-S", "-c", "import os, signal; os.kill(-1, signal.SIGKILL)"])
        # What's in its home, as its uid; the home itself is root's to remove
        # (its parent is root's), which an empty directory lets it do.
        _as(uid, [PYTHON, "-I", "-S", "-c", _EMPTY, str(home)])
        os.rmdir(home)
    except (OSError, subprocess.SubprocessError):
        pass


# A directory the job made unreadable to itself (chmod 000) is opened up
# first, then everything goes.
_EMPTY = """
import os, shutil, sys
def unlock(folder):
    for name in os.listdir(folder):
        path = os.path.join(folder, name)
        if os.path.isdir(path) and not os.path.islink(path):
            os.chmod(path, 0o700)
            unlock(path)
home = sys.argv[1]
unlock(home)
for name in os.listdir(home):
    path = os.path.join(home, name)
    if os.path.isdir(path) and not os.path.islink(path):
        shutil.rmtree(path)
    else:
        os.unlink(path)
"""
