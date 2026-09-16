import json
from typing import Optional
from urllib.parse import quote, urlencode

import httpx
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from botocore.credentials import Credentials

from . import aws_client

# AWS OpenSearch Service (formerly Elasticsearch Service) has no query API in
# boto3 -- only domain management (list/describe domains). The actual search
# traffic goes straight to the domain's own REST endpoint, authenticated with
# a SigV4-signed request using the same assumed-role credentials as every
# other AWS call in this app. This only works for a domain whose access
# policy grants that role and whose endpoint is reachable from this process
# (a public endpoint, or one on a network this backend can already reach).

REQUEST_TIMEOUT_SECONDS = 30.0
SIGNING_SERVICE = "es"

# Indices OpenSearch/Elasticsearch itself creates and manages (dashboards
# config, security config, etc.) -- never useful as a log search target.
_HIDDEN_INDEX_PREFIXES = (".",)

# Cap how much of an error response body gets echoed back -- AWS error
# bodies are normally small JSON, but this guards against something
# unexpected (e.g. a proxy's HTML error page) blowing up the error message.
MAX_ERROR_BODY_CHARS = 2000


class OpenSearchRequestError(Exception):
    """Raised when a signed request to a domain's REST endpoint fails.

    A 403 here almost always comes from something other than "IAM
    permissions are missing on the caller's own policy" -- resp.text carries
    AWS's actual reason (e.g. the domain's access policy doesn't mention
    this role, or fine-grained access control is enabled and the role isn't
    mapped to an internal OpenSearch role), which a bare HTTP status line
    doesn't, so it's included here rather than just raise_for_status()'s
    generic "403 Forbidden for url ...".
    """


def _request(
    account_id: str, region: str, role_name: str, method: str, url: str, body: Optional[dict] = None
) -> dict:
    creds = aws_client.get_credentials(account_id, role_name)
    credentials = Credentials(creds["access_key"], creds["secret_key"], creds["session_token"])

    # The exact same serialized payload must be used for both the signature
    # and the actual request body -- SigV4 signs a hash of the payload.
    payload = json.dumps(body) if body is not None else None
    headers = {"Content-Type": "application/json"} if payload is not None else {}
    aws_request = AWSRequest(method=method, url=url, data=payload, headers=headers)
    SigV4Auth(credentials, SIGNING_SERVICE, region).add_auth(aws_request)

    resp = httpx.request(
        method, url, headers=dict(aws_request.headers), content=payload, timeout=REQUEST_TIMEOUT_SECONDS
    )
    if resp.is_error:
        detail = resp.text.strip()[:MAX_ERROR_BODY_CHARS]
        raise OpenSearchRequestError(
            f"{resp.status_code} {resp.reason_phrase} for {url}" + (f" -- {detail}" if detail else "")
        )
    return resp.json()


def list_domains(account_id: str, region: str, role_name: str) -> list[dict]:
    client = aws_client.get_client("opensearch", account_id, region, role_name)
    names_resp = client.list_domain_names()
    domain_names = [d["DomainName"] for d in names_resp.get("DomainNames", [])]
    if not domain_names:
        return []

    domains = []
    desc_resp = client.describe_domains(DomainNames=domain_names)
    for d in desc_resp.get("DomainStatusList", []):
        endpoint = d.get("Endpoint")
        if not endpoint:
            # A VPC-only domain reports its endpoint(s) under "Endpoints"
            # instead of the single "Endpoint" field.
            endpoints = d.get("Endpoints") or {}
            endpoint = next(iter(endpoints.values()), None)
        domains.append(
            {
                "domain_name": d["DomainName"],
                "endpoint": endpoint,
                "engine_version": d.get("EngineVersion"),
            }
        )
    return domains


def list_indices(account_id: str, region: str, role_name: str, domain_endpoint: str) -> list[dict]:
    # SigV4Auth signs a query string it reads verbatim off the URL -- unlike
    # the request path, it does NOT re-percent-encode it, so reserved
    # characters (the commas in `h=`) must already be escaped here. Otherwise
    # the client signs the raw, under-encoded text while the receiving
    # service canonicalizes (and verifies against) the properly-escaped
    # form, and the two signatures never match ("SignatureDoesNotMatch").
    query = urlencode({"format": "json", "h": "index,docs.count,store.size"}, quote_via=quote)
    url = f"https://{domain_endpoint}/_cat/indices?{query}"
    data = _request(account_id, region, role_name, "GET", url)
    indices = []
    for entry in data:
        name = entry.get("index", "")
        if name.startswith(_HIDDEN_INDEX_PREFIXES):
            continue
        docs_count = entry.get("docs.count")
        indices.append(
            {
                "index": name,
                "docs_count": int(docs_count) if docs_count not in (None, "") else None,
                "store_size": entry.get("store.size"),
            }
        )
    return sorted(indices, key=lambda i: i["index"])


def search(
    account_id: str,
    region: str,
    role_name: str,
    domain_endpoint: str,
    indices: list[str],
    query_string: str,
    start_time: int,
    end_time: int,
    timestamp_field: str = "@timestamp",
    limit: int = 100,
) -> dict:
    index_path = ",".join(indices)
    url = f"https://{domain_endpoint}/{index_path}/_search"

    must: list[dict] = []
    if query_string.strip():
        must.append({"query_string": {"query": query_string}})
    must.append(
        {
            "range": {
                timestamp_field: {
                    "gte": start_time * 1000,
                    "lte": end_time * 1000,
                    "format": "epoch_millis",
                }
            }
        }
    )
    body = {
        "query": {"bool": {"must": must}},
        "sort": [{timestamp_field: {"order": "desc", "unmapped_type": "date"}}],
        "size": limit,
    }
    data = _request(account_id, region, role_name, "POST", url, body)

    total = data.get("hits", {}).get("total")
    total_count = total.get("value") if isinstance(total, dict) else total
    return {
        "hits": data.get("hits", {}).get("hits", []),
        "total": total_count,
    }
