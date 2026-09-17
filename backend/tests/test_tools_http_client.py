import socket

import pytest

from app import tools_http_client
from app.tools_http_client import ToolRequestError, _assert_public_host, send_request


def _fake_addrinfo(ip: str):
    family = socket.AF_INET6 if ":" in ip else socket.AF_INET
    return [(family, socket.SOCK_STREAM, 6, "", (ip, 443))]


@pytest.mark.parametrize(
    "ip",
    [
        "127.0.0.1",  # loopback
        "169.254.169.254",  # cloud metadata endpoint (AWS/GCP/Azure/OCI)
        "10.0.0.5",  # private
        "172.16.0.1",  # private
        "192.168.1.1",  # private
        "::1",  # loopback v6
        "fe80::1",  # link-local v6
        "fc00::1",  # unique local v6
    ],
)
def test_assert_public_host_blocks_non_public_ranges(monkeypatch, ip):
    monkeypatch.setattr(socket, "getaddrinfo", lambda host, port: _fake_addrinfo(ip))
    with pytest.raises(ToolRequestError):
        _assert_public_host("whatever.example")


def test_assert_public_host_allows_public_ip(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", lambda host, port: _fake_addrinfo("93.184.216.34"))
    _assert_public_host("example.com")  # must not raise


def test_assert_public_host_raises_when_unresolvable(monkeypatch):
    def raise_gaierror(host, port):
        raise socket.gaierror("nope")

    monkeypatch.setattr(socket, "getaddrinfo", raise_gaierror)
    with pytest.raises(ToolRequestError):
        _assert_public_host("does-not-resolve.invalid")


def test_send_request_rejects_non_http_scheme():
    with pytest.raises(ToolRequestError):
        send_request("GET", "ftp://example.com/file")


def test_send_request_rejects_url_with_no_hostname():
    with pytest.raises(ToolRequestError):
        send_request("GET", "http:///path")


class _FakeResponse:
    def __init__(self, status_code=200, reason_phrase="OK", headers=None, content=b"", encoding="utf-8"):
        self.status_code = status_code
        self.reason_phrase = reason_phrase
        self.headers = headers or {}
        self.content = content
        self.encoding = encoding


class _FakeClient:
    def __init__(self, response, captured):
        self._response = response
        self._captured = captured

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def request(self, method, url, headers=None, content=None):
        self._captured["method"] = method
        self._captured["url"] = url
        self._captured["headers"] = headers
        self._captured["content"] = content
        return self._response


def test_send_request_success(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", lambda host, port: _fake_addrinfo("93.184.216.34"))
    captured = {}
    fake_response = _FakeResponse(
        status_code=200, reason_phrase="OK", headers={"Content-Type": "application/json"}, content=b'{"ok": true}'
    )
    captured_client_kwargs = {}

    def fake_client(follow_redirects, timeout):
        captured_client_kwargs["follow_redirects"] = follow_redirects
        return _FakeClient(fake_response, captured)

    monkeypatch.setattr(tools_http_client.httpx, "Client", fake_client)

    result = send_request("get", "https://example.com/api", headers={"Accept": "application/json"}, body=None)

    assert captured_client_kwargs["follow_redirects"] is False  # redirects must not be auto-followed
    assert captured["method"] == "GET"
    assert result["status_code"] == 200
    assert result["body"] == '{"ok": true}'
    assert result["body_truncated"] is False
    assert {"key": "Content-Type", "value": "application/json"} in result["headers"]
    assert result["elapsed_ms"] >= 0


def test_send_request_truncates_oversized_body(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", lambda host, port: _fake_addrinfo("93.184.216.34"))
    huge_content = b"x" * (tools_http_client.MAX_RESPONSE_BODY_BYTES + 500)
    fake_response = _FakeResponse(content=huge_content)
    monkeypatch.setattr(
        tools_http_client.httpx, "Client", lambda follow_redirects, timeout: _FakeClient(fake_response, {})
    )

    result = send_request("GET", "https://example.com/big")

    assert result["body_truncated"] is True
    assert len(result["body"]) == tools_http_client.MAX_RESPONSE_BODY_BYTES


def test_send_request_returns_redirect_response_without_following(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", lambda host, port: _fake_addrinfo("93.184.216.34"))
    fake_response = _FakeResponse(status_code=302, reason_phrase="Found", headers={"Location": "https://example.com/next"})
    monkeypatch.setattr(
        tools_http_client.httpx, "Client", lambda follow_redirects, timeout: _FakeClient(fake_response, {})
    )

    result = send_request("GET", "https://example.com/redirect")

    assert result["status_code"] == 302
    assert {"key": "Location", "value": "https://example.com/next"} in result["headers"]
