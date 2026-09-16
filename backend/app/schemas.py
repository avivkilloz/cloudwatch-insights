from typing import Literal, Optional
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
    app_title: Optional[str] = None
    # A URL (including a data: URL for an uploaded image, stored inline) shown
    # right before the app title in the top bar.
    app_logo_url: Optional[str] = None
    logs_enabled: bool = True
    iot_enabled: bool = True
    tables_enabled: bool = True
    buckets_enabled: bool = True
    cognito_enabled: bool = True


class SettingsUpdate(BaseModel):
    default_role_name: Optional[str] = None
    app_title: Optional[str] = None
    app_logo_url: Optional[str] = None
    logs_enabled: Optional[bool] = None
    iot_enabled: Optional[bool] = None
    tables_enabled: Optional[bool] = None
    buckets_enabled: Optional[bool] = None
    cognito_enabled: Optional[bool] = None


class SavedQueryBase(BaseModel):
    name: str
    query_string: str


class SavedQueryCreate(SavedQueryBase):
    pass


class SavedQueryUpdate(BaseModel):
    name: Optional[str] = None
    query_string: Optional[str] = None


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


IotSearchMode = Literal["things", "certificates"]


class IotSavedSearchBase(BaseModel):
    name: str
    query_string: str
    search_mode: IotSearchMode = "things"


class IotSavedSearchCreate(IotSavedSearchBase):
    pass


class IotSavedSearchUpdate(BaseModel):
    name: Optional[str] = None
    query_string: Optional[str] = None
    search_mode: Optional[IotSearchMode] = None


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


class IotPolicyInfo(BaseModel):
    policy_name: str
    policy_arn: Optional[str] = None
    policy_document: Optional[dict] = None


class IotCertificateInfo(BaseModel):
    certificate_id: str
    certificate_arn: str
    status: str
    creation_date: Optional[int] = None
    policies: list[IotPolicyInfo] = []


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


class IotCertificateSearchRequest(BaseModel):
    environment_ids: list[int]
    # AWS IoT Fleet Indexing (used for thing search) doesn't cover
    # certificates -- there's no equivalent "Advanced search" API for them.
    # This is homegrown: `status:<VALUE>` and `certid:<VALUE>` tokens are
    # recognized as filters, anything else is a substring match against the
    # certificate ID. A `certid:` match does a direct lookup instead of
    # paginating every certificate in the account.
    query_string: str = ""
    max_results: Optional[int] = Field(default=50, ge=1, le=500)


class IotCertificateSearchResultItem(BaseModel):
    environment_id: int
    environment_name: str
    account_id: str
    region: str
    certificates: list[IotCertificateInfo] = []
    error: Optional[str] = None


class IotCertificateSearchResponse(BaseModel):
    results: list[IotCertificateSearchResultItem]


class IotCertificateDetailRequest(BaseModel):
    environment_id: int
    certificate_id: str


class IotCertificateDetail(BaseModel):
    certificate_id: str
    certificate_arn: Optional[str] = None
    status: str
    creation_date: Optional[int] = None
    policies: list[IotPolicyInfo] = []
    thing_names: list[str] = []
    warnings: list[str] = []


# ---- DynamoDB (Tables tab) ----


class DynamoTablesResponse(BaseModel):
    tables: list[str]


class DynamoTableDescribeRequest(BaseModel):
    environment_id: int
    table_name: str


class DynamoTableInfo(BaseModel):
    table_name: str
    status: Optional[str] = None
    item_count: Optional[int] = None
    size_bytes: Optional[int] = None
    partition_key: Optional[str] = None
    sort_key: Optional[str] = None


class DynamoScanRequest(BaseModel):
    environment_id: int
    table_name: str
    # `field:value` tokens, ANDed as an equality FilterExpression -- there's
    # no generic way to "search" an arbitrary schemaless table beyond that.
    query_string: str = ""
    limit: int = Field(default=25, ge=1, le=200)
    exclusive_start_key: Optional[str] = None


class DynamoScanResponse(BaseModel):
    items: list[dict] = []
    scanned_count: int = 0
    count: int = 0
    last_evaluated_key: Optional[str] = None


# ---- S3 (Buckets tab) ----


class S3BucketInfo(BaseModel):
    name: str
    creation_date: Optional[int] = None


class S3BucketsResponse(BaseModel):
    buckets: list[S3BucketInfo]


class S3BrowseRequest(BaseModel):
    environment_id: int
    bucket: str
    prefix: str = ""
    # When set, switches from a single-folder listing to a recursive,
    # substring-filtered filename search under `prefix` (see s3_client.browse_bucket).
    search: str = ""
    max_results: int = Field(default=200, ge=1, le=1000)
    continuation_token: Optional[str] = None


class S3FolderInfo(BaseModel):
    name: str
    prefix: str


class S3FileInfo(BaseModel):
    key: str
    name: str
    size: Optional[int] = None
    last_modified: Optional[int] = None
    storage_class: Optional[str] = None


class S3BrowseResponse(BaseModel):
    bucket: str
    bucket_region: str
    prefix: str
    folders: list[S3FolderInfo] = []
    files: list[S3FileInfo] = []
    continuation_token: Optional[str] = None


# ---- Cognito tab ----


class CognitoUserPoolInfo(BaseModel):
    id: str
    name: Optional[str] = None


class CognitoUserPoolsResponse(BaseModel):
    user_pools: list[CognitoUserPoolInfo]


class CognitoUserSearchRequest(BaseModel):
    environment_id: int
    user_pool_id: str
    # A single `attribute:value` token (starts-with match) -- Cognito's
    # ListUsers Filter only supports one attribute per call.
    query_string: str = ""
    limit: int = Field(default=30, ge=1, le=60)
    pagination_token: Optional[str] = None


class CognitoUserInfo(BaseModel):
    username: Optional[str] = None
    status: Optional[str] = None
    enabled: Optional[bool] = None
    created: Optional[int] = None
    last_modified: Optional[int] = None
    attributes: dict[str, Optional[str]] = {}


class CognitoUserSearchResponse(BaseModel):
    users: list[CognitoUserInfo] = []
    pagination_token: Optional[str] = None


# ---- Saved sessions ----
#
# A full working-state snapshot for a page (selected environments, filters,
# query text, sort, time range, etc.), as opposed to a SavedQuery/
# IotSavedSearch which only remembers the query text. `page` identifies which
# page the session is for (e.g. "logs", "iot"); `state` is that page's own
# free-form JSON shape, opaque to the backend.


class SavedSessionBase(BaseModel):
    page: str
    name: str
    state: dict


class SavedSessionCreate(SavedSessionBase):
    pass


class SavedSessionUpdate(BaseModel):
    name: Optional[str] = None
    state: Optional[dict] = None


class SavedSessionOut(SavedSessionBase):
    model_config = ConfigDict(from_attributes=True)
    id: int


# ---- AI assistant ----
#
# Backed by a LiteLLM proxy (or anything OpenAI-compatible), configured
# entirely via env vars (LITELLM_API_KEY/BASE_URL/MODEL) -- never through the
# Settings page, since these are deployment-time secrets/config, not
# app data. Currently used by the Logs page only: building a query from a
# plain-English description, and answering questions about a query's results.


class AiStatus(BaseModel):
    configured: bool


AiChatRole = Literal["user", "assistant"]


class AiChatMessage(BaseModel):
    role: AiChatRole
    content: str


class AiAssistRequest(BaseModel):
    mode: Literal["build_query", "ask_results"]
    # The conversation so far, ending with the new user message.
    messages: list[AiChatMessage]
    query_string: Optional[str] = None
    sample_rows: list[dict] = []
    row_count: Optional[int] = None


class AiAssistResponse(BaseModel):
    reply: str
    # build_query mode only: the query text extracted from the reply's code
    # block, ready to drop straight into the query editor.
    suggested_query: Optional[str] = None
