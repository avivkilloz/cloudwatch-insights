"""A job, inside its own process (PLATFORM_PLAN.md §25, D131): started as
`python -I -S bootstrap.py`, so nothing but the standard library and the SDK
beside this file can be imported, and no environment variable is read.

The job arrives on stdin (code, inputs, callback, deadline). Whatever the
code prints goes to the log (fd 2); the result alone goes to fd 1, written
once at the end -- so a print can never be mistaken for it."""

import json
import os
import sys
import time
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def _line(error: BaseException) -> int | None:
    """The line of the builder's code it failed on."""
    line = None
    for frame in traceback.extract_tb(error.__traceback__):
        if frame.filename == "<code>":
            line = frame.lineno
    if isinstance(error, SyntaxError) and error.filename == "<code>":
        line = error.lineno
    return line


def main() -> None:
    job = json.loads(sys.stdin.read() or "{}")
    result_fd = os.dup(1)
    os.dup2(2, 1)
    sys.stdout = sys.stderr

    from platform_sdk import Context

    deadline = time.monotonic() + float(job.get("timeout") or 30)
    ctx = Context(job.get("inputs") or {}, job.get("callback"), deadline)
    scope: dict = {"__name__": "job"}
    try:
        exec(compile(job.get("code") or "", "<code>", "exec"), scope)
        run = scope.get("run")
        if not callable(run):
            raise NameError("The code defines no run(inputs, ctx).")
        result = {"ok": True, "outputs": run(job.get("inputs") or {}, ctx)}
    except BaseException as e:  # noqa: BLE001 -- whatever the code raised is its answer
        if isinstance(e, KeyboardInterrupt):
            raise
        result = {"ok": False, "error": f"{type(e).__name__}: {e}", "line": _line(e)}
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
