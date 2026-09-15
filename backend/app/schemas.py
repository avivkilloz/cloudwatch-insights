from typing import Optional
from pydantic import BaseModel, ConfigDict


class AccountBase(BaseModel):
    account_id: str
    name: str
    regions: list[str] = []
    role_name: Optional[str] = None


class AccountCreate(AccountBase):
    pass


class AccountUpdate(BaseModel):
    account_id: Optional[str] = None
    name: Optional[str] = None
    regions: Optional[list[str]] = None
    role_name: Optional[str] = None


class AccountOut(AccountBase):
    model_config = ConfigDict(from_attributes=True)
    id: int


class SettingsOut(BaseModel):
    default_role_name: Optional[str] = None


class SettingsUpdate(BaseModel):
    default_role_name: Optional[str] = None


class SavedQueryBase(BaseModel):
    name: str
    query_string: str


class SavedQueryCreate(SavedQueryBase):
    pass


class SavedQueryOut(SavedQueryBase):
    model_config = ConfigDict(from_attributes=True)
    id: int


class Target(BaseModel):
    account_id: str
    region: str


class LogGroupsRequest(BaseModel):
    targets: list[Target]


class LogGroupInfo(BaseModel):
    name: str
    stored_bytes: Optional[int] = None
    creation_time: Optional[int] = None


class LogGroupsResultItem(BaseModel):
    account_id: str
    account_name: str
    region: str
    log_groups: list[LogGroupInfo] = []
    error: Optional[str] = None


class LogGroupsResponse(BaseModel):
    results: list[LogGroupsResultItem]


class QueryTarget(BaseModel):
    account_id: str
    region: str
    log_group_names: list[str]


class StartQueryRequest(BaseModel):
    targets: list[QueryTarget]
    query_string: str
    start_time: int  # epoch seconds
    end_time: int  # epoch seconds
    limit: Optional[int] = 1000


class StartedQuery(BaseModel):
    account_id: str
    account_name: str
    region: str
    query_id: Optional[str] = None
    error: Optional[str] = None


class StartQueryResponse(BaseModel):
    queries: list[StartedQuery]


class ResultField(BaseModel):
    field: str
    value: str


class QueryResultRow(BaseModel):
    account_id: str
    account_name: str
    region: str
    fields: list[ResultField]


class QueryStatusRequest(BaseModel):
    account_id: str
    region: str
    query_id: str


class QueryResultsRequest(BaseModel):
    queries: list[QueryStatusRequest]


class QueryResultItem(BaseModel):
    account_id: str
    account_name: str
    region: str
    query_id: str
    status: str
    rows: list[list[ResultField]] = []
    statistics: Optional[dict] = None
    error: Optional[str] = None


class QueryResultsResponse(BaseModel):
    results: list[QueryResultItem]
    all_done: bool


class StopQueryRequest(BaseModel):
    queries: list[QueryStatusRequest]
