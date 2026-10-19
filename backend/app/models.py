import datetime

from sqlalchemy import Boolean, Column, ForeignKey, Index, Integer, JSON, LargeBinary, String, Text, DateTime, UniqueConstraint, text
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
    # The IAM role name this group's members used to assume in every
    # environment. No longer read: since Phase 2 it is the group's default
    # AWS identity, an "AWS role" credential (GroupIdentity, D31), created
    # from this column by connections.migrate_legacy(). Kept for one release
    # so a rollback has it.
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
    # The Builder (PLATFORM_PLAN.md D71, §24): makes pane types -- and, as the
    # builder grows, steps and workflows. Off unless an admin turns it on; an
    # admin group builds whatever this says.
    builder_enabled = Column(Boolean, nullable=False, server_default="false")
    created_at = Column(DateTime, default=datetime.datetime.utcnow)

    users = relationship("User", back_populates="group")
    environment_links = relationship(
        "GroupEnvironmentAccess", back_populates="group", cascade="all, delete-orphan"
    )
    # Which pane types it may use (D65, pane_access.py) -- the *_enabled
    # columns above are no longer read for panes; they're kept for rollback.
    pane_grants = relationship("GroupPaneGrant", cascade="all, delete-orphan", lazy="selectin")


class GroupPaneGrant(Base):
    """One pane type a group may use (PLATFORM_PLAN.md §19.1, D65). The Admin
    group needs none: it can use every pane type."""

    __tablename__ = "group_pane_grants"
    __table_args__ = (UniqueConstraint("group_id", "pane_type", name="uq_group_pane_grant"),)

    id = Column(Integer, primary_key=True)
    group_id = Column(Integer, ForeignKey("user_groups.id", ondelete="CASCADE"), nullable=False, index=True)
    pane_type = Column(String, nullable=False)


class CatalogueCategory(Base):
    """A category of the catalogue panes are picked from (PLATFORM_PLAN.md
    §19.2, D66). `key` is what a manifest's suggestion matches, fixed at
    creation; `name` is what people see, and an admin can change it."""

    __tablename__ = "catalogue_categories"

    id = Column(Integer, primary_key=True)
    key = Column(String, nullable=False, unique=True)
    name = Column(String, nullable=False, unique=True)
    # A line under its name where panes are offered. Null: never set, so the
    # default for its key applies (catalogue.DESCRIPTIONS); "" is an admin's
    # "none".
    description = Column(Text, nullable=True)
    position = Column(Integer, nullable=False, server_default="0")
    created_at = Column(DateTime, default=datetime.datetime.utcnow)


class CataloguePlacement(Base):
    """Where an admin put a pane type: it stays there whatever its manifest
    suggests later, so an upgrade never undoes it."""

    __tablename__ = "catalogue_placements"

    pane_type = Column(String, primary_key=True)
    category_id = Column(Integer, ForeignKey("catalogue_categories.id", ondelete="CASCADE"), nullable=False)
    position = Column(Integer, nullable=False, server_default="0")


class CataloguePreference(Base):
    """One person's layer over the catalogue: a favourite, or one they hide."""

    __tablename__ = "catalogue_preferences"
    __table_args__ = (UniqueConstraint("user_id", "pane_type", name="uq_catalogue_preference"),)

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    pane_type = Column(String, nullable=False)
    favourite = Column(Boolean, nullable=False, server_default="false")
    hidden = Column(Boolean, nullable=False, server_default="false")


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
    # The session that is this user's home page (R3, D63): the row's own id,
    # since a client_id is only unique per owner. No foreign key -- users and
    # live_sessions would each point at the other -- so a deleted row leaves
    # the id behind, read as "gone" like a session they've left. The title is
    # kept to say which one in the note that follows.
    home_session_id = Column(Integer, nullable=True)
    home_session_title = Column(String, nullable=True)

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
    """A named place people talk about ("Prod", "IoT Test"), holding one or
    more connections (PLATFORM_PLAN.md D1, §14). The unit of group access.

    It used to be one AWS account and region itself. Those two columns are
    no longer read -- each environment's AWS target is a `Connection` now --
    and are kept, nullable, for one release so a rollback has them."""

    __tablename__ = "environments"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    description = Column(Text, nullable=True)
    account_id = Column(String, nullable=True, index=True)
    region = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)

    connections = relationship(
        "Connection", back_populates="environment", cascade="all, delete-orphan", order_by="Connection.position, Connection.id"
    )


class ConnectionType(Base):
    """What it takes to reach one kind of system: its public settings (the
    same field schema as credential types) and which credential types a
    group may use as its identity there. Built-ins are seeded rows
    (connections.BUILTINS); any other is an HTTP API of a kind (D67), made
    by an admin or shipped by the manifest of the pane that needs it."""

    __tablename__ = "connection_types"

    id = Column(String(64), primary_key=True)
    label = Column(String, nullable=False)
    description = Column(Text, nullable=True)
    fields = Column(JSON, nullable=False, default=list)
    identity_types = Column(JSON, nullable=False, default=list)
    builtin = Column(Boolean, nullable=False, server_default="false")
    # "manifest:<pane type>" for one a pane shipped; null for an admin's own.
    origin = Column(String, nullable=True)


class Connection(Base):
    """One configured target inside an environment: *where* something is
    (an account and region, a base URL). *Who* a request runs as there comes
    from the caller's group (GroupIdentity), falling back to the connection's
    own credential.

    Ids come from the environments' own sequence, so a connection and an
    environment never share an id. That is what lets every environment id
    stored before connections existed -- in pane state, templates, saved
    items -- keep meaning one target: an environment's first connection
    takes the environment's own id (D34)."""

    __tablename__ = "connections"
    __table_args__ = (UniqueConstraint("environment_id", "name", name="uq_connections_environment_name"),)

    id = Column(
        Integer, primary_key=True, autoincrement=False, server_default=text("nextval('environments_id_seq'::regclass)")
    )
    environment_id = Column(Integer, ForeignKey("environments.id", ondelete="CASCADE"), nullable=False, index=True)
    type_id = Column(String(64), ForeignKey("connection_types.id", ondelete="RESTRICT"), nullable=False)
    name = Column(String, nullable=False)
    config = Column(JSON, nullable=False, default=dict)
    credential_id = Column(Integer, ForeignKey("credentials.id", ondelete="RESTRICT"), nullable=True)
    position = Column(Integer, nullable=False, server_default="0")
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.datetime.utcnow)

    environment = relationship("Environment", back_populates="connections")
    type = relationship("ConnectionType")
    credential = relationship("Credential")


class GroupIdentity(Base):
    """Who a group is on a kind of connection (D31): a credential it can
    use, as its default for a connection type (connection_id null) or as an
    override for one connection. The AWS role used to be a column on the
    group; it is one of these now."""

    __tablename__ = "group_identities"
    __table_args__ = (
        UniqueConstraint("group_id", "connection_type_id", "connection_id", name="uq_group_identity_override"),
        # Postgres treats NULLs as distinct, so the constraint above can't
        # stop two defaults for one type; this index does.
        Index(
            "uq_group_identity_default",
            "group_id",
            "connection_type_id",
            unique=True,
            postgresql_where=text("connection_id IS NULL"),
        ),
    )

    id = Column(Integer, primary_key=True, index=True)
    group_id = Column(Integer, ForeignKey("user_groups.id", ondelete="CASCADE"), nullable=False, index=True)
    connection_type_id = Column(String(64), ForeignKey("connection_types.id", ondelete="CASCADE"), nullable=False)
    connection_id = Column(Integer, ForeignKey("connections.id", ondelete="CASCADE"), nullable=True)
    credential_id = Column(Integer, ForeignKey("credentials.id", ondelete="RESTRICT"), nullable=False)

    group = relationship("UserGroup")
    connection = relationship("Connection")
    credential = relationship("Credential")


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


class SavedInput(Base):
    """A pane's inputs under a name (PLATFORM_PLAN.md D46): "Load…" fills the
    pane you're in, where a template (SavedSession) starts a new session. One
    store for every pane type, replacing the per-pane saved tables, buckets,
    searches and queries as each pane is ported. Never holds a `sensitive`
    input (routers/saved_inputs.py keeps only the manifest's others)."""

    __tablename__ = "saved_inputs"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    pane_type = Column(String, nullable=False, index=True)
    name = Column(String, nullable=False)
    inputs = Column(JSON, nullable=False)
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


class TabPresence(Base):
    """A browser tab holding the live-session event stream open: what makes a
    session "watched" (PLATFORM_PLAN.md D51). Written by whichever replica
    holds the stream -- streams are spread over replicas, so this can't be a
    process's own memory -- on connect, on each heartbeat, and deleted when
    the stream ends. A row a dead replica left behind ages out by `seen_at`.
    """

    __tablename__ = "tab_presence"

    tab_id = Column(String, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    seen_at = Column(DateTime, nullable=False, default=datetime.datetime.utcnow)


class PaneRun(Base):
    """A long-running action of one pane, polled by the server (D51): a
    CloudWatch query's handles, who started it (it is polled as them), and
    which replica holds it, by heartbeat -- a replica that dies mid-run lets
    another claim it. The session carries the copy the pane draws
    (`<pane>.out.run`); this is the server's own bookkeeping.

    `status` is "running", "done", "stopped" or "failed". `unwatched_since`
    is when the session was last seen with nobody looking, for stopping a run
    nobody ever comes back to; `agent_until` keeps it watched while an agent
    turn waits on it.
    """

    __tablename__ = "pane_runs"

    id = Column(String, primary_key=True)
    session_id = Column(Integer, ForeignKey("live_sessions.id", ondelete="CASCADE"), nullable=False, index=True)
    pane_id = Column(String, nullable=False)
    pane_type = Column(String, nullable=False)
    action = Column(String, nullable=False)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    status = Column(String, nullable=False, default="running", index=True)
    handles = Column(JSON, nullable=False, default=list)
    replica = Column(String, nullable=True)
    heartbeat_at = Column(DateTime, nullable=True)
    unwatched_since = Column(DateTime, nullable=True)
    agent_until = Column(DateTime, nullable=True)
    started_at = Column(DateTime, nullable=False, default=datetime.datetime.utcnow)


class PaneOutput(Base):
    """What one pane of a session shows: its outputs -- a run's rows, `run`,
    `ranAt`, `resultsVersion` -- kept apart from the session's state
    (PLATFORM_PLAN.md D21, §18.2). The state is what people edit and the
    browser saves as a whole; results are what runs write, and kept in it,
    every 1-second poll or refresh resent the whole session to every tab and
    moved its version under someone typing. Written only through
    `pane_outputs.write`, versioned on its own and announced per pane.

    `refreshing_at` marks an auto-refresh under way, so the other tabs
    watching coalesce onto it instead of starting their own (§18.3).
    """

    __tablename__ = "pane_outputs"
    __table_args__ = (UniqueConstraint("session_id", "pane_id", name="uq_pane_outputs_session_pane"),)

    id = Column(Integer, primary_key=True)
    session_id = Column(Integer, ForeignKey("live_sessions.id", ondelete="CASCADE"), nullable=False, index=True)
    pane_id = Column(String, nullable=False)
    data = Column(JSON, nullable=False, default=dict)
    version = Column(Integer, nullable=False, default=0)
    updated_at = Column(DateTime, nullable=False, default=datetime.datetime.utcnow)
    refreshing_at = Column(DateTime, nullable=True)


class StoreItem(Base):
    """An item the store repo keeps (PLATFORM_PLAN.md §21.4, D70): which file
    it is, and the blob of that file as this platform last wrote or read it.
    The item itself lives in its own table (`credential_types`, …); this only
    tracks it. A remote file that is no longer `blob` was edited in the repo
    since, and the next write of the item is a conflict, never an overwrite.

    `state`: synced, pending (in the outbox, not pushed yet), conflict
    (`theirs` holds the remote's blob), or error (why in `error`)."""

    __tablename__ = "store_items"
    __table_args__ = (UniqueConstraint("kind", "item_id", name="uq_store_items_kind_item"),)

    id = Column(Integer, primary_key=True)
    kind = Column(String(40), nullable=False)
    item_id = Column(String(128), nullable=False)
    path = Column(String, nullable=False)
    blob = Column(String(64), nullable=True)
    theirs = Column(String(64), nullable=True)
    state = Column(String(16), nullable=False, default="pending")
    error = Column(Text, nullable=True)
    updated_at = Column(DateTime, nullable=False, default=datetime.datetime.utcnow)


class StoreOutbox(Base):
    """A change waiting to be committed to the store repo, written in the same
    transaction as the change itself so the two can't come apart (D80).
    Committed in id order; rows sharing a `batch` are one commit."""

    __tablename__ = "store_outbox"

    id = Column(Integer, primary_key=True)
    kind = Column(String(40), nullable=False)
    item_id = Column(String(128), nullable=False)
    op = Column(String(8), nullable=False)  # write | delete
    content = Column(Text, nullable=True)
    message = Column(String, nullable=False)
    batch = Column(String(64), nullable=True)
    author = Column(String, nullable=False)
    created_at = Column(DateTime, nullable=False, default=datetime.datetime.utcnow)


class Workflow(Base):
    """A workflow (PLATFORM_PLAN.md §22, D83): parameters and steps, kept as
    the YAML it was written in (`source`, verbatim -- comments and all, the
    store repo's file) beside what it parsed to (`definition`)."""

    __tablename__ = "workflows"

    id = Column(String(64), primary_key=True)
    label = Column(String, nullable=False)
    description = Column(Text, nullable=True)
    source = Column(Text, nullable=False)
    definition = Column(JSON, nullable=False)
    created_by_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.datetime.utcnow)
    updated_by_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    updated_at = Column(DateTime, nullable=False, default=datetime.datetime.utcnow)


class PublishedTemplate(Base):
    """A template made plugin content (PLATFORM_PLAN.md §23, D76, D99): a
    session's inputs and layout made portable -- its AWS connections follow
    the Environment variable, anything that names this deployment's
    connections or credentials left out -- kept in the store repo and offered
    to every group that may use each of its panes. A person's saved templates
    (`saved_sessions`) stay theirs; this is what one became when published."""

    __tablename__ = "published_templates"

    id = Column(String(64), primary_key=True)
    label = Column(String, nullable=False)
    description = Column(Text, nullable=True)
    state = Column(JSON, nullable=False)
    # The saved template it was published from, so its publisher's Add lists
    # offer the published one in its place, not both under one name. Not in
    # the store: a saved template is this deployment's, and its owner's.
    saved_session_id = Column(Integer, ForeignKey("saved_sessions.id", ondelete="SET NULL"), nullable=True)
    created_by_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.datetime.utcnow)
    updated_by_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    updated_at = Column(DateTime, nullable=False, default=datetime.datetime.utcnow)


class BuiltPaneType(Base):
    """A pane type made in the platform (the Builder, PLATFORM_PLAN.md §24,
    D103): its manifest as the YAML it was written in, kept verbatim like a
    workflow's (the store repo's `panes/<name>.yaml`). Checked by the same
    strict model as a bundled manifest, and loaded beside them."""

    __tablename__ = "built_pane_types"

    id = Column(String(64), primary_key=True)
    source = Column(Text, nullable=False)
    created_by_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.datetime.utcnow)
    updated_by_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    updated_at = Column(DateTime, nullable=False, default=datetime.datetime.utcnow)


class WorkflowGrant(Base):
    """A group that may run a workflow (D84). The Admin group needs none."""

    __tablename__ = "workflow_grants"
    __table_args__ = (UniqueConstraint("workflow_id", "group_id", name="uq_workflow_grant"),)

    id = Column(Integer, primary_key=True)
    workflow_id = Column(String(64), ForeignKey("workflows.id", ondelete="CASCADE"), nullable=False, index=True)
    group_id = Column(Integer, ForeignKey("user_groups.id", ondelete="CASCADE"), nullable=False, index=True)


class WorkflowRun(Base):
    """One run of a workflow, as whoever started it (D84, D85). `definition`
    is the workflow as it was when the run started, so a later edit doesn't
    change what a run's page says it did."""

    __tablename__ = "workflow_runs"
    __table_args__ = (UniqueConstraint("workflow_id", "number", name="uq_workflow_run_number"),)

    id = Column(Integer, primary_key=True)
    workflow_id = Column(String(64), ForeignKey("workflows.id", ondelete="CASCADE"), nullable=False, index=True)
    number = Column(Integer, nullable=False)
    # queued running waiting (on an approval, D88) succeeded failed cancelled
    status = Column(String(16), nullable=False, default="queued")
    params = Column(JSON, nullable=False, default=dict)
    definition = Column(JSON, nullable=False)
    started_by_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    started_by_name = Column(String, nullable=True)
    # The group the starter was in: who may read the run (D84).
    group_id = Column(Integer, ForeignKey("user_groups.id", ondelete="SET NULL"), nullable=True)
    trigger = Column(String(16), nullable=False, default="manual")  # manual agent rerun pane
    # The starter's time zone, for a step over a time range (Prometheus').
    timezone = Column(String(64), nullable=True)
    rerun_of = Column(Integer, nullable=True)
    # The step a rerun started from (D90): the ones before it were copied.
    rerun_from = Column(String(64), nullable=True)
    # The run's own chat, "This run" (D98): turns, shared by its readers.
    chat = Column(JSON, nullable=True)
    error = Column(Text, nullable=True)
    cancel_requested = Column(Boolean, nullable=False, server_default="false")
    replica = Column(String, nullable=True)
    heartbeat_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.datetime.utcnow)
    started_at = Column(DateTime, nullable=True)
    finished_at = Column(DateTime, nullable=True)


class WorkflowRunStep(Base):
    """One step of a run, as it went: what it ran with, what came back."""

    __tablename__ = "workflow_run_steps"
    __table_args__ = (UniqueConstraint("run_id", "position", name="uq_workflow_run_step"),)

    id = Column(Integer, primary_key=True)
    run_id = Column(Integer, ForeignKey("workflow_runs.id", ondelete="CASCADE"), nullable=False, index=True)
    position = Column(Integer, nullable=False)
    step_id = Column(String(64), nullable=False)
    label = Column(String, nullable=True)
    # pending running waiting succeeded failed skipped cancelled
    status = Column(String(16), nullable=False, default="pending")
    inputs = Column(JSON, nullable=True)
    outputs = Column(JSON, nullable=True)
    trimmed = Column(Boolean, nullable=False, server_default="false")
    # Outputs over the row's 1 MiB: the whole of them, in the blob store (D91).
    outputs_blob_id = Column(String(32), nullable=True)
    # The most attempts one call took (`retry`, D89).
    attempts = Column(Integer, nullable=False, server_default="0")
    # Copied from the run this one reran from a later stage of (D90).
    reused = Column(Boolean, nullable=False, server_default="false")
    error = Column(Text, nullable=True)
    started_at = Column(DateTime, nullable=True)
    finished_at = Column(DateTime, nullable=True)


class Approval(Base):
    """A decision a person must make before something goes on (D88): a
    workflow step's today, the agent's external actions next. `details` is
    what it will do (the step's resolved inputs); `decide_by` who may answer
    (`anyone` who may read the run, `others` -- not its starter -- or `admins`)."""

    __tablename__ = "approvals"

    id = Column(Integer, primary_key=True)
    kind = Column(String(32), nullable=False, default="workflow_step")
    run_id = Column(Integer, ForeignKey("workflow_runs.id", ondelete="CASCADE"), nullable=True, index=True)
    position = Column(Integer, nullable=True)
    step_id = Column(String(64), nullable=True)
    message = Column(Text, nullable=False)
    details = Column(JSON, nullable=True)
    decide_by = Column(String(16), nullable=False, default="anyone")
    requested_by_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    group_id = Column(Integer, ForeignKey("user_groups.id", ondelete="SET NULL"), nullable=True)
    status = Column(String(16), nullable=False, default="pending", index=True)  # pending approved denied expired cancelled
    decided_by_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    decided_by_name = Column(String, nullable=True)
    comment = Column(Text, nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.datetime.utcnow)
    expires_at = Column(DateTime, nullable=False)
    decided_at = Column(DateTime, nullable=True)


class Blob(Base):
    """A file in the blob store (D7, D91): only its metadata is here, the
    bytes are in the store under `key`. Every download is checked against
    what it belongs to -- a run's readers for a run's (D84)."""

    __tablename__ = "blobs"

    id = Column(String(32), primary_key=True)
    key = Column(String, nullable=False)
    name = Column(String, nullable=False)
    content_type = Column(String, nullable=False)
    size = Column(Integer, nullable=False)
    sha256 = Column(String(64), nullable=False)
    kind = Column(String(32), nullable=False)  # step_outputs artifact
    run_id = Column(Integer, ForeignKey("workflow_runs.id", ondelete="CASCADE"), nullable=True, index=True)
    position = Column(Integer, nullable=True)
    owner_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    group_id = Column(Integer, ForeignKey("user_groups.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.datetime.utcnow)
    expires_at = Column(DateTime, nullable=True, index=True)
