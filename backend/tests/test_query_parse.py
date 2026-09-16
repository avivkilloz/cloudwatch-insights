from app.query_parse import parse_field_filters


def test_parse_field_filters_extracts_multiple_fields():
    filters = parse_field_filters("status:ACTIVE region:us-east-1")
    assert filters == {"status": "ACTIVE", "region": "us-east-1"}


def test_parse_field_filters_lowercases_field_names():
    filters = parse_field_filters("Email:john@example.com")
    assert filters == {"email": "john@example.com"}


def test_parse_field_filters_ignores_tokens_without_colon():
    filters = parse_field_filters("status:ACTIVE freetext")
    assert filters == {"status": "ACTIVE"}


def test_parse_field_filters_empty_string():
    assert parse_field_filters("") == {}
