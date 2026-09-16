from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import models
from .db import Base, engine, ensure_columns
from .routers import (
    ai,
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
)

Base.metadata.create_all(bind=engine)
ensure_columns()

app = FastAPI(title="CloudWatch Insights (Multi-Account)")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

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


@app.get("/api/health")
def health():
    return {"status": "ok"}
