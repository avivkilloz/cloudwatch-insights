# Cloud Insights

A web app that mimics CloudWatch Logs Insights, browses IoT fleets, DynamoDB
tables, S3 buckets, and Cognito user pools, across **multiple AWS accounts and
regions** by assuming a role you configure in each target account.

- Define **environments** — each one an AWS account paired with a single
  region — once, under the admin Settings (gear icon).
- **Logs tab**: pick one or more environments, browse/select their log
  groups, write a CloudWatch Logs Insights query (same syntax as the AWS
  console), and run it — the app fires one `StartQuery` per selected
  environment in parallel and polls until every target finishes. Results
  from all targets are merged into one list, shrunk to a single summary
  line per row by default; click a row to expand every field.
- **IoT tab**: pick one or more environments, then search either **Things**
  (the same "Advanced search" syntax as the AWS console — by name,
  attributes, connectivity, shadow values, group membership, and more) or
  **Certificates** (by status or certificate ID — see below). Expand a thing
  to see its attributes, named/classic shadows (reported vs. desired, last
  updated, version), attached certificates (with status and their attached
  policies, document included), and job execution history (with status).
  Expand a certificate to see its attached policies (document included) and
  which things use it. Read-only — nothing in this tab creates, updates, or
  deletes anything in your AWS accounts.
- **Tables tab**: pick one environment (DynamoDB tables are inherently
  single-account/region, so unlike Logs/IoT this page doesn't fan out
  across several at once), load its table list, and pick a table to see
  its key schema, status, and item count. Search/filter with
  `field:value` tokens (exact match, ANDed) — this runs a `Scan` with a
  `FilterExpression`, since there's no generic way to query an arbitrary,
  schemaless table other than scanning; leave the query blank to browse
  it unfiltered. Expand an item to see its full attributes as JSON. "Load
  more" pages through the table via DynamoDB's own `LastEvaluatedKey`.
- **Buckets tab**: pick one environment and a bucket (its actual region is
  resolved automatically, which can differ from the environment's own
  region), then navigate it like a file explorer — folders and files at
  the current level, breadcrumbs to jump back up. The search box switches
  to a recursive, filename-substring search under the current folder
  instead. Read-only: no file content is ever fetched or previewed, only
  metadata (size, last modified, storage class). Each file has "Copy S3
  URI" (`s3://bucket/key`) and "Copy object URL" (the virtual-hosted-style
  HTTPS URL) buttons.
- **Cognito tab**: pick one environment and a user pool, then search users
  with a single `attribute:value` token (starts-with match, e.g.
  `email:john`) — Cognito's `ListUsers` only supports filtering by one
  attribute per call, unlike the Tables/IoT search boxes. Leave it blank
  to list all users. Expand a user to see every attribute Cognito
  returned for them, plus status/enabled/created/last-modified.
- **Result row selection** (Logs tab): every result row has a checkbox, plus
  a "Select all" checkbox above the list that selects/deselects every
  currently-shown row. Selecting rows enables **Hide selected**, which
  removes them from view (a "Show N hidden" button brings them all back);
  hiding makes room for the next-best row within the current Limit rather
  than just leaving a gap. Selection also feeds the AI assistant below —
  see "About results" and "Build query". A new query run, or deselecting
  everything, clears the selection.
- **Grouping and the `@log` field** (Logs tab, CloudWatch backend): the
  default query includes `@log` alongside `@timestamp`/`@message`, so when
  a query spans multiple log groups, each row shows a tag naming which one
  it came from (CloudWatch returns this as `<account_id>:<log_group_name>`;
  the account id — redundant with the environment tag right next to it —
  is stripped for display). The results view's **Group by** control (was a
  plain "Group by environment" checkbox) is now a dropdown: **None**,
  **Environment**, or **Log group** — the last one buckets rows under a
  header per log group instead of per environment, useful once a query
  spans several. Removing `@log` from a query (or switching to OpenSearch,
  which has no equivalent field) just makes "Log group" grouping and the
  per-row tag a no-op.
- **AI assistant** (Logs tab, optional): a floating "✦ Ask AI" button in
  the bottom-right corner opens a compact panel with two tabs instead of
  bloating the page with always-visible panels. "Build query" turns a
  plain-English description into a CloudWatch Logs Insights query you can
  drop straight into the editor with one click — if you've checked some
  result rows, a "Use N checked result(s) as examples" checkbox includes
  them so the assistant can reference their actual field names/values
  instead of guessing. "About results" answers questions about the current
  result set: by default it sees a sample of the rows spread fairly across
  every log group in the results (so a low-volume log group querying
  alongside a high-volume one isn't crowded out); a "Sampled / Selected"
  toggle appears once you've checked some rows, letting you narrow the
  question to exactly those instead of the sample. Each tab keeps its own
  conversation — switching tabs
  doesn't lose either thread, and you can go back and forth, not just one
  shot. Drag the panel's top-left corner to resize it; the size is
  remembered per browser. Backed by a [LiteLLM](https://www.litellm.ai/)
  proxy (or anything else exposing an OpenAI-compatible
  `/chat/completions` endpoint), configured purely via the
  `LITELLM_API_KEY`/`LITELLM_BASE_URL`/`LITELLM_MODEL` environment
  variables at deploy time — never through the Settings page, since these
  are deployment secrets rather than app data. Entirely optional: the
  floating button stays hidden until all three variables are set. See
  `DEPLOYMENT.md` for wiring this up via Helm.
- Everything saved anywhere in the app — Logs/IoT saved queries and
  searches, Logs/IoT saved sessions, saved HTTP requests, and saved MQTT
  topics — is **per user** (each user only ever sees and manages their own)
  and is managed from one **Saved items** panel on the **Saved** tab, with a
  tab for each kind (Log Queries, IoT Searches, Logs Sessions, IoT Sessions,
  HTTP Requests, MQTT Topics). Every kind supports full editing there, not
  just rename/delete: saved queries/searches edit their query text and extra
  fields (backend, search mode) directly; saved HTTP requests edit
  method/URL/headers/body through the same form the HTTP Client tool itself
  uses; saved MQTT topics edit the topic string; saved Logs/IoT sessions
  (see below) edit their underlying JSON state directly, since their shape
  is page-defined and too open-ended for a bespoke form. Only the
  query/search and HTTP-request/MQTT-topic tabs support adding a new item
  directly from the Saved tab — a session snapshot is still created from its
  own page's "Save session" button, since that's what captures its state in
  the first place. (Tables/Buckets/Cognito have no saved-item concept of
  their own today.)
- **Saved sessions**, distinct from saved queries/searches: the Logs and
  IoT tabs each have a "Save session" button that snapshots the page's
  *entire* working state — selected environments, log groups, query text,
  time range, limit, sort, search mode, and so on — not just the query
  text, so you can resume an investigation later exactly where you left
  it. Load one back via that page's "Load saved session" dropdown. Any
  future page can plug into the same mechanism — a saved session is just a
  page name plus an opaque JSON blob that page defines for itself, which
  is also what the Tools page's saved HTTP requests and saved MQTT topics
  are built on (each just its own page name under the same mechanism).
  (Tables, Buckets, and Cognito don't have this yet.)
- Admin **Settings** (gear icon, top right — only visible to Admin-group
  members) also lets you set a custom app title (shown in the top bar and
  browser tab, in place of the default "Cloud Insights") and upload a logo
  shown right before that title. An uploaded logo is capped at 300 KB and
  stored inline (as a data URL) alongside the rest of the app's settings —
  no separate file storage needed — so keep it small; for a larger image,
  host it yourself and note that this app has no URL field for that today
  (only file upload).
- Pick a theme (Dark, Light, Dracula, Nord, Solarized Light, or one of the
  four [Catppuccin](https://catppuccin.com/) flavors — Latte, Frappé,
  Macchiato, Mocha) from the palette icon in the top bar — it's remembered
  per browser via `localStorage`.

## Users, groups & login

The app requires logging in — there's no anonymous/shared access. Every user
belongs to exactly **one group**, and the group is the sole unit of access
control:

- **Which IAM role** the user's requests assume in every environment they
  can see (the group's **IAM role name**; there's no per-environment
  override).
- **Which environments** are visible to the user (an explicit allow-list per
  group — except the built-in **Admin** group, which always sees every
  environment, so admins can't accidentally lock themselves out of one they
  forgot to self-grant).
- **Which tabs** are visible (Logs, IoT, Tables, Buckets, Cognito, Tools —
  the **Saved** tab and the admin gear icon are handled separately, see
  below).

Only members of the Admin group can add/edit/delete users and groups,
change app settings (title/logo), or add/remove environments — reachable via
the **gear icon** at the right of the top bar. Everyone else sees just their
group's tabs, the **Saved** tab (their own saved queries/searches/sessions —
these are always per-user, regardless of group), and a **logout** icon next
to the theme picker.

A default **Admin** group and an **admin** user in it are created
automatically the first time the app starts with no users yet. Set the
admin user's initial password via the `ADMIN_PASSWORD` environment variable
(see `DEPLOYMENT.md` for wiring this up via Helm); if it's left unset, the
backend generates a random password itself and logs it once, so check the
backend's startup logs (`docker compose logs backend`, or `kubectl logs` for
the backend pod) if you didn't set one. Sign in as `admin` with that
password, then create real users/groups and change the admin password
(via the login/change-password flow) from there.

## Architecture

```
backend/   FastAPI app. Holds ambient AWS credentials (the server's own
           identity) and uses sts:AssumeRole to reach into each configured
           environment (account+region pair), impersonating whichever role
           the logged-in user's group specifies. Postgres persists
           environments, users/groups/sessions, and per-user saved queries/
           searches/sessions.
frontend/  React + Vite SPA. Talks to the backend over /api/*, gated behind
           a login page backed by an httpOnly session cookie.
```

No AWS keys are ever entered into or stored by the browser. The backend is
the only thing that touches AWS credentials, using whatever ambient identity
it's given (env vars, an EC2/ECS/Lambda instance role, or `~/.aws/credentials`).

## Running locally

The backend needs a Postgres database. Either use the provided Compose file
for everything (see [Run with Docker Compose](#run-with-docker-compose)
below), or start just Postgres and run the app processes yourself for a
faster edit loop:

```bash
docker run --rm -d --name cw-postgres \
  -e POSTGRES_USER=cloudwatch_insights \
  -e POSTGRES_PASSWORD=cloudwatch_insights \
  -e POSTGRES_DB=cloudwatch_insights \
  -p 5432:5432 postgres:16-alpine
```

### 1. Backend

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# Provide the server's own AWS identity (must be allowed to assume the
# target role in every account you configure — see IAM setup below):
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
# or AWS_PROFILE=..., or just run this on an instance/task with an IAM role.

export DATABASE_URL=postgresql+psycopg2://cloudwatch_insights:cloudwatch_insights@localhost:5432/cloudwatch_insights
uvicorn app.main:app --reload --port 8000
```

Tables are created automatically on first run. Instead of `DATABASE_URL`
you can set `POSTGRES_HOST` (plus optionally `POSTGRES_PORT`, `POSTGRES_DB`,
`POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_SSLMODE`) and the backend
builds the connection string for you — see `backend/app/db.py`.

Run the test suite with:
```bash
pip install -r requirements-dev.txt
docker run --rm -d --name cw-postgres-test -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=cloudwatch_insights_test -p 5432:5432 postgres:16-alpine
python -m pytest tests/ -v
```
(`tests/conftest.py` defaults `DATABASE_URL` to that same test database if
it isn't already set in the environment.)

### 2. Frontend

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173. The Vite dev server proxies `/api/*` to
`http://127.0.0.1:8000` (override with `BACKEND_URL`).

### Production build

```bash
cd frontend && npm run build
```

Serve the resulting `frontend/dist` as static files from anything (nginx,
S3+CloudFront, or FastAPI's `StaticFiles`) and point it at the backend's
`/api` — put both behind the same origin/reverse proxy so the frontend's
relative `/api/*` calls reach the backend.

### Run with Docker Compose

```bash
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...   # or AWS_PROFILE, see IAM setup below
docker compose up --build
```

This starts Postgres, the backend (http://localhost:8000), and the frontend
(http://localhost:8080) together, with the backend already pointed at
Postgres. AWS env vars are forwarded from your shell into the backend
container so it can assume roles.

### Containers & Kubernetes

- `backend/Dockerfile` and `frontend/Dockerfile` build each half as its own
  image; `.github/workflows/{backend,frontend}-ci.yml` typecheck/test each
  on every push and, on `main`, build and push images to
  `ghcr.io/<owner>/cloudwatch-insights-{backend,frontend}`.
- `helm/cloudwatch-insights/` is a Helm chart for both services, including
  a ServiceAccount meant for IRSA. `argocd/application.yaml` is an example
  Argo CD `Application` for the chart.
- See **[DEPLOYMENT.md](./DEPLOYMENT.md)** for the full Kubernetes/IRSA
  walkthrough: OIDC provider setup, creating the hub IAM role the backend
  runs as, wiring per-target-account trust policies, and deploying with
  Helm or Argo CD.

## IAM setup

The app needs two things:

1. **The server's own identity** (whatever `AWS_ACCESS_KEY_ID`/instance
   role/profile it runs with) must be allowed to call `sts:AssumeRole` on
   the role you'll configure in each target account:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": "sts:AssumeRole",
         "Resource": "arn:aws:iam::*:role/CloudWatchInsightsReadRole"
       }
     ]
   }
   ```

   (Scope the `Resource` down to the specific account ARNs you use in
   practice instead of `*` where possible.)

2. **A role with that same name** (e.g. `CloudWatchInsightsReadRole`) must
   exist in *every* target account, trusting the server's identity, with
   permissions to read logs:

   Trust policy (replace with the server's actual identity/account):
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Principal": { "AWS": "arn:aws:iam::<SERVER_ACCOUNT_ID>:role/<server-identity>" },
         "Action": "sts:AssumeRole"
       }
     ]
   }
   ```

   Permissions policy:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": [
           "logs:DescribeLogGroups",
           "logs:StartQuery",
           "logs:GetQueryResults",
           "logs:StopQuery",
           "iot:SearchIndex",
           "iot:DescribeThing",
           "iot:DescribeEndpoint",
           "iot:ListThingPrincipals",
           "iot:DescribeCertificate",
           "iot:ListNamedShadowsForThing",
           "iot:GetThingShadow",
           "iot:ListJobExecutionsForThing",
           "iot:ListAttachedPolicies",
           "iot:GetPolicy",
           "iot:ListCertificates",
           "iot:ListPrincipalThings",
           "iot:Connect",
           "iot:Publish",
           "iot:Subscribe",
           "iot:Receive",
           "dynamodb:ListTables",
           "dynamodb:DescribeTable",
           "dynamodb:Scan",
           "s3:ListAllMyBuckets",
           "s3:GetBucketLocation",
           "s3:ListBucket",
           "cognito-idp:ListUserPools",
           "cognito-idp:ListUsers",
           "es:ListDomainNames",
           "es:DescribeDomains",
           "es:ESHttpGet",
           "es:ESHttpPost"
         ],
         "Resource": "*"
       }
     ]
   }
   ```
   (Drop whichever service's actions you don't need — `logs:*` for Logs
   (CloudWatch backend), `iot:*` for IoT, `dynamodb:*` for Tables, `s3:*`
   for Buckets, `cognito-idp:*` for Cognito, `es:*` for Logs (OpenSearch
   backend). `s3:ListBucket` is normally scoped to specific bucket ARNs
   rather than `*`; this simplified example grants it account-wide the same
   way the rest of this policy does.)

In the app's admin **Settings** (the gear icon, Admin-group members only),
add an environment for each account/region combination you want to query — a
name, the 12-digit account ID, and a region — under the **Environments**
section. Then, under **User groups**, set each group's **IAM role name**
(e.g. `CloudWatchInsightsReadRole`) — this is the role that group's members
assume in every environment they can see. There's no per-environment role
override anymore: the role to assume is entirely a property of the logged-in
user's group.

### IoT tab prerequisite: Fleet Indexing

The IoT tab's search is powered by [AWS IoT Fleet
Indexing](https://docs.aws.amazon.com/iot/latest/developerguide/iot-indexing.html)
(`iot:SearchIndex`) — the same mechanism behind the "Advanced search" box in
the AWS IoT console. It must be enabled per account/region before searching
will work there; if it isn't, the app surfaces a clear per-environment error
rather than failing silently. Enable it once per target account/region:

```bash
aws iot update-indexing-configuration \
  --thing-indexing-configuration '{"thingIndexingMode":"REGISTRY_AND_SHADOW","thingConnectivityIndexingMode":"STATUS"}' \
  --region us-east-1
```
`REGISTRY_AND_SHADOW` makes attributes and shadow state searchable/visible
in results; `thingConnectivityIndexingMode: STATUS` is what populates the
Connected/Disconnected badge. Certificates and job executions are read
directly (not via the index) and don't need this.

### IoT tab: Certificate search

Fleet Indexing doesn't cover certificates, so **Certificates** mode doesn't
use `iot:SearchIndex` at all — it's a small homegrown query parser against
`iot:ListCertificates`/`iot:DescribeCertificate` instead, so it needs no
indexing setup, but is more limited than Things search:
- `status:ACTIVE` / `status:INACTIVE` / etc. filters by certificate status.
- `certid:<certificate-id>` does an exact-match lookup via
  `DescribeCertificate` (fast, works even with a huge number of
  certificates).
- Any other free text is matched as a substring against certificate IDs
  only (not against metadata) client-side, after paginating through
  `ListCertificates` — so it can be slow and the certificate ID is the only
  thing you can free-text search on.

### Logs tab: OpenSearch backend

The Logs page can search either CloudWatch Logs Insights (the default) or an
AWS-provisioned OpenSearch domain — pick one with the backend toggle at the
top of the page. Both share the same environment picker, results table, and
AI assistant; only the second step (choosing what to search) and the query
syntax (Lucene `query_string`, e.g. `level:ERROR AND service:checkout`,
instead of CloudWatch's pipe syntax) differ.

Two things need to line up for the OpenSearch backend to reach a domain:

1. **IAM permissions** — the assumed role needs `es:ListDomainNames` and
   `es:DescribeDomains` to discover domains, plus `es:ESHttpGet`/
   `es:ESHttpPost` to actually search them (see the permissions policy
   above). Listing indices and running searches go straight to the domain's
   own REST endpoint (`_cat/indices`, `_search`) with a SigV4-signed
   request using the same assumed-role credentials as every other call in
   this app — there's no query API for OpenSearch in the AWS SDK itself.
2. **The domain's own access policy** must separately allow that same role
   — an OpenSearch domain's resource-based access policy is checked in
   addition to the caller's IAM permissions, so `es:ESHttpGet`/
   `es:ESHttpPost` in the IAM policy alone isn't enough if the domain's
   access policy denies or doesn't mention the role.
3. **Network reachability** — this backend makes plain HTTPS requests to
   the domain's endpoint from wherever the app's backend runs, so a
   VPC-only domain needs to be reachable from there (e.g. via VPC
   peering/routing), while a public-endpoint domain works with just the
   IAM/access-policy setup above.

If you get a `403 Forbidden` when listing indices or searching despite 1 and
2 above looking right, the domain almost certainly has **fine-grained
access control (FGAC)** enabled. FGAC adds a second, independent
authorization layer on top of the domain's IAM access policy: even a role
the access policy explicitly allows still gets `403` unless that same role
is also mapped to an internal OpenSearch role with the needed index
permissions (in OpenSearch Dashboards: **Security → Roles** → pick a role
with the access you need, e.g. `all_access`, → **Mapped users** → **Manage
mapping** → add the assumed role's ARN under **Backend roles**). The error
message surfaced by the app includes AWS's response body, which for an FGAC
domain typically names the missing mapping explicitly — check that before
assuming it's an IAM/access-policy problem.

There's no async query concept for OpenSearch the way CloudWatch Logs
Insights has `StartQuery`/`GetQueryResults` — a search is a single
synchronous request, so there's no "Stop" button or polling for that
backend.

## Tools tab

A grid of small, independent developer utilities, each a card you click to
expand in place:

- **JWT Decoder / Encoder** — decode any JWT's header and payload, or build
  and sign a new one. Runs entirely in your browser (via the Web Crypto
  API) — the token, secret, and payload never reach the backend. Only
  symmetric algorithms (HS256/384/512) are supported for signing and
  verification; RS/ES-signed tokens can still be decoded, just not verified.
- **Base64 Encode / Decode** — plain and URL-safe, UTF-8 safe. Client-side
  only.
- **Diff Checker** — character-level comparison of two blocks of text
  (word- and line-level boundaries alone wouldn't highlight, say, a couple
  of changed characters inside one long unbroken token), with a view-mode
  selector: **Unified** (inline, one line under the other), **Split**
  (side-by-side columns), and **Compact** (unified, but collapsing long runs
  of unchanged lines into a clickable "N unchanged lines" placeholder so a
  small change in a large text doesn't require scrolling past pages of
  context). Client-side only.
- **HTTP Client** — a small Postman-like tool: pick a method, enter a URL,
  set headers/body, and see the status, headers, and body that come back.
  Requests can be saved and reloaded by name (**Save request** / **Load
  saved request…**) — manageable, including full editing, from the
  **Saved items** panel's "HTTP Requests" tab on the **Saved** tab. Requests are
  sent **from the backend**, not the
  browser, so they aren't
  subject to CORS — but for that same reason, the backend refuses to reach
  loopback, private, and link-local address ranges (which also covers
  every major cloud's instance metadata endpoint, e.g. `169.254.169.254`),
  so this can't be turned into a way to probe internal infrastructure or
  steal the backend's own AWS credentials. This check resolves the
  hostname once before connecting; it isn't proof against a DNS answer
  that changes between that check and the actual connection (DNS
  rebinding). Redirects are returned as-is rather than followed
  automatically, so a redirect can't be used to reach a blocked address
  either.
- **MQTT Tester** — pick one of your configured environments, then
  subscribe and publish to topics on that account's AWS IoT Core endpoint,
  the same way the AWS IoT console's own "MQTT test client" works.
  Connecting mints a short-lived (5 minute), SigV4-signed WebSocket URL
  server-side using that environment's assumed role, then connects
  straight from your browser to the endpoint — the MQTT session itself
  never passes through this app's backend. The assumed role needs
  `iot:DescribeEndpoint`, `iot:Connect`, `iot:Publish`, `iot:Subscribe`,
  and `iot:Receive` (see the permissions policy above), and the IoT Core
  endpoint must be reachable over HTTPS/WSS from wherever your browser is
  (it's public by default unless the account restricts it to a VPC).
  Frequently-used topics can be saved by name (**Save topic**, next to
  either the subscribe or publish topic field) and reloaded from either
  field's **Load saved topic…** dropdown — topic fields aren't gated on
  being connected, so these can be prepared ahead of time.

  If it connects and then disconnects immediately, the browser itself can't
  tell you why: rejecting a WebSocket handshake never surfaces an HTTP
  status or body to JavaScript, only a generic "closed" event. To work
  around that, minting the connection URL also attempts the actual
  WebSocket handshake from the backend (which *can* see AWS's response) and
  reports the result back as a "pre-flight check" next to the endpoint —
  read that first:
  - `HTTP 101` means AWS accepted the handshake — the URL and signature are
    valid, so a subsequent immediate disconnect in the browser itself points
    at something environment-specific (network reachability from your
    browser, a proxy, etc.) rather than IAM/signing.
  - `HTTP 403`/`401` means AWS rejected the connection, but the generic
    `Forbidden` body it returns doesn't say why -- and **this action doesn't
    show up in CloudTrail**, since it's an MQTT-level decision inside the IoT
    device gateway, a separate system with its own logging. To see the
    actual reason: enable AWS IoT Core's own logging (IoT Console → Settings
    → Logs → set the default log level to `DEBUG` or `INFO`), reconnect, and
    look in the CloudWatch Logs group it writes to (`AWSIotLogsV2` by
    default) for the entry matching the client ID shown under the connection
    status (`cloudwatch-insights-<random>`).
    - **If nothing shows up there even with logging enabled**, check for a
      *per-event-type* override before assuming the request never arrived:
      `aws iot get-v2-logging-options` returns an `eventConfigurations` list
      that can override specific event types (e.g. `Connection.AuthNError`)
      to `DISABLED` independently of `defaultLogLevel` -- easy to miss since
      the console's basic log-level toggle doesn't surface it. Clear that
      override (or set it explicitly to `INFO`) and reconnect.
    - Once you can see the actual log entry, its `reason` field gives the
      real cause. A `reason` of `SECURITY_TOKEN_SIGNATURE_MISMATCH`
      specifically does *not* mean an IAM/policy problem (IAM Policy
      Simulator will report the action as allowed) -- it means the signature
      itself doesn't match what IoT Core recomputes. This app used to have
      exactly that bug: AWS IoT Core's device gateway recomputes the
      expected signature *excluding* the session token, unlike normal
      SigV4Query behavior (e.g. for S3 presigned URLs) which signs the token
      along with everything else -- signing it in, which botocore's
      `SigV4QueryAuth` does by default when given a token-bearing
      credentials object, produces a URL IoT Core always rejects this way.
      It's fixed now (the token is appended after signing, unsigned), but if
      you're running a fork or an older build, this is the first thing to
      check.
    - For any other `reason` (an actual authorization denial), check the
      identity-based policy first -- the MQTT client ID isn't sent until
      *after* a successful WebSocket upgrade, so a client-ID-scoped policy
      condition can't be the cause of a rejection this early. If the role's
      own policy already grants `iot:Connect`/`iot:Publish`/`iot:Subscribe`/
      `iot:Receive` on `Resource: "*"` and it's still denied, run IAM Policy
      Simulator against the exact assumed-role ARN
      (`aws iam simulate-principal-policy --policy-source-arn <role-arn>
      --action-names iot:Connect --resource-arns
      "arn:aws:iot:<region>:<account-id>:client/*"`) -- unlike CloudTrail,
      it accounts for SCPs and permissions boundaries and tells you which
      one is the source of a deny, if any. If the simulator says the action
      is allowed, and DNS for the IoT endpoint resolves to a public IP (not
      a private VPC-endpoint address), also check whether an IoT Core
      custom/default authorizer is configured on the account (IoT Console →
      Security → Authorizers) -- one intercepts even SigV4-authenticated
      connections independently of IAM.
    - Separately, the backend's system clock can also produce a genuine
      signature failure (SigV4 signatures are time-bound) -- compare
      `date -u` in the pod against a trusted clock if the above doesn't
      explain it.
  - If a rejection shows up in the pre-flight check but nothing matching
    ever appears in AWS IoT Core's own logging (with both the default level
    *and* any per-event-type overrides confirmed enabled), the request may
    never be reaching IoT Core's device gateway at all -- something in the
    network path (a proxy, firewall, or inspection appliance) could be
    answering first. The pre-flight check's expandable "Response headers"
    section is the fastest way to tell a genuine AWS rejection (AWS-typical
    headers like `x-amzn-RequestId`/`x-amzn-ErrorType`, JSON content type)
    from an intercepting proxy's own error page (an unfamiliar `Server`
    header, an HTML content type, or other headers a real AWS response
    would never include).
  - `HTTP 404` means the endpoint itself doesn't recognize `/mqtt` as a
    route at all — double check the discovered endpoint is actually this
    account's ATS IoT data endpoint.
  - No status at all (a connection/timeout error) means the endpoint wasn't
    reachable from the backend — check network path and security groups if
    the domain uses a VPC endpoint.

## Notes

- Log group listing and query execution both fan out across every selected
  environment concurrently; a failure in one (bad role, missing
  permissions, wrong region) is shown inline next to that environment
  without blocking the others.
- CloudWatch Logs Insights only supports querying log groups that live in
  the same account/region as each other, which is exactly what an
  environment pins down — so under the hood the app issues one `StartQuery`
  per selected environment (using whichever log groups you selected within
  it) and merges the results client-side.
- The **Limit** field in the Query section is applied per environment via
  CloudWatch's own `StartQuery` `limit` parameter — with N environments
  selected, up to `N × limit` rows can come back from AWS in total. The
  merged view re-sorts everything (see **Sort by**, next) and caps the
  *displayed* total to the same limit, so what you see always matches what
  you asked for regardless of how many environments you selected. A
  `| limit` command inside the query text itself is left untouched and
  applies on top of this, same as in the AWS console.
- The **Sort by** field/direction next to it control how the *merged*
  results from every environment are ordered and displayed — pick any
  field present in the results (it's populated from your actual query
  output after running it), or "Original order" to leave the merge order
  alone. This is separate from a `sort` command inside the query text
  itself: that one still runs on AWS's side per environment and determines
  *which* rows survive that environment's `limit` before they ever reach
  the merge step, so the default query keeps `| sort @timestamp desc` for
  that reason even though the UI's Sort control also defaults to the same
  thing for display.
- The IoT tab's **Max results** is a per-environment cap on a single
  `SearchIndex` call, like Insights' Limit — but unlike Insights there's no
  client-side re-merge/truncation step, since fleet search results aren't
  naturally comparable/sortable across environments the way log rows are by
  timestamp. There's also no "load more"/pagination yet: raise Max results
  (up to 500) if you need more than the default 50 per environment, or
  narrow the query.
- The IoT tab is entirely read-only: it never creates, updates, or deletes
  a thing, certificate, shadow document, or job. A missing permission on
  one part of a thing's detail (e.g. `iot:ListJobExecutionsForThing`)
  shows a warning for just that section rather than hiding the rest of
  the thing's detail.
