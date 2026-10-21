"""A package index for tests: wheels made here, served as a PEP 503 simple
index on a local port -- so installing requirements needs no PyPI."""

import base64
import hashlib
import io
import threading
import zipfile
from http.server import BaseHTTPRequestHandler, HTTPServer


def wheel(name: str, version: str, files: dict[str, str]) -> tuple[str, bytes]:
    dist = f"{name}-{version}.dist-info"
    entries = {
        **files,
        f"{dist}/METADATA": f"Metadata-Version: 2.1\nName: {name}\nVersion: {version}\n",
        f"{dist}/WHEEL": "Wheel-Version: 1.0\nGenerator: tests\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
    }
    record = []
    for path, text in entries.items():
        data = text.encode()
        digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
        record.append(f"{path},sha256={digest},{len(data)}")
    record.append(f"{dist}/RECORD,,")
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as z:
        for path, text in entries.items():
            z.writestr(path, text)
        z.writestr(f"{dist}/RECORD", "\n".join(record) + "\n")
    return f"{name}-{version}-py3-none-any.whl", buffer.getvalue()


class Index:
    """Serves wheels at /simple/<name>/ and /files/<file>; counts what was fetched."""

    def __init__(self) -> None:
        self.wheels: dict[str, tuple[str, bytes]] = {}
        self.fetched: list[str] = []
        index = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                parts = [p for p in self.path.split("?")[0].split("/") if p]
                if len(parts) == 2 and parts[0] == "simple" and parts[1] in index.wheels:
                    file, data = index.wheels[parts[1]]
                    body = (f'<html><body><a href="/files/{file}#sha256={hashlib.sha256(data).hexdigest()}">'
                            f"{file}</a></body></html>").encode()
                    self._send(200, body, "text/html")
                elif len(parts) == 2 and parts[0] == "files":
                    found = next((d for f, d in index.wheels.values() if f == parts[1]), None)
                    if not getattr(self, "_head_only", False):
                        index.fetched.append(parts[1])
                    self._send(200 if found else 404, found or b"", "application/octet-stream")
                else:
                    self._send(404, b"", "text/plain")

            def do_HEAD(self):  # noqa: N802 -- uv asks before reading a wheel's metadata
                self._head_only = True
                self.do_GET()

            def _send(self, status, body, kind):
                self.send_response(status)
                self.send_header("Content-Type", kind)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                if not getattr(self, "_head_only", False):
                    self.wfile.write(body)

            def log_message(self, *_):
                pass

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_port}/simple"

    def add(self, name: str, version: str, files: dict[str, str]) -> str:
        """Serves the wheel; its lock line."""
        file, data = wheel(name, version, files)
        self.wheels[name] = (file, data)
        return f"{name}=={version} \\\n    --hash=sha256:{hashlib.sha256(data).hexdigest()}\n"

    def close(self) -> None:
        self.server.shutdown()
