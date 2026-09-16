from typing import Optional
from pydantic import BaseModel, ConfigDict, Field


class EnvironmentBase(BaseModel):
    name: str
    account_id: str
    region: str
    role_name: Optional[str] = None


class EnvironmentCreate(EnvironmentBase):
    pass


class EnvironmentUpdate(BaseModel):
    name: Optional[str] = None
    account_id: Optional[str] = None
    region: Optional[str] = None
    role_name: Optional[str] = None


class EnvironmentOut(EnvironmentBase):
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


class LogGroupsRequest(BaseModel):
    environment_ids: list[int]


class LogGroupInfo(BaseModel):
    name: str
    stored_bytes: Optional[int] = None
    creation_time: Optional[int] = None


class LogGroupsResultItem(BaseModel):
    environment_id: int
    environment_name: str
    account_id: str
    region: str
    log_groups: list[LogGroupInfo] = []
    error: Optional[str] = None


class LogGroupsResponse(BaseModel):
    results: list[LogGroupsResultItem]


class QueryTarget(BaseModel):
    environment_id: int
    log_group_names: list[str]


class StartQueryRequest(BaseModel):
    targets: list[QueryTarget]
    query_string: str
    start_time: int  # epoch seconds
    end_time: int  # epoch seconds
    # Applied per target via CloudWatch Logs Insights' own StartQuery `limit`
    # parameter -- with N targets selected, up to N * limit rows can come
    # back from AWS. The frontend re-sorts and truncates the merged set to
    # this same value before display so what the user sees matches what
    # they asked for.
    limit: Optional[int] = Field(default=1000, ge=1, le=10000)


class StartedQuery(BaseModel):
    environment_id: int
    environment_name: str
    account_id: str
    region: str
    query_id: Optional[str] = None
    error: Optional[str] = None


class StartQueryResponse(BaseModel):
    queries: list[StartedQuery]


class ResultField(BaseModel):
    field: str
    value: str


class QueryStatusRequest(BaseModel):
    environment_id: int
    query_id: str


class QueryResultsRequest(BaseModel):
    queries: list[QueryStatusRequest]


class QueryResultItem(BaseModel):
    environment_id: int
    environment_name: str
    account_id: str
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


# ---- IoT ----


class IotSavedSearchBase(BaseModel):
    name: str
    query_string: str


class IotSavedSearchCreate(IotSavedSearchBase):
    pass


class IotSavedSearchOut(IotSavedSearchBase):
    model_config = ConfigDict(from_attributes=True)
    id: int


class IotSearchRequest(BaseModel):
    environment_ids: list[int]
    # AWS IoT Fleet Indexing query syntax -- the same "Advanced search" box
    # as the AWS console, e.g. connectivity.connected:true AND
    # attributes.stage:prod. Requires thing indexing to be enabled for the
    # target account/region.
    query_string: str
    max_results: Optional[int] = Field(default=50, ge=1, le=500)


class IotThingSummary(BaseModel):
    thing_name: str
    thing_id: Optional[str] = None
    thing_type_name: Optional[str] = None
    thing_group_names: list[str] = []
    attributes: dict[str, str] = {}
    connected: Optional[bool] = None
    connectivity_timestamp: Optional[int] = None


class IotSearchResultItem(BaseModel):
    environment_id: int
    environment_name: str
    account_id: str
    region: str
    things: list[IotThingSummary] = []
    error: Optional[str] = None


class IotSearchResponse(BaseModel):
    results: list[IotSearchResultItem]


class IotThingDetailRequest(BaseModel):
    environment_id: int
    thing_name: str


class IotCertificateInfo(BaseModel):
    certificate_id: str
    certificate_arn: str
    status: str
    creation_date: Optional[int] = None


class IotShadowInfo(BaseModel):
    name: str
    reported: dict = {}
    desired: dict = {}
    version: Optional[int] = None
    last_updated: Optional[int] = None


class IotJobExecutionInfo(BaseModel):
    job_id: str
    status: str
    queued_at: Optional[int] = None
    started_at: Optional[int] = None
    last_updated_at: Optional[int] = None


class IotThingDetail(BaseModel):
    thing_name: str
    thing_id: Optional[str] = None
    thing_arn: Optional[str] = None
    thing_type_name: Optional[str] = None
    attributes: dict[str, str] = {}
    version: Optional[int] = None
    connected: Optional[bool] = None
    connectivity_timestamp: Optional[int] = None
    certificates: list[IotCertificateInfo] = []
    shadows: list[IotShadowInfo] = []
    jobs: list[IotJobExecutionInfo] = []
    # Non-fatal: one section (e.g. jobs) failing to load doesn't hide the
    # rest of the thing's detail.
    warnings: list[str] = []
