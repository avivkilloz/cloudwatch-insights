import os
import tempfile

# Must run before any `app.*` module is imported (they build the SQLAlchemy
# engine at import time). CI provides its own DATABASE_URL pointing at the
# Postgres service container; local runs fall back to a local test database
# (see README for how to start one).
os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+psycopg2://postgres:postgres@localhost:5432/cloudwatch_insights_test",
)
# A fixed, known admin password for every test run -- see _clean_database
# below, which logs `client` into this account before each test.
os.environ.setdefault("ADMIN_PASSWORD", "test-admin-password")
os.environ.setdefault("COOKIE_SECURE", "false")
# The blob store (D91) on a directory of the run's own, never /data/files.
os.environ.setdefault("STORAGE_PATH", tempfile.mkdtemp(prefix="cwi-blobs-"))

import pytest
from fastapi.testclient import TestClient

from app import bootstrap, catalogue, connections, credential_types, models, pane_access
from app.db import Base, SessionLocal, engine
from app.main import app

ADMIN_USERNAME = "admin"
ADMIN_PASSWORD = os.environ["ADMIN_PASSWORD"]
# Most AWS-calling endpoints need *some* AWS identity to resolve via the
# caller's group -- set on the Admin group here so individual tests don't
# each have to configure one just to get past resolve_identity().
TEST_ROLE_NAME = "TestRole"

# A single TestClient, shared by every test file (`from tests.conftest
# import client`) -- httpx's TestClient persists cookies across requests on
# the same instance, and _clean_database logs it in fresh before each test,
# so every test runs as the admin user against a freshly reset database.
client = TestClient(app)


@pytest.fixture(autouse=True)
def _clean_database():
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)

    db = SessionLocal()
    try:
        bootstrap.ensure_admin_exists(db)
        admin_group = db.query(models.UserGroup).filter(models.UserGroup.is_admin.is_(True)).first()
        admin_group.role_name = TEST_ROLE_NAME
        db.commit()
        credential_types.ensure_builtins(db)
        connections.ensure_builtins(db)
        connections.ensure_manifest_types(db)
        # The role becomes the Admin group's default AWS identity, the way
        # the startup migration does it for a real database (§14.5).
        connections.migrate_legacy(db)
        # As at startup: from here on, groups' pane access is grants (D65).
        pane_access.migrate(db)
        catalogue.ensure_categories(db)
    finally:
        db.close()

    login_resp = client.post("/api/auth/login", json={"username": ADMIN_USERNAME, "password": ADMIN_PASSWORD})
    assert login_resp.status_code == 200, login_resp.text

    yield


class _SendReply:
    """The HTTP client's Send through its action (`http.send`), answered the
    way the retired `/api/tools/http-request` was: the response itself on
    success, the error's detail otherwise -- so the tests written against
    that route still say what they meant."""

    def __init__(self, resp):
        self._resp = resp
        self.status_code = resp.status_code
        self.text = resp.text

    def json(self):
        body = self._resp.json()
        return body["response"] if isinstance(body, dict) and "response" in body else body


def send_http(c, payload: dict) -> _SendReply:
    inputs = {
        "method": payload.get("method", "GET"),
        "url": payload.get("url", ""),
        "body": payload.get("body"),
        "headerRows": [{"id": i + 1, **h} for i, h in enumerate(payload.get("headers") or [])],
        "credentialId": payload.get("credential_id"),
        "targetId": payload.get("target_id"),
    }
    return _SendReply(c.post("/api/panes/tool-http/actions/send", json={"inputs": inputs}))
