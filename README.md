# CloudWatch Insights — Multi-Account

A web app that mimics CloudWatch Logs Insights, but lets you query log groups
across **multiple AWS accounts and regions** at once by assuming a role you
configure in each target account.

- Define **environments** — each one an AWS account paired with a single
  region — once, under Environments & Settings.
- Pick one or more environments on the Insights page.
- Browse and select the log groups available in each.
- Write a CloudWatch Logs Insights query (same syntax as the AWS console).
- Run it — the app fires one `StartQuery` per selected environment in
  parallel and polls until every target finishes.
- Results from all targets are merged into one list, shrunk to a single
  summary line per row by default; click a row to expand every field.
- Pick a theme (Dark, Light, Dracula, Nord, Solarized Light) from the
  dropdown in the top bar — it's remembered per browser via `localStorage`.

## Architecture

```
backend/   FastAPI app. Holds ambient AWS credentials (the server's own
           identity) and uses sts:AssumeRole to reach into each configured
           environment (account+region pair). Postgres persists
           environments, the default role name, and saved queries.
frontend/  React + Vite SPA. Talks to the backend over /api/*.
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
           "logs:StopQuery"
         ],
         "Resource": "*"
       }
     ]
   }
   ```

In the app's **Environments & Settings** tab, set the **global role name**
(e.g. `CloudWatchInsightsReadRole`) once, then add an environment for each
account/region combination you want to query — a name, the 12-digit account
ID, and a region. An individual environment can override the role name if
it uses a different one than the global default.

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
  merged view re-sorts everything by `@timestamp` (most recent first) and
  caps the *displayed* total to the same limit, so what you see always
  matches what you asked for regardless of how many environments you
  selected. A `| limit` command inside the query text itself is left
  untouched and applies on top of this, same as in the AWS console.
