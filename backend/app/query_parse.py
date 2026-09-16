def parse_field_filters(query_string: str) -> dict[str, str]:
    """Parse `field:value field2:value2` tokens into a dict, case-insensitive
    on field names. Tokens without a ':' are ignored -- every filter here
    must name the field it applies to, since (unlike the IoT search boxes)
    there's no single free-text attribute to fall back to for these
    resources. Shared by the DynamoDB, S3, and Cognito search endpoints."""
    filters: dict[str, str] = {}
    for tok in query_string.split():
        if ":" in tok:
            key, _, value = tok.partition(":")
            key = key.strip().lower()
            if key:
                filters[key] = value
    return filters
