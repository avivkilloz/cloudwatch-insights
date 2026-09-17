import httpx
from botocore.auth import SigV4QueryAuth
from botocore.awsrequest import AWSRequest
from botocore.credentials import Credentials

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
    Making the exact same signed request as a plain HTTPS call from here
    instead gets AWS's actual response back (status code and body), which is
    the only place a rejection reason -- an invalid signature, a missing
    iot:Connect/Publish/Subscribe/Receive permission, clock skew, etc. --
    is visible at all. This doesn't try to classify the result as "good" or
    "bad" (that would mean guessing at exactly which status IoT Core's
    device gateway returns for a non-WebSocket request that's otherwise
    validly signed, which isn't documented); it just surfaces what AWS said.
    """
    https_url = url.replace("wss://", "https://", 1)
    try:
        resp = httpx.get(https_url, timeout=PROBE_TIMEOUT_SECONDS)
    except httpx.HTTPError as e:
        return {"status_code": None, "body": str(e)}
    return {"status_code": resp.status_code, "body": resp.text.strip()[:MAX_PROBE_BODY_CHARS]}
