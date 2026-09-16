from app.dynamodb_client import _decode_key, _encode_key, _from_dynamo_item, _plain, _to_dynamo_value


def test_plain_converts_integral_decimal_to_int():
    from decimal import Decimal

    assert _plain(Decimal("42")) == 42
    assert isinstance(_plain(Decimal("42")), int)


def test_plain_converts_fractional_decimal_to_float():
    from decimal import Decimal

    assert _plain(Decimal("3.5")) == 3.5
    assert isinstance(_plain(Decimal("3.5")), float)


def test_plain_converts_set_to_sorted_list():
    assert _plain({3, 1, 2}) == [1, 2, 3]


def test_plain_recurses_into_nested_structures():
    from decimal import Decimal

    assert _plain({"a": [Decimal("1"), {"b": Decimal("2.5")}]}) == {"a": [1, {"b": 2.5}]}


def test_from_dynamo_item_deserializes_low_level_attribute_values():
    item = {"id": {"S": "abc"}, "count": {"N": "5"}}
    assert _from_dynamo_item(item) == {"id": "abc", "count": 5}


def test_to_dynamo_value_prefers_int_then_float_then_string():
    assert _to_dynamo_value("42") == {"N": "42"}
    assert _to_dynamo_value("3.5") == {"N": "3.5"}
    assert _to_dynamo_value("abc") == {"S": "abc"}


def test_encode_decode_key_round_trips():
    key = {"id": {"S": "abc"}, "sort": {"N": "5"}}
    token = _encode_key(key)
    assert isinstance(token, str)
    assert _decode_key(token) == key


def test_encode_decode_key_handles_none():
    assert _encode_key(None) is None
    assert _decode_key(None) is None
