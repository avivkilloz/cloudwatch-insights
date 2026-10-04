"""Envelope encryption for stored secrets (PLATFORM_PLAN.md §13.4).

Each secret gets its own random data key (DEK); the data is encrypted with
it, and the DEK is wrapped by a master key (KEK) that lives outside the
database -- a Kubernetes Secret, read from the environment. A database dump
on its own therefore reveals nothing, and rotating the master key re-wraps
the DEKs (a few bytes each) without re-encrypting a single secret.

The master keys are a keyring, so a rotation can be in progress:

    PLATFORM_MASTER_KEYS="k2:<base64 of 32 bytes>,k1:<base64 of 32 bytes>"
    PLATFORM_MASTER_KEY_ID="k2"     # the one new writes use

Both are read on every call rather than once at import, so a test (or an
operator restarting with a new keyring) is never looking at a stale copy.
No keyring at all is not an error -- the rest of the platform works without
credentials -- but a keyring that is malformed, or that doesn't hold the key
a secret was wrapped with, is: those fail loudly, never as "no secrets".
"""

import base64
import binascii
import os
from dataclasses import dataclass
from typing import Optional

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

KEYS_ENV = "PLATFORM_MASTER_KEYS"
CURRENT_ENV = "PLATFORM_MASTER_KEY_ID"
NONCE_BYTES = 12
KEY_BYTES = 32


class KeyringError(Exception):
    """The keyring is configured but can't be used as configured."""


class DecryptError(Exception):
    """A secret couldn't be decrypted: the master key doesn't match, or the
    stored bytes were altered or moved to another row."""


@dataclass(frozen=True)
class Keyring:
    keys: dict[str, bytes]
    current: str


@dataclass(frozen=True)
class Sealed:
    ciphertext: bytes
    nonce: bytes
    wrapped_dek: bytes
    kek_id: str


def load_keyring() -> Optional[Keyring]:
    """The configured keyring, or None if none is configured."""
    raw = os.environ.get(KEYS_ENV, "").strip()
    if not raw:
        return None
    keys: dict[str, bytes] = {}
    for entry in raw.split(","):
        entry = entry.strip()
        if not entry:
            continue
        key_id, sep, encoded = entry.partition(":")
        key_id = key_id.strip()
        if not sep or not key_id:
            raise KeyringError(f"{KEYS_ENV} entries must look like 'id:base64key'; '{key_id or entry[:8]}…' doesn't.")
        try:
            key = base64.b64decode(encoded.strip(), validate=True)
        except (binascii.Error, ValueError):
            raise KeyringError(f"Master key '{key_id}' in {KEYS_ENV} isn't valid base64.") from None
        if len(key) != KEY_BYTES:
            raise KeyringError(f"Master key '{key_id}' must be {KEY_BYTES} bytes; it is {len(key)}.")
        if key_id in keys:
            raise KeyringError(f"Master key id '{key_id}' appears twice in {KEYS_ENV}.")
        keys[key_id] = key
    if not keys:
        return None
    current = os.environ.get(CURRENT_ENV, "").strip() or next(iter(keys))
    if current not in keys:
        raise KeyringError(f"{CURRENT_ENV} is '{current}', which isn't one of the keys in {KEYS_ENV}.")
    return Keyring(keys=keys, current=current)


def generate_key() -> str:
    """A new master key, base64-encoded, for an operator to store."""
    return base64.b64encode(AESGCM.generate_key(bit_length=256)).decode()


def _wrap_aad(kek_id: str) -> bytes:
    return b"platform-dek:" + kek_id.encode()


def _kek(keyring: Keyring, kek_id: str) -> bytes:
    key = keyring.keys.get(kek_id)
    if key is None:
        raise DecryptError(
            f"This secret was encrypted with master key '{kek_id}', which isn't in {KEYS_ENV}. "
            "Add it back to the keyring (see DEPLOYMENT.md)."
        )
    return key


def seal(plaintext: bytes, aad: bytes, keyring: Keyring) -> Sealed:
    """Encrypts `plaintext` under a fresh data key, bound to `aad`, and wraps
    the data key with the keyring's current master key."""
    dek = AESGCM.generate_key(bit_length=256)
    nonce = os.urandom(NONCE_BYTES)
    ciphertext = AESGCM(dek).encrypt(nonce, plaintext, aad)
    return Sealed(ciphertext=ciphertext, nonce=nonce, wrapped_dek=_wrap(dek, keyring, keyring.current), kek_id=keyring.current)


def _wrap(dek: bytes, keyring: Keyring, kek_id: str) -> bytes:
    wrap_nonce = os.urandom(NONCE_BYTES)
    return wrap_nonce + AESGCM(_kek(keyring, kek_id)).encrypt(wrap_nonce, dek, _wrap_aad(kek_id))


def _unwrap(wrapped_dek: bytes, kek_id: str, keyring: Keyring) -> bytes:
    try:
        return AESGCM(_kek(keyring, kek_id)).decrypt(wrapped_dek[:NONCE_BYTES], wrapped_dek[NONCE_BYTES:], _wrap_aad(kek_id))
    except InvalidTag:
        raise DecryptError(
            f"Master key '{kek_id}' doesn't match the one this secret was encrypted with. "
            "The keyring may hold a different key under the same id (see DEPLOYMENT.md)."
        ) from None


def open_sealed(sealed: Sealed, aad: bytes, keyring: Keyring) -> bytes:
    dek = _unwrap(sealed.wrapped_dek, sealed.kek_id, keyring)
    try:
        return AESGCM(dek).decrypt(sealed.nonce, sealed.ciphertext, aad)
    except InvalidTag:
        raise DecryptError("This secret's stored bytes don't belong to it (altered, or copied from another row).") from None


def rewrap(wrapped_dek: bytes, from_kek: str, keyring: Keyring, to_kek: Optional[str] = None) -> tuple[bytes, str]:
    """The same data key, wrapped by another master key -- a rotation step."""
    target = to_kek or keyring.current
    return _wrap(_unwrap(wrapped_dek, from_kek, keyring), keyring, target), target
