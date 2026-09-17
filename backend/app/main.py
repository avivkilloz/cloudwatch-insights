from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import bootstrap, models
from .db import Base, SessionLocal, engine, ensure_columns
from .routers import (
    ai,
    auth,
    buckets,
    cognito,
    environments,
    iot,
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
ensure_columns()

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
app.include_router(iot.router)
app.include_router(tables.router)
app.include_router(buckets.router)
app.include_router(cognito.router)
app.include_router(ai.router)
app.include_router(tools.router)


@app.get("/api/health")
def health():
    return {"status": "ok"}
