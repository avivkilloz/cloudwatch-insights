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


def build_presigned_ws_url(
    account_id: str, region: str, role_name: str, expires: int = DEFAULT_EXPIRES_SECONDS
) -> dict:
    endpoint = iot_client.get_iot_data_endpoint(account_id, region, role_name)
    creds = aws_client.get_credentials(account_id, role_name)
    credentials = Credentials(creds["access_key"], creds["secret_key"], creds["session_token"])

    request = AWSRequest(method="GET", url=f"https://{endpoint}/mqtt")
    SigV4QueryAuth(credentials, SIGNING_SERVICE, region, expires=expires).add_auth(request)
    return {"endpoint": endpoint, "url": request.url.replace("https://", "wss://", 1)}
