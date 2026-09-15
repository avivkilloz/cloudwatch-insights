import datetime

from sqlalchemy import Column, Integer, String, Text, DateTime, JSON

from .db import Base


class Account(Base):
    __tablename__ = "accounts"

    id = Column(Integer, primary_key=True, index=True)
    account_id = Column(String, nullable=False, index=True)
    name = Column(String, nullable=False)
    regions = Column(JSON, nullable=False, default=list)
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
