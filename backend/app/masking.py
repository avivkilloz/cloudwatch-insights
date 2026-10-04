"""Keeps decrypted secrets out of logs and error messages.

Whatever `credential_store.resolve()` decrypts is registered here for the
rest of the request (a context variable, so one request's secrets never mask
-- or leak into -- another's). Every log record is then masked as it is
created, and callers pass any text that may echo a secret (a test's error,
an HTTP response) through `mask()` before it leaves the process.
"""

import contextvars
import logging
from typing import Any, Iterable

MASK = "****"
# Shorter values would mask ordinary words ("on", "yes") all over a log line,
# and aren't secrets worth the name anyway.
MIN_LENGTH = 4

_registered: contextvars.ContextVar[frozenset[str]] = contextvars.ContextVar("masked_secrets", default=frozenset())


def _strings(value: Any) -> Iterable[str]:
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for v in value.values():
            yield from _strings(v)
    elif isinstance(value, (list, tuple)):
        for v in value:
            yield from _strings(v)


def register(values: Any) -> None:
    """Marks every string inside `values` (nested dicts and lists included)
    as a secret for the rest of this request."""
    found = {s for s in _strings(values) if len(s) >= MIN_LENGTH}
    if found:
        _registered.set(_registered.get() | found)


def mask(text: str) -> str:
    secrets = _registered.get()
    if not secrets or not text:
        return text
    # Longest first, so a secret that contains another is masked whole.
    for secret in sorted(secrets, key=len, reverse=True):
        if secret in text:
            text = text.replace(secret, MASK)
    return text


def reset() -> None:
    _registered.set(frozenset())


_previous_factory = logging.getLogRecordFactory()


def _masking_factory(*args: Any, **kwargs: Any) -> logging.LogRecord:
    record = _previous_factory(*args, **kwargs)
    if _registered.get():
        message = record.getMessage()
        masked = mask(message)
        if masked != message:
            record.msg, record.args = masked, None
    return record


def install() -> None:
    """Masks every log record, from every logger, as it is created. A filter
    on a handler would miss handlers added later (uvicorn adds its own)."""
    if logging.getLogRecordFactory() is not _masking_factory:
        logging.setLogRecordFactory(_masking_factory)
