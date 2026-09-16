import threading
from typing import Optional

from . import aws_client

# Read-only: this module never creates/updates/deletes buckets or objects,
# and never reads object bodies -- only list_buckets / get_bucket_location /
# list_objects_v2.

MAX_SEARCH_PAGES = 20  # bounds how much of a bucket a filename search will scan per request

# A bucket's actual region can differ from the environment's configured
# region, and object listing must target that region's endpoint -- resolved
# once per bucket and cached for the process lifetime.
_bucket_region_cache: dict[tuple[str, str], str] = {}
_bucket_region_lock = threading.Lock()


def _get_bucket_region(account_id: str, region: str, role_name: str, bucket: str) -> str:
    cache_key = (account_id, bucket)
    with _bucket_region_lock:
        cached = _bucket_region_cache.get(cache_key)
        if cached:
            return cached
    client = aws_client.get_client("s3", account_id, region, role_name)
    resp = client.get_bucket_location(Bucket=bucket)
    location = resp.get("LocationConstraint") or "us-east-1"
    if location == "EU":  # historical quirk for some old eu-west-1 buckets
        location = "eu-west-1"
    with _bucket_region_lock:
        _bucket_region_cache[cache_key] = location
    return location


def list_buckets(account_id: str, region: str, role_name: str) -> list[dict]:
    client = aws_client.get_client("s3", account_id, region, role_name)
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
    role_name: str,
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
    - Filename search: a recursive (no Delimiter) listing under `prefix`,
      filtered client-side by substring match against each object's
      basename, capped at MAX_SEARCH_PAGES pages of the underlying listing
      per request so a search over a huge bucket can't run away; page
      further with the returned continuation_token for more matches.
    """
    bucket_region = _get_bucket_region(account_id, region, role_name, bucket)
    client = aws_client.get_client("s3", account_id, bucket_region, role_name)

    folders: list[dict] = []
    files: list[dict] = []
    next_token: Optional[str] = None

    if search.strip():
        term = search.strip().lower()
        kwargs = {"Bucket": bucket, "Prefix": prefix, "MaxKeys": 1000}
        if continuation_token:
            kwargs["ContinuationToken"] = continuation_token
        pages_scanned = 0
        while len(files) < max_results and pages_scanned < MAX_SEARCH_PAGES:
            resp = client.list_objects_v2(**kwargs)
            pages_scanned += 1
            for obj in resp.get("Contents", []):
                key = obj["Key"]
                if key.endswith("/") and obj.get("Size", 0) == 0:
                    continue  # a folder placeholder object, not a real file
                if term in key.rsplit("/", 1)[-1].lower():
                    files.append(_file_info(obj))
                    if len(files) >= max_results:
                        break
            next_token = resp.get("NextContinuationToken") if resp.get("IsTruncated") else None
            if not next_token:
                break
            kwargs["ContinuationToken"] = next_token
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
    }
