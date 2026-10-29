import asyncio
import contextlib
import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from starlette.routing import Route

from . import (
    bootstrap,
    builder,
    catalogue,
    connections,
    credential_store,
    credential_types,
    masking,
    models,
    store,
    workflows,
)
from .db import Base, SessionLocal, engine, ensure_columns
from .panes import runs as pane_runs
from .panes import saved as pane_saved
from .platform_tools import server as platform_server
from .routers import (
    access_tokens as access_tokens_router,
    screen as screen_router,
    agent,
    blobs as blobs_router,
    build_drafts as build_drafts_router,
    build_members as build_members_router,
    builder as builder_router,
    auth,
    catalogue as catalogue_router,
    credentials,
    environments,
    live_sessions,
    panes,
    runner as runner_router,
    saved_inputs,
    saved_sessions,
    session_categories,
    settings,
    store as store_router,
    tools,
    user_groups,
    users,
    templates as templates_router,
    workflows as workflows_router,
)

Base.metadata.create_all(bind=engine)
_added_columns = ensure_columns()

# The agent flag starts off for every group (see UserGroup.agent_enabled), but
# the Admin group -- which can turn it on for anyone -- has it from the start.
if "user_groups.agent_enabled" in _added_columns:
    with engine.begin() as _conn:
        _conn.execute(text("UPDATE user_groups SET agent_enabled = true WHERE is_admin"))

# Who may change what's built is a person now, not a group (D161): what was
# there is its maker's. A connection type kept no maker, so it is admins'
# until one hands it on.
for _table in ("built_pane_types", "built_step_types", "workflows", "credential_types"):
    if f"{_table}.owner_id" in _added_columns:
        with engine.begin() as _conn:
            _conn.execute(text(f"UPDATE {_table} SET owner_id = created_by_id"))

# One draft per thing built, shared by everyone who may change it (D161), in
# place of one per person: the newest of each is kept, the others' chats
# folded into it. Only while the old per-person index is there, so once.
with engine.begin() as _conn:
    if _conn.execute(text("SELECT 1 FROM pg_indexes WHERE indexname = 'uq_build_drafts_target'")).first():
        from .build_drafts import fold_duplicates

        fold_duplicates(_conn)
        _conn.execute(text("DROP INDEX uq_build_drafts_target"))
    _conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS uq_build_drafts_item ON build_drafts (kind, target_id) "
                       "WHERE target_id IS NOT NULL"))

# Pane types and workflows were granted to groups (D65, D84); every one is
# everyone's now (D160), so the grants go. Harmless to repeat.
with engine.begin() as _conn:
    _conn.execute(text("DROP TABLE IF EXISTS group_pane_grants"))
    _conn.execute(text("DROP TABLE IF EXISTS workflow_grants"))

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

# Pane types built here (§24), beside the bundled manifests -- after the store,
# which may have just brought some back.
_bootstrap_db = SessionLocal()
try:
    builder.load(_bootstrap_db)
finally:
    _bootstrap_db.close()


@contextlib.asynccontextmanager
async def lifespan(_app: FastAPI):
    # The MCP endpoint's session manager lives as long as the app does, and so
    # does this replica's driver of background runs (D51), whose sweeper
    # picks up runs a replica that went away was polling.
    async with platform_server.endpoint.lifespan():
        pane_runs.manager.start()
        store.manager.start()
        workflows.manager.start()
        # Another replica's save of a built pane type, seen here within seconds.
        built = asyncio.create_task(builder.manager())
        try:
            yield
        finally:
            built.cancel()
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
app.include_router(templates_router.router)
app.include_router(builder_router.router)
app.include_router(build_drafts_router.router)
app.include_router(build_members_router.router)
app.include_router(runner_router.router)
app.include_router(workflows_router.router)
app.include_router(workflows_router.runs_router)
app.include_router(workflows_router.approvals_router)
app.include_router(blobs_router.router)
app.include_router(access_tokens_router.router)
app.include_router(screen_router.router)


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
# And under /api for MCP clients outside the cluster -- Claude Code on a
# user's machine, with a personal access token (D156) -- since /api is all
# the frontend's nginx and the ingress pass on. Only personal tokens there.
app.router.routes.append(Route("/api/mcp", endpoint=platform_server.endpoint))
app.router.routes.append(Route("/api/mcp/", endpoint=platform_server.endpoint))
