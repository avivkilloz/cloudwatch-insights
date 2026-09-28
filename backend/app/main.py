import contextlib

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from starlette.routing import Route

from . import bootstrap, models
from .db import Base, SessionLocal, engine, ensure_columns
from .platform_tools import server as platform_server
from .routers import (
    agent,
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
    session_categories,
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

# The agent flag starts off for every group (see UserGroup.agent_enabled), but
# the Admin group -- which can turn it on for anyone -- has it from the start.
if "user_groups.agent_enabled" in _added_columns:
    with engine.begin() as _conn:
        _conn.execute(text("UPDATE user_groups SET agent_enabled = true WHERE is_admin"))

_bootstrap_db = SessionLocal()
try:
    bootstrap.ensure_admin_exists(_bootstrap_db)
finally:
    _bootstrap_db.close()



@contextlib.asynccontextmanager
async def lifespan(_app: FastAPI):
    # The MCP endpoint's session manager lives as long as the app does.
    async with platform_server.endpoint.lifespan():
        yield


app = FastAPI(title="CloudWatch Insights (Multi-Account)", lifespan=lifespan)

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
app.include_router(session_categories.router)
app.include_router(live_sessions.router)
app.include_router(iot.router)
app.include_router(tables.router)
app.include_router(buckets.router)
app.include_router(cognito.router)
app.include_router(agent.router)
app.include_router(tools.router)


@app.get("/api/health")
def health():
    return {"status": "ok"}


# The platform agent's tools (platform_tools/server.py). Outside /api on
# purpose: the frontend's nginx only proxies /api, so this is reachable inside
# the cluster (where the agent runs) and not from the browser's side at all.
# Both spellings, because a mounted sub-app would answer only one of them and
# redirect the other, and an MCP client doesn't follow a redirected POST.
app.router.routes.append(Route("/mcp", endpoint=platform_server.endpoint))
app.router.routes.append(Route("/mcp/", endpoint=platform_server.endpoint))
