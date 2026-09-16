import json

import pytest

from app import opensearch_client


class _FakeCatIndicesResponse:
    def __init__(self, payload, status_code=200, text=""):
        self._payload = payload
        self.status_code = status_code
        self.is_error = status_code >= 400
        self.reason_phrase = "Forbidden" if status_code == 403 else "Error"
        self.text = text

    def json(self):
        return self._payload


def _fake_credentials(account_id, role_name):
    return {"access_key": "AKIA...", "secret_key": "secret", "session_token": "token"}


def test_request_signs_with_same_payload_used_for_the_body(monkeypatch):
    monkeypatch.setattr(opensearch_client.aws_client, "get_credentials", _fake_credentials)

    captured = {}

    def fake_httpx_request(method, url, headers, content, timeout):
        captured["method"] = method
        captured["url"] = url
        captured["headers"] = headers
        captured["content"] = content
        return _FakeCatIndicesResponse({"ok": True})

    monkeypatch.setattr(opensearch_client.httpx, "request", fake_httpx_request)

    body = {"query": {"match_all": {}}}
    result = opensearch_client._request(
        "111122223333", "us-east-1", "OpsRole", "POST", "https://search-x.us-east-1.es.amazonaws.com/i/_search", body
    )

    assert result == {"ok": True}
    assert captured["method"] == "POST"
    # The signed request and the actual HTTP call must carry byte-identical
    # payloads -- SigV4 signs a hash of the body, so any divergence would
    # make the signature invalid.
    assert captured["content"] == json.dumps(body)
    assert "Authorization" in captured["headers"]


def test_request_with_no_body_sends_none_content(monkeypatch):
    monkeypatch.setattr(opensearch_client.aws_client, "get_credentials", _fake_credentials)

    captured = {}

    def fake_httpx_request(method, url, headers, content, timeout):
        captured["content"] = content
        return _FakeCatIndicesResponse([])

    monkeypatch.setattr(opensearch_client.httpx, "request", fake_httpx_request)

    opensearch_client._request(
        "111122223333", "us-east-1", "OpsRole", "GET", "https://search-x.us-east-1.es.amazonaws.com/_cat/indices"
    )

    assert captured["content"] is None


def test_list_indices_filters_hidden_indices_and_sorts(monkeypatch):
    monkeypatch.setattr(opensearch_client.aws_client, "get_credentials", _fake_credentials)

    def fake_httpx_request(method, url, headers, content, timeout):
        return _FakeCatIndicesResponse(
            [
                {"index": "app-logs-2024.03", "docs.count": "1500", "store.size": "2.1mb"},
                {"index": ".kibana_1", "docs.count": "3", "store.size": "10kb"},
                {"index": "app-logs-2024.01", "docs.count": "900", "store.size": "1.2mb"},
                {"index": ".opensearch-observability", "docs.count": "0", "store.size": "208b"},
            ]
        )

    monkeypatch.setattr(opensearch_client.httpx, "request", fake_httpx_request)

    indices = opensearch_client.list_indices("111122223333", "us-east-1", "OpsRole", "search-x.us-east-1.es.amazonaws.com")

    assert [i["index"] for i in indices] == ["app-logs-2024.01", "app-logs-2024.03"]
    assert indices[0]["docs_count"] == 900
    assert indices[1]["store_size"] == "2.1mb"


def test_list_indices_percent_encodes_commas_in_the_query_string(monkeypatch):
    # SigV4Auth signs the query string as literal text off the URL (unlike
    # the path, it does not re-percent-encode it), so an unescaped comma
    # here gets signed as-is while AWS's own canonicalization of what it
    # actually received escapes it -- a mismatch that surfaces as a 403
    # "SignatureDoesNotMatch". The URL we actually send must already carry
    # the escaped form.
    monkeypatch.setattr(opensearch_client.aws_client, "get_credentials", _fake_credentials)
    captured = {}

    def fake_httpx_request(method, url, headers, content, timeout):
        captured["url"] = url
        return _FakeCatIndicesResponse([])

    monkeypatch.setattr(opensearch_client.httpx, "request", fake_httpx_request)

    opensearch_client.list_indices("111122223333", "us-east-1", "OpsRole", "search-x.us-east-1.es.amazonaws.com")

    assert captured["url"] == (
        "https://search-x.us-east-1.es.amazonaws.com/_cat/indices"
        "?format=json&h=index%2Cdocs.count%2Cstore.size"
    )


def test_list_indices_handles_missing_docs_count(monkeypatch):
    monkeypatch.setattr(opensearch_client.aws_client, "get_credentials", _fake_credentials)
    monkeypatch.setattr(
        opensearch_client.httpx,
        "request",
        lambda method, url, headers, content, timeout: _FakeCatIndicesResponse(
            [{"index": "empty-index", "docs.count": "", "store.size": None}]
        ),
    )

    indices = opensearch_client.list_indices("111122223333", "us-east-1", "OpsRole", "search-x.us-east-1.es.amazonaws.com")
    assert indices[0]["docs_count"] is None


def test_search_builds_query_string_and_time_range_filter(monkeypatch):
    monkeypatch.setattr(opensearch_client.aws_client, "get_credentials", _fake_credentials)

    captured = {}

    def fake_httpx_request(method, url, headers, content, timeout):
        captured["url"] = url
        captured["body"] = json.loads(content)
        return _FakeCatIndicesResponse(
            {"hits": {"total": {"value": 2}, "hits": [{"_index": "app-logs", "_id": "1", "_source": {"a": 1}}]}}
        )

    monkeypatch.setattr(opensearch_client.httpx, "request", fake_httpx_request)

    result = opensearch_client.search(
        "111122223333",
        "us-east-1",
        "OpsRole",
        "search-x.us-east-1.es.amazonaws.com",
        ["app-logs", "other-logs"],
        "level:ERROR",
        1700000000,
        1700003600,
        timestamp_field="@timestamp",
        limit=50,
    )

    assert captured["url"] == "https://search-x.us-east-1.es.amazonaws.com/app-logs,other-logs/_search"
    body = captured["body"]
    assert body["size"] == 50
    assert body["sort"] == [{"@timestamp": {"order": "desc", "unmapped_type": "date"}}]
    must_clauses = body["query"]["bool"]["must"]
    assert {"query_string": {"query": "level:ERROR"}} in must_clauses
    range_clause = next(c["range"]["@timestamp"] for c in must_clauses if "range" in c)
    assert range_clause == {"gte": 1700000000000, "lte": 1700003600000, "format": "epoch_millis"}

    assert result["total"] == 2
    assert result["hits"][0]["_id"] == "1"


def test_search_omits_query_string_clause_when_blank(monkeypatch):
    monkeypatch.setattr(opensearch_client.aws_client, "get_credentials", _fake_credentials)

    captured = {}

    def fake_httpx_request(method, url, headers, content, timeout):
        captured["body"] = json.loads(content)
        return _FakeCatIndicesResponse({"hits": {"total": 0, "hits": []}})

    monkeypatch.setattr(opensearch_client.httpx, "request", fake_httpx_request)

    result = opensearch_client.search(
        "111122223333", "us-east-1", "OpsRole", "search-x.us-east-1.es.amazonaws.com", ["app-logs"], "  ", 0, 3600
    )

    must_clauses = captured["body"]["query"]["bool"]["must"]
    assert all("query_string" not in c for c in must_clauses)
    assert result["total"] == 0
    assert result["hits"] == []


def test_request_surfaces_response_body_on_error(monkeypatch):
    # A bare "403 Forbidden" tells a user nothing actionable -- AWS's actual
    # reason (missing access-policy entry, fine-grained access control
    # blocking the role, etc.) lives in the response body, so it must be
    # included rather than swallowed like requests.raise_for_status() would.
    monkeypatch.setattr(opensearch_client.aws_client, "get_credentials", _fake_credentials)
    error_body = '{"Message":"User: arn:aws:sts::111122223333:assumed-role/OpsRole/x is not authorized"}'

    def fake_httpx_request(method, url, headers, content, timeout):
        return _FakeCatIndicesResponse(None, status_code=403, text=error_body)

    monkeypatch.setattr(opensearch_client.httpx, "request", fake_httpx_request)

    with pytest.raises(opensearch_client.OpenSearchRequestError) as exc_info:
        opensearch_client.list_indices("111122223333", "us-east-1", "OpsRole", "search-x.us-east-1.es.amazonaws.com")

    message = str(exc_info.value)
    assert "403" in message
    assert error_body in message


def test_request_caps_error_body_length(monkeypatch):
    monkeypatch.setattr(opensearch_client.aws_client, "get_credentials", _fake_credentials)
    huge_body = "x" * 10000

    monkeypatch.setattr(
        opensearch_client.httpx,
        "request",
        lambda method, url, headers, content, timeout: _FakeCatIndicesResponse(None, status_code=500, text=huge_body),
    )

    with pytest.raises(opensearch_client.OpenSearchRequestError) as exc_info:
        opensearch_client.list_indices("111122223333", "us-east-1", "OpsRole", "search-x.us-east-1.es.amazonaws.com")

    assert len(str(exc_info.value)) < len(huge_body)
