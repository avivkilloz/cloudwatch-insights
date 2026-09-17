from urllib.parse import parse_qs, urlsplit

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
