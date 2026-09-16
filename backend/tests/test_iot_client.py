import io
import json

from app import aws_client, iot_client
from app.iot_client import _cert_summary, _extract_latest_timestamp, _list_shadows_for_thing, _parse_simple_query


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


class _FakeControlClient:
    """Mimics the real `iot` control-plane client's API surface: it has
    describe_endpoint but, crucially, NOT list_named_shadows_for_thing --
    that operation only exists on the iot-data client. A fake with an
    unconditional list_named_shadows_for_thing would hide this exact bug."""

    def describe_endpoint(self, endpointType):
        return {"endpointAddress": "abc123.iot.us-east-1.amazonaws.com"}


class _FakeDataClient:
    """Mimics the real `iot-data` client's API surface."""

    class exceptions:
        class ResourceNotFoundException(Exception):
            pass

    def __init__(self, named_shadows):
        self._named_shadows = named_shadows

    def list_named_shadows_for_thing(self, thingName, nextToken=None):
        return {"results": self._named_shadows}

    def get_thing_shadow(self, thingName, shadowName=None):
        payload = {
            "state": {"reported": {"x": 1}, "desired": {}},
            "metadata": {"reported": {"x": {"timestamp": 1700000000}}},
            "version": 1,
        }
        return {"payload": io.BytesIO(json.dumps(payload).encode())}


def test_list_shadows_for_thing_uses_data_plane_client_for_listing(monkeypatch):
    """Regression test: ListNamedShadowsForThing is a data-plane (iot-data)
    operation, not a control-plane (iot) one. Calling it on the control
    client raises AttributeError ("'IoT' object has no attribute
    'list_named_shadows_for_thing'") and silently drops every named shadow."""
    data_client = _FakeDataClient(named_shadows=["config", "sensor"])

    def fake_get_client(service, account_id, region, role_name):
        assert service == "iot"
        return _FakeControlClient()

    def fake_get_client_with_endpoint(service, account_id, region, role_name, endpoint_url):
        assert service == "iot-data"
        return data_client

    monkeypatch.setattr(aws_client, "get_client", fake_get_client)
    monkeypatch.setattr(aws_client, "get_client_with_endpoint", fake_get_client_with_endpoint)
    iot_client._endpoint_cache.clear()

    shadows, warnings = _list_shadows_for_thing("111122223333", "us-east-1", "SomeRole", "my-thing")

    assert warnings == []
    shadow_names = {s["name"] for s in shadows}
    assert shadow_names == {"(classic)", "config", "sensor"}
