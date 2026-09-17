from typing import Literal, Optional
from pydantic import BaseModel, ConfigDict, Field


class EnvironmentBase(BaseModel):
    name: str
    account_id: str
    region: str


class EnvironmentCreate(EnvironmentBase):
    pass


class EnvironmentUpdate(BaseModel):
    name: Optional[str] = None
    account_id: Optional[str] = None
    region: Optional[str] = None


class EnvironmentOut(EnvironmentBase):
    model_config = ConfigDict(from_attributes=True)
    id: int


class SettingsOut(BaseModel):
    app_title: Optional[str] = None
    # A URL (including a data: URL for an uploaded image, stored inline) shown
    # right before the app title in the top bar.
    app_logo_url: Optional[str] = None


class SettingsUpdate(BaseModel):
    app_title: Optional[str] = None
    app_logo_url: Optional[str] = None


# ---- Auth / users / user groups ----
#
# A user belongs to exactly one group; the group is the sole unit of access
# control (role to assume, visible tabs, visible environments). The Admin
# group (UserGroup.is_admin) always sees every environment and is the only
# group whose members can manage users/groups/settings/environments.

TAB_FIELDS = ["logs_enabled", "iot_enabled", "tables_enabled", "buckets_enabled", "cognito_enabled", "tools_enabled"]


class UserGroupBase(BaseModel):
    name: str
    role_name: Optional[str] = None
    logs_enabled: bool = True
    iot_enabled: bool = True
    tables_enabled: bool = True
    buckets_enabled: bool = True
    cognito_enabled: bool = True
    tools_enabled: bool = True


class UserGroupCreate(UserGroupBase):
    # Environment ids this group can see (ignored for the Admin group, which
    # always sees every environment regardless of this list).
    environment_ids: list[int] = []


class UserGroupUpdate(BaseModel):
    name: Optional[str] = None
    role_name: Optional[str] = None
    logs_enabled: Optional[bool] = None
    iot_enabled: Optional[bool] = None
    tables_enabled: Optional[bool] = None
    buckets_enabled: Optional[bool] = None
    cognito_enabled: Optional[bool] = None
    tools_enabled: Optional[bool] = None
    environment_ids: Optional[list[int]] = None


class UserGroupOut(UserGroupBase):
    model_config = ConfigDict(from_attributes=True)
    id: int
    is_admin: bool
    environment_ids: list[int] = []
    user_count: int = 0


class UserBase(BaseModel):
    username: str
    group_id: int


class UserCreate(UserBase):
    password: str


class UserUpdate(BaseModel):
    group_id: Optional[int] = None
    password: Optional[str] = None


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    username: str
    group_id: int
    group_name: str
    is_admin: bool
    # The user's group's tab visibility -- included here (not just on
    # UserGroupOut) because /api/auth/me is how a non-admin user, who can't
    # call the admin-only /api/user-groups, finds out which tabs they can see.
    logs_enabled: bool
    iot_enabled: bool
    tables_enabled: bool
    buckets_enabled: bool
    cognito_enabled: bool
    tools_enabled: bool


class LoginRequest(BaseModel):
    username: str
    password: str


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


LogsBackend = Literal["cloudwatch", "opensearch"]


class SavedQueryBase(BaseModel):
    name: str
    query_string: str
    # Which Logs-page backend this query is written for -- CloudWatch Logs
    # Insights' pipe syntax and OpenSearch's Lucene query_string syntax are
    # not interchangeable, so the "Load saved query" dropdown filters by
    # whichever backend is currently selected.
    backend: LogsBackend = "cloudwatch"


class SavedQueryCreate(SavedQueryBase):
    pass


class SavedQueryUpdate(BaseModel):
    name: Optional[str] = None
    query_string: Optional[str] = None
    backend: Optional[LogsBackend] = None


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


# ---- OpenSearch (Logs tab: OpenSearch backend) ----
#
# AWS OpenSearch Service, provisioned domains. Mirrors the CloudWatch
# log-groups/queries shape closely (multi-environment domain discovery, then
# a multi-target search) so the frontend can reuse the same environment
# selector, results table, and AI assistant -- but the search itself is a
# single synchronous request/response (OpenSearch has no async query concept
# like CloudWatch Logs Insights' StartQuery/GetQueryResults), so there's no
# polling or stop endpoint.


class OpenSearchDomainsRequest(BaseModel):
    environment_ids: list[int]


class OpenSearchDomainInfo(BaseModel):
    domain_name: str
    # The domain's HTTPS endpoint. The frontend carries this straight through
    # into later /indices and /search calls instead of the backend
    # re-resolving it from the domain name each time.
    endpoint: Optional[str] = None
    engine_version: Optional[str] = None


class OpenSearchDomainsResultItem(BaseModel):
    environment_id: int
    environment_name: str
    account_id: str
    region: str
    domains: list[OpenSearchDomainInfo] = []
    error: Optional[str] = None


class OpenSearchDomainsResponse(BaseModel):
    results: list[OpenSearchDomainsResultItem]


class OpenSearchIndicesRequest(BaseModel):
    environment_id: int
    domain_endpoint: str


class OpenSearchIndexInfo(BaseModel):
    index: str
    docs_count: Optional[int] = None
    store_size: Optional[str] = None


class OpenSearchIndicesResponse(BaseModel):
    indices: list[OpenSearchIndexInfo] = []


class OpenSearchTarget(BaseModel):
    environment_id: int
    domain_name: str
    domain_endpoint: str
    indices: list[str]


class OpenSearchSearchRequest(BaseModel):
    targets: list[OpenSearchTarget]
    # Lucene query_string syntax, e.g. `level:ERROR AND service:checkout` --
    # blank matches everything in the time range.
    query_string: str = ""
    start_time: int  # epoch seconds
    end_time: int  # epoch seconds
    timestamp_field: str = Field(default="@timestamp", min_length=1)
    limit: int = Field(default=100, ge=1, le=1000)


class OpenSearchResultItem(BaseModel):
    environment_id: int
    environment_name: str
    account_id: str
    region: str
    domain_name: str
    indices: list[str]
    # "Complete" | "Failed" -- kept aligned with QueryResultItem.status so
    # both backends' results can be handled identically in the UI.
    status: str
    rows: list[list[ResultField]] = []
    total_hits: Optional[int] = None
    error: Optional[str] = None


class OpenSearchSearchResponse(BaseModel):
    results: list[OpenSearchResultItem]


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
    # Which Logs-page backend this request is for -- build_query mode uses it
    # to teach the right query syntax (CloudWatch Logs Insights' pipe syntax
    # vs. OpenSearch's Lucene query_string syntax); ask_results mode ignores
    # it, since answering questions about a sample of rows doesn't depend on
    # which backend produced them.
    backend: LogsBackend = "cloudwatch"


class AiAssistResponse(BaseModel):
    reply: str
    # build_query mode only: the query text extracted from the reply's code
    # block, ready to drop straight into the query editor.
    suggested_query: Optional[str] = None


# ---- Tools page ----
#
# A grid of small, independent developer utilities. Most (JWT, Base64, diff)
# run entirely client-side and never touch the backend. The two that do:
# the HTTP request tool (needs a server to avoid the browser's own CORS
# restrictions) and the MQTT tester (needs a server to mint a SigV4-signed
# connection URL with an environment's assumed-role credentials, though the
# MQTT session itself then runs straight from the browser to the broker).


class ToolHeader(BaseModel):
    key: str
    value: str


HttpMethod = Literal["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]


class HttpToolRequest(BaseModel):
    method: HttpMethod = "GET"
    url: str
    headers: list[ToolHeader] = []
    body: Optional[str] = None


class HttpToolResponse(BaseModel):
    status_code: int
    status_text: str
    headers: list[ToolHeader] = []
    body: str
    body_truncated: bool = False
    elapsed_ms: int


class MqttPresignedUrlRequest(BaseModel):
    environment_id: int


class MqttPresignedUrlResponse(BaseModel):
    endpoint: str
    url: str
    expires_in: int
    # A backend-side pre-flight check against this same URL -- browsers hide
    # the real reason a WebSocket handshake gets rejected, so this surfaces
    # whatever AWS actually said (status code + body) as a diagnostic.
    diagnostic_status_code: Optional[int] = None
    diagnostic_body: Optional[str] = None
    # Raw response headers from the pre-flight check -- a rejection that
    # never appears in AWS IoT Core's own connection logging (even with
    # DEBUG logging on) suggests something in the network path answered
    # before the request reached IoT Core at all; these headers are the
    # fastest way to tell a genuine AWS response from an intercepting
    # proxy/firewall's own.
    diagnostic_headers: list[str] = []
