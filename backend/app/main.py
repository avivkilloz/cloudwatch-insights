from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import models
from .db import Base, engine
from .routers import environments, log_groups, queries, saved_queries, settings

Base.metadata.create_all(bind=engine)

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
app.include_router(saved_queries.router)


@app.get("/api/health")
def health():
    return {"status": "ok"}
