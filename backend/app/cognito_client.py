from typing import Optional

from . import aws_client
from .query_parse import parse_field_filters

# Read-only: this module never creates/updates/deletes user pools or users --
# only list_user_pools / list_users.


def list_user_pools(account_id: str, region: str, role_name: str) -> list[dict]:
    client = aws_client.get_client("cognito-idp", account_id, region, role_name)
    pools = []
    paginator = client.get_paginator("list_user_pools")
    for page in paginator.paginate(MaxResults=60):
        for p in page.get("UserPools", []):
            pools.append({"id": p["Id"], "name": p.get("Name")})
    return pools


def _build_filter(attribute: str, value: str) -> str:
    # ListUsers' Filter is a small string DSL ("attribute ^= \"value\"") --
    # only double quotes and backslashes inside the value need escaping.
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'{attribute} ^= "{escaped}"'


def _user_summary(user: dict) -> dict:
    attributes = {a["Name"]: a.get("Value") for a in user.get("Attributes", [])}
    created = user.get("UserCreateDate")
    modified = user.get("UserLastModifiedDate")
    return {
        "username": user.get("Username"),
        "status": user.get("UserStatus"),
        "enabled": user.get("Enabled"),
        "created": int(created.timestamp()) if created else None,
        "last_modified": int(modified.timestamp()) if modified else None,
        "attributes": attributes,
    }


def search_users(
    account_id: str,
    region: str,
    role_name: str,
    user_pool_id: str,
    query_string: str = "",
    limit: int = 30,
    pagination_token: Optional[str] = None,
) -> dict:
    """Cognito's ListUsers Filter only supports a single `attribute ^= "value"`
    (starts-with) expression -- unlike the IoT/DynamoDB search boxes, there's
    no ANDing multiple fields here. `field:value` tokens beyond the first in
    query_string are ignored; only one is meaningful to the API."""
    client = aws_client.get_client("cognito-idp", account_id, region, role_name)
    filters = parse_field_filters(query_string)

    kwargs: dict = {"UserPoolId": user_pool_id, "Limit": limit}
    if filters:
        attribute, value = next(iter(filters.items()))
        kwargs["Filter"] = _build_filter(attribute, value)
    if pagination_token:
        kwargs["PaginationToken"] = pagination_token

    resp = client.list_users(**kwargs)
    return {
        "users": [_user_summary(u) for u in resp.get("Users", [])],
        "pagination_token": resp.get("PaginationToken"),
    }
