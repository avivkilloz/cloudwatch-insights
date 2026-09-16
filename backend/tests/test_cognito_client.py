from datetime import datetime, timezone

from app.cognito_client import _build_filter, _user_summary


def test_build_filter_formats_starts_with_expression():
    assert _build_filter("email", "john") == 'email ^= "john"'


def test_build_filter_escapes_double_quotes_in_value():
    assert _build_filter("email", 'jo"hn') == 'email ^= "jo\\"hn"'


def test_build_filter_escapes_backslashes_in_value():
    assert _build_filter("email", "jo\\hn") == 'email ^= "jo\\\\hn"'


def test_user_summary_flattens_attributes_list_to_dict():
    dt = datetime(2024, 1, 1, tzinfo=timezone.utc)
    user = {
        "Username": "jdoe",
        "UserStatus": "CONFIRMED",
        "Enabled": True,
        "UserCreateDate": dt,
        "UserLastModifiedDate": dt,
        "Attributes": [{"Name": "email", "Value": "jdoe@example.com"}, {"Name": "sub", "Value": "abc-123"}],
    }
    summary = _user_summary(user)
    assert summary["username"] == "jdoe"
    assert summary["status"] == "CONFIRMED"
    assert summary["enabled"] is True
    assert summary["created"] == int(dt.timestamp())
    assert summary["attributes"] == {"email": "jdoe@example.com", "sub": "abc-123"}


def test_user_summary_handles_missing_attributes():
    user = {"Username": "jdoe"}
    summary = _user_summary(user)
    assert summary["attributes"] == {}
    assert summary["created"] is None
