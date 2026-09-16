import base64
import json
from decimal import Decimal, InvalidOperation
from typing import Optional

from boto3.dynamodb.types import TypeDeserializer, TypeSerializer

from . import aws_client
from .query_parse import parse_field_filters

# Read-only: this module never creates/updates/deletes tables or items --
# only list_tables / describe_table / scan.

_deserializer = TypeDeserializer()
_serializer = TypeSerializer()


def _from_dynamo_item(item: dict) -> dict:
    return {k: _plain(_deserializer.deserialize(v)) for k, v in item.items()}


def _plain(value):
    """Deserialized DynamoDB values can contain Decimal and set types that
    don't round-trip through JSON on their own -- normalize them."""
    if isinstance(value, Decimal):
        return int(value) if value % 1 == 0 else float(value)
    if isinstance(value, (set, frozenset)):
        return sorted(_plain(v) for v in value)
    if isinstance(value, dict):
        return {k: _plain(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_plain(v) for v in value]
    return value


def _to_dynamo_value(value: str) -> dict:
    """A search box only ever gives us strings -- try numeric first since
    that's how most DynamoDB attributes worth filtering on are typed,
    falling back to a string match. boto3's TypeSerializer requires Decimal
    for the Number type -- it rejects a plain float outright."""
    try:
        return _serializer.serialize(int(value))
    except ValueError:
        pass
    try:
        return _serializer.serialize(Decimal(value))
    except InvalidOperation:
        pass
    return _serializer.serialize(value)


def _encode_key(key: Optional[dict]) -> Optional[str]:
    if not key:
        return None
    return base64.urlsafe_b64encode(json.dumps(key).encode()).decode()


def _decode_key(token: Optional[str]) -> Optional[dict]:
    if not token:
        return None
    return json.loads(base64.urlsafe_b64decode(token.encode()).decode())


def list_tables(account_id: str, region: str, role_name: str) -> list[str]:
    client = aws_client.get_client("dynamodb", account_id, region, role_name)
    names = []
    paginator = client.get_paginator("list_tables")
    for page in paginator.paginate():
        names.extend(page.get("TableNames", []))
    return names


def describe_table(account_id: str, region: str, role_name: str, table_name: str) -> dict:
    client = aws_client.get_client("dynamodb", account_id, region, role_name)
    resp = client.describe_table(TableName=table_name)
    table = resp["Table"]
    key_schema = table.get("KeySchema", [])
    partition_key = next((k["AttributeName"] for k in key_schema if k["KeyType"] == "HASH"), None)
    sort_key = next((k["AttributeName"] for k in key_schema if k["KeyType"] == "RANGE"), None)
    return {
        "table_name": table["TableName"],
        "status": table.get("TableStatus"),
        "item_count": table.get("ItemCount"),
        "size_bytes": table.get("TableSizeBytes"),
        "partition_key": partition_key,
        "sort_key": sort_key,
    }


def scan_items(
    account_id: str,
    region: str,
    role_name: str,
    table_name: str,
    query_string: str = "",
    limit: int = 25,
    exclusive_start_key: Optional[str] = None,
) -> dict:
    """A plain Scan (optionally with an equality FilterExpression) -- there's
    no way to offer a general "search by any field" over an arbitrary,
    schemaless DynamoDB table other than scanning, and FilterExpression is
    applied *after* the page is read, so a filtered scan can legitimately
    return fewer than `limit` items (or zero) while still having more pages;
    the caller should keep paging via last_evaluated_key when it wants more."""
    client = aws_client.get_client("dynamodb", account_id, region, role_name)
    filters = parse_field_filters(query_string)

    kwargs: dict = {"TableName": table_name, "Limit": limit}
    start_key = _decode_key(exclusive_start_key)
    if start_key:
        kwargs["ExclusiveStartKey"] = start_key

    if filters:
        expr_names = {f"#f{i}": name for i, name in enumerate(filters)}
        expr_values = {f":v{i}": _to_dynamo_value(value) for i, value in enumerate(filters.values())}
        kwargs["FilterExpression"] = " AND ".join(f"#f{i} = :v{i}" for i in range(len(filters)))
        kwargs["ExpressionAttributeNames"] = expr_names
        kwargs["ExpressionAttributeValues"] = expr_values

    resp = client.scan(**kwargs)
    return {
        "items": [_from_dynamo_item(i) for i in resp.get("Items", [])],
        "scanned_count": resp.get("ScannedCount", 0),
        "count": resp.get("Count", 0),
        "last_evaluated_key": _encode_key(resp.get("LastEvaluatedKey")),
    }
