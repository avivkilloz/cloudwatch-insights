"""Server actions a manifest names by `handler` (PLATFORM_PLAN.md §16.3.1).

One code path for the browser and the agent: the pane calls
`POST /api/panes/{type}/actions/{action}` (routers/panes.py), the agent's
`run_pane` calls the same function (platform_tools/panes._handler_runner),
and both get the same outputs, keyed by the manifest's output names. Before
this, each pane called its own routes and the agent ran separate functions
that wrote the page's keys -- the drift D5 exists to end.

Each handler takes the pane's inputs (by the manifest's input keys) and, for
a paged action, the cursor its last run returned, and returns outputs. For
now they wrap the per-service routes, which stay for one release (D49) and
re-check the group's flag, the connection and the identity; those checks
move here when the routes go (3b-2).

A loader -- what fills a picker's options (D47) -- returns
`{"options": [{"value", "label"}]}`.

Errors are the routes' own `HTTPException`s, with a sentence the user can act
on; a missing input is the manifest's `requires` message, checked before a
handler runs.
"""

from typing import Any, Callable, Optional

from sqlalchemy.orm import Session

from .. import models, schemas

Handler = Callable[[Session, models.User, dict[str, Any], Any], dict[str, Any]]


def _connection(inputs: dict[str, Any]) -> int:
    return int(inputs["connection"])


def _limit(value: Any, default: int, high: int) -> int:
    try:
        return min(max(int(value), 1), high)
    except (TypeError, ValueError):
        return default


# ---------------------------------------------------------------- DynamoDB


def dynamodb_list_tables(db: Session, user: models.User, inputs: dict[str, Any], _cursor: Any) -> dict[str, Any]:
    from ..routers import tables

    listed = tables.list_tables(environment_id=_connection(inputs), db=db, current_user=user)
    return {"options": [{"value": t, "label": t} for t in listed.tables]}


def dynamodb_describe(db: Session, user: models.User, inputs: dict[str, Any], _cursor: Any) -> dict[str, Any]:
    from ..routers import tables

    info = tables.describe_table(
        payload=schemas.DynamoTableDescribeRequest(environment_id=_connection(inputs), table_name=inputs["tableName"]),
        db=db,
        current_user=user,
    )
    return {"tableInfo": info.model_dump()}


def dynamodb_scan(db: Session, user: models.User, inputs: dict[str, Any], cursor: Any) -> dict[str, Any]:
    from ..routers import tables

    scanned = tables.scan_table(
        payload=schemas.DynamoScanRequest(
            environment_id=_connection(inputs),
            table_name=inputs["tableName"],
            query_string=inputs.get("queryString") or "",
            limit=_limit(inputs.get("limit"), 25, 200),
            exclusive_start_key=cursor,
        ),
        db=db,
        current_user=user,
    )
    return {
        "items": scanned.items,
        "lastEvaluatedKey": scanned.last_evaluated_key,
        "scannedCount": scanned.scanned_count,
    }


# ---------------------------------------------------------------- Cognito


def cognito_list_user_pools(db: Session, user: models.User, inputs: dict[str, Any], _cursor: Any) -> dict[str, Any]:
    from ..routers import cognito

    pools = cognito.list_user_pools(environment_id=_connection(inputs), db=db, current_user=user)
    return {"options": [{"value": p.id, "label": f"{p.name or p.id} ({p.id})"} for p in pools.user_pools]}


def cognito_search(db: Session, user: models.User, inputs: dict[str, Any], cursor: Any) -> dict[str, Any]:
    from ..routers import cognito

    found = cognito.search_users(
        payload=schemas.CognitoUserSearchRequest(
            environment_id=_connection(inputs),
            user_pool_id=inputs["userPoolId"],
            query_string=inputs.get("queryString") or "",
            pagination_token=cursor,
        ),
        db=db,
        current_user=user,
    )
    return {"users": [u.model_dump() for u in found.users], "paginationToken": found.pagination_token}


# ---------------------------------------------------------------- S3


def s3_list_buckets(db: Session, user: models.User, inputs: dict[str, Any], _cursor: Any) -> dict[str, Any]:
    from ..routers import buckets

    listed = buckets.list_buckets(environment_id=_connection(inputs), db=db, current_user=user)
    return {"options": [{"value": b.name, "label": b.name} for b in listed.buckets]}


def s3_browse(db: Session, user: models.User, inputs: dict[str, Any], cursor: Any) -> dict[str, Any]:
    from ..routers import buckets

    search = inputs.get("search") or ""
    browsed = buckets.browse_bucket(
        payload=schemas.S3BrowseRequest(
            environment_id=_connection(inputs),
            bucket=inputs["bucket"],
            prefix=inputs.get("prefix") or "",
            search=search,
            continuation_token=cursor,
        ),
        db=db,
        current_user=user,
    )
    # The listing's own prefix and bucket aren't written back: the inputs are
    # the source of truth in v2 (§16.2). What the listing was made with that
    # the inputs may no longer say -- the search typed since -- is an output.
    return {
        "bucketRegion": browsed.bucket_region,
        "activeSearch": search,
        "folders": [f.model_dump() for f in browsed.folders],
        "files": [f.model_dump() for f in browsed.files],
        "continuationToken": browsed.continuation_token,
    }


ACTIONS: dict[str, Handler] = {
    "aws.dynamodb.list_tables": dynamodb_list_tables,
    "aws.dynamodb.describe": dynamodb_describe,
    "aws.dynamodb.scan": dynamodb_scan,
    "aws.cognito.list_user_pools": cognito_list_user_pools,
    "aws.cognito.search": cognito_search,
    "aws.s3.list_buckets": s3_list_buckets,
    "aws.s3.browse": s3_browse,
}


def missing(action_requires: dict[str, str], inputs: dict[str, Any]) -> Optional[str]:
    """The first `requires` message whose input isn't set, if any."""
    for key, message in action_requires.items():
        if inputs.get(key) in (None, "", []):
            return message
    return None
