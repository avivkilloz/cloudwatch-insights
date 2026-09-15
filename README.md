# CloudWatch Insights — Multi-Account

A web app that mimics CloudWatch Logs Insights, but lets you query log groups
across **multiple AWS accounts and regions** at once by assuming a role you
configure in each target account.

- Pick one or more AWS accounts + regions.
- Browse and select the log groups available in each.
- Write a CloudWatch Logs Insights query (same syntax as the AWS console).
- Run it — the app fires one `StartQuery` per account/region target in
  parallel and polls until every target finishes.
- Results from all targets are merged into one list, shrunk to a single
  summary line per row by default; click a row to expand every field.

## Architecture

```
backend/   FastAPI app. Holds ambient AWS credentials (the server's own
           identity) and uses sts:AssumeRole to reach into each configured
           account/region. SQLite persists accounts, the default role name,
           and saved queries.
frontend/  React + Vite SPA. Talks to the backend over /api/*.
```

No AWS keys are ever entered into or stored by the browser. The backend is
the only thing that touches AWS credentials, using whatever ambient identity
it's given (env vars, an EC2/ECS/Lambda instance role, or `~/.aws/credentials`).

## Running locally

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

uvicorn app.main:app --reload --port 8000
```

The SQLite database is created at `backend/data/app.db` on first run.

Run the test suite with `pip install -r requirements-dev.txt && python -m pytest tests/ -v`.

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

In the app's **Accounts & Settings** tab, set the **global role name**
(e.g. `CloudWatchInsightsReadRole`) once, then add each account by its
12-digit account ID and a friendly name. An individual account can override
the role name if it uses a different one than the global default.

## Notes

- Log group listing and query execution both fan out across every selected
  account/region target concurrently; a failure in one target (bad role,
  missing permissions, wrong region) is shown inline next to that target
  without blocking the others.
- CloudWatch Logs Insights only supports querying log groups that live in
  the same account/region as each other, so under the hood the app issues
  one `StartQuery` per account/region combination (using whichever log
  groups you selected within that target) and merges the results client-side.
