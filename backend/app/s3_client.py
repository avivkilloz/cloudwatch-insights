import threading
import time
from typing import Optional

from . import aws_client

# Read-only: this module never creates/updates/deletes buckets or objects,
# and never reads object bodies -- only list_buckets / get_bucket_location /
# list_objects_v2.

# How much of a bucket one filename search request scans: until it has a page
# of matches, the listing ends, or this long has gone (a page of 1000 keys is
# ~0.1-0.3 s). It was 20 pages, and a file past the first 20,000 keys of a big
# bucket was "Nothing here." -- the search never got there.
SEARCH_SECONDS = 8.0
MAX_SEARCH_PAGES = 200
# A search's cursor is the last key it looked at (StartAfter), not S3's own
# continuation token: a request that fills up mid-page resumes from the very
# next key, where a page's token skipped the rest of that page.
_AFTER = "after:"

# A bucket's actual region can differ from the environment's configured
# region, and object listing must target that region's endpoint -- resolved
# once per bucket and cached for the process lifetime.
_bucket_region_cache: dict[tuple[str, str], str] = {}
_bucket_region_lock = threading.Lock()


def _get_bucket_region(account_id: str, region: str, identity: aws_client.Identity, bucket: str) -> str:
    cache_key = (account_id, bucket)
    with _bucket_region_lock:
        cached = _bucket_region_cache.get(cache_key)
        if cached:
            return cached
    client = aws_client.get_client("s3", account_id, region, identity)
    resp = client.get_bucket_location(Bucket=bucket)
    location = resp.get("LocationConstraint") or "us-east-1"
    if location == "EU":  # historical quirk for some old eu-west-1 buckets
        location = "eu-west-1"
    with _bucket_region_lock:
        _bucket_region_cache[cache_key] = location
    return location


def list_buckets(account_id: str, region: str, identity: aws_client.Identity) -> list[dict]:
    client = aws_client.get_client("s3", account_id, region, identity)
    resp = client.list_buckets()
    buckets = []
    for b in resp.get("Buckets", []):
        creation_date = b.get("CreationDate")
        buckets.append({"name": b["Name"], "creation_date": int(creation_date.timestamp()) if creation_date else None})
    return buckets


def _file_info(obj: dict) -> dict:
    key = obj["Key"]
    last_modified = obj.get("LastModified")
    return {
        "key": key,
        "name": key.rsplit("/", 1)[-1],
        "size": obj.get("Size"),
        "last_modified": int(last_modified.timestamp()) if last_modified else None,
        "storage_class": obj.get("StorageClass"),
    }


def browse_bucket(
    account_id: str,
    region: str,
    identity: aws_client.Identity,
    bucket: str,
    prefix: str = "",
    search: str = "",
    max_results: int = 200,
    continuation_token: Optional[str] = None,
) -> dict:
    """Two modes, chosen by whether `search` is set:
    - Folder browsing (default): a single Delimiter="/" listing under
      `prefix`, splitting the result into subfolders (CommonPrefixes) and
      files (Contents) at that level only -- a normal file-explorer view.
    - Path lookup, when `search` holds a "/": that path's folders and files,
      as `aws s3 ls` lists them -- S3 finds a prefix itself, at once.
    - Filename search: a recursive (no Delimiter) listing under `prefix`,
      matched case-insensitively against each object's path below `prefix`
      (so "2024/app" finds a file in a folder, and a bare name finds it
      anywhere below), for up to SEARCH_SECONDS per request; `scanned` says
      how many keys it looked at, and the returned cursor carries on from
      the last one.
    """
    bucket_region = _get_bucket_region(account_id, region, identity, bucket)
    client = aws_client.get_client("s3", account_id, bucket_region, identity)

    folders: list[dict] = []
    files: list[dict] = []
    next_token: Optional[str] = None
    scanned = 0

    path = search.strip().lstrip("/")
    # Load more of a name search carries on as one (its cursor is a key).
    if "/" in path and not (continuation_token or "").startswith(_AFTER):
        # A path ("POP/69/", "logs/2024/app"): listed the way `aws s3 ls
        # s3://bucket/POP/69/` lists it -- S3 itself finds the keys under a
        # prefix, at once, however big the bucket. Scanning for it as a
        # substring went through every key before it (33,000 and still short
        # of "POP/" in a real bucket). Case matters here, as it does to S3.
        kwargs = {"Bucket": bucket, "Prefix": prefix + path, "Delimiter": "/", "MaxKeys": max_results}
        if continuation_token and not continuation_token.startswith(_AFTER):
            kwargs["ContinuationToken"] = continuation_token
        resp = client.list_objects_v2(**kwargs)
        for cp in resp.get("CommonPrefixes", []):
            folder_prefix = cp["Prefix"]
            folders.append({"name": folder_prefix[len(prefix):].rstrip("/"), "prefix": folder_prefix})
        for obj in resp.get("Contents", []):
            if obj["Key"].endswith("/") and obj.get("Size", 0) == 0:
                continue  # a folder's placeholder object
            files.append(_file_info(obj))
        if resp.get("IsTruncated"):
            next_token = resp.get("NextContinuationToken")
        if folders or files or continuation_token:
            return {
                "bucket": bucket,
                "bucket_region": bucket_region,
                "prefix": prefix,
                "folders": folders,
                "files": files,
                "continuation_token": next_token,
                "scanned": 0,
                "mode": "path",
            }
        # No such path (or not in this case): looked for as part of a name
        # instead, which "2024/app" for logs/2024/App.log still finds.

    if search.strip():
        term = search.strip().lower()
        kwargs: dict = {"Bucket": bucket, "Prefix": prefix, "MaxKeys": 1000}
        if continuation_token and continuation_token.startswith(_AFTER):
            kwargs["StartAfter"] = continuation_token[len(_AFTER):]
        elif continuation_token:
            kwargs["ContinuationToken"] = continuation_token  # a cursor stored before the change
        deadline = time.monotonic() + SEARCH_SECONDS
        last_key: Optional[str] = None
        more = True
        for _ in range(MAX_SEARCH_PAGES):
            resp = client.list_objects_v2(**kwargs)
            contents = resp.get("Contents", [])
            more = bool(resp.get("IsTruncated"))
            for i, obj in enumerate(contents):
                key = obj["Key"]
                last_key = key
                scanned += 1
                if key.endswith("/") and obj.get("Size", 0) == 0:
                    continue  # a folder placeholder object, not a real file
                if term in key[len(prefix):].lower():
                    files.append(_file_info(obj))
                    if len(files) >= max_results:
                        more = more or i < len(contents) - 1
                        break
            if len(files) >= max_results or not more or time.monotonic() >= deadline:
                break
            kwargs.pop("ContinuationToken", None)
            kwargs["StartAfter"] = last_key
        next_token = f"{_AFTER}{last_key}" if more and last_key is not None else None
    else:
        kwargs = {"Bucket": bucket, "Prefix": prefix, "Delimiter": "/", "MaxKeys": max_results}
        if continuation_token:
            kwargs["ContinuationToken"] = continuation_token
        resp = client.list_objects_v2(**kwargs)
        for cp in resp.get("CommonPrefixes", []):
            folder_prefix = cp["Prefix"]
            folders.append({"name": folder_prefix[len(prefix):].rstrip("/"), "prefix": folder_prefix})
        for obj in resp.get("Contents", []):
            if obj["Key"] == prefix:
                continue  # the "folder" placeholder object for the current prefix itself
            files.append(_file_info(obj))
        if resp.get("IsTruncated"):
            next_token = resp.get("NextContinuationToken")

    return {
        "bucket": bucket,
        "bucket_region": bucket_region,
        "prefix": prefix,
        "folders": folders,
        "files": files,
        "continuation_token": next_token,
        "scanned": scanned,
        "mode": "name" if search.strip() else "browse",
    }
