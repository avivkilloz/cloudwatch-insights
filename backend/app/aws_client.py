import threading
import time
from dataclasses import dataclass, field
from typing import Optional

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError, BotoCoreError

BOTO_CONFIG = Config(retries={"max_attempts": 5, "mode": "adaptive"})

SESSION_NAME = "cloudwatch-insights-webapp"
CREDENTIAL_EXPIRY_BUFFER_SECONDS = 60

_credential_cache: dict[tuple, dict] = {}
_cache_lock = threading.Lock()


class AssumeRoleError(Exception):
    pass


@dataclass(frozen=True)
class Identity:
    """Who an AWS call runs as: the caller's group's identity on the
    connection (PLATFORM_PLAN.md D31), resolved from a credential by
    `resolve.resolve_identity`. Either a role assumed by name in the
    connection's account from the platform's own AWS identity -- what every
    group did before identities existed -- or access keys used directly.

    Secrets are kept out of its repr, so an Identity in a log line or a
    traceback says which role, never which key."""

    role_name: Optional[str] = None
    external_id: Optional[str] = field(default=None, repr=False)
    access_key_id: Optional[str] = None
    secret_access_key: Optional[str] = field(default=None, repr=False)
    session_token: Optional[str] = field(default=None, repr=False)


def _identity(identity: "Identity | str") -> Identity:
    # A bare string is a role name: what every caller passed before identities.
    return Identity(role_name=identity) if isinstance(identity, str) else identity


def _assume_role(account_id: str, identity: "Identity | str") -> dict:
    """Temporary credentials for `identity` in `account_id`: access keys as
    they are, or the role assumed with the server's ambient AWS identity,
    cached until shortly before expiry."""
    identity = _identity(identity)
    if identity.access_key_id:
        return {
            "access_key": identity.access_key_id,
            "secret_key": identity.secret_access_key,
            "session_token": identity.session_token,
            "expiration": float("inf"),
        }
    cache_key = (account_id, identity.role_name, identity.external_id)
    with _cache_lock:
        cached = _credential_cache.get(cache_key)
        if cached and cached["expiration"] - time.time() > CREDENTIAL_EXPIRY_BUFFER_SECONDS:
            return cached

    sts = boto3.client("sts", config=BOTO_CONFIG)
    role_arn = f"arn:aws:iam::{account_id}:role/{identity.role_name}"
    kwargs = {"RoleArn": role_arn, "RoleSessionName": SESSION_NAME, "DurationSeconds": 3600}
    if identity.external_id:
        kwargs["ExternalId"] = identity.external_id
    try:
        resp = sts.assume_role(**kwargs)
    except (ClientError, BotoCoreError) as e:
        raise AssumeRoleError(f"Failed to assume role {role_arn}: {e}") from e

    creds = resp["Credentials"]
    entry = {
        "access_key": creds["AccessKeyId"],
        "secret_key": creds["SecretAccessKey"],
        "session_token": creds["SessionToken"],
        "expiration": creds["Expiration"].timestamp(),
    }
    with _cache_lock:
        _credential_cache[cache_key] = entry
    return entry


def get_credentials(account_id: str, identity: Identity) -> dict:
    """Raw temporary credentials (access_key/secret_key/session_token) for
    the assumed role -- needed to SigV4-sign requests made outside of boto3
    itself, e.g. direct HTTP calls to an OpenSearch domain endpoint."""
    return _assume_role(account_id, identity)


def get_client(service: str, account_id: str, region: str, identity: Identity):
    creds = _assume_role(account_id, identity)
    return boto3.client(
        service,
        region_name=region,
        aws_access_key_id=creds["access_key"],
        aws_secret_access_key=creds["secret_key"],
        aws_session_token=creds["session_token"],
        config=BOTO_CONFIG,
    )


def get_client_with_endpoint(service: str, account_id: str, region: str, identity: Identity, endpoint_url: str):
    """Like get_client, but against an explicit endpoint -- needed for
    account-specific endpoints such as the IoT data plane (iot-data)."""
    creds = _assume_role(account_id, identity)
    return boto3.client(
        service,
        region_name=region,
        endpoint_url=endpoint_url,
        aws_access_key_id=creds["access_key"],
        aws_secret_access_key=creds["secret_key"],
        aws_session_token=creds["session_token"],
        config=BOTO_CONFIG,
    )


def list_log_groups(account_id: str, region: str, identity: Identity) -> list[dict]:
    client = get_client("logs", account_id, region, identity)
    log_groups = []
    paginator = client.get_paginator("describe_log_groups")
    for page in paginator.paginate():
        for lg in page.get("logGroups", []):
            log_groups.append(
                {
                    "name": lg.get("logGroupName"),
                    "stored_bytes": lg.get("storedBytes"),
                    "creation_time": lg.get("creationTime"),
                }
            )
    return log_groups


def start_query(
    account_id: str,
    region: str,
    identity: Identity,
    log_group_names: list[str],
    query_string: str,
    start_time: int,
    end_time: int,
    limit: Optional[int] = 1000,
) -> str:
    client = get_client("logs", account_id, region, identity)
    kwargs = dict(
        startTime=start_time,
        endTime=end_time,
        queryString=query_string,
        limit=limit or 1000,
    )
    if len(log_group_names) == 1:
        kwargs["logGroupName"] = log_group_names[0]
    else:
        kwargs["logGroupNames"] = log_group_names
    resp = client.start_query(**kwargs)
    return resp["queryId"]


def get_query_results(account_id: str, region: str, identity: Identity, query_id: str) -> dict:
    client = get_client("logs", account_id, region, identity)
    resp = client.get_query_results(queryId=query_id)
    return {
        "status": resp.get("status"),
        "results": resp.get("results", []),
        "statistics": resp.get("statistics"),
    }


def stop_query(account_id: str, region: str, identity: Identity, query_id: str) -> None:
    client = get_client("logs", account_id, region, identity)
    try:
        client.stop_query(queryId=query_id)
    except ClientError as e:
        # Query may have already finished; ignore that class of error.
        if "not currently running" not in str(e).lower():
            raise
