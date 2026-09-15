import os

# Must run before any `app.*` module is imported (they build the SQLAlchemy
# engine at import time). CI provides its own DATABASE_URL pointing at the
# Postgres service container; local runs fall back to a local test database
# (see README for how to start one).
os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+psycopg2://postgres:postgres@localhost:5432/cloudwatch_insights_test",
)

import pytest

from app.db import Base, engine


@pytest.fixture(autouse=True)
def _clean_database():
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    yield
