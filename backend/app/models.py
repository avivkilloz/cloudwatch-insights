import datetime

from sqlalchemy import Column, Integer, String, Text, DateTime

from .db import Base


class Environment(Base):
    __tablename__ = "environments"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    account_id = Column(String, nullable=False, index=True)
    region = Column(String, nullable=False)
    role_name = Column(String, nullable=True)  # overrides global default role name if set
    created_at = Column(DateTime, default=datetime.datetime.utcnow)


class Setting(Base):
    __tablename__ = "settings"

    key = Column(String, primary_key=True)
    value = Column(String, nullable=True)


class SavedQuery(Base):
    __tablename__ = "saved_queries"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    query_string = Column(Text, nullable=False)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)


class IotSavedSearch(Base):
    __tablename__ = "iot_saved_searches"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    query_string = Column(Text, nullable=False)
    # SQLAlchemy auto-quotes a plain string server_default as a SQL string
    # literal -- do not wrap this in extra quotes, that would double-quote it.
    search_mode = Column(String, nullable=False, server_default="things")
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
