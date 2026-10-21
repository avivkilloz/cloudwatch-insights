"""A job, inside its own process (PLATFORM_PLAN.md §25, D131): started as
`python -I -S bootstrap.py`, so nothing but the standard library and the SDK
beside this file can be imported, and no environment variable is read.

The job arrives on stdin (code, inputs, callback, deadline) -- or, for code
kept in files (D138), the directory the runner put them in, the module to
import and the function to call. Whatever the code prints goes to the log
(fd 2); the result alone goes to fd 1, written once at the end -- so a print
can never be mistaken for it."""

import importlib
import json
import os
import sys
import time
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def _where(error: BaseException, src: str | None) -> tuple[str | None, int | None]:
    """The file (None: the inline code) and line of the builder's code it
    failed on -- the deepest frame that is theirs."""
    found: tuple[str | None, int | None] = (None, None)

    def theirs(filename: str | None) -> tuple[bool, str | None]:
        if filename == "<code>":
            return True, None
        if src and filename and os.path.dirname(os.path.abspath(filename)) == src:
            return True, os.path.basename(filename)
        return False, None

    for frame in traceback.extract_tb(error.__traceback__):
        mine, name = theirs(frame.filename)
        if mine:
            found = (name, frame.lineno)
    if isinstance(error, SyntaxError):
        mine, name = theirs(error.filename)
        if mine:
            found = (name, error.lineno)
    return found


def _entry(job: dict):
    """The function to call: from the inline code, or the module's."""
    function = job.get("function") or "run"
    if job.get("module"):
        # After the standard library and the SDK, so a file can't stand in
        # for either (the backend refuses such names too).
        sys.path.append(job["src"])
        module = importlib.import_module(job["module"])
        run = getattr(module, function, None)
        if not callable(run):
            raise NameError(f"{job['module']}.py defines no {function}(inputs, ctx).")
        return run
    scope: dict = {"__name__": "job"}
    exec(compile(job.get("code") or "", "<code>", "exec"), scope)
    run = scope.get(function)
    if not callable(run):
        raise NameError(f"The code defines no {function}(inputs, ctx).")
    return run


def main() -> None:
    job = json.loads(sys.stdin.read() or "{}")
    result_fd = os.dup(1)
    os.dup2(2, 1)
    sys.stdout = sys.stderr

    from platform_sdk import Context

    deadline = time.monotonic() + float(job.get("timeout") or 30)
    ctx = Context(job.get("inputs") or {}, job.get("callback"), deadline)
    try:
        run = _entry(job)
        result = {"ok": True, "outputs": run(job.get("inputs") or {}, ctx)}
    except BaseException as e:  # noqa: BLE001 -- whatever the code raised is its answer
        if isinstance(e, KeyboardInterrupt):
            raise
        file, line = _where(e, job.get("src"))
        result = {"ok": False, "error": f"{type(e).__name__}: {e}", "line": line, "file": file}
    result["calls"] = ctx.calls
    try:
        text = json.dumps(result, default=str)
    except (TypeError, ValueError) as e:
        text = json.dumps({"ok": False, "error": f"What run returned isn't data the platform can keep: {e}",
                           "calls": ctx.calls})
    data = text.encode()
    while data:
        data = data[os.write(result_fd, data):]


main()
