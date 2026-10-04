import datetime

from sqlalchemy import Boolean, Column, ForeignKey, Integer, JSON, LargeBinary, String, Text, DateTime, UniqueConstraint
from sqlalchemy.orm import relationship

from .db import Base


class UserGroup(Base):
    """A permission scope: which role to assume, which tabs are visible,
    and (for non-admin groups) which environments are visible. Every user
    belongs to exactly one group -- the group is the sole unit of access
    control, there's no separate per-user override."""

    __tablename__ = "user_groups"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, unique=True, nullable=False)
    # The IAM role name this group's members assume in every environment
    # they can see (replaces the old app-wide "default role name" and the
    # per-environment role override -- role is now purely a group property).
    role_name = Column(String, nullable=True)
    # The Admin group is marked, not just named "Admin" -- membership in
    # *this* group (however it's renamed) is what grants admin actions
    # (manage users/groups/settings/environments), and it always sees every
    # environment regardless of the group_environment_access list.
    is_admin = Column(Boolean, nullable=False, server_default="false")
    logs_enabled = Column(Boolean, nullable=False, server_default="true")
    # CloudWatch and OpenSearch are two pages and two sets of credentials, so
    # a group can have one without the other. Older databases carried both
    # under logs_enabled; the column is backfilled from it when it is added,
    # in main.py, so nobody silently gains a page they were not given.
    opensearch_enabled = Column(Boolean, nullable=False, server_default="true")
    iot_enabled = Column(Boolean, nullable=False, server_default="true")
    tables_enabled = Column(Boolean, nullable=False, server_default="true")
    buckets_enabled = Column(Boolean, nullable=False, server_default="true")
    cognito_enabled = Column(Boolean, nullable=False, server_default="true")
    aggregator_enabled = Column(Boolean, nullable=False, server_default="true")
    tools_enabled = Column(Boolean, nullable=False, server_default="true")
    # The platform agent acts as the user who asks it, with everything their
    # group can reach -- so unlike the page flags it starts off, and an admin
    # turns it on for a group deliberately. The Admin group gets it on
    # creation (bootstrap.py) and on the upgrade that adds this (main.py).
    agent_enabled = Column(Boolean, nullable=False, server_default="false")
    created_at = Column(DateTime, default=datetime.datetime.utcnow)

    users = relationship("User", back_populates="group")
    environment_links = relationship(
        "GroupEnvironmentAccess", back_populates="group", cascade="all, delete-orphan"
    )


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String, unique=True, nullable=False, index=True)
    password_hash = Column(String, nullable=False)
    group_id = Column(Integer, ForeignKey("user_groups.id"), nullable=False)
    # Optional profile picture, stored inline as a data: URL (same pattern as
    # Setting.app_logo_url) -- capped client-side and re-checked server-side
    # to keep rows small.
    avatar_url = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)

    group = relationship("UserGroup", back_populates="users")


class Session(Base):
    """A DB-backed login session -- the id itself (a long random token) is
    the httpOnly cookie value. No separate signing needed: it's already
    unguessable, and revoking a session (logout) is just deleting the row."""

    __tablename__ = "sessions"

    id = Column(String, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    expires_at = Column(DateTime, nullable=False)


class GroupEnvironmentAccess(Base):
    """Which environments a (non-admin) group can see. The Admin group
    ignores this entirely and always sees every environment -- see
    UserGroup.is_admin."""

    __tablename__ = "group_environment_access"

    group_id = Column(Integer, ForeignKey("user_groups.id", ondelete="CASCADE"), primary_key=True)
    environment_id = Column(Integer, ForeignKey("environments.id", ondelete="CASCADE"), primary_key=True)

    group = relationship("UserGroup", back_populates="environment_links")


class Environment(Base):
    __tablename__ = "environments"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    account_id = Column(String, nullable=False, index=True)
    region = Column(String, nullable=False)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)


class Setting(Base):
    """What's left here after user groups took over the default role name
    and per-tab visibility: app-wide branding (title/logo), which isn't
    access control and so isn't scoped per group."""

    __tablename__ = "settings"

    key = Column(String, primary_key=True)
    value = Column(String, nullable=True)


class SavedQuery(Base):
    __tablename__ = "saved_queries"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True)
    name = Column(String, nullable=False)
    query_string = Column(Text, nullable=False)
    # SQLAlchemy auto-quotes a plain string server_default as a SQL string
    # literal -- do not wrap this in extra quotes, that would double-quote it.
    backend = Column(String, nullable=False, server_default="cloudwatch")
    created_at = Column(DateTime, default=datetime.datetime.utcnow)


class IotSavedSearch(Base):
    __tablename__ = "iot_saved_searches"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True)
    name = Column(String, nullable=False)
    query_string = Column(Text, nullable=False)
    # SQLAlchemy auto-quotes a plain string server_default as a SQL string
    # literal -- do not wrap this in extra quotes, that would double-quote it.
    search_mode = Column(String, nullable=False, server_default="things")
    created_at = Column(DateTime, default=datetime.datetime.utcnow)


class SavedSession(Base):
    """A snapshot of an entire page's working state (selected environments,
    filters, query text, etc.) -- distinct from a SavedQuery/IotSavedSearch,
    which only remembers the query text. `page` is a free-form key identifying
    which page the session belongs to (e.g. "logs", "iot") and `state` is
    that page's own JSON shape; this table doesn't need to know it."""

    __tablename__ = "saved_sessions"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True)
    page = Column(String, nullable=False, index=True)
    name = Column(String, nullable=False)
    state = Column(JSON, nullable=False)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)


class SessionCategory(Base):
    """A named group of sessions in the side panel, the way a Slack workspace
    groups channels. Purely organizational -- it holds no state of its own,
    just a name and where it sits among the user's other categories. A session
    with no category shows outside any group, the way it always has.

    Deleting a category does not delete the sessions in it: LiveSession.category_id
    is ON DELETE SET NULL, so they fall back to ungrouped rather than vanishing.
    """

    __tablename__ = "session_categories"
    __table_args__ = (UniqueConstraint("user_id", "name", name="uq_session_categories_user_name"),)

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    name = Column(String, nullable=False)
    # Where it sits in the side panel, same convention as LiveSession.position:
    # rewritten wholesale on drag, so gaps and duplicates don't matter.
    position = Column(Integer, nullable=False, server_default="0")
    created_at = Column(DateTime, default=datetime.datetime.utcnow)


class LiveSession(Base):
    """One of the sessions open in someone's side panel, as their browser last
    left it.

    The neighbouring SavedSession is a *template*: a name you choose, holding a
    page's inputs, that you start a fresh session from. This is the opposite --
    nobody names it and nobody saves it, it is just the working state of a
    session that is already open, written back on every change so it survives a
    refresh, a different browser or a different machine.

    `client_id` is the id the browser generated for the session, not a database
    key: it is what the open workspace refers to itself by, so a browser that
    goes offline mid-edit and syncs later still addresses the same row.
    `state` is the page's own free-form JSON, opaque here, and `truncated` says
    the browser dropped the results to fit -- so the session can own up to it
    rather than coming back looking like an empty result set.

    `closed_at` set means closed but kept: the row stays so the session can be
    reopened from "Recently closed". Deleting is what actually removes it.
    """

    __tablename__ = "live_sessions"
    __table_args__ = (UniqueConstraint("user_id", "client_id", name="uq_live_sessions_user_client"),)

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    client_id = Column(String, nullable=False)
    type = Column(String, nullable=False)
    title = Column(String, nullable=False)
    # Where it sits in the side panel. Rewritten wholesale when sessions are
    # dragged, so gaps and duplicates don't matter -- only the order does.
    position = Column(Integer, nullable=False, server_default="0")
    # Which side-panel category this session sits in, if any. Nullable so a
    # session made before categories existed -- or never assigned to one --
    # just shows ungrouped rather than needing a migration to invent one.
    category_id = Column(Integer, ForeignKey("session_categories.id", ondelete="SET NULL"), nullable=True, index=True)
    state = Column(JSON, nullable=False, default=dict)
    # SQLAlchemy auto-quotes a plain string server_default as a SQL string
    # literal -- do not wrap this in extra quotes, that would double-quote it.
    truncated = Column(Boolean, nullable=False, server_default="false")
    closed_at = Column(DateTime, nullable=True, index=True)
    # Bumped on every write, whoever makes it. A writer says which version it
    # started from (`base_version` on PUT); one that started from an older one
    # is refused rather than allowed to overwrite a change it never saw --
    # which, once the server itself can change a session (the platform agent),
    # is the difference between two-way sync and last-write-wins data loss.
    version = Column(Integer, nullable=False, server_default="0")
    updated_at = Column(
        DateTime, default=datetime.datetime.utcnow, onupdate=datetime.datetime.utcnow
    )


class SessionMember(Base):
    """A user other than the owner invited into a live session, with a
    permission tier. `LiveSession.user_id` stays the owner throughout --
    membership is additive, so every existing single-owner code path
    (ownership checks, live sync, the agent's per-user token) still works
    unmodified for the owner's own view.

    A member's *own* view of the shared session -- their panel position,
    which of their own categories they filed it under, whether they've
    closed it -- can't live on `LiveSession` itself: those columns are the
    owner's alone, and a session shared with several people needs one
    independent view per person, the same way each of them can see the
    session's *state* while organizing it differently in their own panel.
    So this table carries that view too, mirroring the fields `LiveSession`
    carries for the owner. `category_id` points at one of the *member's
    own* categories (`SessionCategory.user_id` is that member, not the
    owner) -- categorizing a shared session never touches anyone else's.
    """

    __tablename__ = "session_members"
    __table_args__ = (UniqueConstraint("session_id", "user_id", name="uq_session_members_session_user"),)

    id = Column(Integer, primary_key=True, index=True)
    session_id = Column(Integer, ForeignKey("live_sessions.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    # "viewer": read-only. "editor": everything else -- edit inputs, add or
    # remove panes, run tools and services. The owner is never a member of
    # their own session; there is no row here for them.
    permission = Column(String, nullable=False, server_default="editor")
    # This member's own position among their sessions (owned and shared,
    # ordered together), which of their own categories they filed it under
    # (if any), and whether they've closed it -- same meaning as the
    # matching LiveSession columns, just scoped to this one member.
    position = Column(Integer, nullable=False, server_default="0")
    category_id = Column(Integer, ForeignKey("session_categories.id", ondelete="SET NULL"), nullable=True, index=True)
    closed_at = Column(DateTime, nullable=True, index=True)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)

    user = relationship("User")
    session = relationship("LiveSession")


class AgentToken(Base):
    """A short-lived credential the backend hands the platform agent for one
    chat turn, so the agent can call the MCP tools *as the user who asked* --
    with exactly that user's group, environments and IAM role, nothing more.

    The agent never sees the user's session cookie, and the browser never sees
    this token: the backend mints it when a turn starts, passes it to the
    agent container, and deletes it when the turn's stream ends (the expiry is
    the backstop for a turn that never ends cleanly). Only a hash is stored,
    so a database read doesn't hand out live credentials.

    It also carries what the turn knows about the asker that the MCP tools
    need and can't otherwise learn: their browser's time zone (a query's
    "since 9am" means their 9am) and the session they were looking at ("add
    a pane here").

    A session chat's turn is also held to that one session
    (`session_scope_id`, the row's id): the tools refuse to change any other
    session, or create one, with it. The prompt already asked for that, and a
    model that didn't listen wrote into a session the user wasn't looking at
    -- which looked, from the chat, like work done in the background."""

    __tablename__ = "agent_tokens"

    token_hash = Column(String(64), primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    expires_at = Column(DateTime, nullable=False)
    timezone = Column(String, nullable=True)
    viewing_session_id = Column(String, nullable=True)
    session_scope_id = Column(Integer, nullable=True)


class CredentialType(Base):
    """The shape of a kind of secret: a list of fields, each public or secret
    (PLATFORM_PLAN.md §13.3). Data, not code, so an admin can define one for
    their own pane without a release; the built-ins are seeded rows of the
    same kind (`builtin`), kept in step with credential_types.BUILTINS and
    not editable. A plugin will ship its types the same way."""

    __tablename__ = "credential_types"

    id = Column(String(64), primary_key=True)
    label = Column(String, nullable=False)
    description = Column(Text, nullable=True)
    # Bumped on every change to the fields, so a credential can tell which
    # shape it was saved against (and its ciphertext is bound to it).
    version = Column(Integer, nullable=False, default=1)
    fields = Column(JSON, nullable=False)
    # A CEL map expression over the fields: the JSON a consumer receives,
    # when the flat object of fields isn't the shape it wants.
    output_template = Column(Text, nullable=True)
    # How a credential of this type authenticates an HTTP request, and an
    # optional request that checks it works -- both declarative (CEL inside).
    inject = Column(JSON, nullable=True)
    http_test = Column(JSON, nullable=True)
    builtin = Column(Boolean, nullable=False, server_default="false")
    created_by_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    updated_by_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    updated_at = Column(DateTime, default=datetime.datetime.utcnow)


class Credential(Base):
    """One stored secret of a CredentialType.

    Its secret fields are one AES-GCM ciphertext under a data key of its own,
    and that key is wrapped by the master key (`kek_id` says which one, so a
    rotation re-wraps the key without touching the ciphertext). The
    ciphertext is bound to this row -- its id, type and type version are the
    associated data -- so moving it to another row fails to decrypt instead
    of handing one secret to the wrong consumer. Nothing here is ever
    returned in clear: `secret_fields_set` is all anyone learns about the
    secret fields (Grafana's secureJsonFields). See crypto.py and
    credential_store.py."""

    __tablename__ = "credentials"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    type_id = Column(String(64), ForeignKey("credential_types.id", ondelete="RESTRICT"), nullable=False, index=True)
    type_version = Column(Integer, nullable=False)
    description = Column(Text, nullable=True)
    # "global" (usable by a group only through a grant) or "group".
    scope = Column(String(16), nullable=False)
    group_id = Column(Integer, ForeignKey("user_groups.id", ondelete="CASCADE"), nullable=True, index=True)
    public_fields = Column(JSON, nullable=False, default=dict)
    secret_ciphertext = Column(LargeBinary, nullable=True)
    secret_nonce = Column(LargeBinary, nullable=True)
    wrapped_dek = Column(LargeBinary, nullable=True)
    kek_id = Column(String(64), nullable=True)
    secret_fields_set = Column(JSON, nullable=False, default=list)
    created_by_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    updated_by_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    updated_at = Column(DateTime, default=datetime.datetime.utcnow)
    last_tested_at = Column(DateTime, nullable=True)
    last_test_ok = Column(Boolean, nullable=True)
    last_test_message = Column(Text, nullable=True)
    last_used_at = Column(DateTime, nullable=True)

    type = relationship("CredentialType")
    group = relationship("UserGroup")
    grants = relationship("CredentialGrant", cascade="all, delete-orphan", back_populates="credential")


class CredentialGrant(Base):
    """A global credential made usable by one group. Global credentials are
    usable by nobody but admins until granted (PLATFORM_PLAN.md D15)."""

    __tablename__ = "credential_grants"

    credential_id = Column(Integer, ForeignKey("credentials.id", ondelete="CASCADE"), primary_key=True)
    group_id = Column(Integer, ForeignKey("user_groups.id", ondelete="CASCADE"), primary_key=True)
    granted_by_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    granted_at = Column(DateTime, default=datetime.datetime.utcnow)

    credential = relationship("Credential", back_populates="grants")
    group = relationship("UserGroup")


class AuditEvent(Base):
    """Who did what, to which object, when. General on purpose: credentials
    are its first writer, and workflows, plugins and connections will write
    to it too. `detail` never holds a secret -- which fields changed, never
    their values. The object and group are plain ids, not foreign keys, so a
    record outlives what it describes."""

    __tablename__ = "audit_events"

    id = Column(Integer, primary_key=True, index=True)
    at = Column(DateTime, default=datetime.datetime.utcnow, index=True)
    actor_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    actor_name = Column(String, nullable=True)
    actor_kind = Column(String(16), nullable=False)
    action = Column(String(64), nullable=False)
    object_type = Column(String(32), nullable=False)
    object_id = Column(String(64), nullable=False)
    group_id = Column(Integer, nullable=True)
    detail = Column(JSON, nullable=False, default=dict)
