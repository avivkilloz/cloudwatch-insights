import os

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

import pytest
from fastapi.testclient import TestClient

from app import bootstrap, models
from app.db import Base, SessionLocal, engine
from app.main import app

ADMIN_USERNAME = "admin"
ADMIN_PASSWORD = os.environ["ADMIN_PASSWORD"]
# Most AWS-calling endpoints need *some* role name to resolve via the
# caller's group -- set on the Admin group here so individual tests don't
# each have to configure one just to get past resolve_role_name().
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
    finally:
        db.close()

    login_resp = client.post("/api/auth/login", json={"username": ADMIN_USERNAME, "password": ADMIN_PASSWORD})
    assert login_resp.status_code == 200, login_resp.text

    yield
