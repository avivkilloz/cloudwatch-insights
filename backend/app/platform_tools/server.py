"""The MCP server the platform agent calls, mounted at /mcp.

Every call carries the per-turn token the backend minted for the user who
asked (see `tokens`); the middleware below refuses anything else before MCP
sees it, and each tool acts as that user. Tools fall into three groups:

- *Looking around:* the user's environments and the pane kinds their group
  allows (`get_context`), their open sessions, and the names a pane's inputs
  need (log groups, domains, tables, buckets, user pools).
- *Shaping a session:* create one, add, remove and rename panes, pick the
  layout, arrange a dashboard, fill in a pane's inputs, set its description
  or file it into a side-panel category.
- *Running a pane* -- read-only searches only. The run happens here, and its
  results land in the pane's own result keys.

Each change is one versioned, announced write (`live_store.mutate`), so the
user's open panes follow the agent as it works. Anything that would reach
outside the platform (sending an HTTP request, publishing to MQTT) is not
here: it waits for the approval step.

The endpoint is stateless (each POST stands alone, no MCP session to keep),
so it works the same whichever backend replica a call reaches.
"""

import asyncio
import contextlib
import contextvars
import datetime
import json
from typing import Any, Literal, Optional
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp.exceptions import ToolError
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
from mcp.server.transport_security import TransportSecuritySettings
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from starlette.types import Receive, Scope, Send

from .. import catalogue, connections, credential_store, live_store, models, pane_outputs, schemas, templates
from ..db import SessionLocal
from ..live_store import StoreError, tag_set, untag
from ..panes import manifest as pane_manifest
from ..panes import runs as pane_runs
from ..panes import variables as pane_variables
from . import tokens
from .panes import (
    _visible_environment,
    chart_spec,
    KINDS,
    InputError,
    PaneKind,
    RunContext,
    _call,
    _summary,
    agent_value,
    available_kinds,
    convert,
    input_key,
    kind_for,
    output_key,
    pane_values,
)

# Every write the agent makes is announced with this origin, so a browser can
# tell the agent's changes from another tab's (and show them as the agent's).
ORIGIN = "agent"

LAYOUTS = ("tabs", "columns", "stacked", "dashboard")
Layout = Literal["tabs", "columns", "stacked", "dashboard"]

# Where the browser puts a dashboard's panes is in pixels of a canvas only it
# can measure, so the agent says where in grid terms and the browser works out
# the pixels (AggregatorPage, `dashboardPlan`).
DASHBOARD_COLUMNS = 12

INSTRUCTIONS = """\
Tools for working in the user's platform workspace, as that user. A workspace \
holds sessions; a session holds panes (a CloudWatch query, an S3 browser, a \
Base64 tool...) arranged as tabs, columns, stacked, or a free dashboard. The \
user sees every change you make in their open panes as you make it.

Start with get_context: it lists the environments (each an AWS account + \
region, called "Prod", or "Prod · iot" where one environment holds several) and \
the pane kinds you may use, with each kind's inputs. Put results where the \
user can see them: create a session (or add panes to the one they are \
viewing), set a pane's inputs, and run it. A run's rows go into the pane; you \
get a sample back to answer from."""

mcp = FastMCP(
    "platform",
    instructions=INSTRUCTIONS,
    stateless_http=True,
    json_response=True,
    # This app owns the transport (see McpEndpoint); FastMCP only supplies the
    # tools. DNS-rebinding protection is for unauthenticated local servers a
    # web page could reach -- every call here needs a bearer token no browser
    # ever holds, and the Host a cluster uses is not a fixed list.
    transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
)

_caller: contextvars.ContextVar[Optional[tokens.Caller]] = contextvars.ContextVar("platform_caller", default=None)


@contextlib.contextmanager
def _acting():
    """The database session and user a tool acts with."""
    caller = _caller.get()
    if caller is None:  # the middleware lets nothing through without one
        raise ToolError("Not authorised.")
    db = SessionLocal()
    try:
        user = db.get(models.User, caller.user_id)
        if user is None:
            raise ToolError("Not authorised.")
        yield db, user, caller
    except (InputError, StoreError) as e:
        db.rollback()
        raise ToolError(str(e)) from None
    finally:
        db.close()


# ---------------------------------------------------------------- reading


def _environments(db, user) -> list[dict]:
    """The AWS connections the user can reach, as pane inputs name them:
    `id` is the connection's (an environment's first AWS connection kept
    the environment's own id, D34), `name` is "Prod", or "Prod · iot" where
    an environment holds several (D32)."""
    return connections.targets(db, user, connections.AWS)


def _full(db: Session, row: Optional[models.LiveSession]) -> dict:
    """The session's state with its panes' outputs back under `<pane>.out.`,
    as the agent's readers have always read them -- outputs live in their
    own records now (D21, §18.2)."""
    if row is None:
        return {}
    state = dict(row.state or {})
    for pane, record in pane_outputs.read(db, row).items():
        for key, value in (record.get("values") or {}).items():
            state[f"{pane}.out.{key}"] = value
    return state


def _pane_ids(state: dict) -> list[str]:
    return list(state.get("services") or [])


def _pane_type(state: dict, pane_id: str) -> str:
    return (state.get("paneTypes") or {}).get(pane_id, pane_id)


def _label(type_: str) -> str:
    kind = KINDS.get(type_)
    return kind.label if kind else type_


def _pane_title(state: dict, pane_id: str) -> str:
    return (state.get("paneTitles") or {}).get(pane_id) or _label(_pane_type(state, pane_id))


def _pane(state: dict, pane_id: str) -> str:
    if pane_id not in _pane_ids(state):
        panes = ", ".join(f"{p} ({_pane_title(state, p)})" for p in _pane_ids(state)) or "none"
        raise InputError(f"This session has no pane '{pane_id}'. Its panes are: {panes}.")
    return _pane_type(state, pane_id)


def _describe_pane(state: dict, pane_id: str, detail: bool) -> dict:
    type_ = _pane_type(state, pane_id)
    out: dict[str, Any] = {"pane_id": pane_id, "kind": type_, "title": _pane_title(state, pane_id)}
    kind = KINDS.get(type_)
    if kind is None:
        out["note"] = "The agent can't fill in or run this kind of pane."
    elif not kind.inputs:
        out["note"] = kind.run_help
    if not detail or kind is None or not kind.inputs:
        return out
    values = pane_values(state, pane_id)
    out["inputs"] = {i.key: agent_value(i, values[i.key]) for i in kind.inputs if i.key in values}
    run = _run_state(state, kind, pane_id)
    if run:
        out["run"] = run
    every = state.get(f"{pane_id}.refresh")
    if isinstance(every, (int, float)):
        out["refresh_every"] = int(every) or "off"
    on_open = state.get(f"{pane_id}.{SESSION_ON_OPEN_KEY}")
    if isinstance(on_open, (int, float)):
        out["refresh_on_open"] = f"if older than {int(on_open)} s" if on_open else "off"
    manifest = pane_manifest.get(type_)
    if manifest is not None:
        # Which inputs take their value from the session's variables (D60):
        # set one and the pane stops following, so it's said up front.
        follows = pane_variables.follows(state, pane_id, manifest)
        if follows:
            out["from_session"] = follows
        unlinked = pane_variables.unlinked(state, pane_id)
        if unlinked:
            out["unlinked_from"] = unlinked
    shown = state.get(f"{pane_id}.{PANE_INPUTS_KEY}")
    if shown in ("shown", "hidden"):
        out["inputs_shown"] = shown == "shown"
    said = _text_outputs(state, kind, pane_id)
    if said:
        out["outputs"] = said
    # What a run left there, as counts -- the rows themselves are for the
    # user to read in the pane; the agent gets its sample when it runs.
    counts = {
        k: len(v)
        for k, v in values.items()
        if isinstance(v, list) and kind.input(k) is None and not k.startswith("ai.") and k != "expanded"
    }
    if values.get("ranAt"):
        out["last_run"] = datetime.datetime.fromtimestamp(values["ranAt"] / 1000, datetime.timezone.utc).isoformat()
    if counts:
        out["results"] = counts
    return out


def _action_label(kind: PaneKind) -> str:
    manifest = pane_manifest.get(kind.type)
    main = manifest.main_action() if manifest else None
    return main.run_label if main is not None and isinstance(main.run_label, str) else "Run"


def _run_state(state: dict, kind: PaneKind, pane_id: str) -> Optional[dict]:
    """Whether the pane's run is going, for a pane that runs in the background
    (D51): a query still running, a connection open. Without it the agent had
    no way to tell -- it filled in the MQTT tester's topics, never connected,
    and told the user it was connected and listening, three times."""
    if not kind.background:
        return None
    run = untag(state.get(output_key(kind, pane_id, "run")))
    label = _action_label(kind)
    if not isinstance(run, dict) or not run.get("status"):
        return {"status": "not running", "note": f"Nothing is running: run_pane starts it ({label})."}
    out: dict[str, Any] = {"status": run["status"]}
    if isinstance(run.get("startedAt"), (int, float)):
        out["started"] = datetime.datetime.fromtimestamp(run["startedAt"] / 1000, datetime.timezone.utc).isoformat()
    for key, name in (("stoppedBy", "stopped_by"), ("note", "note"), ("error", "error")):
        if run.get(key):
            out[name] = run[key]
    if run["status"] != pane_runs.RUNNING:
        out.setdefault("note", f"Not running now: run_pane starts it again ({label}).")
    return out


# A pane's own sentences about itself -- "Connected to … as …", "Published 18
# bytes to …" -- are short; anything longer is results, which the agent gets
# from a run's sample instead.
TEXT_OUTPUT_CHARS = 300


def _text_outputs(state: dict, kind: PaneKind, pane_id: str) -> dict[str, str]:
    if not kind.v2:
        return {}
    prefix = f"{pane_id}.out."
    return {
        k[len(prefix):]: v if len(v) <= TEXT_OUTPUT_CHARS else v[:TEXT_OUTPUT_CHARS] + "…"
        for k, v in state.items()
        if k.startswith(prefix) and isinstance(v, str) and v.strip()
    }


def _membership(db: Session, row: models.LiveSession, user_id: int) -> Optional[models.SessionMember]:
    if row.user_id == user_id:
        return None
    return (
        db.query(models.SessionMember)
        .filter(models.SessionMember.session_id == row.id, models.SessionMember.user_id == user_id)
        .one_or_none()
    )


def _participants(db: Session, row: models.LiveSession) -> list[dict]:
    """Everyone who can reach this session -- the owner and every invited
    member -- so the agent can answer "who's on this session" the same way a
    person asking it could see for themselves in the session card's own
    Members section. Mirrors routers/live_sessions.py's own
    list_session_participants."""
    owner = db.get(models.User, row.user_id)
    out = [{"username": owner.username, "role": "owner"}] if owner else []
    members = db.query(models.SessionMember).filter(models.SessionMember.session_id == row.id).all()
    for m in members:
        user = db.get(models.User, m.user_id)
        if user is not None:
            out.append({"username": user.username, "role": m.permission})
    return out


def _describe_session(db: Session, row: models.LiveSession, user_id: int, detail: bool = False) -> dict:
    """Every field here is the *caller's own view* -- their own role,
    category and closed state if they're a member, never the owner's or
    another member's, even though `state` (panes, layout, description) is
    the one document every reachable caller sees alike."""
    state = _full(db, row)
    member = _membership(db, row, user_id)
    out: dict[str, Any] = {
        "session_id": row.client_id,
        "title": row.title,
        "layout": state.get("layout") or "tabs",
        "panes": [_describe_pane(state, p, detail) for p in _pane_ids(state)],
        # "owner", or the permission this caller was invited at -- a viewer
        # knows from this alone why a change tool just refused them.
        "role": "owner" if member is None else member.permission,
    }
    # What the session is for, in its owner's words (the browser's
    # SESSION_DESCRIPTION_KEY) -- the best clue the agent has to what a
    # request about "this session" is after.
    description = state.get("description")
    if isinstance(description, str) and description.strip():
        out["description"] = description
    category_id = row.category_id if member is None else member.category_id
    if category_id is not None:
        category = db.get(models.SessionCategory, category_id)
        if category is not None:
            out["category"] = category.name
    closed_at = row.closed_at if member is None else member.closed_at
    if closed_at is not None:
        out["closed"] = True
    # Only when it's actually shared -- otherwise every solo session would
    # carry a one-entry "just the owner" list nobody asked about.
    members_out = _participants(db, row)
    if len(members_out) > 1:
        out["members"] = members_out
    variables = pane_variables.defined(state)
    if variables:
        out["variables"] = _describe_variables(db, variables)
    if state.get(VIEW_MODE_KEY):
        out["view_mode"] = True
    if detail:
        out["active_pane"] = state.get("activePane")
        if state.get(SESSION_REFRESH_KEY):
            out["refresh_every"] = state[SESSION_REFRESH_KEY]
        if state.get(SESSION_ON_OPEN_KEY):
            out["refresh_on_open"] = f"if older than {int(state[SESSION_ON_OPEN_KEY])} s"
    return out


# The session's view mode (D61), and a pane's own override of it.
VIEW_MODE_KEY = "viewMode"
PANE_INPUTS_KEY = "inputs"


def _describe_variables(db: Session, variables: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    if pane_variables.ENVIRONMENT in variables:
        value = variables[pane_variables.ENVIRONMENT]
        connection = db.get(models.Connection, value) if isinstance(value, int) else None
        out["environment"] = {"id": value, "name": connections.label(connection) if connection else None}
    if pane_variables.TIME in variables and isinstance(variables[pane_variables.TIME], dict):
        out["time_range"] = variables[pane_variables.TIME]
    return out


@mcp.tool()
async def get_context() -> dict:
    """Who you are acting for, the time where they are, the environments they can reach, the pane kinds their group
    allows (with every input each kind takes), and the session they were looking at when they asked, if any. Call this
    first."""
    with _acting() as (db, user, caller):
        categories = catalogue.category_of(db)
        zone_name = caller.timezone or "UTC"
        now = datetime.datetime.now(datetime.timezone.utc)
        try:
            local = now.astimezone(ZoneInfo(zone_name))
        except Exception:  # noqa: BLE001 -- an unknown zone just means UTC
            zone_name, local = "UTC", now
        viewing = None
        if caller.viewing_session_id:
            row, member = live_store.reachable(db, user.id, caller.viewing_session_id)
            closed = (row.closed_at if member is None else member.closed_at) if row is not None else None
            if row is not None and closed is None:
                viewing = _describe_session(db, row, user.id)
        return {
            "user": user.username,
            "group": user.group.name if user.group else None,
            "timezone": zone_name,
            "local_time": local.strftime("%Y-%m-%dT%H:%M"),
            "environments": [
                {
                    "id": t["id"],
                    "name": t["label"],
                    "environment": t["environment"],
                    "connection": t["connection"],
                    "account_id": t["config"].get("account_id"),
                    "region": t["config"].get("region"),
                }
                for t in _environments(db, user)
            ],
            # Every HTTP connection (D67), for a pane's `connection` input of
            # its type -- the API table's HTTP APIs, a Prometheus pane's
            # Prometheus servers: names, types and base URLs, never an identity.
            "http_apis": [
                {"id": t["id"], "name": t["label"], "type": t["type_id"], "base_url": t["config"].get("base_url")}
                for t in connections.targets(db, user)
                if t["type_id"] != connections.AWS
            ],
            # Each with the catalogue category it's listed under (D66), so
            # "a tool for X" can be answered from what the person sees.
            "pane_kinds": [{**k.describe(), "category": categories.get(k.type)} for k in available_kinds(user)],
            # Names and types only, never a value: what a pane's credential
            # input can be set to.
            "credentials": [
                {"id": c.id, "name": c.name, "type": c.type.label, "authenticates": bool(c.type.inject)}
                for c in credential_store.visible(db, user).order_by(models.Credential.name).all()
            ],
            # Ready-made sessions (§23): open_template starts one for an environment.
            "templates": [
                {"id": t.id, "label": t.label, "description": t.description,
                 "needs_environment": templates.needs_environment(t.state or {})}
                for t in templates.visible(db, user)
            ],
            "layouts": list(LAYOUTS),
            "viewing_session": viewing,
        }


@mcp.tool()
async def list_sessions() -> dict:
    """The user's open sessions, in the order their panel shows them, with each one's panes -- their own, and any
    shared with them."""
    with _acting() as (db, user, caller):
        return {"sessions": [_describe_session(db, r, user.id) for r in live_store.reachable_sessions(db, user.id)]}


@mcp.tool()
async def get_session(session_id: str) -> dict:
    """One session in detail: its layout, and each pane's inputs and what its last run left (as counts). Reachable
    through a session shared with the caller as well as one they own."""
    with _acting() as (db, user, caller):
        row, _ = live_store.reachable(db, user.id, session_id)
        if row is None:
            raise InputError(f"There is no session with id '{session_id}'. list_sessions shows them.")
        return _describe_session(db, row, user.id, detail=True)


# What inspect_row hands back at most; a row with a huge value is cut down.
INSPECT_CHARS = 20_000


def _bounded(value: Any) -> Any:
    if len(json.dumps(value, default=str)) <= INSPECT_CHARS:
        return value
    if isinstance(value, dict):
        return {k: _bounded(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_bounded(v) for v in value[:50]]
    if isinstance(value, str):
        return value[:2000] + "…"
    return value


@mcp.tool()
async def inspect_row(session_id: str, pane_id: str, row: int) -> dict:
    """One row of a pane's last run in full, rather than the run's shortened sample -- and for some kinds more than
    the run fetched (get_context's pane_kinds say which, under inspect_row). `row` counts from 0 in the order the run's
    sample listed them. Look at one before writing a filter on data you haven't seen the shape of. Changes nothing."""
    with _acting() as (db, user, caller):
        found, _ = live_store.reachable(db, user.id, session_id)
        if found is None:
            raise InputError(f"There is no session with id '{session_id}'. list_sessions shows them.")
        kind = kind_for(user, _pane(found.state, pane_id))
        if kind.rows is None:
            raise InputError(f"{kind.label} panes have no rows to inspect.")
        values = pane_values(_full(db, found), pane_id)
        rows = kind.rows(values)
        if not rows:
            raise InputError("This pane has no results yet. Run it first.")
        if not 0 <= row < len(rows):
            raise InputError(f"There's no row {row}: the last run has rows 0 to {len(rows) - 1}.")
        picked = rows[row]
        if kind.detail is not None:
            # A second look-up acts as the caller, like a run: in a shared
            # session the row may be from an environment only its owner has.
            environment_id = picked.get("environment_id")
            if environment_id is not None and environment_id not in {t["id"] for t in _environments(db, user)}:
                raise InputError(
                    f"That row is from environment {environment_id}, which you can't reach, so it can't be looked "
                    "up for you."
                )
            picked = await kind.detail(RunContext(db=db, user=user, timezone=caller.timezone), values, picked)
        return {"session_id": session_id, "pane_id": pane_id, "row": row, "of": len(rows), "detail": _bounded(picked)}


# ---------------------------------------------------------------- names for inputs


@mcp.tool()
async def list_options(
    session_id: str,
    pane_id: str,
    input: str,
    inputs: Optional[dict[str, Any]] = None,
    parent: Optional[dict[str, Any]] = None,
    contains: str = "",
) -> dict:
    """The choices for a pane input whose options are loaded (get_context's pane_kinds mark them `options`): a
    DynamoDB pane's tables, an S3 pane's buckets, a CloudWatch pane's log groups per environment, an OpenSearch
    pane's domains per environment. Uses the pane's current inputs, with `inputs` (same keys as set_pane_inputs)
    used instead for this look-up only -- e.g. {"connection": 3} to list another environment's tables. A two-level
    picker (OpenSearch's indices) lists inside one first-level item with `parent`: {"connection": environment id,
    "domainEndpoint": the domain's endpoint}. `contains` keeps only choices whose text contains it. Changes
    nothing."""
    with _acting() as (db, user, caller):
        found, _ = live_store.reachable(db, user.id, session_id)
        if found is None:
            raise InputError(f"There is no session with id '{session_id}'. list_sessions shows them.")
        kind = kind_for(user, _pane(found.state, pane_id))
        manifest = pane_manifest.get(kind.type)
        spec = next((i for i in manifest.inputs if i.key == input), None) if manifest else None
        if spec is None or spec.options is None:
            loaded = ", ".join(i.key for i in (manifest.inputs if manifest else []) if i.options) or "none"
            raise InputError(f"{kind.label}'s {input} has no options to list. Its inputs with options: {loaded}.")
        rc = RunContext(db=db, user=user, timezone=caller.timezone)
        if parent is not None:
            if not spec.options.children:
                raise InputError(f"{kind.label}'s {input} has one level of choices: leave parent out.")
            action = next(a for a in manifest.actions if a.id == spec.options.children)
            values = dict(parent)
            if "connection" in values:
                values["connection"] = _visible_environment(rc, values["connection"])
        else:
            unknown = [k for k in inputs or {} if kind.input(k) is None]
            if unknown:
                raise InputError(f"{kind.label} has no input {', '.join(unknown)}.")
            values = {
                **pane_values(found.state, pane_id), **{k: _convert(kind, k, v, rc) for k, v in (inputs or {}).items()}
            }
            _check_reachable(db, user, kind, values)
            action = next(a for a in manifest.actions if a.id == spec.options.action)
        from ..routers import panes as panes_router

        try:
            listed = await asyncio.to_thread(panes_router.run_handler, db, user, manifest, action, values)
        except HTTPException as e:
            raise InputError(str(e.detail)) from None
        needle = contains.lower()

        def kept(items: list) -> list:
            return [i for i in items if needle in json.dumps(i, default=str).lower()] if needle else items

        if "groups" in listed:
            # A two-level picker's first level: its items per environment, each
            # with its own error, as the pane draws them.
            out = []
            for group in listed["groups"]:
                entry: dict[str, Any] = {
                    "environment_id": group.get("environment_id"),
                    "environment": group.get("environment_name"),
                }
                if group.get("error"):
                    entry["error"] = group["error"]
                items = kept(group.get("items") or [])
                # A big account has thousands; the model needs enough to choose from.
                entry["items"] = items[:200]
                if len(items) > 200:
                    entry["more"] = len(items) - 200
                out.append(entry)
            more = (
                {"next": f"list_options with parent lists inside one ({spec.options.children})"}
                if spec.options.children
                else {}
            )
            return {"input": input, "groups": out, **more}
        return {"input": input, "options": kept(listed.get("options") or [])}


# ---------------------------------------------------------------- shaping a session


class PaneSpec(BaseModel):
    kind: str = Field(description="A pane kind from get_context, e.g. logs-cloudwatch.")
    title: Optional[str] = Field(default=None, description="A name for the pane; defaults to its kind's label.")


def _add_pane(state: dict, kind: PaneKind, title: Optional[str]) -> str:
    """A new pane, named and numbered the way AggregatorPage.addPane does it,
    and shown -- which is what adding one means."""
    ids = _pane_ids(state)
    pane_id = kind.type
    n = 2
    while pane_id in ids:
        pane_id = f"{kind.type}~{n}"
        n += 1
    taken = [_pane_title(state, p) for p in ids]
    state["services"] = ids + [pane_id]
    state["paneTypes"] = {**(state.get("paneTypes") or {}), pane_id: kind.type}
    state["paneTitles"] = {
        **(state.get("paneTitles") or {}),
        pane_id: (title or "").strip() or live_store.next_title(kind.label, taken),
    }
    state["activePane"] = pane_id
    # A pane added to a session with variables takes them, as it does when
    # added by hand (D60).
    manifest = pane_manifest.get(kind.type)
    if manifest is not None:
        pane_variables.apply(state, pane_id, manifest)
    return pane_id


def _mutate(db: Session, user: models.User, caller: tokens.Caller, session_id: str, change, origin: str):
    """`live_store.mutate`, held to the session a session chat is about. Every
    tool that changes a session goes through here, so the limit is the
    server's, not the prompt's: asked in one session's chat, the model still
    sometimes wrote into another -- one not on screen, so the user saw an
    answer and nothing in their panes. Checked on the locked row (its id),
    not the client id, which is only unique per owner."""

    def scoped(state: dict, row: models.LiveSession, member: Optional[models.SessionMember]):
        if caller.session_scope_id is not None and row.id != caller.session_scope_id:
            raise InputError(_OUT_OF_SCOPE)
        return change(state, row, member)

    return live_store.mutate(db, user.id, session_id, scoped, origin)


_OUT_OF_SCOPE = (
    "This is one session's chat, so you can only change this session. To work in another session or make a new "
    "one, the user can ask in the Global tab."
)


@mcp.tool()
async def create_session(title: str, panes: list[PaneSpec], layout: Layout = "tabs") -> dict:
    """A new session in the user's workspace holding the given panes (several of one kind are fine), in the given
    layout. It appears in the user's panel at once. Returns its id and the ids of its panes."""
    with _acting() as (db, user, caller):
        if caller.session_scope_id is not None:
            raise InputError(_OUT_OF_SCOPE)
        state: dict[str, Any] = {"services": [], "paneTypes": {}, "paneTitles": {}, "layout": layout}
        pane_ids = [_add_pane(state, kind_for(user, p.kind), p.title) for p in panes]
        state["activePane"] = pane_ids[0] if pane_ids else None
        row = live_store.create(db, user.id, title, state, ORIGIN)
        return _describe_session(db, row, user.id) | {"pane_ids": pane_ids}


@mcp.tool()
async def add_pane(session_id: str, kind: str, title: Optional[str] = None) -> dict:
    """Adds an empty pane of a kind to a session and shows it. Returns the new pane's id. Works on a session shared
    with the caller as an editor, the same as one they own; a viewer can't (403)."""
    with _acting() as (db, user, caller):
        pane_kind = kind_for(user, kind)
        row, pane_id = _mutate(db, user, caller, session_id, lambda s, _r, _m: _add_pane(s, pane_kind, title), ORIGIN)
        return {"session_id": row.client_id, "pane_id": pane_id, "title": _pane_title(row.state, pane_id)}


def _remove_pane(state: dict, pane_id: str) -> None:
    """Everything about a pane goes, as AggregatorPage.closePane does it -- so a
    pane added later, even one reusing this id, starts empty."""
    _pane(state, pane_id)
    state["services"] = [p for p in _pane_ids(state) if p != pane_id]
    for key in ("paneTypes", "paneTitles", "dashboardRects"):
        if isinstance(state.get(key), dict):
            state[key] = {k: v for k, v in state[key].items() if k != pane_id}
    minimized = untag(state.get("minimized")) or []
    if pane_id in minimized:
        state["minimized"] = tag_set(m for m in minimized if m != pane_id)
    if state.get("activePane") == pane_id:
        state["activePane"] = None
    for key in [k for k in state if k.startswith(f"{pane_id}.")]:
        del state[key]


@mcp.tool()
async def remove_pane(session_id: str, pane_id: str) -> dict:
    """Removes a pane from a session, with its inputs and results."""
    with _acting() as (db, user, caller):
        row, _ = _mutate(db, user, caller, session_id, lambda s, _r, _m: _remove_pane(s, pane_id), ORIGIN)
        return _describe_session(db, row, user.id)


@mcp.tool()
async def rename(session_id: str, title: str, pane_id: Optional[str] = None) -> dict:
    """Renames a session, or with pane_id one of its panes. A session's own name is shared -- renaming one an editor
    was invited to renames it for its owner too, the same as editing anything else in it would."""
    title = title.strip()
    if not title:
        raise ToolError("A name can't be blank.")

    def change(state: dict, row: models.LiveSession, _member: Optional[models.SessionMember]) -> None:
        if pane_id is None:
            row.title = title[:200]
        else:
            _pane(state, pane_id)
            state["paneTitles"] = {**(state.get("paneTitles") or {}), pane_id: title[:200]}

    with _acting() as (db, user, caller):
        row, _ = _mutate(db, user, caller, session_id, change, ORIGIN)
        return _describe_session(db, row, user.id)


@mcp.tool()
async def set_description(session_id: str, description: str) -> dict:
    """Sets what a session is for (its card's Description field) -- blank clears it."""
    text = description.strip()

    def change(state: dict, _row: models.LiveSession, _member: Optional[models.SessionMember]) -> None:
        if text:
            state["description"] = text
        else:
            state.pop("description", None)

    with _acting() as (db, user, caller):
        row, _ = _mutate(db, user, caller, session_id, change, ORIGIN)
        return _describe_session(db, row, user.id)


@mcp.tool()
async def list_categories() -> dict:
    """The side panel's session categories (Slack-style groups a session can be filed into)."""
    with _acting() as (db, user, caller):
        rows = (
            db.query(models.SessionCategory)
            .filter(models.SessionCategory.user_id == user.id)
            .order_by(models.SessionCategory.position, models.SessionCategory.id)
            .all()
        )
        return {"categories": [c.name for c in rows]}


def _find_or_create_category(db: Session, user: models.User, name: str) -> models.SessionCategory:
    existing = (
        db.query(models.SessionCategory)
        .filter(models.SessionCategory.user_id == user.id, models.SessionCategory.name == name)
        .one_or_none()
    )
    if existing is not None:
        return existing
    position = db.query(models.SessionCategory).filter(models.SessionCategory.user_id == user.id).count()
    category = models.SessionCategory(user_id=user.id, name=name, position=position)
    db.add(category)
    try:
        db.flush()
    except IntegrityError:
        # Created by a concurrent call between the query above and this flush.
        db.rollback()
        existing = (
            db.query(models.SessionCategory)
            .filter(models.SessionCategory.user_id == user.id, models.SessionCategory.name == name)
            .one()
        )
        return existing
    return category


@mcp.tool()
async def set_category(session_id: str, category: Optional[str] = None) -> dict:
    """Files a session into a named side-panel category, creating it if it doesn't already exist (list_categories
    shows the existing ones). Omit category, or pass one that's blank, to take the session out of its category. On a
    session shared with the caller, this is *their own* category -- never the owner's, or another member's."""

    with _acting() as (db, user, caller):
        category_id = _find_or_create_category(db, user, category.strip()).id if category and category.strip() else None

        def change(_state: dict, row: models.LiveSession, member: Optional[models.SessionMember]) -> None:
            if member is None:
                row.category_id = category_id
            else:
                member.category_id = category_id

        row, _ = _mutate(db, user, caller, session_id, change, ORIGIN)
        return _describe_session(db, row, user.id)


@mcp.tool()
async def set_layout(session_id: str, layout: Layout, active_pane: Optional[str] = None) -> dict:
    """How a session's panes are arranged: tabs (one at a time; active_pane picks which), columns (side by side),
    stacked, or dashboard (free placement -- use arrange_dashboard to place them)."""

    def change(state: dict, _row, _member: Optional[models.SessionMember]) -> None:
        state["layout"] = layout
        if active_pane is not None:
            _pane(state, active_pane)
            state["activePane"] = active_pane

    with _acting() as (db, user, caller):
        row, _ = _mutate(db, user, caller, session_id, change, ORIGIN)
        return _describe_session(db, row, user.id)


class DashboardCell(BaseModel):
    pane_id: str
    width: int = Field(ge=1, le=DASHBOARD_COLUMNS, description="Columns wide, of 12 across the dashboard.")


class DashboardRow(BaseModel):
    height: int = Field(default=340, ge=160, le=2000, description="Row height in pixels (about 340 is a normal pane).")
    panes: list[DashboardCell]


# The intervals the browser's refresh picker offers (§18.3), in seconds.
REFRESH_CHOICES = (10, 30, 60, 300, 900, 3600)
SESSION_REFRESH_KEY = "refresh"
# Run once when someone opens the session, if the outputs are older than this
# many seconds (D77); 0 off, unset on a pane following the session's.
SESSION_ON_OPEN_KEY = "refreshOnOpen"


def _every(value: Any) -> int:
    """An interval as the agent may say it -- 0/"off", seconds, "30s", "5m",
    "1h" -- in seconds."""
    if value in (None, "", 0, "0", "off", "Off", False):
        return 0
    if isinstance(value, (int, float)):
        return int(value)
    text = str(value).strip().lower()
    units = {"s": 1, "m": 60, "h": 3600}
    try:
        return int(float(text[:-1]) * units[text[-1]]) if text[-1] in units else int(text)
    except (ValueError, IndexError):
        raise InputError(f"{value!r} isn't an interval: say off, or seconds, or like 30s, 5m, 1h.") from None


@mcp.tool()
async def set_refresh(
    session_id: str, every: Optional[str] = None, pane_id: Optional[str] = None, on_open: Optional[str] = None
) -> dict:
    """Makes panes run again by themselves while the session is open on someone's screen -- a live dashboard. `every`
    is off, or an interval like 30s, 1m, 5m, 1h. `on_open` runs a pane once when someone opens the session, if what
    it shows is older than the window given (off, or like 1m, 5m, 1h). With pane_id they are that pane's own;
    without, the session's default for every pane that hasn't its own. Only panes that can (get_context's
    refresh_floor says which, and how often at most) refresh; nothing runs now."""
    if every is None and on_open is None:
        raise InputError("Say every (an interval), on_open (a window), or both.")
    seconds = _every(every) if every is not None else None
    window = _every(on_open) if on_open is not None else None
    with _acting() as (db, user, caller):

        def change(state: dict, _row, _member: Optional[models.SessionMember]) -> None:
            if pane_id is None:
                if seconds and seconds < min(REFRESH_CHOICES):
                    raise InputError(f"The shortest interval is {min(REFRESH_CHOICES)} seconds.")
                if seconds is not None:
                    state[SESSION_REFRESH_KEY] = seconds
                if window is not None:
                    state[SESSION_ON_OPEN_KEY] = window
                return
            kind = kind_for(user, _pane(state, pane_id))
            floor = _refresh_floor(kind)
            if floor is None:
                raise InputError(f"{kind.label} panes don't refresh by themselves.")
            if seconds and seconds < floor:
                raise InputError(f"{kind.label} panes refresh at most every {floor} seconds.")
            if seconds is not None:
                state[f"{pane_id}.{SESSION_REFRESH_KEY}"] = seconds
            if window is not None:
                state[f"{pane_id}.{SESSION_ON_OPEN_KEY}"] = window

        row, _ = _mutate(db, user, caller, session_id, change, ORIGIN)
        return _describe_session(db, row, user.id, detail=True)


def _time_presets() -> list[Any]:
    """The presets a pane's time range offers: what a Time range variable may be."""
    out: list[Any] = []
    for manifest in pane_manifest.manifests().values():
        preset = pane_variables.targets(manifest).get(pane_variables.TIME, {})
        for key, part in preset.items():
            if part == "preset":
                spec = next((i for i in manifest.inputs if i.key == key), None)
                out += [c for c in (spec.choices if spec else []) if c not in out]
    return out


def _time_variable(time_range: Any, start: Optional[str], end: Optional[str]) -> dict[str, Any]:
    presets = _time_presets()
    if str(time_range).strip().lower() == "custom":
        if not start or not end:
            raise InputError('A custom time range needs start and end, as "YYYY-MM-DDTHH:mm" in the user\'s local time.')
        return {"preset": "custom", "start": start, "end": end}
    seconds = _every(time_range)
    if seconds not in presets:
        offered = ", ".join(_say_seconds(p) for p in presets if p != "custom")
        raise InputError(f"{time_range!r} isn't one of the time ranges panes offer: {offered}, or custom.")
    return {"preset": seconds, "start": "", "end": ""}


def _say_seconds(seconds: int) -> str:
    for unit, size in (("d", 86400), ("h", 3600), ("m", 60)):
        if seconds % size == 0:
            return f"{seconds // size}{unit}"
    return f"{seconds}s"


def _follow_variables(state: dict, user: models.User, pane_id: str, cleared: list[str]) -> list[str]:
    """Copies the variables a pane follows into its inputs, clearing what
    each change resets, as a person's pick would. The input keys changed."""
    manifest = pane_manifest.get(_pane_type(state, pane_id))
    kind = KINDS.get(_pane_type(state, pane_id))
    if manifest is None or kind is None:
        return []
    changed = pane_variables.apply(state, pane_id, manifest)
    values = {k: state.get(input_key(kind, pane_id, k)) for k in changed}
    for key in changed:
        _reset(state, kind, pane_id, key, values[key], values, cleared)
    return changed


@mcp.tool()
async def set_variables(
    session_id: str,
    environment: Optional[Any] = None,
    time_range: Optional[Any] = None,
    start: Optional[str] = None,
    end: Optional[str] = None,
    remove: Optional[list[str]] = None,
) -> dict:
    """Sets the session's variables -- a dashboard's shared controls, shown in a bar under the session card -- and
    copies them into every pane that follows them: `environment` (an AWS environment, by id or name as get_context
    lists them) into every pane's environment input, `time_range` (15m, 1h, 1d... or "custom" with `start` and `end`
    as "YYYY-MM-DDTHH:mm", the user's local time) into every pane's time range. A pane unlinked from one keeps its
    own value. `remove` drops variables by name (environment, time); the panes keep the values they have. Like
    set_pane_inputs it runs nothing: run_pane the panes it lists to bring their results up to date."""
    with _acting() as (db, user, caller):
        rc = RunContext(db=db, user=user, timezone=caller.timezone)
        wanted: dict[str, Any] = {}
        if environment is not None:
            wanted[pane_variables.ENVIRONMENT] = _visible_environment(rc, environment)
        if time_range is not None:
            wanted[pane_variables.TIME] = _time_variable(time_range, start, end)
        dropped = [n for n in (remove or [])]
        unknown = [n for n in dropped if n not in pane_variables.NAMES]
        if unknown:
            raise InputError(f"There is no variable {', '.join(unknown)}; they are: {', '.join(pane_variables.NAMES)}.")
        if not wanted and not dropped:
            raise InputError("Say an environment, a time_range, or variables to remove.")
        cleared: dict[str, list[str]] = {}
        changed: dict[str, list[str]] = {}

        def change(state: dict, _row, _member: Optional[models.SessionMember]) -> None:
            variables = {k: v for k, v in pane_variables.defined(state).items() if k not in dropped}
            state[pane_variables.VARIABLES_KEY] = {**variables, **wanted}
            for pane_id in _pane_ids(state):
                cleared[pane_id] = []
                keys = _follow_variables(state, user, pane_id, cleared[pane_id])
                if keys:
                    changed[pane_id] = keys

        row, _ = _mutate(db, user, caller, session_id, change, ORIGIN)
        for pane_id, keys in cleared.items():
            _clear_outputs(db, row, pane_id, keys)
        out = _describe_session(db, row, user.id, detail=True)
        full = _full(db, row)
        if changed:
            had_run = [p for p in changed if pane_values(full, p).get("ranAt")]
            out["note"] = (
                "Copied into " + ", ".join(f"{_pane_title(full, p)} ({', '.join(k)})" for p, k in changed.items()) + ". "
                + (
                    f"Nothing ran: run_pane {', '.join(had_run)} to bring their results up to date."
                    if had_run
                    else "Nothing ran."
                )
            )
        else:
            out["note"] = "No pane's inputs changed."
        return out


@mcp.tool()
async def link_pane(session_id: str, pane_id: str, variable: str, follow: bool = True) -> dict:
    """Makes a pane follow a session variable (environment or time) again -- its inputs take the variable's value
    now -- or, with follow=false, keep its own value from now on. Runs nothing."""
    if variable not in pane_variables.NAMES:
        raise InputError(f"There is no variable {variable}; they are: {', '.join(pane_variables.NAMES)}.")
    with _acting() as (db, user, caller):
        cleared: list[str] = []

        def change(state: dict, _row, _member: Optional[models.SessionMember]) -> None:
            _pane(state, pane_id)
            current = set(pane_variables.unlinked(state, pane_id))
            if follow:
                current.discard(variable)
            else:
                current.add(variable)
            state[pane_variables.unlinked_key(pane_id)] = sorted(current)
            if follow:
                _follow_variables(state, user, pane_id, cleared)

        row, _ = _mutate(db, user, caller, session_id, change, ORIGIN)
        _clear_outputs(db, row, pane_id, cleared)
        return {"session_id": row.client_id, "pane": _describe_pane(_full(db, row), pane_id, detail=True)}


@mcp.tool()
async def set_view_mode(session_id: str, view: bool, pane_id: Optional[str] = None) -> dict:
    """View mode turns a session into a dashboard: panes show their results without their inputs and buttons
    (D61). Without pane_id it is the session's; with pane_id it overrides the session for that pane (view=false
    shows that pane's inputs even in a dashboard). A viewer member always sees view mode."""
    with _acting() as (db, user, caller):

        def change(state: dict, _row, _member: Optional[models.SessionMember]) -> None:
            if pane_id is None:
                state[VIEW_MODE_KEY] = bool(view)
            else:
                _pane(state, pane_id)
                state[f"{pane_id}.{PANE_INPUTS_KEY}"] = "hidden" if view else "shown"

        row, _ = _mutate(db, user, caller, session_id, change, ORIGIN)
        return _describe_session(db, row, user.id, detail=True)


def _refresh_floor(kind: PaneKind) -> Optional[int]:
    from ..panes import refresh as pane_refresh

    manifest = pane_manifest.get(kind.type)
    if manifest is None or manifest.refresh_action() is None:
        return None
    return pane_refresh.floor_seconds(manifest)


@mcp.tool()
async def arrange_dashboard(session_id: str, rows: list[DashboardRow]) -> dict:
    """Switches a session to the dashboard layout and places its panes: rows top to bottom, each row's panes left to
    right, each given a width in columns out of 12 (a row's widths add up to at most 12). Panes you leave out are put
    in the first free space after these."""

    def change(state: dict, _row, _member: Optional[models.SessionMember]) -> None:
        seen: set[str] = set()
        for row in rows:
            if sum(c.width for c in row.panes) > DASHBOARD_COLUMNS:
                raise InputError(f"A row's widths add up to more than {DASHBOARD_COLUMNS}.")
            for cell in row.panes:
                _pane(state, cell.pane_id)
                if cell.pane_id in seen:
                    raise InputError(f"Pane {cell.pane_id} is placed twice.")
                seen.add(cell.pane_id)
        state["layout"] = "dashboard"
        state["dashboardPlan"] = {
            "columns": DASHBOARD_COLUMNS,
            "rows": [r.model_dump() for r in rows],
            # A new plan each time, even an identical one, so a browser that
            # applied the last one applies this one too.
            "id": live_store.new_client_id(),
        }

    with _acting() as (db, user, caller):
        row, _ = _mutate(db, user, caller, session_id, change, ORIGIN)
        return _describe_session(db, row, user.id)


def _apply_inputs(
    state: dict,
    user: models.User,
    db,
    caller,
    pane_id: str,
    inputs: dict[str, Any],
    cleared: Optional[list[str]] = None,
    unlinked: Optional[list[str]] = None,
) -> PaneKind:
    """The inputs written into the state, with what each change resets: in
    the state for inputs and views, and -- since outputs have their own
    records (§18.2) -- named in `cleared` for the caller to clear there."""
    type_ = _pane(state, pane_id)
    kind = kind_for(user, type_)
    rc = RunContext(db=db, user=user, timezone=caller.timezone)
    # An input renamed by its port (selectedEnvironmentIds -> connections,
    # D40) is still taken by its old name: an earlier turn in the history
    # may use it, and the model copies what it sees.
    inputs = {kind.aliases.get(k, k): v for k, v in inputs.items()}
    unknown = [k for k in inputs if kind.input(k) is None]
    if unknown:
        if not kind.inputs:
            raise InputError(kind.run_help)
        keys = ", ".join(i.key for i in kind.inputs)
        raise InputError(f"{kind.label} has no input {', '.join(unknown)}. Its inputs are: {keys}.")
    converted = {k: _convert(kind, k, v, rc) for k, v in inputs.items()}
    # Picking log groups ticks their environments too, as it does by hand --
    # added to whatever was already ticked, unless the agent set those itself.
    for key, value in kind.implies(inputs).items():
        if key in inputs:
            continue
        current = untag(state.get(input_key(kind, pane_id, key))) or []
        converted[key] = _convert(kind, key, sorted(set(current) | set(value)), rc)
    # An input that follows a session variable, set to a value of its own:
    # the pane stops following that variable, as a person unlinking it and
    # choosing would (D60) -- otherwise the next change to the variable would
    # quietly overwrite what was asked for here.
    manifest = pane_manifest.get(kind.type)
    if manifest is not None:
        follows = pane_variables.follows(state, pane_id, manifest)
        for key in converted:
            variable = pane_variables.variable_of(manifest, key)
            if variable and variable in follows and state.get(input_key(kind, pane_id, key)) != converted[key]:
                state[pane_variables.unlinked_key(pane_id)] = sorted({*pane_variables.unlinked(state, pane_id), variable})
                if unlinked is not None and variable not in unlinked:
                    unlinked.append(variable)
    for key, value in converted.items():
        stored = input_key(kind, pane_id, key)
        changed = state.get(stored) != value
        state[stored] = value
        if changed:
            _reset(state, kind, pane_id, key, value, converted, cleared)
    if (state.get("layout") or "tabs") == "tabs":
        state["activePane"] = pane_id
    # And not folded to its header in the other layouts: a run into a
    # minimised pane filled it where nobody could see, which read as the
    # agent working in the background.
    minimized = untag(state.get("minimized")) or []
    if pane_id in minimized:
        state["minimized"] = tag_set(m for m in minimized if m != pane_id)
    return kind


def _reset(
    state: dict, kind: PaneKind, pane_id: str, key: str, value: Any, converted: dict, cleared: Optional[list[str]]
) -> None:
    """What a change to an input clears, as the same pick in the pane does: a
    new table's info and items, a new bucket's listing and position."""
    for ref in kind.resets.get(key, ()):
        part, _, ref_key = ref.partition(".")
        if part == "in" and ref_key in converted:
            continue  # set in this same call: that value stands
        if part == "view":
            state[f"{pane_id}.{ref}"] = kind.view_defaults.get(ref_key)
        elif part == "out":
            if cleared is not None:
                cleared.append(ref_key)
        else:
            state.pop(f"{pane_id}.{ref}", None)
    # A choice that sets others (IoT's mode puts its own default query
    # in), unless this call set them itself.
    sets = kind.choice_sets.get(key, {}).get(value, {}) if isinstance(value, (str, int, bool)) else {}
    for other, set_to in sets.items():
        if other not in converted:
            state[input_key(kind, pane_id, other)] = set_to


def _convert(kind: PaneKind, key: str, value: Any, rc: RunContext) -> Any:
    return convert(kind.input(key), value, rc)


@mcp.tool()
async def set_pane_inputs(session_id: str, pane_id: str, inputs: dict[str, Any]) -> dict:
    """Fills in some of a pane's inputs (the keys get_context lists for its kind); inputs you leave out keep their
    value. The user sees them filled in at once. Doesn't run anything -- run_pane does."""
    with _acting() as (db, user, caller):
        before = {}
        found, _ = live_store.reachable(db, user.id, session_id)
        if found is not None:
            before = pane_values(found.state, pane_id) if pane_id in _pane_ids(found.state) else {}
        cleared: list[str] = []
        unlinked: list[str] = []
        row, kind = _mutate(
            db,
            user,
            caller,
            session_id,
            lambda s, _r, _m: _apply_inputs(s, user, db, caller, pane_id, inputs, cleared, unlinked),
            ORIGIN,
        )
        _clear_outputs(db, row, pane_id, cleared)
        restarted = await _restart_if_running(db, user, row, kind, pane_id, before)
        if restarted:
            db.refresh(row)
        out = {"session_id": row.client_id, "pane": _describe_pane(_full(db, row), pane_id, detail=True)}
        # Said in so many words: from "Doesn't run anything" in the tool's
        # description alone, a model filled in the MQTT tester and reported
        # it connected.
        out["note"] = restarted or (
            f"Only the inputs changed; nothing ran. run_pane runs it ({_action_label(kind)})."
            if kind.run or kind.background
            else "Only the inputs changed."
        )
        if unlinked:
            out["note"] += (
                f" It no longer follows the session's {', '.join(unlinked)} variable (link_pane follows it again)."
            )
        return out


async def _restart_if_running(db: Session, user: models.User, row: models.LiveSession, kind: PaneKind, pane_id: str, before: dict) -> Optional[str]:
    """A running background run whose `restart_on` inputs just changed starts
    again as this caller (D54: a topic someone adds is subscribed as them,
    never as whoever connected), keeping what it had shown."""
    manifest = pane_manifest.get(kind.type)
    main = manifest.main_action() if manifest else None
    if main is None or main.poll is None or not main.restart_on:
        return None
    after = pane_values(row.state, pane_id)
    if all(before.get(k) == after.get(k) for k in main.restart_on):
        return None
    going = (
        db.query(models.PaneRun)
        .filter(models.PaneRun.session_id == row.id, models.PaneRun.pane_id == pane_id, models.PaneRun.status == pane_runs.RUNNING)
        .first()
    )
    if going is None:
        return None
    _, member = live_store.reachable(db, user.id, row.client_id)
    try:
        await asyncio.to_thread(
            _start_run, user.id, row.id, member.id if member else None, manifest, main, pane_id, after,
            main.poll.agent_wait or BACKGROUND_WAIT_SECONDS, True,
        )
    except (HTTPException, pane_runs.RunError) as e:
        return f"It was running, and restarting it with the new inputs failed: {getattr(e, 'detail', e)}"
    return "It was running, so it restarted with the new inputs, as you."


def _apply_views(state: dict, user: models.User, pane_id: str, views: dict[str, Any]) -> None:
    kind = kind_for(user, _pane(state, pane_id))
    if not kind.v2 or not kind.view_defaults:
        raise InputError(f"{kind.label} has nothing to change in how it shows its results.")
    unknown = [k for k in views if k not in kind.view_defaults]
    if unknown:
        raise InputError(
            f"{kind.label} has no view {', '.join(unknown)}. Its views are: {', '.join(kind.view_defaults)}."
        )
    for key, value in views.items():
        state[f"{pane_id}.view.{key}"] = chart_spec(value) if kind.view_kinds.get(key) == "chart" else value
    if (state.get("layout") or "tabs") == "tabs":
        state["activePane"] = pane_id


@mcp.tool()
async def set_pane_view(session_id: str, pane_id: str, views: dict[str, Any]) -> dict:
    """Changes how a pane shows its results -- its view keys, as get_context lists them for its kind: the sort, the
    grouping, expanded rows, a chart of the rows. Everyone looking at the session sees it. Runs nothing."""
    with _acting() as (db, user, caller):
        row, _ = _mutate(db, user, caller, session_id, lambda s, _r, _m: _apply_views(s, user, pane_id, views), ORIGIN)
        return {"session_id": row.client_id, "pane": _describe_pane(_full(db, row), pane_id, detail=True)}


def _longest_list(value: Any) -> Optional[list]:
    """The longest list anywhere inside a run's writes: the thing to halve
    when they don't fit."""
    best: Optional[list] = None
    stack = [value]
    while stack:
        v = stack.pop()
        if isinstance(v, list):
            if best is None or len(v) > len(best):
                best = v
            stack.extend(v)
        elif isinstance(v, dict):
            stack.extend(v.values())
    return best


def _write_results(
    db: Session, user: models.User, caller, row: models.LiveSession, kind: PaneKind, pane_id: str, writes: dict[str, Any]
) -> tuple[models.LiveSession, bool]:
    """A run's results into its pane's own record (§18.2), cut down to fit;
    whether anything had to go. What a run resets in the session itself (an
    expanded row, `view.`) goes through the session's own write."""
    shaped = {output_key(kind, pane_id, k): v for k, v in writes.items()}
    prefix = f"{pane_id}.out."
    in_state = {k: v for k, v in shaped.items() if not k.startswith(prefix)}
    outputs = {k[len(prefix):]: v for k, v in shaped.items() if k.startswith(prefix)}
    if in_state:

        def change(state: dict, _r, _m) -> None:
            if pane_id not in _pane_ids(state):
                raise InputError("The pane was removed while it was running, so its results have nowhere to go.")
            state.update(in_state)

        row, _ = _mutate(db, user, caller, row.client_id, change, ORIGIN)

    def store(values: dict) -> bool:
        values.update(outputs)
        try:
            return pane_outputs.fit(values)
        except pane_outputs.OutputError as e:
            raise InputError(str(e)) from None

    try:
        _, trimmed = pane_outputs.write(db, row, pane_id, store, ORIGIN)
    except pane_outputs.OutputError as e:
        raise InputError(f"{e} Its results have nowhere to go.") from None
    db.refresh(row)
    return row, trimmed


def _clear_outputs(db: Session, row: models.LiveSession, pane_id: str, keys: list[str]) -> None:
    if keys:
        pane_outputs.clear(db, row, pane_id, keys, ORIGIN)


def _shown_in(row: models.LiveSession, pane_id: str) -> str:
    """Where a run's results are, in the words the user sees them by -- so
    the answer can point at them by name rather than by an id."""
    return f"the {_pane_title(row.state, pane_id)} pane of the session \"{row.title}\""


# Input types that name environments, and where in their stored value the ids are.
_ENVIRONMENT_INPUTS = ("environments", "environment", "log_groups", "opensearch_indices")
# A ported pane's AWS connections are the environments they used to be (D40).
_AS_ENVIRONMENT = {"connection": "environment", "connections": "environments"}


def _environment_ids(input_kind: str, value: Any) -> list[Any]:
    if input_kind == "environments":
        value = untag(value)
        return list(value) if isinstance(value, (list, set, tuple)) else []
    if input_kind == "environment":
        return [] if value is None else [value]
    return list(value) if isinstance(value, dict) else []  # keyed by environment id


def _check_reachable(db: Session, user: models.User, kind: PaneKind, values: dict) -> None:
    """Refuses a run of a pane still pointed at an environment the caller
    can't reach -- in a shared session, one its owner or another member
    picked. The run would have acted as the caller anyway and failed for that
    environment with a bare "Environment 2 is not configured", which a model
    read as "IoT Test isn't there" and went round in circles over. This says
    which input to change, and to what."""
    reachable = {t["id"]: t["label"] for t in _environments(db, user)}
    for spec in kind.inputs:
        input_kind = _AS_ENVIRONMENT.get(spec.kind, spec.kind) if spec.connection_type == "aws" else spec.kind
        if input_kind not in _ENVIRONMENT_INPUTS or spec.key not in values:
            continue
        unreachable = []
        for value in _environment_ids(input_kind, values[spec.key]):
            try:
                if int(value) in reachable:
                    continue
            except (TypeError, ValueError):
                pass
            unreachable.append(str(value))
        if unreachable:
            yours = ", ".join(f"{i} ({name})" for i, name in reachable.items()) or "none"
            raise InputError(
                f"This pane's {spec.key} includes environment {', '.join(unreachable)}, which you can't reach "
                f"(someone else in this session set it). Set {spec.key} to environments you can reach -- yours are: "
                f"{yours} -- and run it again."
            )


@mcp.tool()
async def run_pane(session_id: str, pane_id: str, inputs: Optional[dict[str, Any]] = None) -> dict:
    """Runs a pane -- a read-only search -- with its current inputs, after setting any `inputs` given (same keys as
    set_pane_inputs). The results appear in the pane; you get counts and a sample of the rows to answer from. Queries
    are given about 90 seconds."""
    with _acting() as (db, user, caller):
        cleared: list[str] = []
        row, kind = _mutate(
            db,
            user,
            caller,
            session_id,
            lambda s, _r, _m: _apply_inputs(s, user, db, caller, pane_id, inputs or {}, cleared),
            ORIGIN,
        )
        _clear_outputs(db, row, pane_id, cleared)
        if kind.background:
            _check_reachable(db, user, kind, pane_values(row.state, pane_id))
            return await _run_background(db, user, caller, row, kind, pane_id)
        if kind.run is None:
            raise InputError(kind.run_help)
        _check_reachable(db, user, kind, pane_values(row.state, pane_id))
        # No lock is held while it runs: a query can take a minute, and the
        # user's own edits to the session carry on meanwhile.
        result = await kind.run(RunContext(db=db, user=user, timezone=caller.timezone), pane_values(_full(db, row), pane_id))
        if not result.writes:
            return {"session_id": session_id, "pane_id": pane_id, "shown_in": _shown_in(row, pane_id), **result.summary}
        writes = json.loads(json.dumps(result.writes))  # our own copy to trim
        row, trimmed = _write_results(db, user, caller, row, kind, pane_id, writes)
        out = {"session_id": session_id, "pane_id": pane_id, "shown_in": _shown_in(row, pane_id), **result.summary}
        if trimmed:
            out["note"] = "The results were too big for a pane and were cut down; narrow the search to see them all."
        return out


# How long run_pane waits on a background run before answering from what has
# arrived; the run carries on in the pane after that.
BACKGROUND_WAIT_SECONDS = 90.0


async def _run_background(db: Session, user: models.User, caller, row: models.LiveSession, kind: PaneKind, pane_id: str) -> dict:
    """A background action (a CloudWatch query, D51): started in the pane, as
    the pane's own Run does, and waited on while the server polls it -- this
    turn counts as watching, so it is polled even with no browser open. A
    query still going after the wait is left running, its results arriving
    in the pane; it used to be stopped at 90 s."""
    manifest = pane_manifest.get(kind.type)
    main = manifest.main_action()
    if caller.session_scope_id is not None and row.id != caller.session_scope_id:
        raise InputError(_OUT_OF_SCOPE)
    _, member = live_store.reachable(db, user.id, row.client_id)
    values = {**pane_values(row.state, pane_id), "_tz": caller.timezone}
    # A stream (an MQTT connection) never finishes: read what arrived after a
    # few seconds rather than waiting the whole 90 on it.
    wait = main.poll.agent_wait or BACKGROUND_WAIT_SECONDS
    try:
        run = await asyncio.to_thread(
            _start_run, user.id, row.id, member.id if member else None, manifest, main, pane_id, values, wait
        )
    except HTTPException as e:
        raise InputError(str(e.detail)) from None
    except pane_runs.RunError as e:
        raise InputError(str(e)) from None
    deadline = asyncio.get_running_loop().time() + wait
    status = run["status"]
    while status == pane_runs.RUNNING and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(1.0)
        status = await asyncio.to_thread(_run_status, run["id"])
    db.expire_all()
    fresh = db.get(models.LiveSession, row.id)
    values = pane_values(_full(db, fresh), pane_id)
    # What the pane shows of the run: its outputs but the run itself and the
    # histogram, a chart's worth of numbers the model doesn't need.
    results = {
        o.key: values.get(o.key) for o in manifest.outputs
        if o.render not in ("run", "histogram") and values.get(o.key) is not None
    }
    summary = _summary(manifest, results, None)
    # The run's status is "status"; a pane's own output of that name (MQTT's
    # "Connected to ...") is said as what it is.
    if "status" in summary:
        summary["connection"] = summary.pop("status")
    out = {
        "session_id": row.client_id,
        "pane_id": pane_id,
        "shown_in": _shown_in(fresh or row, pane_id),
        "status": status,
        **summary,
    }
    if (values.get("run") or {}).get("trimmed"):
        out["note"] = "The results were too big for a pane and were cut down; narrow the search to see them all."
    if status == pane_runs.RUNNING:
        out["note"] = (
            f"Still running after {wait:.0f} seconds: this is what arrived so far. It keeps running in the pane, "
            "more arriving there; stop_pane stops it."
        )
    return out


def _start_run(
    user_id: int, row_id: int, member_id, manifest, action, pane_id: str, values: dict,
    wait: float = BACKGROUND_WAIT_SECONDS, keep: bool = False,
) -> dict:
    with SessionLocal() as db:
        user = db.get(models.User, user_id)
        row = db.get(models.LiveSession, row_id)
        member = db.get(models.SessionMember, member_id) if member_id else None
        run = pane_runs.start(
            db, user, row, member, manifest, action, pane_id, values, agent_seconds=wait + 5, keep=keep
        )
        return {"id": run.id, "status": run.status}


def _run_status(run_id: str) -> str:
    with SessionLocal() as db:
        run = db.get(models.PaneRun, run_id)
        return run.status if run else pane_runs.FAILED


@mcp.tool()
async def stop_pane(session_id: str, pane_id: str) -> dict:
    """Stops a pane's run that is still going (a CloudWatch query), the same as its Stop button. Changes nothing
    else."""
    with _acting() as (db, user, caller):
        row, member = live_store.reachable(db, user.id, session_id)
        if row is None:
            raise InputError(f"There is no session with id '{session_id}'. list_sessions shows them.")
        if caller.session_scope_id is not None and row.id != caller.session_scope_id:
            raise InputError(_OUT_OF_SCOPE)
        kind = kind_for(user, _pane(row.state, pane_id))
        if not kind.background:
            raise InputError(f"{kind.label} panes have nothing running in the background to stop.")
        try:
            stopped = pane_runs.stop(db, user, row, member, pane_id)
        except pane_runs.RunError as e:
            raise InputError(str(e)) from None
        return {"session_id": session_id, "pane_id": pane_id, "stopped": stopped,
                **({} if stopped else {"note": "Nothing was running in that pane."})}


# ---------------------------------------------------------------- workflows (§22)


def _run_out(db: Session, run: models.WorkflowRun, user: models.User) -> dict:
    """A run as the agent reads it: where it got to, and each step's outputs
    cut down to a sample -- or only that it happened, when its outputs aren't
    the asker's to see (D84)."""
    from .. import workflows

    out = workflows.summary(db, run, user, detail=True)
    out.pop("definition", None)
    for step in out.get("steps") or []:
        step.pop("inputs", None)
        if step.get("outputs") is not None:
            step["outputs"] = _bounded(step["outputs"])
    return out


@mcp.tool()
async def list_workflows() -> dict:
    """The workflows the user may run: each one's id, label, description and parameters (key, type, label,
    default, required; a connection parameter takes a connection id from get_context)."""
    from .. import workflows

    with _acting() as (db, user, _caller):
        return {
            "workflows": [
                {"id": w.id, "label": w.label, "description": w.description, "parameters": w.definition.get("parameters") or []}
                for w in workflows.runnable(db, user)
            ]
        }


@mcp.tool()
async def run_workflow(workflow_id: str, params: Optional[dict[str, Any]] = None, wait_seconds: int = 20) -> dict:
    """Starts a workflow as the user, with its parameters, and waits up to wait_seconds (at most 120) for it to
    finish, answering with where it got to: its status, each step's status and a sample of its outputs. A run still
    going can be read again with get_workflow_run. The run is also on the Workflows page for the user to watch. A
    step that needs approval makes the run wait for a person to decide there; you can't approve it."""
    from .. import workflows

    with _acting() as (db, user, _caller):
        workflow = db.get(models.Workflow, workflow_id)
        if workflow is None or not workflows.can_run(db, user, workflow):
            raise InputError(f"There is no workflow '{workflow_id}' the user may run; list_workflows says which they may.")
        try:
            run = workflows.start(db, user, workflow, params or {}, trigger="agent")
        except workflows.WorkflowError as e:
            raise InputError(str(e)) from None
        run_id = run.id
    deadline = asyncio.get_running_loop().time() + max(0, min(int(wait_seconds), 120))
    while True:
        if not workflows.manager.active:
            await asyncio.to_thread(workflows.drain)
        with _acting() as (db, user, _caller):
            run = db.get(models.WorkflowRun, run_id)
            if run.status == "waiting":
                # A person's decision (D88), never the agent's: say where it waits.
                out = _run_out(db, run, user)
                out["note"] = ("It waits for a person to approve a step, on the run's page in Workflows; "
                               "get_workflow_run reads it again once they have.")
                return out
            if run.status in workflows.FINISHED or asyncio.get_running_loop().time() >= deadline:
                # Followed in the browser like a session the agent made (Follow on).
                return {**_run_out(db, run, user), "show": {"href": f"?run={run.id}"}}
        await asyncio.sleep(0.5)


# ---------------------------------------------------------------- building (5-2, D72)


def _may_build(user: models.User, kind: str) -> None:
    """Pane types are a Builder's (or an admin's); a workflow's definition is
    an admin's until builders may edit workflows (5-3) -- as in the UI."""
    from .. import builder

    if kind == "pane" and not builder.can_build(user):
        raise InputError("Building pane types isn't turned on for the user's group.")
    if kind == "workflow" and not (user.group and user.group.is_admin):
        raise InputError("Only an admin edits workflows' definitions, for now.")
    if kind not in ("pane", "workflow"):
        raise InputError('kind is "pane" or "workflow".')


def _checked(db: Session, kind: str, source: str, definition_id: Optional[str]) -> list[dict]:
    from .. import builder, workflows

    try:
        if kind == "pane":
            builder.parse(source, definition_id or "draft")
        else:
            workflows.parse(source)
    except (builder.BuilderError, workflows.WorkflowError) as e:
        # A new pane type's id is the editor's Id field, not the draft's.
        return [x for x in e.errors if not (definition_id is None and str(x.get("message", "")).startswith("Its id is"))]
    return []


@mcp.tool()
async def build_reference(kind: str) -> dict:
    """What a pane type's ("pane") or a workflow's ("workflow") definition may say: each part's fields and types,
    the handlers, live functions, input types and renders there are (panes), the panes and actions a step can run
    (workflows), and the ids whose YAML read_definition shows as examples."""
    from .. import builder

    with _acting() as (db, user, _caller):
        _may_build(user, kind)
        return builder.reference(db, kind, user)


@mcp.tool()
async def read_definition(kind: str, definition_id: str) -> dict:
    """The YAML of an existing pane type (bundled or built here) or workflow, as written -- to learn from or to
    start a change from."""
    from .. import workflows

    with _acting() as (db, user, _caller):
        _may_build(user, kind)
        if kind == "pane":
            row = db.get(models.BuiltPaneType, definition_id)
            if row is not None:
                return {"kind": kind, "id": definition_id, "source": row.source}
            if definition_id in pane_manifest.bundled():
                return {"kind": kind, "id": definition_id,
                        "source": (pane_manifest.MANIFEST_DIR / f"{definition_id}.yaml").read_text()}
            raise InputError(f"There is no pane type {definition_id}; build_reference lists the examples.")
        workflow = db.get(models.Workflow, definition_id)
        if workflow is None or not workflows.can_run(db, user, workflow):
            raise InputError(f"There is no workflow {definition_id} the user may read; build_reference lists them.")
        return {"kind": kind, "id": definition_id, "source": workflow.source}


@mcp.tool()
async def check_definition(kind: str, source: str, definition_id: Optional[str] = None) -> dict:
    """Checks a pane type's or a workflow's YAML in full, as Check and Save do: every problem, each with its line.
    Saves nothing."""
    with _acting() as (db, user, _caller):
        _may_build(user, kind)
        errors = _checked(db, kind, source, definition_id)
        return {"ok": not errors, "errors": errors}


@mcp.tool()
async def propose_definition(kind: str, source: str, summary: str, definition_id: Optional[str] = None) -> dict:
    """Puts a pane type's or a workflow's YAML into the editor the user has open, replacing what's there, for them
    to review, Check and Save -- you can't save it yourself. It's checked first: with any problem, nothing is put
    there and the problems come back to fix. `summary` says in a sentence what you changed."""
    with _acting() as (db, user, _caller):
        _may_build(user, kind)
        errors = _checked(db, kind, source, definition_id)
        if errors:
            return {"ok": False, "errors": errors,
                    "note": "Nothing was put in the editor: fix these and propose again."}
        return {"ok": True, "note": "It's in the editor, unsaved: the user reviews it and saves.",
                "propose": {"kind": kind, "source": source, "summary": summary[:300]}}


@mcp.tool()
async def investigate_run(run_id: int) -> dict:
    """Opens a new session holding what a workflow run found: a pane per stage that ran a pane action, with the
    inputs it ran with and its results, to look into, sort, chart or run again. Nothing runs again. Only for a run
    the user may read (theirs, their group's, or as an admin)."""
    from .. import workflow_doors, workflows

    with _acting() as (db, user, caller):
        if caller.session_scope_id is not None:
            raise InputError(_OUT_OF_SCOPE)
        run = db.get(models.WorkflowRun, run_id)
        workflow = db.get(models.Workflow, run.workflow_id) if run else None
        if run is None or workflow is None or not workflows.can_run(db, user, workflow):
            raise InputError(f"There is no run {run_id} the user can see.")
        try:
            row = workflow_doors.investigate(db, user, run)
        except workflows.WorkflowError as e:
            raise InputError(str(e)) from None
        return _describe_session(db, row, user.id)


@mcp.tool()
async def open_template(template_id: str, environment: Optional[Any] = None) -> dict:
    """Opens a new session from a published template (get_context's templates): its panes, layout and inputs as
    made, for the environment given (an id or name from get_context's environments) when it needs one. Nothing
    runs."""
    with _acting() as (db, user, caller):
        if caller.session_scope_id is not None:
            raise InputError(_OUT_OF_SCOPE)
        row = db.get(models.PublishedTemplate, template_id)
        if row is None or not templates.usable(user, row):
            names = ", ".join(t.id for t in templates.visible(db, user)) or "none"
            raise InputError(f"There is no template {template_id} the user can open. Theirs: {names}.")
        chosen = None
        if environment not in (None, ""):
            chosen = _visible_environment(RunContext(db=db, user=user, timezone=caller.timezone), environment)
        try:
            made = templates.instantiate(db, user, row, chosen)
        except templates.TemplateError as e:
            raise InputError(str(e)) from None
        return _describe_session(db, made, user.id)


@mcp.tool()
async def open_workflow(workflow_id: Optional[str] = None, run_id: Optional[int] = None) -> dict:
    """Shows the user a workflow's page (its runs, Run, its definition) or one run's page (its stages, inputs,
    outputs, files) on the Workflows page, in their browser. Give one of the two."""
    from .. import workflows

    with _acting() as (db, user, _caller):
        if run_id is not None:
            run = db.get(models.WorkflowRun, run_id)
            workflow = db.get(models.Workflow, run.workflow_id) if run else None
            if run is None or workflow is None or not workflows.can_run(db, user, workflow):
                raise InputError(f"There is no run {run_id} the user can see.")
            return {"shown": f"{workflow.label} #{run.number}", "show": {"href": f"?run={run.id}"}}
        if not workflow_id:
            raise InputError("Give the workflow_id (list_workflows) or a run_id.")
        workflow = db.get(models.Workflow, workflow_id)
        if workflow is None or not workflows.can_run(db, user, workflow):
            raise InputError(f"There is no workflow '{workflow_id}' the user may run; list_workflows says which they may.")
        return {"shown": workflow.label, "show": {"href": f"?workflow={workflow.id}"}}


@mcp.tool()
async def get_workflow_run(run_id: int) -> dict:
    """A workflow run as it stands: its status, each step's status, error and a sample of its outputs."""
    from .. import workflows

    with _acting() as (db, user, _caller):
        run = db.get(models.WorkflowRun, run_id)
        workflow = db.get(models.Workflow, run.workflow_id) if run else None
        if run is None or workflow is None or not workflows.can_run(db, user, workflow):
            raise InputError(f"There is no run {run_id} the user can see.")
        return _run_out(db, run, user)


# ---------------------------------------------------------------- transport


class McpEndpoint:
    """The ASGI app mounted at /mcp: bearer-token check, then MCP.

    The SDK's session manager can only be run once, so this makes a fresh one
    for each lifespan of the backend app (`lifespan` below) instead of holding
    one for the life of the process -- a test suite, or a reload, runs the app
    more than once."""

    def __init__(self) -> None:
        self._manager: Optional[StreamableHTTPSessionManager] = None

    @contextlib.asynccontextmanager
    async def lifespan(self):
        manager = StreamableHTTPSessionManager(
            app=mcp._mcp_server,
            json_response=True,
            stateless=True,
            security_settings=mcp.settings.transport_security,
        )
        async with manager.run():
            self._manager = manager
            try:
                yield
            finally:
                self._manager = None

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            return
        caller = self._authenticate(scope)
        if caller is None:
            await _plain(send, 401, "A valid agent token is required.", {"www-authenticate": "Bearer"})
            return
        if self._manager is None:
            await _plain(send, 503, "The MCP endpoint isn't running yet.")
            return
        # MCP handles the call in tasks started from here, which inherit this
        # context -- that's how a tool learns whose call it is.
        token = _caller.set(caller)
        try:
            await self._manager.handle_request(scope, receive, send)
        finally:
            _caller.reset(token)

    @staticmethod
    def _authenticate(scope: Scope) -> Optional[tokens.Caller]:
        header = dict(scope.get("headers") or []).get(b"authorization", b"").decode("latin-1")
        scheme, _, token = header.partition(" ")
        if scheme.lower() != "bearer" or not token:
            return None
        db = SessionLocal()
        try:
            return tokens.resolve(db, token.strip())
        finally:
            db.close()


async def _plain(send: Send, status: int, text: str, headers: Optional[dict[str, str]] = None) -> None:
    body = json.dumps({"detail": text}).encode()
    raw_headers = [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]
    raw_headers += [(k.encode(), v.encode()) for k, v in (headers or {}).items()]
    await send({"type": "http.response.start", "status": status, "headers": raw_headers})
    await send({"type": "http.response.body", "body": body})


endpoint = McpEndpoint()
