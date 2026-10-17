import contextlib
import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from starlette.routing import Route

from . import bootstrap, catalogue, connections, credential_store, credential_types, masking, models, pane_access, store, workflows
from .db import Base, SessionLocal, engine, ensure_columns
from .panes import runs as pane_runs
from .panes import saved as pane_saved
from .platform_tools import server as platform_server
from .routers import (
    agent,
    auth,
    catalogue as catalogue_router,
    credentials,
    environments,
    live_sessions,
    panes,
    saved_inputs,
    saved_sessions,
    session_categories,
    settings,
    store as store_router,
    tools,
    user_groups,
    users,
    workflows as workflows_router,
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

# An environment is no longer an AWS account and region itself (its
# connections are), so those two columns stop being required. Kept for one
# release so a rollback has them; harmless to repeat on every start.
with engine.begin() as _conn:
    _conn.execute(text("ALTER TABLE environments ALTER COLUMN account_id DROP NOT NULL"))
    _conn.execute(text("ALTER TABLE environments ALTER COLUMN region DROP NOT NULL"))

_bootstrap_db = SessionLocal()
try:
    bootstrap.ensure_admin_exists(_bootstrap_db)
    credential_types.ensure_builtins(_bootstrap_db)
    connections.ensure_builtins(_bootstrap_db)
    # The connection types panes ship, the first time each is missing (D67).
    connections.ensure_manifest_types(_bootstrap_db)
    # Once per database: environments become AWS connections with their own
    # ids, group roles become group identities (PLATFORM_PLAN.md §14.5).
    for _line in connections.migrate_legacy(_bootstrap_db):
        logging.getLogger("connections").warning("Migrated %s", _line)
    # Once per database: the per-page booleans become grants per pane type (D65).
    for _line in pane_access.migrate(_bootstrap_db):
        logging.getLogger("pane_access").warning("Migrated %s", _line)
    # The categories the panes suggest, the first time each is suggested (D66).
    catalogue.ensure_categories(_bootstrap_db)
    # Once per database: the per-pane saved stores become saved inputs (D46).
    for _line in pane_saved.migrate_saved_shortcuts(_bootstrap_db):
        logging.getLogger("saved_inputs").warning("Migrated %s", _line)
finally:
    _bootstrap_db.close()

# Whatever a request decrypts is masked in every log line it writes after.
masking.install()

_bootstrap_db = SessionLocal()
try:
    for _line in credential_store.startup_check(_bootstrap_db):
        logging.getLogger("credentials").warning(_line)
finally:
    _bootstrap_db.close()

# What the store repo holds and this database lacks comes back, and what is
# pending goes out (D70, §21.6). After the built-ins and the manifests' types,
# so a type a manifest seeded is overwritten by the repo's edited copy. A repo
# that can't be reached is logged; the platform starts anyway.
store.startup()


@contextlib.asynccontextmanager
async def lifespan(_app: FastAPI):
    # The MCP endpoint's session manager lives as long as the app does, and so
    # does this replica's driver of background runs (D51), whose sweeper
    # picks up runs a replica that went away was polling.
    async with platform_server.endpoint.lifespan():
        pane_runs.manager.start()
        store.manager.start()
        workflows.manager.start()
        try:
            yield
        finally:
            await workflows.manager.stop()
            await store.manager.stop()
            await pane_runs.manager.stop()


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
app.include_router(environments.connections_router)
app.include_router(environments.types_router)
app.include_router(environments.targets_router)
app.include_router(panes.router)
app.include_router(credentials.types_router)
app.include_router(credentials.router)
app.include_router(credentials.audit_router)
app.include_router(settings.router)
app.include_router(saved_sessions.router)
app.include_router(session_categories.router)
app.include_router(live_sessions.router)
app.include_router(agent.router)
app.include_router(tools.router)
app.include_router(saved_inputs.router)
app.include_router(catalogue_router.router)
app.include_router(store_router.router)
app.include_router(workflows_router.router)
app.include_router(workflows_router.runs_router)


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
