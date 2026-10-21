"""What a builder's code is given (PLATFORM_PLAN.md §25, D133): its inputs,
a log, and the platform's own ways out -- `ctx.http` and `ctx.aws`.

Code in the runner holds no secret and can reach nothing but the backend.
Each call here goes back to the backend with this job's own token, and is
made there as the person running the code: their connection, their group's
identity added, the SSRF guard, the reply masked -- exactly as a declarative
request is. So code never sees a credential.

    def run(inputs, ctx):
        reply = ctx.http(inputs["connection"], "/devices", query={"site": "north"})
        rows = [d for d in reply.json()["items"] if d["online"]]
        ctx.log(len(rows), "online")
        return {"rows": rows}
"""

from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request
from typing import Any, Optional

__all__ = ["Context", "Response", "CallError"]

# A job's calls, all told: a loop calling out without end is stopped.
MAX_CALLS = 200


class CallError(Exception):
    """A call the platform refused or that failed, in a sentence: an
    unknown connection, a write from code that only reads, an AWS error."""


class Response:
    """An HTTP reply, as the platform passed it on (masked)."""

    def __init__(self, data: dict):
        self.status: int = int(data.get("status") or 0)
        self.headers: dict = dict(data.get("headers") or {})
        self.text: str = data.get("body") or ""

    @property
    def ok(self) -> bool:
        return 200 <= self.status < 300

    def json(self) -> Any:
        return json.loads(self.text)

    def __repr__(self) -> str:
        return f"<Response {self.status}>"


class Context:
    """Passed to `run(inputs, ctx)`."""

    def __init__(self, inputs: dict, callback: Optional[dict] = None, deadline: Optional[float] = None):
        self.inputs = inputs
        self._callback = callback or {}
        self._deadline = deadline
        self.calls = 0

    def log(self, *parts: Any) -> None:
        """A line in the job's log, beside anything printed."""
        print(*parts, file=sys.stderr, flush=True)

    def http(self, connection: Any, path: str = "", method: str = "GET", query: Optional[dict] = None,
             headers: Optional[dict] = None, body: Any = None) -> Response:
        """A request to a connection of an HTTP type (its id, or its name),
        `path` after its base URL -- as the person running this code."""
        return Response(self._call({"kind": "http", "connection": connection, "path": path, "method": method,
                                    "query": query or {}, "headers": headers or {}, "body": body}))

    def aws(self, connection: Any, service: str, operation: str, params: Optional[dict] = None,
            paginate: bool = False) -> dict:
        """An AWS API call that reads (botocore's names: `lambda`,
        `ListFunctions`) on an AWS connection (its id, or its name), as the
        person running this code. Its reply, as JSON."""
        return self._call({"kind": "aws", "connection": connection, "service": service, "operation": operation,
                           "params": params or {}, "paginate": paginate})["reply"]

    def name(self, connection: Any) -> str:
        """The name the person running this code sees a connection by (an
        environment's, or "Prod · iot" beside another of its type): what a row
        stamps as its Environment, so a row action given it reaches the same
        connection back."""
        return self._call({"kind": "name", "connection": connection})["name"]

    def _call(self, payload: dict) -> dict:
        url, token = self._callback.get("url"), self._callback.get("token")
        if not url or not token:
            raise CallError("This job can't call out: it was started without a way back to the platform.")
        self.calls += 1
        if self.calls > MAX_CALLS:
            raise CallError(f"A job makes at most {MAX_CALLS} calls.")
        left = self._deadline - time.monotonic() if self._deadline else 60.0
        if left <= 0.5:
            raise CallError("The job's time is up.")
        request = urllib.request.Request(url, data=json.dumps(payload, default=str).encode(), method="POST",
                                         headers={"Content-Type": "application/json",
                                                  "Authorization": f"Bearer {token}"})
        try:
            with urllib.request.urlopen(request, timeout=min(left, 60.0)) as reply:
                return json.loads(reply.read().decode() or "{}")
        except urllib.error.HTTPError as e:
            try:
                detail = json.loads(e.read().decode()).get("detail")
            except ValueError:
                detail = None
            raise CallError(str(detail or f"The platform answered {e.code}.")) from None
        except urllib.error.URLError as e:
            raise CallError(f"The platform couldn't be reached: {e.reason}") from None
