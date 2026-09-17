from urllib.parse import parse_qs, urlsplit

import httpx

from app import iot_mqtt_signer


def test_build_presigned_ws_url_produces_a_valid_sigv4_query_url(monkeypatch):
    monkeypatch.setattr(
        iot_mqtt_signer.iot_client,
        "get_iot_data_endpoint",
        lambda account_id, region, role_name: "abc123-ats.iot.us-east-1.amazonaws.com",
    )
    monkeypatch.setattr(
        iot_mqtt_signer.aws_client,
        "get_credentials",
        lambda account_id, role_name: {"access_key": "AKIA...", "secret_key": "secret", "session_token": "token"},
    )

    result = iot_mqtt_signer.build_presigned_ws_url("111122223333", "us-east-1", "OpsRole")

    assert result["endpoint"] == "abc123-ats.iot.us-east-1.amazonaws.com"
    assert result["url"].startswith("wss://abc123-ats.iot.us-east-1.amazonaws.com/mqtt?")

    parts = urlsplit(result["url"])
    qs = parse_qs(parts.query)
    assert qs["X-Amz-Algorithm"][0] == "AWS4-HMAC-SHA256"
    assert qs["X-Amz-SignedHeaders"][0] == "host"
    assert "iotdevicegateway" in qs["X-Amz-Credential"][0]
    assert qs["X-Amz-Security-Token"][0] == "token"
    assert qs["X-Amz-Expires"][0] == str(iot_mqtt_signer.DEFAULT_EXPIRES_SECONDS)
    assert "X-Amz-Signature" in qs


def test_build_presigned_ws_url_respects_custom_expiry(monkeypatch):
    monkeypatch.setattr(
        iot_mqtt_signer.iot_client, "get_iot_data_endpoint", lambda account_id, region, role_name: "x.iot.eu-west-1.amazonaws.com"
    )
    monkeypatch.setattr(
        iot_mqtt_signer.aws_client,
        "get_credentials",
        lambda account_id, role_name: {"access_key": "AKIA...", "secret_key": "secret", "session_token": "token"},
    )

    result = iot_mqtt_signer.build_presigned_ws_url("111122223333", "eu-west-1", "OpsRole", expires=60)

    qs = parse_qs(urlsplit(result["url"]).query)
    assert qs["X-Amz-Expires"][0] == "60"


class _FakeProbeResponse:
    def __init__(self, status_code, text=""):
        self.status_code = status_code
        self.text = text


def test_probe_presigned_url_swaps_wss_for_https_and_reports_status(monkeypatch):
    captured = {}

    def fake_get(url, timeout):
        captured["url"] = url
        captured["timeout"] = timeout
        return _FakeProbeResponse(403, '{"message":"Forbidden"}')

    monkeypatch.setattr(iot_mqtt_signer.httpx, "get", fake_get)

    result = iot_mqtt_signer.probe_presigned_url("wss://abc123-ats.iot.us-east-1.amazonaws.com/mqtt?X-Amz-Signature=x")

    assert captured["url"] == "https://abc123-ats.iot.us-east-1.amazonaws.com/mqtt?X-Amz-Signature=x"
    assert result == {"status_code": 403, "body": '{"message":"Forbidden"}'}


def test_probe_presigned_url_caps_body_length(monkeypatch):
    huge_body = "x" * 5000
    monkeypatch.setattr(iot_mqtt_signer.httpx, "get", lambda url, timeout: _FakeProbeResponse(400, huge_body))

    result = iot_mqtt_signer.probe_presigned_url("wss://example.com/mqtt?a=b")

    assert result["status_code"] == 400
    assert len(result["body"]) == iot_mqtt_signer.MAX_PROBE_BODY_CHARS


def test_probe_presigned_url_reports_network_errors_without_raising(monkeypatch):
    def fake_get(url, timeout):
        raise httpx.ConnectTimeout("timed out")

    monkeypatch.setattr(iot_mqtt_signer.httpx, "get", fake_get)

    result = iot_mqtt_signer.probe_presigned_url("wss://example.com/mqtt?a=b")

    assert result["status_code"] is None
    assert "timed out" in result["body"]
