"""Server actions a manifest names by `handler` (PLATFORM_PLAN.md §16.3.1).

One code path for the browser and the agent: the pane calls
`POST /api/panes/{type}/actions/{action}` (routers/panes.py), the agent's
`run_pane` calls the same function (platform_tools/panes._handler_runner),
and both get the same outputs, keyed by the manifest's output names. Before
this, each pane called its own routes and the agent ran separate functions
that wrote the page's keys -- the drift D5 exists to end.

Each handler takes the pane's inputs (by the manifest's input keys) and, for
a paged action, the cursor its last run returned, and returns outputs. The
group's flag is checked before any handler runs (routers/panes.run_handler);
each handler resolves its connection and identity as the caller, through
`resolve` like everything else. DynamoDB's, Cognito's and S3's per-service
routes, which 3b-1's handlers wrapped, are gone (D49); their bodies are here.

A loader -- what fills a picker's options (D47) -- returns
`{"options": [{"value", "label"}]}`.

Errors are the routes' own `HTTPException`s, with a sentence the user can act
on; a missing input is the manifest's `requires` message, checked before a
handler runs.
"""

from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Optional

from fastapi import HTTPException
from sqlalchemy.orm import Session

from .. import aws_client, cognito_client, connections, dynamodb_client, iot_client, models, s3_client, schemas
from ..live_store import untag
from ..resolve import ResolveError, Target, resolve_identity, resolve_target

Handler = Callable[[Session, models.User, dict[str, Any], Any], dict[str, Any]]


def _limit(value: Any, default: int, high: int) -> int:
    try:
        return min(max(int(value), 1), high)
    except (TypeError, ValueError):
        return default


# ---------------------------------------------------------------- one connection


def _one(db: Session, user: models.User, inputs: dict[str, Any], key: str = "connection") -> tuple[Target, aws_client.Identity]:
    """The AWS connection an input names, as the caller, and who they are
    there: the same checks (and sentences) the per-service routes made."""
    try:
        target = resolve_target(db, int(inputs[key]), user)
        return target, resolve_identity(db, target, user)
    except (TypeError, ValueError, KeyError):
        raise HTTPException(status_code=400, detail="Choose an environment first.") from None
    except ResolveError as e:
        raise HTTPException(status_code=400, detail=str(e)) from None


def _aws(message: str, call: Callable[[], Any]) -> Any:
    """An AWS call whose failure is a 502 saying what failed, in AWS's words."""
    try:
        return call()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"{message}: {e}") from e


# ---------------------------------------------------------------- DynamoDB


def dynamodb_list_tables(db: Session, user: models.User, inputs: dict[str, Any], _cursor: Any) -> dict[str, Any]:
    t, identity = _one(db, user, inputs)
    listed = _aws("Failed to list tables", lambda: dynamodb_client.list_tables(t.account_id, t.region, identity))
    return {"options": [{"value": name, "label": name} for name in listed]}


def dynamodb_describe(db: Session, user: models.User, inputs: dict[str, Any], _cursor: Any) -> dict[str, Any]:
    t, identity = _one(db, user, inputs)
    name = str(inputs["tableName"])
    info = _aws(
        f"Failed to describe table '{name}'",
        lambda: dynamodb_client.describe_table(t.account_id, t.region, identity, name),
    )
    return {"tableInfo": schemas.DynamoTableInfo(**info).model_dump()}


def dynamodb_scan(db: Session, user: models.User, inputs: dict[str, Any], cursor: Any) -> dict[str, Any]:
    t, identity = _one(db, user, inputs)
    name = str(inputs["tableName"])
    scanned = schemas.DynamoScanResponse(
        **_aws(
            f"Failed to scan table '{name}'",
            lambda: dynamodb_client.scan_items(
                t.account_id,
                t.region,
                identity,
                name,
                str(inputs.get("queryString") or ""),
                _limit(inputs.get("limit"), 25, 200),
                cursor,
            ),
        )
    )
    return {
        "items": scanned.items,
        "lastEvaluatedKey": scanned.last_evaluated_key,
        "scannedCount": scanned.scanned_count,
    }


# ---------------------------------------------------------------- Cognito


def cognito_list_user_pools(db: Session, user: models.User, inputs: dict[str, Any], _cursor: Any) -> dict[str, Any]:
    t, identity = _one(db, user, inputs)
    pools = _aws("Failed to list user pools", lambda: cognito_client.list_user_pools(t.account_id, t.region, identity))
    return {"options": [{"value": p["id"], "label": f"{p.get('name') or p['id']} ({p['id']})"} for p in pools]}


def cognito_search(db: Session, user: models.User, inputs: dict[str, Any], cursor: Any) -> dict[str, Any]:
    t, identity = _one(db, user, inputs)
    pool = str(inputs["userPoolId"])
    request = schemas.CognitoUserSearchRequest(
        environment_id=t.id, user_pool_id=pool, query_string=str(inputs.get("queryString") or ""), pagination_token=cursor
    )
    found = schemas.CognitoUserSearchResponse(
        **_aws(
            f"Failed to search users in pool '{pool}'",
            lambda: cognito_client.search_users(
                t.account_id, t.region, identity, pool, request.query_string, request.limit, request.pagination_token
            ),
        )
    )
    return {"users": [u.model_dump() for u in found.users], "paginationToken": found.pagination_token}


# ---------------------------------------------------------------- S3


def s3_list_buckets(db: Session, user: models.User, inputs: dict[str, Any], _cursor: Any) -> dict[str, Any]:
    t, identity = _one(db, user, inputs)
    listed = _aws("Failed to list buckets", lambda: s3_client.list_buckets(t.account_id, t.region, identity))
    return {"options": [{"value": b["name"], "label": b["name"]} for b in listed]}


def s3_browse(db: Session, user: models.User, inputs: dict[str, Any], cursor: Any) -> dict[str, Any]:
    t, identity = _one(db, user, inputs)
    bucket = str(inputs["bucket"])
    request = schemas.S3BrowseRequest(
        environment_id=t.id,
        bucket=bucket,
        prefix=str(inputs.get("prefix") or ""),
        search=str(inputs.get("search") or ""),
        continuation_token=cursor,
    )
    browsed = schemas.S3BrowseResponse(
        **_aws(
            f"Failed to browse bucket '{bucket}'",
            lambda: s3_client.browse_bucket(
                t.account_id,
                t.region,
                identity,
                bucket,
                request.prefix,
                request.search,
                request.max_results,
                request.continuation_token,
            ),
        )
    )
    # The listing's own prefix and bucket aren't written back: the inputs are
    # the source of truth in v2 (§16.2). What the listing was made with that
    # the inputs may no longer say -- the search typed since -- is an output.
    return {
        "bucketRegion": browsed.bucket_region,
        "activeSearch": request.search,
        "folders": [f.model_dump() for f in browsed.folders],
        "files": [f.model_dump() for f in browsed.files],
        "continuationToken": browsed.continuation_token,
    }


# ---------------------------------------------------------------- fan-out


_executor = ThreadPoolExecutor(max_workers=16)


def connection_ids(value: Any) -> list[int]:
    """A `connections` input as ids: a plain list (v2), or the tagged Set a
    session saved before the port still holds."""
    value = untag(value)
    if not isinstance(value, (list, tuple, set)):
        return []
    out = []
    for v in value:
        try:
            out.append(int(v))
        except (TypeError, ValueError):
            continue
    return sorted(set(out))


def fan_out(
    db: Session,
    user: models.User,
    ids: list[int],
    rows: str,
    run: Callable[[str, str, aws_client.Identity], list[dict]],
) -> list[dict[str, Any]]:
    """One group per AWS connection, `{environment_id, environment_name,
    account_id, region, <rows>: [...], error}` -- the shape every pane that
    searches several environments has always stored (§16.4.1). A connection
    that can't be reached or whose call fails is that group's `error`, never
    the whole run's: partial failures are reported per account.

    Each connection and identity is resolved here, in the request's thread,
    and `run` gets plain strings (account, region) and the identity: the
    database session isn't shared across threads, and a commit while
    resolving (an identity's use is audited) expires the connection row, so
    reading it from a worker would load it there.
    Only the AWS calls run in parallel."""
    groups: list[dict[str, Any]] = []
    pending = []
    for connection_id in ids:
        group: dict[str, Any] = {
            "environment_id": connection_id,
            "environment_name": str(connection_id),
            "account_id": "",
            "region": "",
            rows: [],
            "error": None,
        }
        groups.append(group)
        try:
            target = resolve_target(db, connection_id, user)
            group.update(environment_name=target.name, account_id=target.account_id, region=target.region)
            identity = resolve_identity(db, target, user)
        except ResolveError as e:
            group["error"] = str(e)
            continue
        pending.append((group, _executor.submit(run, group["account_id"], group["region"], identity)))
    for group, future in pending:
        try:
            group[rows] = future.result()
        except Exception as e:  # noqa: BLE001 - one environment's failure is its own row, not the run's
            group["error"] = str(e)
    return groups


# ---------------------------------------------------------------- IoT

IOT_DEFAULT_QUERY = {"things": "thingName:*", "certificates": "status:ACTIVE"}


def iot_search(db: Session, user: models.User, inputs: dict[str, Any], _cursor: Any) -> dict[str, Any]:
    """Things by Fleet Indexing query, or certificates, across the chosen
    connections. Writes both outputs, the other mode's empty, so a pane never
    shows a search that isn't the one it ran."""
    mode = "certificates" if inputs.get("searchMode") == "certificates" else "things"
    query = str(inputs.get("queryString") or "").strip()
    if not query:
        raise HTTPException(status_code=400, detail=f"Enter a search query (e.g. {IOT_DEFAULT_QUERY[mode]}).")
    most = _limit(inputs.get("maxResults"), 50, 500)
    ids = connection_ids(inputs.get("connections"))
    if mode == "certificates":
        found = fan_out(
            db,
            user,
            ids,
            "certificates",
            lambda account, region, identity: [
                schemas.IotCertificateInfo(**c).model_dump()
                for c in iot_client.search_certificates(account, region, identity, query, most)
            ],
        )
        return {"certResults": found, "thingResults": []}
    found = fan_out(
        db,
        user,
        ids,
        "things",
        lambda account, region, identity: [
            schemas.IotThingSummary(**c).model_dump()
            for c in iot_client.search_things(account, region, identity, query, most)
        ],
    )
    return {"thingResults": found, "certResults": []}


def iot_thing_detail(db: Session, user: models.User, inputs: dict[str, Any], _cursor: Any) -> dict[str, Any]:
    """A thing's shadows, certificates (with their policies) and jobs: what
    expanding its row shows, and what inspect_row hands the agent."""
    target, identity = _one(db, user, inputs)
    name = str(inputs["thingName"])
    try:
        detail = iot_client.get_thing_detail(target.account_id, target.region, identity, name)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Failed to load thing '{name}': {e}") from e
    return schemas.IotThingDetail(**detail).model_dump()


def iot_cert_detail(db: Session, user: models.User, inputs: dict[str, Any], _cursor: Any) -> dict[str, Any]:
    """Which things a certificate is attached to (its search row already
    carries its policies)."""
    target, identity = _one(db, user, inputs)
    cert = str(inputs["certificateId"])
    try:
        detail = iot_client.get_certificate_detail(target.account_id, target.region, identity, cert)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Failed to load certificate '{cert}': {e}") from e
    return schemas.IotCertificateDetail(**detail).model_dump()


# ---------------------------------------------------------------- HTTP client

BODYLESS = ("GET", "HEAD")


def _header_rows(value: Any) -> list[schemas.ToolHeader]:
    rows = value if isinstance(value, list) else []
    return [
        schemas.ToolHeader(key=str(r.get("key") or ""), value=str(r.get("value") or ""))
        for r in rows
        if isinstance(r, dict) and str(r.get("key") or "").strip()
    ]


def http_send(db: Session, user: models.User, inputs: dict[str, Any], _cursor: Any) -> dict[str, Any]:
    """The HTTP client's Send, through `/api/tools/http-request`'s own
    function: the SSRF guard, the target's base URL and identity, the
    credential's `inject` and the masking all stay exactly where they were.

    Besides the response it returns the exchange -- the request as sent
    beside its response -- which the pane always offers the agent to attach
    ("why is this a 403?" can't be answered without what was sent). Built
    here, so the joined URL is the server's own; the auth is said by name,
    and nothing secret is in it: the credential's values were applied below
    this, and anything they produced is masked in the reply."""
    from ..routers import tools

    method = str(inputs.get("method") or "GET")
    url = str(inputs.get("url") or "").strip()
    target_id = inputs.get("targetId")
    target_id = int(target_id) if target_id not in (None, "") else None
    credential_id = inputs.get("credentialId")
    credential_id = int(credential_id) if credential_id not in (None, "") else None
    if not url and target_id is None:
        raise HTTPException(status_code=400, detail="Enter a URL.")
    headers = _header_rows(inputs.get("headerRows"))
    body = None if method in BODYLESS else (str(inputs.get("body") or "") or None)
    response = tools.send_http_request(
        payload=schemas.HttpToolRequest(
            method=method, url=url, headers=headers, body=body, credential_id=credential_id, target_id=target_id
        ),
        db=db,
        current_user=user,
    )
    request: dict[str, Any] = {
        "method": method,
        "url": url,
        "headers": [h.model_dump() for h in headers],
        "body": body,
    }
    if target_id is not None:
        target = resolve_target(db, target_id, user, type_id=connections.HTTP_API)
        request["url"] = connections.join_url(target.config["base_url"], url)
        request["target"] = target.name
    if credential_id is not None:
        credential = db.get(models.Credential, credential_id)
        request["auth"] = f'credential "{credential.name}"' if credential else "a credential"
    elif target_id is not None:
        request["auth"] = f"your group's identity on {request['target']}, if it has one"
    exchange = {"request": request, "response": response.model_dump()}
    return {"response": response.model_dump(), "exchange": [exchange]}


ACTIONS: dict[str, Handler] = {
    "aws.dynamodb.list_tables": dynamodb_list_tables,
    "aws.dynamodb.describe": dynamodb_describe,
    "aws.dynamodb.scan": dynamodb_scan,
    "aws.cognito.list_user_pools": cognito_list_user_pools,
    "aws.cognito.search": cognito_search,
    "aws.s3.list_buckets": s3_list_buckets,
    "aws.s3.browse": s3_browse,
    "aws.iot.search": iot_search,
    "aws.iot.thing_detail": iot_thing_detail,
    "aws.iot.cert_detail": iot_cert_detail,
    "http.send": http_send,
}


def missing(action_requires: dict[str, str], inputs: dict[str, Any]) -> Optional[str]:
    """The first `requires` message whose input isn't set, if any."""
    for key, message in action_requires.items():
        if inputs.get(key) in (None, "", []):
            return message
    return None
