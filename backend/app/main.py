from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from . import bootstrap, models
from .db import Base, SessionLocal, engine, ensure_columns
from .routers import (
    ai,
    auth,
    buckets,
    cognito,
    environments,
    iot,
    live_sessions,
    log_groups,
    opensearch,
    queries,
    saved_queries,
    saved_sessions,
    settings,
    tables,
    tools,
    user_groups,
    users,
)

Base.metadata.create_all(bind=engine)
_added_columns = ensure_columns()

# CloudWatch and OpenSearch used to share one flag, so a database written
# before the split says nothing about OpenSearch on its own. Its column
# defaults to true for brand-new groups, which would hand OpenSearch to every
# group that had logs turned off -- so on the upgrade that adds it, it starts
# out saying exactly what logs_enabled said.
if "user_groups.opensearch_enabled" in _added_columns:
    with engine.begin() as _conn:
        _conn.execute(text("UPDATE user_groups SET opensearch_enabled = logs_enabled"))

_bootstrap_db = SessionLocal()
try:
    bootstrap.ensure_admin_exists(_bootstrap_db)
finally:
    _bootstrap_db.close()

app = FastAPI(title="CloudWatch Insights (Multi-Account)")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(users.router)
app.include_router(user_groups.router)
app.include_router(environments.router)
app.include_router(settings.router)
app.include_router(log_groups.router)
app.include_router(queries.router)
app.include_router(opensearch.router)
app.include_router(saved_queries.router)
app.include_router(saved_sessions.router)
app.include_router(live_sessions.router)
app.include_router(iot.router)
app.include_router(tables.router)
app.include_router(buckets.router)
app.include_router(cognito.router)
app.include_router(ai.router)
app.include_router(tools.router)


@app.get("/api/health")
def health():
    return {"status": "ok"}
