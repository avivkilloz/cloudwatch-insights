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

import contextlib
import contextvars
import datetime
import json
from typing import Any, Literal, Optional
from zoneinfo import ZoneInfo

from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp.exceptions import ToolError
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
from mcp.server.transport_security import TransportSecuritySettings
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from starlette.types import Receive, Scope, Send

from .. import live_store, models, schemas
from ..db import SessionLocal
from ..live_store import StoreError, tag_set, untag
from ..routers import environments as environments_router
from ..routers import buckets, cognito, log_groups, opensearch, tables
from . import tokens
from .panes import KINDS, InputError, PaneKind, RunContext, available_kinds, convert, kind_for, pane_values, _call

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

Start with get_context: it lists the environments (AWS account + region) and \
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


def _environments(db, user) -> list[models.Environment]:
    return environments_router.list_environments(db=db, current_user=user)


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
    out["inputs"] = {i.key: values[i.key] for i in kind.inputs if i.key in values}
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
    state = row.state or {}
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
    if detail:
        out["active_pane"] = state.get("activePane")
    return out


@mcp.tool()
async def get_context() -> dict:
    """Who you are acting for, the time where they are, the environments they can reach, the pane kinds their group
    allows (with every input each kind takes), and the session they were looking at when they asked, if any. Call this
    first."""
    with _acting() as (db, user, caller):
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
                {"id": e.id, "name": e.name, "account_id": e.account_id, "region": e.region}
                for e in _environments(db, user)
            ],
            "pane_kinds": [k.describe() for k in available_kinds(user)],
            "layouts": list(LAYOUTS),
            "viewing_session": viewing,
        }


@mcp.tool()
async def list_sessions() -> dict:
    """The user's open sessions, in the order their panel shows them, with each one's panes -- their own, and any
    shared with them."""
    with _acting() as (db, user, _):
        return {"sessions": [_describe_session(db, r, user.id) for r in live_store.reachable_sessions(db, user.id)]}


@mcp.tool()
async def get_session(session_id: str) -> dict:
    """One session in detail: its layout, and each pane's inputs and what its last run left (as counts). Reachable
    through a session shared with the caller as well as one they own."""
    with _acting() as (db, user, _):
        row, _ = live_store.reachable(db, user.id, session_id)
        if row is None:
            raise InputError(f"There is no session with id '{session_id}'. list_sessions shows them.")
        return _describe_session(db, row, user.id, detail=True)


# ---------------------------------------------------------------- names for inputs


def _flagged(user: models.User, flag: str, label: str) -> None:
    if not (user.group and getattr(user.group, flag, False)):
        raise InputError(f"Your group doesn't have {label} turned on.")


@mcp.tool()
async def list_log_groups(environment_ids: list[int], name_contains: str = "") -> dict:
    """CloudWatch log group names in the given environments, optionally only those whose name contains some text."""
    with _acting() as (db, user, _):
        _flagged(user, "logs_enabled", "CloudWatch")
        response = await log_groups.get_log_groups(
            payload=schemas.LogGroupsRequest(environment_ids=environment_ids), db=db, current_user=user
        )
        needle = name_contains.lower()
        out = []
        for r in response.results:
            names = [g.name for g in r.log_groups if needle in g.name.lower()]
            entry: dict[str, Any] = {"environment_id": r.environment_id, "environment": r.environment_name}
            if r.error:
                entry["error"] = r.error
            # A big account has thousands; the model needs enough to choose from.
            entry["log_groups"] = names[:200]
            if len(names) > 200:
                entry["more"] = len(names) - 200
            out.append(entry)
        return {"results": out}


@mcp.tool()
async def list_opensearch_domains(environment_ids: list[int]) -> dict:
    """OpenSearch domains, with their endpoints, in the given environments."""
    with _acting() as (db, user, _):
        _flagged(user, "opensearch_enabled", "OpenSearch")
        response = await opensearch.get_domains(
            payload=schemas.OpenSearchDomainsRequest(environment_ids=environment_ids), db=db, current_user=user
        )
        return {"results": [r.model_dump() for r in response.results]}


@mcp.tool()
async def list_opensearch_indices(environment_id: int, domain_endpoint: str) -> dict:
    """The indices of one OpenSearch domain (its endpoint comes from list_opensearch_domains)."""
    with _acting() as (db, user, _):
        _flagged(user, "opensearch_enabled", "OpenSearch")
        response = _call(
            opensearch.get_indices,
            payload=schemas.OpenSearchIndicesRequest(environment_id=environment_id, domain_endpoint=domain_endpoint),
            db=db,
            current_user=user,
        )
        return {"indices": [i.model_dump() for i in response.indices]}


@mcp.tool()
async def list_dynamodb_tables(environment_id: int) -> dict:
    """DynamoDB table names in one environment."""
    with _acting() as (db, user, _):
        _flagged(user, "tables_enabled", "DynamoDB")
        return {"tables": list(_call(tables.list_tables, environment_id=environment_id, db=db, current_user=user).tables)}


@mcp.tool()
async def list_s3_buckets(environment_id: int) -> dict:
    """S3 bucket names in one environment."""
    with _acting() as (db, user, _):
        _flagged(user, "buckets_enabled", "S3")
        listed = _call(buckets.list_buckets, environment_id=environment_id, db=db, current_user=user)
        return {"buckets": [b.name for b in listed.buckets]}


@mcp.tool()
async def list_cognito_user_pools(environment_id: int) -> dict:
    """Cognito user pools (id and name) in one environment."""
    with _acting() as (db, user, _):
        _flagged(user, "cognito_enabled", "Cognito")
        pools = _call(cognito.list_user_pools, environment_id=environment_id, db=db, current_user=user)
        return {"user_pools": [p.model_dump() for p in pools.user_pools]}


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
    return pane_id


@mcp.tool()
async def create_session(title: str, panes: list[PaneSpec], layout: Layout = "tabs") -> dict:
    """A new session in the user's workspace holding the given panes (several of one kind are fine), in the given
    layout. It appears in the user's panel at once. Returns its id and the ids of its panes."""
    with _acting() as (db, user, _):
        state: dict[str, Any] = {"services": [], "paneTypes": {}, "paneTitles": {}, "layout": layout}
        pane_ids = [_add_pane(state, kind_for(user, p.kind), p.title) for p in panes]
        state["activePane"] = pane_ids[0] if pane_ids else None
        row = live_store.create(db, user.id, title, state, ORIGIN)
        return _describe_session(db, row, user.id) | {"pane_ids": pane_ids}


@mcp.tool()
async def add_pane(session_id: str, kind: str, title: Optional[str] = None) -> dict:
    """Adds an empty pane of a kind to a session and shows it. Returns the new pane's id. Works on a session shared
    with the caller as an editor, the same as one they own; a viewer can't (403)."""
    with _acting() as (db, user, _):
        pane_kind = kind_for(user, kind)
        row, pane_id = live_store.mutate(
            db, user.id, session_id, lambda s, _r, _m: _add_pane(s, pane_kind, title), ORIGIN
        )
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
    with _acting() as (db, user, _):
        row, _ = live_store.mutate(db, user.id, session_id, lambda s, _r, _m: _remove_pane(s, pane_id), ORIGIN)
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

    with _acting() as (db, user, _):
        row, _ = live_store.mutate(db, user.id, session_id, change, ORIGIN)
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

    with _acting() as (db, user, _):
        row, _ = live_store.mutate(db, user.id, session_id, change, ORIGIN)
        return _describe_session(db, row, user.id)


@mcp.tool()
async def list_categories() -> dict:
    """The side panel's session categories (Slack-style groups a session can be filed into)."""
    with _acting() as (db, user, _):
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

    with _acting() as (db, user, _):
        category_id = _find_or_create_category(db, user, category.strip()).id if category and category.strip() else None

        def change(_state: dict, row: models.LiveSession, member: Optional[models.SessionMember]) -> None:
            if member is None:
                row.category_id = category_id
            else:
                member.category_id = category_id

        row, _ = live_store.mutate(db, user.id, session_id, change, ORIGIN)
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

    with _acting() as (db, user, _):
        row, _ = live_store.mutate(db, user.id, session_id, change, ORIGIN)
        return _describe_session(db, row, user.id)


class DashboardCell(BaseModel):
    pane_id: str
    width: int = Field(ge=1, le=DASHBOARD_COLUMNS, description="Columns wide, of 12 across the dashboard.")


class DashboardRow(BaseModel):
    height: int = Field(default=340, ge=160, le=2000, description="Row height in pixels (about 340 is a normal pane).")
    panes: list[DashboardCell]


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

    with _acting() as (db, user, _):
        row, _ = live_store.mutate(db, user.id, session_id, change, ORIGIN)
        return _describe_session(db, row, user.id)


def _apply_inputs(state: dict, user: models.User, db, caller, pane_id: str, inputs: dict[str, Any]) -> PaneKind:
    type_ = _pane(state, pane_id)
    kind = kind_for(user, type_)
    rc = RunContext(db=db, user=user, timezone=caller.timezone)
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
        current = untag(state.get(f"{pane_id}.{key}")) or []
        converted[key] = _convert(kind, key, sorted(set(current) | set(value)), rc)
    for key, value in converted.items():
        state[f"{pane_id}.{key}"] = value
    if (state.get("layout") or "tabs") == "tabs":
        state["activePane"] = pane_id
    return kind


def _convert(kind: PaneKind, key: str, value: Any, rc: RunContext) -> Any:
    return convert(kind.input(key), value, rc)


@mcp.tool()
async def set_pane_inputs(session_id: str, pane_id: str, inputs: dict[str, Any]) -> dict:
    """Fills in some of a pane's inputs (the keys get_context lists for its kind); inputs you leave out keep their
    value. The user sees them filled in at once. Doesn't run anything -- run_pane does."""
    with _acting() as (db, user, caller):
        row, _ = live_store.mutate(
            db, user.id, session_id, lambda s, _r, _m: _apply_inputs(s, user, db, caller, pane_id, inputs), ORIGIN
        )
        return {"session_id": row.client_id, "pane": _describe_pane(row.state, pane_id, detail=True)}


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


def _write_results(state: dict, pane_id: str, writes: dict[str, Any]) -> bool:
    """A run's results into its pane, cut down until the session still fits
    under the browser's limit. True if anything had to go."""
    if pane_id not in _pane_ids(state):
        raise InputError("The pane was removed while it was running, so its results have nowhere to go.")
    budget = int(live_store.BROWSER_STATE_BYTES * 0.9)
    trimmed = False
    while True:
        for key, value in writes.items():
            state[f"{pane_id}.{key}"] = value
        if live_store.state_bytes(state) <= budget:
            return trimmed
        longest = _longest_list(writes)
        if not longest:
            raise InputError("These results are too big to show in a pane, even cut down. Ask for fewer.")
        del longest[len(longest) // 2 :]
        trimmed = True


def _shown_in(row: models.LiveSession, pane_id: str) -> str:
    """Where a run's results are, in the words the user sees them by -- so
    the answer can point at them by name rather than by an id."""
    return f"the {_pane_title(row.state, pane_id)} pane of the session \"{row.title}\""


@mcp.tool()
async def run_pane(session_id: str, pane_id: str, inputs: Optional[dict[str, Any]] = None) -> dict:
    """Runs a pane -- a read-only search -- with its current inputs, after setting any `inputs` given (same keys as
    set_pane_inputs). The results appear in the pane; you get counts and a sample of the rows to answer from. Queries
    are given about 90 seconds."""
    with _acting() as (db, user, caller):
        row, kind = live_store.mutate(
            db,
            user.id,
            session_id,
            lambda s, _r, _m: _apply_inputs(s, user, db, caller, pane_id, inputs or {}),
            ORIGIN,
        )
        if kind.run is None:
            raise InputError(kind.run_help)
        # No lock is held while it runs: a query can take a minute, and the
        # user's own edits to the session carry on meanwhile.
        result = await kind.run(RunContext(db=db, user=user, timezone=caller.timezone), pane_values(row.state, pane_id))
        if not result.writes:
            return {"session_id": session_id, "pane_id": pane_id, "shown_in": _shown_in(row, pane_id), **result.summary}
        writes = json.loads(json.dumps(result.writes))  # our own copy to trim
        row, trimmed = live_store.mutate(
            db, user.id, session_id, lambda s, _r, _m: _write_results(s, pane_id, writes), ORIGIN
        )
        out = {"session_id": session_id, "pane_id": pane_id, "shown_in": _shown_in(row, pane_id), **result.summary}
        if trimmed:
            out["note"] = "The results were too big for a pane and were cut down; narrow the search to see them all."
        return out


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
