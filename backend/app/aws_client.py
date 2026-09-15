import threading
import time
from typing import Optional

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError, BotoCoreError

BOTO_CONFIG = Config(retries={"max_attempts": 5, "mode": "adaptive"})

SESSION_NAME = "cloudwatch-insights-webapp"
CREDENTIAL_EXPIRY_BUFFER_SECONDS = 60

_credential_cache: dict[tuple[str, str], dict] = {}
_cache_lock = threading.Lock()


class AssumeRoleError(Exception):
    pass


def _assume_role(account_id: str, role_name: str) -> dict:
    """Assume `role_name` in `account_id` using the server's ambient AWS identity.
    Returns a dict of temporary credentials, cached until shortly before expiry.
    """
    cache_key = (account_id, role_name)
    with _cache_lock:
        cached = _credential_cache.get(cache_key)
        if cached and cached["expiration"] - time.time() > CREDENTIAL_EXPIRY_BUFFER_SECONDS:
            return cached

    sts = boto3.client("sts", config=BOTO_CONFIG)
    role_arn = f"arn:aws:iam::{account_id}:role/{role_name}"
    try:
        resp = sts.assume_role(RoleArn=role_arn, RoleSessionName=SESSION_NAME, DurationSeconds=3600)
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


def get_client(service: str, account_id: str, region: str, role_name: str):
    creds = _assume_role(account_id, role_name)
    return boto3.client(
        service,
        region_name=region,
        aws_access_key_id=creds["access_key"],
        aws_secret_access_key=creds["secret_key"],
        aws_session_token=creds["session_token"],
        config=BOTO_CONFIG,
    )


def list_log_groups(account_id: str, region: str, role_name: str) -> list[dict]:
    client = get_client("logs", account_id, region, role_name)
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
    role_name: str,
    log_group_names: list[str],
    query_string: str,
    start_time: int,
    end_time: int,
    limit: Optional[int] = 1000,
) -> str:
    client = get_client("logs", account_id, region, role_name)
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


def get_query_results(account_id: str, region: str, role_name: str, query_id: str) -> dict:
    client = get_client("logs", account_id, region, role_name)
    resp = client.get_query_results(queryId=query_id)
    return {
        "status": resp.get("status"),
        "results": resp.get("results", []),
        "statistics": resp.get("statistics"),
    }


def stop_query(account_id: str, region: str, role_name: str, query_id: str) -> None:
    client = get_client("logs", account_id, region, role_name)
    try:
        client.stop_query(queryId=query_id)
    except ClientError as e:
        # Query may have already finished; ignore that class of error.
        if "not currently running" not in str(e).lower():
            raise
