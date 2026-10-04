"""Master-key housekeeping, run by an operator (DEPLOYMENT.md):

    python -m app.keys generate          # a new key to add to PLATFORM_MASTER_KEYS
    python -m app.keys check             # every credential decrypts with the keyring
    python -m app.keys rotate [--to ID]  # re-wrap every data key under ID (default: current)

A rotation commits in batches and only touches credentials not yet on the
target key, so it can be interrupted and run again. Drop the old key from the
keyring only after `check` passes with it gone.
"""

import argparse
import sys

from . import credential_store, crypto, models
from .db import SessionLocal


def _check(db) -> int:
    ring = credential_store.keyring()
    bad = 0
    for cred in db.query(models.Credential).filter(models.Credential.wrapped_dek.isnot(None)).all():
        try:
            credential_store._open(cred, ring)
        except credential_store.CredentialError as e:
            bad += 1
            print(f"FAIL  {cred.id} {cred.name}: {e}", file=sys.stderr)
    return bad


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.keys")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("generate", help="print a new random master key (base64)")
    commands.add_parser("check", help="verify every stored credential decrypts with the keyring")
    rotate = commands.add_parser("rotate", help="re-wrap every credential's data key under one master key")
    rotate.add_argument("--to", help="the key id to re-wrap under (default: PLATFORM_MASTER_KEY_ID)")
    args = parser.parse_args(argv)

    if args.command == "generate":
        print(crypto.generate_key())
        return 0
    db = SessionLocal()
    try:
        if args.command == "check":
            bad = _check(db)
            print("All credentials decrypt." if not bad else f"{bad} credential(s) don't decrypt.")
            return 1 if bad else 0
        ring = credential_store.keyring()
        done = credential_store.rewrap_all(db, ring, args.to)
        print(f"Re-wrapped {done} credential(s) under '{args.to or ring.current}'.")
        return 0
    except (credential_store.CredentialsOff, credential_store.CredentialError) as e:
        print(str(e), file=sys.stderr)
        return 2
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
