import os
from urllib.parse import quote_plus

from sqlalchemy import create_engine, inspect, text
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


def ensure_columns():
    """Lightweight, additive schema-evolution helper: this project has no
    migration framework, and Base.metadata.create_all() only creates
    missing TABLES -- a column added to an existing model never reaches a
    database that already has that table without this. Only adds columns
    that are safe to backfill on existing rows (nullable, or carrying a
    server_default); anything else is skipped rather than risking a failed
    ALTER TABLE on a table that already has rows.
    """
    inspector = inspect(engine)
    existing_tables = set(inspector.get_table_names())
    with engine.begin() as conn:
        for table in Base.metadata.sorted_tables:
            if table.name not in existing_tables:
                continue  # brand new table -- create_all already made it with every column
            existing_columns = {c["name"] for c in inspector.get_columns(table.name)}
            for column in table.columns:
                if column.name in existing_columns:
                    continue
                if not column.nullable and column.server_default is None:
                    continue
                ddl_type = column.type.compile(dialect=engine.dialect)
                clause = f'ALTER TABLE "{table.name}" ADD COLUMN "{column.name}" {ddl_type}'
                if column.server_default is not None:
                    default_arg = column.server_default.arg
                    if hasattr(default_arg, "text"):
                        # an explicit text()/SQL-expression default -- already raw SQL
                        default_sql = default_arg.text
                    else:
                        # a plain Python value (SQLAlchemy's own server_default
                        # convention): quote it as a SQL string literal ourselves,
                        # the same way SQLAlchemy's own DDL compiler would.
                        default_sql = "'" + str(default_arg).replace("'", "''") + "'"
                    clause += f" DEFAULT {default_sql}"
                if not column.nullable:
                    clause += " NOT NULL"
                conn.execute(text(clause))
