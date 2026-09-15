import os
from urllib.parse import quote_plus

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base


def _build_database_url() -> str:
    url = os.environ.get("DATABASE_URL")
    if url:
        return url

    host = os.environ.get("POSTGRES_HOST")
    if not host:
        raise RuntimeError(
            "No database configured. Set DATABASE_URL (a full SQLAlchemy URL), "
            "or POSTGRES_HOST plus optionally POSTGRES_PORT/POSTGRES_DB/"
            "POSTGRES_USER/POSTGRES_PASSWORD/POSTGRES_SSLMODE."
        )
    port = os.environ.get("POSTGRES_PORT", "5432")
    name = os.environ.get("POSTGRES_DB", "cloudwatch_insights")
    user = os.environ.get("POSTGRES_USER", "cloudwatch_insights")
    password = os.environ.get("POSTGRES_PASSWORD", "")

    auth = quote_plus(user)
    if password:
        auth += f":{quote_plus(password)}"

    url = f"postgresql+psycopg2://{auth}@{host}:{port}/{name}"
    sslmode = os.environ.get("POSTGRES_SSLMODE")
    if sslmode:
        url += f"?sslmode={sslmode}"
    return url


DATABASE_URL = _build_database_url()

# pool_pre_ping avoids handing out connections the server has since dropped
# (idle timeouts, restarts) -- common with a managed/external Postgres.
engine = create_engine(DATABASE_URL, pool_pre_ping=True)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
