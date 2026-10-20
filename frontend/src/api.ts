import type { PaneManifest } from "./panes/manifest";
/** What a pane picks as an "environment": an AWS connection the user can
 * reach (PLATFORM_PLAN.md §14). `name` is "Prod", or "Prod · iot" where an
 * environment holds several. Its id is the connection's -- the same number
 * the environment itself had before connections existed (D34), so every
 * stored id still names the same place. */
export interface Environment {
  id: number;
  name: string;
  account_id: string;
  region: string;
}

/** A connection the user can use, as /api/targets lists it. */
export interface Target {
  id: number;
  label: string;
  type_id: string;
  environment_id: number;
  environment: string;
  connection: string;
  config: Record<string, string>;
}

/** One configured target inside an environment: where something is. */
export interface Connection {
  id: number;
  environment_id: number;
  type_id: string;
  type_label: string;
  name: string;
  label: string;
  config: Record<string, string>;
  /** Its own identity, used only by a group that has none for it. */
  credential_id: number | null;
  credential_name: string | null;
  position: number;
}

/** An environment as Settings manages it: a named group of connections. */
export interface EnvironmentRecord {
  id: number;
  name: string;
  description: string | null;
  account_id: string;
  region: string;
  connections: Connection[];
  /** The groups that see it (admins see every environment anyway). */
  group_ids: number[];
}

export interface ConnectionType {
  id: string;
  label: string;
  description: string | null;
  fields: CredentialField[];
  /** Credential type ids a group may use as its identity; "@inject" means any that can sign an HTTP request. */
  identity_types: string[];
  builtin: boolean;
  /** "manifest:<pane type>" when a pane shipped it (D67); null for an admin's own. */
  origin: string | null;
  /** How many connections are of it, and which panes reach it: why it can't be deleted. */
  connections: number;
  needed_by: string[];
  /** Where it stands in the store repo (D70); null when the store doesn't keep it. */
  store_state?: StoreState | null;
}

/** An HTTP connection type as an admin saves it (D67): its Base URL is always there. */
export interface ConnectionTypeDraft {
  id?: string;
  label: string;
  description: string | null;
  fields: { key: string; label: string; help: string; required: boolean }[];
}

/** Who a group is on a kind of connection (D31): its default for a type (no connection_id) or an override. */
export interface GroupIdentity {
  connection_type_id: string;
  connection_id: number | null;
  credential_id: number;
  connection_label?: string | null;
  credential_name?: string;
  credential_type?: string;
}

export interface Settings {
  app_title: string | null;
  /** A URL, including a data: URL for an uploaded image, shown right before the app title in the top bar. */
  app_logo_url: string | null;
}

/** A user belongs to exactly one group; the group is the sole unit of
 * access control -- which IAM role to assume, which tabs are visible, and
 * (for non-admin groups) which environments are visible. */
export interface UserGroup {
  id: number;
  name: string;
  role_name: string | null;
  is_admin: boolean;
  logs_enabled: boolean;
  opensearch_enabled: boolean;
  iot_enabled: boolean;
  tables_enabled: boolean;
  buckets_enabled: boolean;
  cognito_enabled: boolean;
  aggregator_enabled: boolean;
  tools_enabled: boolean;
  /** The platform agent. Off unless an admin turns it on: it acts with
   * everything the group can reach. */
  agent_enabled: boolean;
  /** The Builder (§24): makes pane types. Off unless an admin turns it on. */
  builder_enabled: boolean;
  /** Ignored for the Admin group, which always sees every environment. */
  environment_ids: number[];
  user_count: number;
  /** The pane types it may use (D65; every one for the Admin group). The
   * *_enabled booleans above are worked out from these, and kept as shorthand. */
  pane_types: string[];
}

/** The catalogue panes are picked from (D66): its categories in order, each
 * with the pane types the caller may use, and their own favourites and hidden. */
export interface Catalogue {
  /** `description`: a line under its name where panes are offered; "" for none. */
  categories: { id: number; name: string; description: string; pane_types: string[] }[];
  favourites: string[];
  hidden: string[];
}

/** The user's home page (R3, D63): a session they can reach, or the title of
 * one that's gone (deleted, or no longer shared with them), or neither. */
export interface HomeSession {
  home: { client_id: string; title: string; closed: boolean } | null;
  missing: string | null;
}

export interface User {
  id: number;
  username: string;
  group_id: number;
  group_name: string;
  is_admin: boolean;
  avatar_url: string | null;
  logs_enabled: boolean;
  opensearch_enabled: boolean;
  iot_enabled: boolean;
  tables_enabled: boolean;
  buckets_enabled: boolean;
  cognito_enabled: boolean;
  aggregator_enabled: boolean;
  tools_enabled: boolean;
  agent_enabled: boolean;
  /** Whether they build pane types (§24): their group's Builder, or an admin. */
  builder_enabled: boolean;
  /** The pane types the user's group may use (D65): what the catalogue offers. */
  pane_types: string[];
}

/** One pane's inputs under a name (PLATFORM_PLAN.md D46). Never a sensitive input. */
export interface SavedInput {
  id: number;
  pane_type: string;
  name: string;
  inputs: Record<string, unknown>;
  created_at?: string | null;
}

export interface SavedSession<T = Record<string, unknown>> {
  id: number;
  page: string;
  name: string;
  state: T;
}

/** A pane type made in the platform (the Builder, §24): its manifest as written. */
export interface BuiltPaneType {
  id: string;
  label: string;
  source: string;
  updated_at: string | null;
  updated_by: string | null;
  store_state: StoreState | null;
  /** Whether it loads now: a handler it names may have gone since. */
  loads: boolean;
}

/** A step type made in the Builder (D122): a declarative HTTP request, or a
 * chain of steps, a workflow uses by name as one step. */
/** What's being built and isn't saved (D125): the editor's text, the Id typed
 * for a new one and the Building chat, saved as its builder types. Theirs alone. */
export interface BuildDraft {
  id: number;
  kind: "pane" | "step" | "workflow";
  /** The pane type, step type or workflow it changes; null for a new one. */
  target_id: string | null;
  new_id: string;
  label: string;
  updated_at: string;
  turns: number;
  /** False for a saved one's draft that holds only its chat (kept after Save). */
  changed: boolean;
  /** Only when read whole (one draft, or an existing one's). */
  source?: string;
  chat?: unknown[];
}

export interface BuiltStepType {
  id: string;
  label: string;
  description: string | null;
  /** "request" or "steps"; null when it doesn't load now. */
  kind: "request" | "steps" | null;
  /** A workflow's step using it waits for a person: it changes something. */
  external: boolean;
  inputs: WorkflowParam[];
  source: string;
  loads: boolean;
  can_edit: boolean;
  updated_at: string | null;
  updated_by: string | null;
  store_state: StoreState | null;
}

export interface StepSchema {
  starter: string;
  chain_example: string;
  namespace: string | null;
  reference: Record<string, unknown>;
}

/** What a pane type's definition may say: for the editor's reference. */
export interface BuilderSchema {
  handlers: string[];
  live: string[];
  /** What the form editor's pickers offer (5-2d). */
  input_types: string[];
  renders: string[];
  /** The bundled pane types, whose manifests are the examples to read. */
  examples: string[];
  starter: string;
  /** The store's namespace a new id is saved under, or null without a store (D78). */
  namespace: string | null;
}

/** A published template (PLATFORM_PLAN.md §23, D99): plugin content, offered
 * to whoever may use each of its panes, opened for an environment they choose. */
export interface PublishedTemplate {
  id: string;
  label: string;
  description: string | null;
  pane_types: string[];
  needs_environment: boolean;
  /** Whether the asker's group may use every pane of it (an admin sees all). */
  usable: boolean;
  store_state: StoreState | null;
  /** The asker's own saved template it was published from, if it was theirs. */
  from_saved_session_id: number | null;
}

/**
 * One of the sessions open in the side panel, as the server last heard about
 * it. A SavedSession above is a named template you start a session *from*;
 * this is the live working state of a session already open, autosaved.
 *
 * `state` is a page's own bag, tag-encoded by sessions/storage before it is
 * sent: pages keep Sets and Maps, and plain JSON turns those into `{}`
 * silently -- handing the page back a selection it can no longer read. The
 * backend stores it as opaque JSON either way.
 */
/** The caller's own relationship to a session: "owner" for their own, or
 * whatever permission they were invited at if it's shared with them.
 * position/category_id/closed_at are always this caller's own view too --
 * the owner's, or the caller's own as an invited member -- never someone
 * else's, even though `state` and `version` are the one document everyone
 * who can reach the session sees alike. */
export type SessionRole = "owner" | "editor" | "viewer";

/** A closed session as the side panel lists it. No `state`: nothing trims the
 * closed list, so sending every session's rows on every page load would make
 * the app slower the longer you had used it. The rows arrive with
 * `getLiveSession` when one is actually reopened. */
export interface LiveSessionSummary {
  client_id: string;
  type: string;
  title: string;
  truncated: boolean;
  closed_at: string | null;
  /** Which side-panel category it was in when closed, so the panel can still
   * group it there dimmed rather than pulling it into a separate list. */
  category_id: number | null;
  role: SessionRole;
}

export interface LiveSession {
  client_id: string;
  type: string;
  title: string;
  position: number;
  /** Which side-panel category this session sits in, if any. Null for one
   * never assigned to a category, or whose category was deleted. */
  category_id: number | null;
  state: Record<string, unknown>;
  /** The browser dropped this session's results to stay under its size cap,
   * so the page can say so rather than looking like it found nothing. */
  truncated: boolean;
  /** Null while it is open; set once it is closed but still reopenable. */
  closed_at: string | null;
  role: SessionRole;
  /** Bumped by the server on every write, whoever made it. A write says which
   * version it was made from, and one made from an older version is refused
   * (409) so the writer merges instead of overwriting a change it never saw. */
  version: number;
  /** Each pane's outputs, apart from `state` and versioned on their own
   * (PLATFORM_PLAN.md D21, sessions/outputs.ts). */
  outputs?: Record<string, PaneOutputs>;
}

/** One pane's outputs as the server holds them. Version 0 is outputs still in
 * an old session's state, not yet moved into a record. */
export interface PaneOutputs {
  version: number;
  values: Record<string, unknown>;
}

/** A named group of sessions in the side panel, the way a Slack workspace
 * groups channels. Holds no state of its own -- a LiveSession's own
 * category_id is what actually puts it in one. */
export interface SessionCategory {
  id: number;
  name: string;
  position: number;
}

/** "viewer" is read-only; "editor" can also edit inputs, add or remove
 * panes, and run tools and services -- everything short of managing
 * membership itself, which stays the owner's alone. */
export type SessionPermission = "viewer" | "editor";

/** A user other than the owner invited into a live session. Phase 1 of
 * sharing: this is only the roster -- an invited member can't reach the
 * session yet (that's a later phase), so today only the owner ever sees
 * this list, for the session they already own. */
export interface SessionMember {
  user_id: number;
  username: string;
  permission: SessionPermission;
  avatar_url?: string | null;
}

/** A username-prefix match for the invite field's suggestion dropdown --
 * deliberately just enough to fill it in, never the full `User` (group,
 * admin, tab flags): `suggestUsers` is open to any authenticated user, not
 * just admins, since the invite endpoint it feeds already lets any user
 * invite any other by exact username, in any group. */
export interface UserSuggestion {
  id: number;
  username: string;
}

/** Everyone who can currently reach a session -- the owner and every invited
 * member -- for @mentioning them in its chat. Unlike `SessionMember`'s list
 * (the roster `/members` manages, owner-only), `listSessionParticipants` is
 * reachable by any participant and includes the owner too. */
export interface SessionParticipant {
  user_id: number;
  username: string;
  role: SessionRole;
  avatar_url?: string | null;
}

// ---- Tools page ----


const BASE = "/api";

/** This tab's own id, sent with every request as X-Sync-Origin. The server
 * stamps it on the change announcements it sends out (see
 * sessions/liveEvents.ts), which is how a tab tells the echo of its own write
 * from someone else's -- another tab, another machine, the platform agent.
 * Per tab rather than per browser on purpose: two tabs are two writers. */
export const SYNC_ORIGIN = `tab-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;


// ------------------------------------------------------------------ credentials
// Typed secrets (PLATFORM_PLAN.md §13). Nothing the backend sends ever holds a
// secret value: a secret field is only reported as set, in secret_fields_set.

export type CredentialFieldKind = "text" | "multiline" | "number" | "bool" | "choice" | "json" | "file";

export interface CredentialField {
  key: string;
  label: string;
  kind: CredentialFieldKind;
  secret: boolean;
  required: boolean;
  help: string;
  default?: unknown;
  choices?: string[];
}

/** How a credential of a type authenticates an HTTP request; the values are CEL over its fields. */
export interface CredentialInject {
  kind: "header" | "basic" | "query";
  name?: string;
  name_from?: string;
  value?: string;
  username?: string;
  password?: string;
}

export interface CredentialHttpTest {
  method: string;
  url: string;
  headers: Record<string, string>;
}

export interface CredentialType {
  id: string;
  label: string;
  description: string | null;
  version: number;
  fields: CredentialField[];
  output_template: string | null;
  inject: CredentialInject | null;
  http_test: CredentialHttpTest | null;
  builtin: boolean;
  in_use: number;
  has_test: boolean;
  store_state?: StoreState | null;
}

/** An item's place in the store repo (PLATFORM_PLAN.md §21): pushed, waiting
 * to be, or edited in the repo since this platform last wrote it. */
export type StoreState = "synced" | "pending" | "conflict" | "error";

export interface StoreItem {
  kind: string;
  noun: string;
  item_id: string;
  label: string;
  path: string;
  state: StoreState;
  error: string | null;
}

/** Settings → Store. Never a token or key: `auth` says which kind is set. */
export interface StoreStatus {
  configured: boolean;
  source: "helm" | "settings" | null;
  locked: boolean;
  url: string | null;
  branch: string | null;
  path: string | null;
  namespace: string | null;
  author_domain: string | null;
  username: string | null;
  known_hosts: string | null;
  credential_id: number | null;
  credential_name: string | null;
  auth: "token" | "ssh key" | "none" | null;
  problem: string | null;
  last_sync_at: string | null;
  last_error: string | null;
  pending: number;
  items: StoreItem[];
  restored?: string[];
}

/** A workflow's parameter (PLATFORM_PLAN.md §22.2): the pane inputs' own vocabulary. */
export interface WorkflowParam {
  key: string;
  type: "text" | "int" | "bool" | "choice" | "connection" | "connections";
  label?: string;
  help?: string;
  default?: unknown;
  required?: boolean;
  choices?: unknown[];
  connection_type?: string;
  /** A list of texts rather than one. */
  multiple?: boolean;
  /** Choices listed by a pane input's loader, from the other parameters (D94). */
  options_from?: { pane: string; input: string; with?: Record<string, unknown> };
}

/** A parameter's listed choices: `needs` names the parameters to fill in first;
 * a loader's failure is `error` (per environment, `errors`), never thrown. */
export interface WorkflowParamOptions {
  options: { value: string; label: string }[];
  needs?: string[];
  error?: string;
  errors?: string[];
}

export type RunStatus = "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled";
export type StepStatus = "pending" | "running" | "waiting" | "succeeded" | "failed" | "skipped" | "cancelled";

/** A decision a person must make before a step runs (D88). In the pending
 * list it also says which run it's in. */
export interface WorkflowApproval {
  id: number;
  status: "pending" | "approved" | "denied" | "expired" | "cancelled";
  message: string;
  /** What the step will do: its resolved inputs, or a for_each's first items. */
  details: { inputs?: Record<string, unknown>; count?: number; items?: Record<string, unknown>[] } | null;
  by: "anyone" | "others" | "admins";
  step_id: string | null;
  run_id: number | null;
  created_at: string | null;
  expires_at: string | null;
  decided_by: string | null;
  decided_at: string | null;
  comment: string | null;
  can_decide: boolean;
  workflow_id?: string | null;
  workflow_label?: string | null;
  run_number?: number | null;
  started_by?: string | null;
}

/** A file in the blob store (D91): a run's artifact, or a step's whole outputs. */
export interface BlobRef {
  id: string;
  name: string;
  size: number;
  content_type: string;
}

export interface WorkflowRunStep {
  position: number;
  id: string;
  label: string | null;
  status: StepStatus;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  inputs?: unknown;
  outputs?: Record<string, unknown> | null;
  trimmed?: boolean;
  /** The whole outputs, when the row holds them cut down (D91). */
  outputs_blob?: string | null;
  /** The most attempts one call took (`retry`). */
  attempts: number;
  /** Copied from the run this one reran from a later stage of (D90). */
  reused: boolean;
  approval?: WorkflowApproval;
}

/** A run. Its params, steps and outputs only when `readable` (D84): they came
 * from its starter's environments. */
export interface WorkflowRun {
  id: number;
  workflow_id: string;
  workflow_label: string;
  number: number;
  status: RunStatus;
  trigger: string;
  started_by: string | null;
  created_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  readable: boolean;
  cancel_requested: boolean;
  rerun_of: number | null;
  rerun_from: string | null;
  params?: Record<string, unknown>;
  error?: string | null;
  steps?: WorkflowRunStep[];
  /** The workflow as it was when the run started (a run's own page only). */
  definition?: { parameters?: WorkflowParam[]; steps?: { id: string; pane?: string }[] };
  artifacts?: (BlobRef & { position: number | null })[];
}

export interface Workflow {
  id: string;
  label: string;
  description: string | null;
  parameters: WorkflowParam[];
  steps: number;
  can_edit: boolean;
  can_run: boolean;
  last_run: WorkflowRun | null;
  store_state?: StoreState | null;
  source?: string;
  group_ids?: number[];
}

export interface WorkflowProblem {
  line: number | null;
  message: string;
}

export interface StoreDraft {
  url: string;
  branch: string;
  path: string;
  namespace: string;
  author_domain: string;
  username: string;
  credential_id: number | null;
  known_hosts: string;
}

export type CredentialTypeDraft = Pick<CredentialType, "id" | "label" | "description" | "fields" | "output_template" | "inject" | "http_test">;

export interface Credential {
  id: number;
  name: string;
  type_id: string;
  type_label: string;
  type_version: number;
  description: string | null;
  scope: "global" | "group";
  group_id: number | null;
  group_name: string | null;
  public_fields: Record<string, unknown>;
  secret_fields_set: string[];
  grants: number[];
  created_at: string | null;
  updated_at: string | null;
  last_tested_at: string | null;
  last_test_ok: boolean | null;
  last_test_message: string | null;
  last_used_at: string | null;
  /** Whether its type says how to authenticate an HTTP request. */
  authenticates: boolean;
}

/** What a non-admin sees of a credential their group can use: enough to pick it. */
export interface CredentialSummary {
  id: number;
  name: string;
  type_id: string;
  type_label: string;
  scope: "global" | "group";
  authenticates: boolean;
}

export interface CredentialsStatus {
  enabled: boolean;
  reason: string | null;
  key_id?: string | null;
}

export interface AuditEvent {
  id: number;
  at: string;
  actor_name: string | null;
  actor_kind: string;
  action: string;
  object_type: string;
  object_id: string;
  group_id: number | null;
  detail: Record<string, unknown>;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// Set by AuthContext so that a 401 from ANY api call (not just the initial
// /auth/me check) -- e.g. a session that expired while a background page was
// still open -- immediately drops the app back to the login page, instead of
// each page having to handle it individually.
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null) {
  onUnauthorized = fn;
}

// ---- Platform agent ----

/** Whether this deployment runs the agent, and whether your group may use it. */
export interface AgentStatus {
  available: boolean;
  enabled: boolean;
}

/** A tool an earlier answer used, sent back with it so the agent sees what
 * it actually ran rather than only what it said. */
export interface AgentHistoryStep {
  /** The provider's own id for the call, replayed as it was. */
  id: string;
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  summary: string;
}

export interface AgentChatMessage {
  role: "user" | "assistant";
  content: string;
  steps?: AgentHistoryStep[];
}

/** One step of an agent turn as it happens (platform-agent/app/agent.py). */
export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "retract"; chars: number }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown>; preamble?: boolean }
  | {
      type: "tool_result";
      id: string;
      name: string;
      ok: boolean;
      summary: string;
      session_id?: string;
      /** A place in the app a tool asked to show (`open_workflow`, a run it started). */
      show?: { href: string };
      /** A definition the agent put forward for the editor on screen (D107). */
      propose?: { kind: string; source: string; summary?: string };
    }
  | { type: "notice"; message: string }
  | { type: "error"; message: string }
  | { type: "done" };

/** The readable part of an error response: FastAPI's `detail` if there is one. */
function detailOf(text: string): string {
  try {
    const parsed = JSON.parse(text) as { detail?: unknown };
    if (typeof parsed.detail === "string") return parsed.detail;
    // A detail with every problem in it (a definition's check): its sentence.
    const message = (parsed.detail as { message?: unknown } | undefined)?.message;
    if (typeof message === "string") return message;
  } catch {
    // not JSON; the text is the message
  }
  return text;
}

/** What to show for a failed call: the backend's own sentence, not the
 * "400 Bad Request: {...}" an ApiError's message starts with. */
export function readableError(e: unknown): string {
  if (e instanceof ApiError) {
    const body = e.message.replace(/^\d{3} [^:]*: /, "");
    return detailOf(body) || e.message;
  }
  return e instanceof Error ? e.message : "Something went wrong.";
}

/**
 * Runs one agent turn, calling `onEvent` for each step as it streams in. A
 * stream rather than a request, because a turn is many steps over up to a
 * few minutes and each is worth showing the moment it happens. Resolves when
 * the turn's stream ends; `signal` stops it (and the agent with it).
 */
async function agentChat(
  body: {
    messages: AgentChatMessage[];
    viewing_session_id: string | null;
    timezone: string;
    scope: "global" | "session" | "run" | "build";
    run_id?: number | null;
    build?: { kind: "pane" | "workflow" | "step"; id: string | null; title: string; source: string };
  },
  onEvent: (event: AgentEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(`${BASE}/agent/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Sync-Origin": SYNC_ORIGIN },
    credentials: "same-origin",
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    if (res.status === 401) onUnauthorized?.();
    throw new ApiError(res.status, detailOf(await res.text().catch(() => "")) || `${res.status} ${res.statusText}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      // Comment lines are the stream's heartbeat; only data lines are events.
      for (const line of block.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        try {
          onEvent(JSON.parse(line.slice(6)) as AgentEvent);
        } catch {
          // a malformed line is skipped rather than ending the turn
        }
      }
    }
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const { headers, ...rest } = init ?? {};
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json", "X-Sync-Origin": SYNC_ORIGIN, ...headers },
    credentials: "same-origin",
    ...rest,
  });
  if (!res.ok) {
    if (res.status === 401 && path !== "/auth/login") onUnauthorized?.();
    const text = await res.text().catch(() => "");
    throw new ApiError(res.status, `${res.status} ${res.statusText}: ${text}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  login: (username: string, password: string) =>
    req<User>("/auth/login", { method: "POST", body: JSON.stringify({ username, password }) }),
  logout: () => req<void>("/auth/logout", { method: "POST" }),
  me: () => req<User>("/auth/me"),
  changeOwnPassword: (current_password: string, new_password: string) =>
    req<User>("/auth/password", { method: "PUT", body: JSON.stringify({ current_password, new_password }) }),
  updateOwnProfile: (avatar_url: string | null) =>
    req<User>("/auth/profile", { method: "PUT", body: JSON.stringify({ avatar_url }) }),

  listUsers: () => req<User[]>("/users"),
  suggestUsers: (prefix: string) => req<UserSuggestion[]>(`/users/suggest?prefix=${encodeURIComponent(prefix)}`),
  createUser: (payload: { username: string; password: string; group_id: number }) =>
    req<User>("/users", { method: "POST", body: JSON.stringify(payload) }),
  updateUser: (id: number, payload: Partial<{ group_id: number; password: string }>) =>
    req<User>(`/users/${id}`, { method: "PUT", body: JSON.stringify(payload) }),
  deleteUser: (id: number) => req<void>(`/users/${id}`, { method: "DELETE" }),

  listUserGroups: () => req<UserGroup[]>("/user-groups"),
  // Only the name is needed: the server's defaults fill the rest, and
  // `pane_types` says exactly what it may use (D65).
  createUserGroup: (payload: Pick<UserGroup, "name"> & Partial<Omit<UserGroup, "id" | "is_admin" | "user_count">>) =>
    req<UserGroup>("/user-groups", { method: "POST", body: JSON.stringify(payload) }),
  updateUserGroup: (id: number, payload: Partial<Omit<UserGroup, "id" | "is_admin" | "user_count">>) =>
    req<UserGroup>(`/user-groups/${id}`, { method: "PUT", body: JSON.stringify(payload) }),
  deleteUserGroup: (id: number) => req<void>(`/user-groups/${id}`, { method: "DELETE" }),

  /** What a pane's environment picker offers: every AWS connection the user can reach, shaped as an Environment. */
  listEnvironments: async (): Promise<Environment[]> =>
    (await req<Target[]>("/targets?type=aws")).map((t) => ({
      id: t.id,
      name: t.label,
      account_id: t.config.account_id ?? "",
      region: t.config.region ?? "",
    })),
  listTargets: (type?: string) => req<Target[]>(`/targets${type ? `?type=${encodeURIComponent(type)}` : ""}`),

  /** Every pane type the user's group may use, as its manifest describes it (PLATFORM_PLAN.md §15). */
  listPaneTypes: () => req<PaneManifest[]>("/pane-types"),
  /** Runs a manifest action that needs the server (the API table's Fetch); returns its outputs by key. */
  runPaneAction: (
    type: string,
    action: string,
    inputs: Record<string, unknown>,
    cursor?: unknown,
    /** The session and pane it runs for -- where the server stores its outputs
     * (D21) or a background run (D51) -- a time range's zone, a restart, and
     * outputs an input change made stale, cleared in the same write. */
    extra?: { session?: string; pane?: string; timezone?: string; restart?: boolean; clear?: string[] },
  ) =>
    req<Record<string, unknown>>(`/panes/${encodeURIComponent(type)}/actions/${encodeURIComponent(action)}`, {
      method: "POST",
      // A cursor only for Load more: a first run's request is just its inputs.
      body: JSON.stringify({ inputs, ...(cursor === undefined || cursor === null ? {} : { cursor }), ...(extra ?? {}) }),
    }),
  /** Stops a pane's background run (a CloudWatch query), whoever started it. */
  stopPaneRun: (type: string, session: string, pane: string) =>
    req<{ stopped: boolean }>(`/panes/${encodeURIComponent(type)}/stop`, {
      method: "POST",
      body: JSON.stringify({ session, pane }),
    }),

  /** A pane's inputs saved under a name (D46), by pane type; the user's own. */
  listSavedInputs: (paneType?: string) =>
    req<SavedInput[]>(`/saved-inputs${paneType ? `?pane_type=${encodeURIComponent(paneType)}` : ""}`),
  createSavedInputs: (payload: { pane_type: string; name: string; inputs: Record<string, unknown> }) =>
    req<SavedInput>("/saved-inputs", { method: "POST", body: JSON.stringify(payload) }),
  updateSavedInputs: (id: number, payload: { name?: string; inputs?: Record<string, unknown> }) =>
    req<SavedInput>(`/saved-inputs/${id}`, { method: "PUT", body: JSON.stringify(payload) }),
  deleteSavedInputs: (id: number) => req<void>(`/saved-inputs/${id}`, { method: "DELETE" }),
  listEnvironmentRecords: () => req<EnvironmentRecord[]>("/environments"),
  createEnvironment: (payload: { name: string; description?: string | null; account_id?: string; region?: string }) =>
    req<EnvironmentRecord>("/environments", { method: "POST", body: JSON.stringify(payload) }),
  updateEnvironment: (id: number, payload: { name?: string; description?: string | null }) =>
    req<EnvironmentRecord>(`/environments/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
  setEnvironmentGroups: (id: number, groupIds: number[]) =>
    req<EnvironmentRecord>(`/environments/${id}/groups`, { method: "PUT", body: JSON.stringify({ group_ids: groupIds }) }),
  deleteEnvironment: (id: number) => req<void>(`/environments/${id}`, { method: "DELETE" }),
  listConnectionTypes: () => req<ConnectionType[]>("/connection-types"),
  createConnectionType: (draft: ConnectionTypeDraft) =>
    req<ConnectionType>("/connection-types", { method: "POST", body: JSON.stringify(draft) }),
  updateConnectionType: (id: string, draft: ConnectionTypeDraft) =>
    req<ConnectionType>(`/connection-types/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(draft) }),
  deleteConnectionType: (id: string) => req<void>(`/connection-types/${encodeURIComponent(id)}`, { method: "DELETE" }),
  addConnection: (
    environmentId: number,
    payload: { type_id: string; name: string; config: Record<string, string>; credential_id?: number | null },
  ) => req<Connection>(`/environments/${environmentId}/connections`, { method: "POST", body: JSON.stringify(payload) }),
  updateConnection: (
    id: number,
    payload: { name?: string; config?: Record<string, string>; credential_id?: number | null; clear_credential?: boolean },
  ) => req<Connection>(`/connections/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
  deleteConnection: (id: number) => req<void>(`/connections/${id}`, { method: "DELETE" }),
  testConnection: (id: number, groupId: number) =>
    req<{ ok: boolean; message: string }>(`/connections/${id}/test`, {
      method: "POST",
      body: JSON.stringify({ group_id: groupId }),
    }),
  listGroupIdentities: (groupId: number) => req<GroupIdentity[]>(`/user-groups/${groupId}/identities`),
  setGroupIdentities: (groupId: number, identities: GroupIdentity[]) =>
    req<GroupIdentity[]>(`/user-groups/${groupId}/identities`, {
      method: "PUT",
      body: JSON.stringify({
        identities: identities.map(({ connection_type_id, connection_id, credential_id }) => ({
          connection_type_id,
          connection_id,
          credential_id,
        })),
      }),
    }),

  credentialsStatus: () => req<CredentialsStatus>("/credentials/status"),
  listCredentialTypes: () => req<CredentialType[]>("/credential-types"),
  createCredentialType: (payload: CredentialTypeDraft) =>
    req<CredentialType>("/credential-types", { method: "POST", body: JSON.stringify(payload) }),
  updateCredentialType: (id: string, payload: Partial<CredentialTypeDraft> & { confirm_remove?: boolean }) =>
    req<CredentialType>(`/credential-types/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(payload) }),
  deleteCredentialType: (id: string) => req<void>(`/credential-types/${encodeURIComponent(id)}`, { method: "DELETE" }),
  inferCredentialType: (example: unknown) =>
    req<{ fields: CredentialField[]; output_template: string | null }>("/credential-types/infer", {
      method: "POST",
      body: JSON.stringify({ example }),
    }),
  previewCredentialType: (payload: { fields: CredentialField[]; output_template: string | null; values: Record<string, unknown> }) =>
    req<{ output: unknown }>("/credential-types/preview", { method: "POST", body: JSON.stringify(payload) }),
  /** Admins get Credential[]; anyone else CredentialSummary[] (what their group can use). */
  listCredentials: <T extends Credential | CredentialSummary = Credential>() => req<T[]>("/credentials"),
  listWorkflows: () => req<Workflow[]>("/workflows"),
  getWorkflow: (id: string) => req<Workflow>(`/workflows/${encodeURIComponent(id)}`),
  validateWorkflow: (source: string) =>
    req<{ ok: boolean; errors: WorkflowProblem[] }>("/workflows/validate", { method: "POST", body: JSON.stringify({ source }) }),
  createWorkflow: (id: string, source: string) =>
    req<Workflow>("/workflows", { method: "POST", body: JSON.stringify({ id, source }) }),
  updateWorkflow: (id: string, source: string) =>
    req<Workflow>(`/workflows/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ source }) }),
  deleteWorkflow: (id: string) => req<void>(`/workflows/${encodeURIComponent(id)}`, { method: "DELETE" }),
  setWorkflowGrants: (id: string, groupIds: number[]) =>
    req<Workflow>(`/workflows/${encodeURIComponent(id)}/grants`, { method: "PUT", body: JSON.stringify({ group_ids: groupIds }) }),
  startWorkflowRun: (id: string, params: Record<string, unknown>, timezone?: string) =>
    req<WorkflowRun>(`/workflows/${encodeURIComponent(id)}/runs`, {
      method: "POST",
      body: JSON.stringify({ params, ...(timezone ? { timezone } : {}) }),
    }),
  listWorkflowRuns: (id: string) => req<WorkflowRun[]>(`/workflows/${encodeURIComponent(id)}/runs`),
  workflowParamOptions: (id: string, key: string, params: Record<string, unknown>) =>
    req<WorkflowParamOptions>(`/workflows/${encodeURIComponent(id)}/parameters/${encodeURIComponent(key)}/options`, {
      method: "POST",
      body: JSON.stringify({ params }),
    }),
  recentWorkflowRuns: (mine = false) => req<WorkflowRun[]>(`/workflow-runs${mine ? "?mine=true" : ""}`),
  getWorkflowRun: (runId: number) => req<WorkflowRun>(`/workflow-runs/${runId}`),
  cancelWorkflowRun: (runId: number) => req<WorkflowRun>(`/workflow-runs/${runId}/cancel`, { method: "POST" }),
  rerunWorkflowRun: (runId: number, params?: Record<string, unknown>, fromStep?: string) =>
    req<WorkflowRun>(`/workflow-runs/${runId}/rerun`, {
      method: "POST",
      body: JSON.stringify({
        ...(params ? { params } : {}),
        ...(fromStep ? { from_step: fromStep, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } : {}),
      }),
    }),
  listApprovals: () => req<WorkflowApproval[]>("/approvals"),
  /** A new session of the caller's holding what the run found (D95). */
  investigateRun: (runId: number) =>
    req<{ session_id: string; title: string }>(`/workflow-runs/${runId}/investigate`, { method: "POST" }),
  /** A workflow drafted from a session, for the editor (D96); nothing saved. */
  draftWorkflow: (sessionId: string) =>
    req<{ source: string; errors: WorkflowProblem[]; suggested_id: string }>("/workflows/draft", {
      method: "POST",
      body: JSON.stringify({ session: sessionId }),
    }),
  /** This run's own chat (D98), shared by its readers. */
  getRunChat: (runId: number) => req<{ turns: unknown[] }>(`/workflow-runs/${runId}/chat`),
  addRunChat: (runId: number, turns: unknown[]) =>
    req<{ turns: unknown[] }>(`/workflow-runs/${runId}/chat`, { method: "POST", body: JSON.stringify({ turns }) }),
  decideApproval: (id: number, approve: boolean, comment?: string) =>
    req<WorkflowRun>(`/approvals/${id}/${approve ? "approve" : "deny"}`, {
      method: "POST",
      body: JSON.stringify({ comment: comment || null }),
    }),
  /** A blob's download address: the backend checks who's asking (D91). */
  blobUrl: (id: string) => `/api/blobs/${encodeURIComponent(id)}`,
  getStore: () => req<StoreStatus>("/store"),
  putStore: (draft: StoreDraft) => req<StoreStatus>("/store", { method: "PUT", body: JSON.stringify(draft) }),
  deleteStore: () => req<void>("/store", { method: "DELETE" }),
  syncStore: () => req<StoreStatus>("/store/sync", { method: "POST" }),
  storeSides: (kind: string, itemId: string) =>
    req<{ mine: string | null; theirs: string | null; path: string }>(
      `/store/items/${encodeURIComponent(kind)}/${encodeURIComponent(itemId)}`,
    ),
  resolveStoreItem: (kind: string, itemId: string, take: "mine" | "theirs") =>
    req<StoreStatus>(`/store/items/${encodeURIComponent(kind)}/${encodeURIComponent(itemId)}/resolve`, {
      method: "POST",
      body: JSON.stringify({ take }),
    }),
  createCredential: (payload: {
    name: string;
    type_id: string;
    scope: "global" | "group";
    group_id: number | null;
    description: string | null;
    values: Record<string, unknown>;
  }) => req<Credential>("/credentials", { method: "POST", body: JSON.stringify(payload) }),
  updateCredential: (
    id: number,
    payload: { name?: string; description?: string | null; values?: Record<string, unknown>; clear?: string[] },
  ) => req<Credential>(`/credentials/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
  deleteCredential: (id: number) => req<void>(`/credentials/${id}`, { method: "DELETE" }),
  testCredential: (id: number) =>
    req<{ ok: boolean | null; message: string }>(`/credentials/${id}/test`, { method: "POST" }),
  grantCredential: (id: number, groupId: number) =>
    req<void>(`/credentials/${id}/grants/${groupId}`, { method: "POST" }),
  revokeCredential: (id: number, groupId: number) =>
    req<void>(`/credentials/${id}/grants/${groupId}`, { method: "DELETE" }),
  auditFor: (objectType: string, objectId: string | number) =>
    req<AuditEvent[]>(`/audit?object=${encodeURIComponent(`${objectType}:${objectId}`)}`),

  getSettings: () => req<Settings>("/settings"),
  updateSettings: (payload: Partial<Settings>) =>
    req<Settings>("/settings", { method: "PUT", body: JSON.stringify(payload) }),

  builderSchema: () => req<BuilderSchema>("/builder/schema"),
  listBuiltPanes: () => req<BuiltPaneType[]>("/builder/panes"),
  builderExample: (id: string) => req<{ id: string; source: string }>(`/builder/examples/${encodeURIComponent(id)}`),
  /** The draft as a pane type the preview draws, or its problems (D112). */
  builderPreview: (source: string, id?: string, newId?: string) =>
    req<{ ok: boolean; errors: WorkflowProblem[]; manifest: PaneManifest | null }>("/builder/preview", {
      method: "POST",
      body: JSON.stringify({ source, id, new_id: newId }),
    }),
  /** One of a draft's actions, run as its builder; nothing is stored. */
  builderPreviewAction: (
    source: string,
    id: string | undefined,
    action: string,
    inputs: Record<string, unknown>,
    cursor?: unknown,
    timezone?: string,
  ) =>
    req<Record<string, unknown>>(`/builder/preview/actions/${encodeURIComponent(action)}`, {
      method: "POST",
      body: JSON.stringify({ source, id, inputs, cursor, timezone }),
    }),
  /** `newId`: the Id typed for a new one, which the YAML's own id is held to. */
  checkBuiltPane: (source: string, id?: string, newId?: string) =>
    req<{ ok: boolean; errors: WorkflowProblem[] }>("/builder/check", {
      method: "POST",
      body: JSON.stringify({ source, id, new_id: newId }),
    }),
  createBuiltPane: (id: string, source: string) =>
    req<BuiltPaneType>("/builder/panes", { method: "POST", body: JSON.stringify({ id, source }) }),
  updateBuiltPane: (id: string, source: string) =>
    req<BuiltPaneType>(`/builder/panes/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ source }) }),
  deleteBuiltPane: (id: string) => req<void>(`/builder/panes/${encodeURIComponent(id)}`, { method: "DELETE" }),
  stepSchema: () => req<StepSchema>("/builder/step-schema"),
  listBuiltSteps: () => req<BuiltStepType[]>("/builder/steps"),
  checkBuiltStep: (source: string, id?: string, newId?: string) =>
    req<{ ok: boolean; errors: WorkflowProblem[] }>("/builder/steps/check", {
      method: "POST",
      body: JSON.stringify({ source, id, new_id: newId }),
    }),
  /** A draft request step sent once, as you -- for real (D122). */
  tryBuiltStep: (source: string, inputs: Record<string, unknown>, id?: string) =>
    req<{ status: number; response: unknown; rows?: Record<string, unknown>[] }>("/builder/steps/try", {
      method: "POST",
      body: JSON.stringify({ source, inputs, id }),
    }),
  createBuiltStep: (id: string, source: string) =>
    req<BuiltStepType>("/builder/steps", { method: "POST", body: JSON.stringify({ id, source }) }),
  updateBuiltStep: (id: string, source: string) =>
    req<BuiltStepType>(`/builder/steps/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ source }) }),
  deleteBuiltStep: (id: string) => req<void>(`/builder/steps/${encodeURIComponent(id)}`, { method: "DELETE" }),
  listBuildDrafts: (kind: BuildDraft["kind"]) => req<BuildDraft[]>(`/build-drafts?kind=${kind}`),
  /** This person's draft of an existing one, whole -- or none. */
  draftOf: async (kind: BuildDraft["kind"], target: string): Promise<BuildDraft | null> =>
    (await req<BuildDraft[]>(`/build-drafts?kind=${kind}&target=${encodeURIComponent(target)}`))[0] ?? null,
  getBuildDraft: (id: number) => req<BuildDraft>(`/build-drafts/${id}`),
  createBuildDraft: (payload: { kind: BuildDraft["kind"]; target_id?: string | null; new_id?: string; source?: string; chat?: unknown[] }) =>
    req<BuildDraft>("/build-drafts", { method: "POST", body: JSON.stringify(payload) }),
  updateBuildDraft: (id: number, payload: { target_id?: string; new_id?: string; source?: string; chat?: unknown[] }) =>
    req<BuildDraft>(`/build-drafts/${id}`, { method: "PUT", body: JSON.stringify(payload) }),
  deleteBuildDraft: (id: number) => req<void>(`/build-drafts/${id}`, { method: "DELETE" }),
  listPublishedTemplates: () => req<PublishedTemplate[]>("/templates"),
  publishTemplate: (payload: { saved_session_id: number; id: string; label: string; description?: string }) =>
    req<PublishedTemplate & { changes: string[] }>("/templates", { method: "POST", body: JSON.stringify(payload) }),
  updatePublishedTemplate: (id: string, payload: { label?: string; description?: string }) =>
    req<PublishedTemplate>(`/templates/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(payload) }),
  unpublishTemplate: (id: string) => req<void>(`/templates/${encodeURIComponent(id)}`, { method: "DELETE" }),
  openPublishedTemplate: (id: string, environment: number | null) =>
    req<{ session_id: string; title: string }>(`/templates/${encodeURIComponent(id)}/open`, {
      method: "POST",
      body: JSON.stringify({ environment }),
    }),
  listSavedSessions: <T = Record<string, unknown>>(page?: string) =>
    req<SavedSession<T>[]>(`/saved-sessions${page ? `?page=${encodeURIComponent(page)}` : ""}`),
  createSavedSession: <T = Record<string, unknown>>(payload: { page: string; name: string; state: T }) =>
    req<SavedSession<T>>("/saved-sessions", { method: "POST", body: JSON.stringify(payload) }),
  updateSavedSession: <T = Record<string, unknown>>(id: number, payload: Partial<{ name: string; state: T }>) =>
    req<SavedSession<T>>(`/saved-sessions/${id}`, { method: "PUT", body: JSON.stringify(payload) }),
  deleteSavedSession: (id: number) => req<void>(`/saved-sessions/${id}`, { method: "DELETE" }),

  listLiveSessions: () => req<LiveSession[]>("/live-sessions"),
  listClosedLiveSessions: () => req<LiveSessionSummary[]>("/live-sessions/closed"),
  getLiveSession: (clientId: string) => req<LiveSession>(`/live-sessions/${encodeURIComponent(clientId)}`),
  /** Asks for a pane to run again if it's due -- once, however many tabs ask (§18.3). */
  /** `fresh` instead of `every` is a run on open (D77): due when the outputs
   * are older than that many seconds. */
  refreshPane: (type: string, session: string, pane: string, every: number, timezone?: string, fresh?: number) =>
    req<{ refreshed: boolean; reason: string; version: number | null; error?: string; outputs?: PaneOutputs | null }>(
      `/panes/${encodeURIComponent(type)}/refresh`,
      {
        method: "POST",
        body: JSON.stringify({ session, pane, every, ...(timezone ? { timezone } : {}), ...(fresh ? { fresh } : {}) }),
      },
    ),
  /** Some panes' outputs, after an "outputs" event says they're newer (D21). */
  getPaneOutputs: (clientId: string, panes: string[]) =>
    req<Record<string, PaneOutputs>>(
      `/live-sessions/${encodeURIComponent(clientId)}/outputs?${panes.map((p) => `pane=${encodeURIComponent(p)}`).join("&")}`,
    ),
  /** Clears outputs an input change made stale (its `resets`), for everyone. */
  clearPaneOutputs: (clientId: string, pane: string, keys: string[]) =>
    req<PaneOutputs>(`/live-sessions/${encodeURIComponent(clientId)}/outputs/${encodeURIComponent(pane)}/clear`, {
      method: "POST",
      body: JSON.stringify({ keys }),
    }),
  putLiveSession: (
    clientId: string,
    // role is the server's own read on the caller's relationship to the
    // session -- never something the client says.
    payload: Omit<LiveSession, "client_id" | "closed_at" | "version" | "role" | "outputs"> & { base_version?: number },
  ) =>
    req<LiveSession>(`/live-sessions/${encodeURIComponent(clientId)}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    }),
  reorderLiveSessions: (client_ids: string[]) =>
    req<LiveSession[]>("/live-sessions/reorder", { method: "POST", body: JSON.stringify({ client_ids }) }),
  closeLiveSession: (clientId: string) =>
    req<LiveSession>(`/live-sessions/${encodeURIComponent(clientId)}/close`, { method: "POST" }),
  deleteLiveSession: (clientId: string) =>
    req<void>(`/live-sessions/${encodeURIComponent(clientId)}`, { method: "DELETE" }),
  getCatalogue: () => req<Catalogue>("/catalogue"),
  setCataloguePreference: (paneType: string, pref: { favourite?: boolean; hidden?: boolean }) =>
    req<Catalogue>(`/catalogue/preferences/${encodeURIComponent(paneType)}`, { method: "PUT", body: JSON.stringify(pref) }),
  createCatalogueCategory: (name: string, description: string) =>
    req<Catalogue>("/catalogue/categories", { method: "POST", body: JSON.stringify({ name, description }) }),
  updateCatalogueCategory: (id: number, name: string, description: string) =>
    req<Catalogue>(`/catalogue/categories/${id}`, { method: "PUT", body: JSON.stringify({ name, description }) }),
  deleteCatalogueCategory: (id: number, moveTo: number) =>
    req<Catalogue>(`/catalogue/categories/${id}?move_to=${moveTo}`, { method: "DELETE" }),
  setCatalogueLayout: (categories: { id: number; pane_types: string[] }[]) =>
    req<Catalogue>("/catalogue/layout", { method: "PUT", body: JSON.stringify({ categories }) }),
  getHomeSession: () => req<HomeSession>("/live-sessions/home"),
  setHomeSession: (clientId: string) =>
    req<HomeSession>(`/live-sessions/${encodeURIComponent(clientId)}/home`, { method: "PUT" }),
  clearHomeSession: () => req<HomeSession>("/live-sessions/home", { method: "DELETE" }),

  listSessionMembers: (clientId: string) =>
    req<SessionMember[]>(`/live-sessions/${encodeURIComponent(clientId)}/members`),
  inviteSessionMember: (clientId: string, username: string, permission: SessionPermission) =>
    req<SessionMember>(`/live-sessions/${encodeURIComponent(clientId)}/members`, {
      method: "POST",
      body: JSON.stringify({ username, permission }),
    }),
  updateSessionMemberPermission: (clientId: string, userId: number, permission: SessionPermission) =>
    req<SessionMember>(`/live-sessions/${encodeURIComponent(clientId)}/members/${userId}`, {
      method: "PUT",
      body: JSON.stringify({ permission }),
    }),
  removeSessionMember: (clientId: string, userId: number) =>
    req<void>(`/live-sessions/${encodeURIComponent(clientId)}/members/${userId}`, { method: "DELETE" }),
  listSessionParticipants: (clientId: string) =>
    req<SessionParticipant[]>(`/live-sessions/${encodeURIComponent(clientId)}/participants`),

  listSessionCategories: () => req<SessionCategory[]>("/session-categories"),
  createSessionCategory: (name: string) =>
    req<SessionCategory>("/session-categories", { method: "POST", body: JSON.stringify({ name }) }),
  renameSessionCategory: (id: number, name: string) =>
    req<SessionCategory>(`/session-categories/${id}`, { method: "PUT", body: JSON.stringify({ name }) }),
  reorderSessionCategories: (ids: number[]) =>
    req<SessionCategory[]>("/session-categories/reorder", { method: "POST", body: JSON.stringify({ ids }) }),
  deleteSessionCategory: (id: number) => req<void>(`/session-categories/${id}`, { method: "DELETE" }),

  getAgentStatus: () => req<AgentStatus>("/agent/status"),
  agentChat,

};
