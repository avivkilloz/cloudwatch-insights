import json
import threading
from typing import Optional

from . import aws_client

# Read-only: this module never creates/updates/deletes things, certificates,
# shadows, or jobs -- only search_index / describe_* / list_* / get_*.

THINGS_INDEX = "AWS_Things"

# The IoT data-plane endpoint (used for shadow reads) is per-account/region
# and does not change, so it's cached indefinitely for the process lifetime
# once resolved once.
_endpoint_cache: dict[tuple[str, str, str], str] = {}
_endpoint_lock = threading.Lock()


def _get_iot_data_endpoint(account_id: str, region: str, role_name: str) -> str:
    cache_key = (account_id, region, role_name)
    with _endpoint_lock:
        cached = _endpoint_cache.get(cache_key)
        if cached:
            return cached
    client = aws_client.get_client("iot", account_id, region, role_name)
    resp = client.describe_endpoint(endpointType="iot:Data-ATS")
    endpoint = resp["endpointAddress"]
    with _endpoint_lock:
        _endpoint_cache[cache_key] = endpoint
    return endpoint


def _get_iot_data_client(account_id: str, region: str, role_name: str):
    endpoint = _get_iot_data_endpoint(account_id, region, role_name)
    return aws_client.get_client_with_endpoint("iot-data", account_id, region, role_name, f"https://{endpoint}")


def search_things(account_id: str, region: str, role_name: str, query_string: str, max_results: int = 100) -> list[dict]:
    """Fleet Indexing search -- the same mechanism and query syntax as the
    "Advanced search" box for IoT things in the AWS console. Requires thing
    indexing to be enabled for this account/region; raises otherwise."""
    client = aws_client.get_client("iot", account_id, region, role_name)
    things: list[dict] = []
    next_token = None
    while len(things) < max_results:
        kwargs = {
            "indexName": THINGS_INDEX,
            "queryString": query_string,
            "maxResults": min(100, max_results - len(things)),
        }
        if next_token:
            kwargs["nextToken"] = next_token
        resp = client.search_index(**kwargs)
        for t in resp.get("things", []):
            connectivity = t.get("connectivity") or {}
            things.append(
                {
                    "thing_name": t.get("thingName"),
                    "thing_id": t.get("thingId"),
                    "thing_type_name": t.get("thingTypeName"),
                    "thing_group_names": t.get("thingGroupNames", []),
                    "attributes": t.get("attributes", {}),
                    "connected": connectivity.get("connected"),
                    "connectivity_timestamp": connectivity.get("timestamp"),
                }
            )
        next_token = resp.get("nextToken")
        if not next_token:
            break
    return things[:max_results]


def _describe_thing(account_id: str, region: str, role_name: str, thing_name: str) -> dict:
    client = aws_client.get_client("iot", account_id, region, role_name)
    resp = client.describe_thing(thingName=thing_name)
    return {
        "thing_name": resp.get("thingName"),
        "thing_id": resp.get("thingId"),
        "thing_arn": resp.get("thingArn"),
        "thing_type_name": resp.get("thingTypeName"),
        "attributes": resp.get("attributes", {}),
        "version": resp.get("version"),
    }


def _get_connectivity(account_id: str, region: str, role_name: str, thing_name: str) -> Optional[dict]:
    client = aws_client.get_client("iot", account_id, region, role_name)
    resp = client.search_index(indexName=THINGS_INDEX, queryString=f'thingName:"{thing_name}"', maxResults=1)
    items = resp.get("things", [])
    if not items:
        return None
    connectivity = items[0].get("connectivity") or {}
    return {"connected": connectivity.get("connected"), "timestamp": connectivity.get("timestamp")}


def _list_certificates_for_thing(account_id: str, region: str, role_name: str, thing_name: str) -> list[dict]:
    client = aws_client.get_client("iot", account_id, region, role_name)
    resp = client.list_thing_principals(thingName=thing_name)
    certs = []
    for principal_arn in resp.get("principals", []):
        if ":cert/" not in principal_arn:
            continue  # e.g. a Cognito identity principal -- not describable as a certificate
        cert_id = principal_arn.split("/")[-1]
        try:
            cert_resp = client.describe_certificate(certificateId=cert_id)
            desc = cert_resp.get("certificateDescription", {})
            creation_date = desc.get("creationDate")
            certs.append(
                {
                    "certificate_id": desc.get("certificateId", cert_id),
                    "certificate_arn": desc.get("certificateArn", principal_arn),
                    "status": desc.get("status", "UNKNOWN"),
                    "creation_date": int(creation_date.timestamp()) if creation_date else None,
                }
            )
        except Exception:  # noqa: BLE001 -- one bad principal shouldn't drop the rest
            certs.append(
                {
                    "certificate_id": cert_id,
                    "certificate_arn": principal_arn,
                    "status": "UNKNOWN",
                    "creation_date": None,
                }
            )
    return certs


def _extract_latest_timestamp(node) -> Optional[int]:
    """Shadow `metadata` mirrors `state`'s shape, with every leaf replaced by
    {"timestamp": <epoch seconds>}. Walk it and take the max -- i.e. the most
    recently updated leaf value anywhere in reported/desired."""
    latest: Optional[int] = None

    def walk(n):
        nonlocal latest
        if isinstance(n, dict):
            for key, value in n.items():
                if key == "timestamp" and isinstance(value, (int, float)):
                    if latest is None or value > latest:
                        latest = value
                else:
                    walk(value)
        elif isinstance(n, list):
            for item in n:
                walk(item)

    walk(node)
    return int(latest) if latest is not None else None


def _list_shadows_for_thing(account_id: str, region: str, role_name: str, thing_name: str) -> list[dict]:
    control_client = aws_client.get_client("iot", account_id, region, role_name)
    shadow_names: list[Optional[str]] = [None]  # classic/unnamed shadow, always attempted
    try:
        resp = control_client.list_named_shadows_for_thing(thingName=thing_name)
        shadow_names += resp.get("results", [])
    except Exception:  # noqa: BLE001 -- fall back to just the classic shadow
        pass

    data_client = _get_iot_data_client(account_id, region, role_name)
    shadows = []
    for name in shadow_names:
        try:
            kwargs = {"thingName": thing_name}
            if name:
                kwargs["shadowName"] = name
            resp = data_client.get_thing_shadow(**kwargs)
            payload = json.loads(resp["payload"].read())
            state = payload.get("state", {})
            metadata = payload.get("metadata", {})
            shadows.append(
                {
                    "name": name or "(classic)",
                    "reported": state.get("reported", {}),
                    "desired": state.get("desired", {}),
                    "version": payload.get("version"),
                    "last_updated": _extract_latest_timestamp(metadata),
                }
            )
        except data_client.exceptions.ResourceNotFoundException:
            continue  # this shadow name doesn't actually have a document
        except Exception:  # noqa: BLE001
            continue
    return shadows


def _list_job_executions_for_thing(account_id: str, region: str, role_name: str, thing_name: str) -> list[dict]:
    client = aws_client.get_client("iot", account_id, region, role_name)
    jobs = []
    next_token = None
    while True:
        kwargs = {"thingName": thing_name, "maxResults": 50}
        if next_token:
            kwargs["nextToken"] = next_token
        resp = client.list_job_executions_for_thing(**kwargs)
        for je in resp.get("executionSummaries", []):
            summary = je.get("jobExecutionSummary", {})
            queued_at = summary.get("queuedAt")
            started_at = summary.get("startedAt")
            last_updated_at = summary.get("lastUpdatedAt")
            jobs.append(
                {
                    "job_id": je.get("jobId"),
                    "status": summary.get("status"),
                    "queued_at": int(queued_at.timestamp()) if queued_at else None,
                    "started_at": int(started_at.timestamp()) if started_at else None,
                    "last_updated_at": int(last_updated_at.timestamp()) if last_updated_at else None,
                }
            )
        next_token = resp.get("nextToken")
        if not next_token or len(jobs) >= 200:
            break
    return jobs


def get_thing_detail(account_id: str, region: str, role_name: str, thing_name: str) -> dict:
    """Combines several AWS IoT calls into one thing-detail payload. The
    core describe_thing call is allowed to raise (nothing to show without
    it); each auxiliary section (connectivity/certs/shadows/jobs) degrades
    independently so a missing permission on one doesn't hide the rest."""
    result = {
        **_describe_thing(account_id, region, role_name, thing_name),
        "connected": None,
        "connectivity_timestamp": None,
        "certificates": [],
        "shadows": [],
        "jobs": [],
        "warnings": [],
    }

    try:
        connectivity = _get_connectivity(account_id, region, role_name, thing_name)
        if connectivity:
            result["connected"] = connectivity.get("connected")
            result["connectivity_timestamp"] = connectivity.get("timestamp")
    except Exception as e:  # noqa: BLE001
        result["warnings"].append(f"connectivity: {e}")

    try:
        result["certificates"] = _list_certificates_for_thing(account_id, region, role_name, thing_name)
    except Exception as e:  # noqa: BLE001
        result["warnings"].append(f"certificates: {e}")

    try:
        result["shadows"] = _list_shadows_for_thing(account_id, region, role_name, thing_name)
    except Exception as e:  # noqa: BLE001
        result["warnings"].append(f"shadows: {e}")

    try:
        result["jobs"] = _list_job_executions_for_thing(account_id, region, role_name, thing_name)
    except Exception as e:  # noqa: BLE001
        result["warnings"].append(f"jobs: {e}")

    return result
