from botocore.auth import SigV4QueryAuth
from botocore.awsrequest import AWSRequest
from botocore.credentials import Credentials
from websockets.exceptions import InvalidStatus
from websockets.sync.client import connect as ws_connect

from . import aws_client, iot_client

# AWS IoT Core's device gateway accepts MQTT-over-WebSocket connections
# authenticated with a SigV4 *query-string* presigned URL -- the same
# standard "authorization query parameters" mechanism used for e.g. S3
# presigned URLs, just against IoT's own signing name ("iotdevicegateway")
# and its data-plane endpoint's "/mqtt" path. This is exactly how the AWS
# IoT Console's own web-based MQTT test client connects: entirely from the
# browser, straight to the endpoint, with no server acting as a relay for
# the MQTT session itself -- only the URL is minted server-side, since it
# has to be signed with the environment's assumed-role credentials.

SIGNING_SERVICE = "iotdevicegateway"
DEFAULT_EXPIRES_SECONDS = 300

PROBE_TIMEOUT_SECONDS = 8.0
# Caps how much of a probe response body gets echoed back, same rationale as
# the OpenSearch client's error-body cap.
MAX_PROBE_BODY_CHARS = 1000


def build_presigned_ws_url(
    account_id: str, region: str, role_name: str, expires: int = DEFAULT_EXPIRES_SECONDS
) -> dict:
    endpoint = iot_client.get_iot_data_endpoint(account_id, region, role_name)
    creds = aws_client.get_credentials(account_id, role_name)
    credentials = Credentials(creds["access_key"], creds["secret_key"], creds["session_token"])

    request = AWSRequest(method="GET", url=f"https://{endpoint}/mqtt")
    SigV4QueryAuth(credentials, SIGNING_SERVICE, region, expires=expires).add_auth(request)
    return {"endpoint": endpoint, "url": request.url.replace("https://", "wss://", 1)}


def probe_presigned_url(url: str) -> dict:
    """Best-effort pre-flight check against a just-minted presigned URL.

    A browser gives no visibility into *why* a WebSocket handshake was
    rejected -- a failed upgrade just looks like a bare, reason-less close.
    This attempts the *actual* WebSocket handshake server-side (same "mqtt"
    subprotocol mqtt.js requests), which -- unlike a browser -- lets us read
    AWS's real rejection response (status code, headers, and body) when the
    upgrade is refused. A plain HTTPS GET without WebSocket upgrade headers
    isn't equivalent: IoT Core's device gateway 404s a request that doesn't
    look like a WebSocket upgrade at all, regardless of whether the
    signature is valid, which would be indistinguishable from an actual
    auth failure.

    The response headers are included (not just status/body) because a
    rejection that never shows up in AWS IoT Core's own connection logging
    -- even with DEBUG logging enabled, which logs every attempt whether
    accepted or rejected -- means something in the network path is
    answering *before* the request ever reaches IoT Core's device gateway
    (a proxy, firewall, or inspection appliance). Its response headers
    typically look nothing like a genuine AWS service response (missing
    the usual AWS request-id-style headers, an unfamiliar `Server` header,
    etc.), which is the fastest way to tell the two apart from here.
    """
    try:
        with ws_connect(url, subprotocols=["mqtt"], open_timeout=PROBE_TIMEOUT_SECONDS, proxy=None):
            pass
    except InvalidStatus as e:
        resp = e.response
        body = bytes(resp.body).decode("utf-8", errors="replace") if resp.body else ""
        headers = [f"{k}: {v}" for k, v in resp.headers.raw_items()]
        return {"status_code": resp.status_code, "body": body.strip()[:MAX_PROBE_BODY_CHARS], "headers": headers}
    except Exception as e:  # noqa: BLE001 - surface any handshake failure reason (DNS, TLS, timeout, etc.)
        return {"status_code": None, "body": str(e), "headers": []}
    # No exception means AWS accepted the WebSocket upgrade (101 Switching
    # Protocols) -- the signature and permissions are valid.
    return {
        "status_code": 101,
        "body": "AWS accepted the WebSocket upgrade -- this URL and its signature are valid.",
        "headers": [],
    }
