from datetime import datetime
from typing import Any, Literal, Optional
from pydantic import BaseModel, ConfigDict, Field


# An environment is a named group of connections (PLATFORM_PLAN.md §14).
# `account_id`/`region` are its first AWS connection's, kept in and out so
# the old one-account shape still works (D34): creating an environment with
# them creates that connection, with the environment's own id.


class EnvironmentCreate(BaseModel):
    name: str
    description: Optional[str] = None
    account_id: Optional[str] = None
    region: Optional[str] = None


class EnvironmentUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    account_id: Optional[str] = None
    region: Optional[str] = None


class ConnectionOut(BaseModel):
    id: int
    environment_id: int
    type_id: str
    type_label: str
    name: str
    label: str
    config: dict[str, Any] = {}
    credential_id: Optional[int] = None
    credential_name: Optional[str] = None
    position: int = 0


class EnvironmentOut(BaseModel):
    id: int
    name: str
    description: Optional[str] = None
    account_id: str = ""
    region: str = ""
    connections: list[ConnectionOut] = []
    # Which groups see it -- admins only; empty for anyone else.
    group_ids: list[int] = []


class EnvironmentGroups(BaseModel):
    group_ids: list[int]


class ConnectionCreate(BaseModel):
    type_id: str
    name: str
    config: dict[str, Any] = {}
    credential_id: Optional[int] = None


class ConnectionUpdate(BaseModel):
    name: Optional[str] = None
    config: Optional[dict[str, Any]] = None
    credential_id: Optional[int] = None
    clear_credential: bool = False
    position: Optional[int] = None


class ConnectionTestRequest(BaseModel):
    group_id: int


class ConnectionTestResult(BaseModel):
    ok: bool
    message: str


class ConnectionTypeOut(BaseModel):
    id: str
    label: str
    description: Optional[str] = None
    fields: list[dict[str, Any]] = []
    identity_types: list[str] = []
    builtin: bool = True
    # "manifest:<pane type>" when a pane shipped it (D67); null for an admin's.
    origin: Optional[str] = None
    # How many connections are of this type, and which panes reach it: why it
    # can't be deleted, said before anyone tries.
    connections: int = 0
    needed_by: list[str] = []
    # Where it stands in the store repo (D70): synced, pending, conflict --
    # null when the store doesn't keep it (no store, or built in).
    store_state: Optional[str] = None


class ConnectionTypeFieldIn(BaseModel):
    key: str
    label: str = ""
    help: str = ""
    required: bool = False


class ConnectionTypeIn(BaseModel):
    """An HTTP connection type (D67). `id` only when creating; its Base URL
    field is always there and needn't be sent."""

    id: Optional[str] = None
    label: str
    description: Optional[str] = None
    fields: list[ConnectionTypeFieldIn] = []


class TargetOut(BaseModel):
    """A connection the caller can use, named the way pickers show it."""

    id: int
    label: str
    type_id: str
    environment_id: int
    environment: str
    connection: str
    config: dict[str, Any] = {}


class GroupIdentityIn(BaseModel):
    connection_type_id: str
    # Null: the group's default for the type; otherwise an override for one connection.
    connection_id: Optional[int] = None
    credential_id: int


class GroupIdentitiesIn(BaseModel):
    identities: list[GroupIdentityIn]


class GroupIdentityOut(GroupIdentityIn):
    connection_label: Optional[str] = None
    credential_name: str
    credential_type: str


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

TAB_FIELDS = [
    "logs_enabled",
    "opensearch_enabled",
    "iot_enabled",
    "tables_enabled",
    "buckets_enabled",
    "cognito_enabled",
    "tools_enabled",
    "aggregator_enabled",
    "agent_enabled",
]


class UserGroupBase(BaseModel):
    name: str
    role_name: Optional[str] = None
    logs_enabled: bool = True
    opensearch_enabled: bool = True
    iot_enabled: bool = True
    tables_enabled: bool = True
    buckets_enabled: bool = True
    cognito_enabled: bool = True
    aggregator_enabled: bool = True
    tools_enabled: bool = True
    # Off unless asked for: see UserGroup.agent_enabled.
    agent_enabled: bool = False


class UserGroupCreate(UserGroupBase):
    # Environment ids this group can see (ignored for the Admin group, which
    # always sees every environment regardless of this list).
    environment_ids: list[int] = []
    # Exactly the pane types it may use (D65). Left out, the booleans above
    # are taken as shorthand for them, as they always meant.
    pane_types: Optional[list[str]] = None


class UserGroupUpdate(BaseModel):
    name: Optional[str] = None
    role_name: Optional[str] = None
    logs_enabled: Optional[bool] = None
    opensearch_enabled: Optional[bool] = None
    iot_enabled: Optional[bool] = None
    tables_enabled: Optional[bool] = None
    buckets_enabled: Optional[bool] = None
    cognito_enabled: Optional[bool] = None
    aggregator_enabled: Optional[bool] = None
    tools_enabled: Optional[bool] = None
    agent_enabled: Optional[bool] = None
    environment_ids: Optional[list[int]] = None
    # Exactly the pane types it may use (D65); wins over the booleans above,
    # which are shorthand for grants of the panes that name them.
    pane_types: Optional[list[str]] = None


class UserGroupOut(UserGroupBase):
    model_config = ConfigDict(from_attributes=True)
    id: int
    is_admin: bool
    environment_ids: list[int] = []
    user_count: int = 0
    # The pane types it may use (every one, for the Admin group). The
    # booleans are worked out from these.
    pane_types: list[str] = []


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
    avatar_url: Optional[str] = None
    # The user's group's tab visibility -- included here (not just on
    # UserGroupOut) because /api/auth/me is how a non-admin user, who can't
    # call the admin-only /api/user-groups, finds out which tabs they can see.
    logs_enabled: bool
    opensearch_enabled: bool
    iot_enabled: bool
    tables_enabled: bool
    buckets_enabled: bool
    cognito_enabled: bool
    aggregator_enabled: bool
    tools_enabled: bool
    agent_enabled: bool = False
    # The pane types the user's group may use (D65): what the catalogue offers.
    pane_types: list[str] = []


class LoginRequest(BaseModel):
    username: str
    password: str


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


class ProfileUpdate(BaseModel):
    # Self-service only (own avatar) -- distinct from UserUpdate, which is
    # admin-only and covers group/password for any user.
    avatar_url: Optional[str] = None


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
    # A search's keys looked at by this request (0 when browsing a folder).
    scanned: int = 0


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


class SavedInputCreate(BaseModel):
    pane_type: str
    name: str = Field(min_length=1, max_length=200)
    inputs: dict


class SavedInputUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=200)
    inputs: Optional[dict] = None


class SavedInputOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    pane_type: str
    name: str
    inputs: dict
    created_at: Optional[datetime] = None


# ---- Live sessions ----
#
# The sessions currently open in someone's side panel, autosaved. Distinct
# from a SavedSession, which is a named template you start a new session from:
# nobody names these and nobody presses save. `client_id` is the id the browser
# generated for the session, `state` is the page's own free-form JSON, and
# `truncated` says the browser dropped the results to stay under its size cap.
#
# Which session is *active* deliberately isn't here: that's which tab you are
# looking at in this browser, not something to follow you to another machine.


class LiveSessionUpsert(BaseModel):
    type: str
    title: str
    position: int = 0
    category_id: Optional[int] = None
    state: dict = Field(default_factory=dict)
    truncated: bool = False
    # The version this write was made from. Stale (the row has moved on since)
    # is a 409 the writer resolves by merging; absent means "overwrite
    # regardless", which is what a browser from before versions existed sends.
    base_version: Optional[int] = None


# The caller's own relationship to a session: "owner" for their own, or
# whatever permission they were invited at. Position, category and closed
# state below are always *this caller's own view* -- the owner's columns on
# LiveSession for "owner", this member's own columns on SessionMember
# otherwise -- never someone else's, even though `state` itself (and
# `version`) is the one shared document everyone sees alike.
SessionRole = Literal["owner", "editor", "viewer"]


class LiveSessionOut(BaseModel):
    client_id: str
    type: str
    title: str
    position: int
    category_id: Optional[int] = None
    state: dict
    truncated: bool
    closed_at: Optional[datetime] = None
    version: int = 0
    role: SessionRole = "owner"
    # Each pane's outputs, apart from `state` (D21): {pane: {version, values}}.
    outputs: dict[str, "PaneOutputsOut"] = {}


class PaneOutputsOut(BaseModel):
    version: int
    values: dict


class PaneOutputsClear(BaseModel):
    keys: list[str] = Field(max_length=200)


LiveSessionOut.model_rebuild()


class HomeSessionRef(BaseModel):
    client_id: str
    title: str
    # Closed in the caller's own panel: Home reopens it.
    closed: bool


class HomeSessionOut(BaseModel):
    """The caller's home page (R3, D63): a session they can reach, or the
    title of one that was deleted or isn't shared with them any more -- or
    neither, when none is set."""

    home: Optional[HomeSessionRef] = None
    missing: Optional[str] = None


class LiveSessionSummary(BaseModel):
    """A closed session as the side panel lists it: enough to show and reopen,
    without its rows. Nothing trims the closed list, so sending every session's
    state on every page load would make the app slower the longer you used it."""

    client_id: str
    type: str
    title: str
    truncated: bool
    closed_at: Optional[datetime] = None
    # So the panel can still group a closed session under its category instead
    # of pulling it into a separate list -- without this the closed listing had
    # no way to say which category a session belonged to before it was closed.
    category_id: Optional[int] = None
    role: SessionRole = "owner"


class LiveSessionOrder(BaseModel):
    """The open sessions in the order they should appear. Ids the caller does
    not own are ignored rather than rejected: a stale tab reordering a session
    that another tab has since deleted shouldn't fail the whole request."""

    client_ids: list[str]


# ---- Sharing a session ----
# Phase 1 of sharing: who is invited to a session, and at what permission.
# "viewer" is read-only; "editor" can also edit inputs, add or remove panes,
# and run tools and services -- everything short of managing membership
# itself, which stays the owner's alone.

SessionPermission = Literal["viewer", "editor"]


class SessionMemberOut(BaseModel):
    user_id: int
    username: str
    permission: SessionPermission


class SessionMemberCreate(BaseModel):
    username: str
    permission: SessionPermission = "editor"


class SessionMemberUpdate(BaseModel):
    permission: SessionPermission


class UserSuggestion(BaseModel):
    """Just enough to fill an invite field's dropdown -- never the full
    UserOut (group_id/group_name/is_admin/tab flags), since this is reachable
    by any authenticated user, not just admins (see routers/users.py's
    suggest_users)."""

    id: int
    username: str


class SessionParticipant(BaseModel):
    """Everyone who can currently reach a session -- the owner and every
    invited member -- for @mentioning them in its chat. Unlike
    SessionMemberOut's list (the roster /members manages, owner-only),
    this is reachable by any participant and includes the owner too: knowing
    who else is here isn't the same capability as inviting or removing them."""

    user_id: int
    username: str
    role: SessionRole


# ---- Session categories ----
# Slack-style groups for the side panel's session list. A category holds no
# state of its own -- LiveSession.category_id is what actually assigns a
# session to one.


class SessionCategoryCreate(BaseModel):
    name: str


class SessionCategoryUpdate(BaseModel):
    name: Optional[str] = None


class SessionCategoryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    position: int


class SessionCategoryOrder(BaseModel):
    """Category ids in the order they should appear, same convention as
    LiveSessionOrder: ids the caller does not own are ignored rather than
    rejected."""

    ids: list[int]


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
    # A credential to authenticate with, by id: the backend resolves it and
    # applies its type's `inject`, so its secret never reaches the browser.
    credential_id: Optional[int] = None
    # An HTTP API connection to send to (D33): `url` is then a path joined to
    # its base URL, and without a credential_id the request is signed with
    # the caller's group's identity there, or the connection's own.
    target_id: Optional[int] = None


class HttpToolResponse(BaseModel):
    status_code: int
    status_text: str
    headers: list[ToolHeader] = []
    body: str
    body_truncated: bool = False
    elapsed_ms: int


class CredentialTypeIn(BaseModel):
    id: str = Field(max_length=64)
    label: str = Field(min_length=1, max_length=100)
    description: Optional[str] = Field(default=None, max_length=1000)
    fields: list[dict]
    output_template: Optional[str] = Field(default=None, max_length=10_000)
    inject: Optional[dict] = None
    http_test: Optional[dict] = None


class CredentialTypeUpdate(BaseModel):
    label: Optional[str] = Field(default=None, min_length=1, max_length=100)
    description: Optional[str] = Field(default=None, max_length=1000)
    fields: Optional[list[dict]] = None
    output_template: Optional[str] = Field(default=None, max_length=10_000)
    inject: Optional[dict] = None
    http_test: Optional[dict] = None
    # Removing a field that holds values in existing credentials discards
    # them; the first attempt is refused with the list, this confirms it.
    confirm_remove: bool = False


class CredentialTypeOut(BaseModel):
    id: str
    label: str
    description: Optional[str] = None
    version: int
    fields: list[dict]
    output_template: Optional[str] = None
    inject: Optional[dict] = None
    http_test: Optional[dict] = None
    builtin: bool
    in_use: int = 0
    has_test: bool = False
    store_state: Optional[str] = None


class CredentialTypeInfer(BaseModel):
    example: Any


class CredentialTypePreview(BaseModel):
    fields: list[dict]
    output_template: Optional[str] = None
    values: dict = Field(default_factory=dict)


class CredentialIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    type_id: str = Field(max_length=64)
    scope: Literal["global", "group"]
    group_id: Optional[int] = None
    description: Optional[str] = Field(default=None, max_length=1000)
    values: dict = Field(default_factory=dict)


class CredentialUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=200)
    description: Optional[str] = Field(default=None, max_length=1000)
    values: Optional[dict] = None
    clear: Optional[list[str]] = None


class CredentialOut(BaseModel):
    id: int
    name: str
    type_id: str
    type_label: str
    type_version: int
    description: Optional[str] = None
    scope: str
    group_id: Optional[int] = None
    group_name: Optional[str] = None
    public_fields: dict
    secret_fields_set: list[str]
    grants: list[int]
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    last_tested_at: Optional[datetime] = None
    last_test_ok: Optional[bool] = None
    last_test_message: Optional[str] = None
    last_used_at: Optional[datetime] = None
    authenticates: bool = False


class CredentialSummary(BaseModel):
    """What a non-admin sees of a credential their group can use: enough to
    pick it, nothing about its contents."""

    id: int
    name: str
    type_id: str
    type_label: str
    scope: str
    # Whether its type says how to authenticate an HTTP request (`inject`),
    # i.e. whether the HTTP client can use it.
    authenticates: bool = False


class CredentialTestOut(BaseModel):
    ok: Optional[bool] = None
    message: str


class CredentialsStatus(BaseModel):
    enabled: bool
    reason: Optional[str] = None
    key_id: Optional[str] = None


class AuditEventOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    at: datetime
    actor_name: Optional[str] = None
    actor_kind: str
    action: str
    object_type: str
    object_id: str
    group_id: Optional[int] = None
    detail: dict


class StoreIn(BaseModel):
    """Settings → Store, when Helm leaves it unset (PLATFORM_PLAN.md §21.7)."""

    url: str
    branch: str = "main"
    path: str = ""
    namespace: str
    author_domain: str = "platform.local"
    username: str = ""
    credential_id: Optional[int] = None
    known_hosts: str = ""


class StoreResolveIn(BaseModel):
    take: str  # "mine" | "theirs"
