import ipaddress
import socket
import time
from typing import Optional
from urllib.parse import urlparse

import httpx

# Backs the Tools page's Postman-like HTTP request tool. Requests are sent
# from this backend (not the browser) so they aren't subject to CORS -- but
# that means this process, which holds AWS role credentials, becomes an
# arbitrary-URL proxy unless it refuses to reach non-public network ranges.
# Blocking those (including 169.254.169.254 et al, covered by the link-local
# range) stops the tool from being used to probe internal infrastructure or
# reach a cloud metadata endpoint. This is a best-effort check, not a hard
# security boundary: it resolves the hostname once up front and httpx
# resolves independently again when it actually connects, so a DNS answer
# that changes between those two lookups (rebinding) isn't caught here.

REQUEST_TIMEOUT_SECONDS = 30.0
# Caps memory/response size -- generous for a normal API response.
MAX_RESPONSE_BODY_BYTES = 1_000_000

_BLOCKED_NETWORKS = [
    ipaddress.ip_network("0.0.0.0/8"),
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("100.64.0.0/10"),  # carrier-grade NAT
    ipaddress.ip_network("127.0.0.0/8"),  # loopback
    # Link-local -- also covers every major cloud's instance metadata
    # endpoint (169.254.169.254 on AWS/GCP/Azure/OCI alike).
    ipaddress.ip_network("169.254.0.0/16"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.0.0.0/24"),
    ipaddress.ip_network("192.0.2.0/24"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("198.18.0.0/15"),
    ipaddress.ip_network("198.51.100.0/24"),
    ipaddress.ip_network("203.0.113.0/24"),
    ipaddress.ip_network("224.0.0.0/4"),  # multicast
    ipaddress.ip_network("240.0.0.0/4"),  # reserved
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("fc00::/7"),  # unique local
    ipaddress.ip_network("fe80::/10"),  # link-local
    ipaddress.ip_network("ff00::/8"),  # multicast
]


class ToolRequestError(Exception):
    pass


def _assert_public_host(hostname: str) -> None:
    try:
        infos = socket.getaddrinfo(hostname, None)
    except socket.gaierror as e:
        raise ToolRequestError(f"Could not resolve host '{hostname}': {e}") from e

    for family, _, _, _, sockaddr in infos:
        raw_ip = sockaddr[0].split("%", 1)[0]  # strip an IPv6 zone id, if present
        ip = ipaddress.ip_address(raw_ip)
        if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
            ip = ip.ipv4_mapped
        if any(ip in net for net in _BLOCKED_NETWORKS if ip.version == net.version):
            raise ToolRequestError(
                f"Refusing to request '{hostname}' ({ip}) -- loopback, private, link-local, and "
                "other non-public address ranges are blocked (this also covers cloud metadata "
                "endpoints such as 169.254.169.254)."
            )


def send_request(
    method: str,
    url: str,
    headers: Optional[dict] = None,
    body: Optional[str] = None,
    timeout: float = REQUEST_TIMEOUT_SECONDS,
) -> dict:
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ToolRequestError(f"Unsupported URL scheme '{parsed.scheme or ''}' -- only http/https are allowed.")
    if not parsed.hostname:
        raise ToolRequestError("URL has no hostname.")
    _assert_public_host(parsed.hostname)

    start = time.monotonic()
    # Redirects are not followed automatically -- doing so would connect to
    # wherever the Location header points without re-running the check
    # above, letting a malicious or compromised server redirect the request
    # to a blocked address. The 3xx response (with its Location header) is
    # returned as-is instead, for the caller to follow manually if they want.
    with httpx.Client(follow_redirects=False, timeout=timeout) as client:
        resp = client.request(method.upper(), url, headers=headers or {}, content=body)
    elapsed_ms = int((time.monotonic() - start) * 1000)

    content = resp.content
    truncated = len(content) > MAX_RESPONSE_BODY_BYTES
    if truncated:
        content = content[:MAX_RESPONSE_BODY_BYTES]
    try:
        text = content.decode(resp.encoding or "utf-8", errors="replace")
    except (LookupError, TypeError):
        text = content.decode("utf-8", errors="replace")

    return {
        "status_code": resp.status_code,
        "status_text": resp.reason_phrase,
        "headers": [{"key": k, "value": v} for k, v in resp.headers.items()],
        "body": text,
        "body_truncated": truncated,
        "elapsed_ms": elapsed_ms,
    }
