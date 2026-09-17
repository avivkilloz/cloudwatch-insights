import datetime

from sqlalchemy import Boolean, Column, ForeignKey, Integer, JSON, String, Text, DateTime
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
    iot_enabled = Column(Boolean, nullable=False, server_default="true")
    tables_enabled = Column(Boolean, nullable=False, server_default="true")
    buckets_enabled = Column(Boolean, nullable=False, server_default="true")
    cognito_enabled = Column(Boolean, nullable=False, server_default="true")
    tools_enabled = Column(Boolean, nullable=False, server_default="true")
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
