from app.iot_client import _cert_summary, _extract_latest_timestamp, _parse_simple_query


def test_parse_simple_query_extracts_known_filters():
    filters = _parse_simple_query("status:ACTIVE certid:abc123 stray text")
    assert filters["status"] == "ACTIVE"
    assert filters["certid"] == "abc123"
    assert filters["_text"] == "stray text"


def test_parse_simple_query_freetext_only():
    filters = _parse_simple_query("my-cert-prefix")
    assert filters.get("status") is None
    assert filters.get("certid") is None
    assert filters["_text"] == "my-cert-prefix"


def test_parse_simple_query_empty():
    filters = _parse_simple_query("")
    assert filters["_text"] == ""


def test_extract_latest_timestamp_picks_max_across_nested_metadata():
    metadata = {
        "reported": {
            "temp": {"timestamp": 100},
            "nested": {"fan": {"timestamp": 300}},
        },
        "desired": {
            "temp": {"timestamp": 200},
        },
    }
    assert _extract_latest_timestamp(metadata) == 300


def test_extract_latest_timestamp_handles_empty():
    assert _extract_latest_timestamp({}) is None


def test_cert_summary_prefers_own_id_over_fallback():
    summary = _cert_summary({"certificateId": "real-id", "status": "ACTIVE"}, fallback_id="fallback-id")
    assert summary["certificate_id"] == "real-id"
    assert summary["status"] == "ACTIVE"


def test_cert_summary_uses_fallback_when_id_missing():
    summary = _cert_summary({"status": "ACTIVE"}, fallback_id="fallback-id")
    assert summary["certificate_id"] == "fallback-id"
