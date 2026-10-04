# Deploying to Kubernetes (Helm + IRSA + Argo CD)

This covers running the app on EKS with the backend's pod assuming AWS
credentials via **IRSA** (IAM Roles for Service Accounts) instead of static
keys, deployed with the Helm chart in `helm/cloudwatch-insights/`, optionally
managed by Argo CD.

If you just want to run the app locally without Kubernetes, see the main
[README](./README.md) instead — this doc assumes you're deploying to a
real cluster.

## How auth works in this setup

```
EKS pod (backend, ServiceAccount X)
  --IRSA-->  Hub IAM role (lives in the account that hosts the cluster)
  --sts:AssumeRole-->  CloudWatchInsightsReadRole (one per target account)
  --logs:* / iot:*-->  CloudWatch Logs / IoT in that target account/region
```

The **hub role** is the backend's actual runtime identity (swapped in via
IRSA — no keys stored anywhere). It only needs permission to assume the
per-account role; it does not need `logs:*`/`iot:*` itself. Each **target
account** gets its own role, trusting only the hub role, with the actual
`logs:*` and `iot:*` read permissions. This is the same two-policy shape
described in the main README's "IAM setup" section, just with the hub
role's identity being an IRSA role instead of a plain server credential.
(If you only use one of the two tabs, drop the other service's actions
from the target-account policy below.)

## Prerequisites

1. **An EKS cluster with an IAM OIDC provider associated.** If you're not
   sure whether this is already done:
   ```bash
   aws eks describe-cluster --name <CLUSTER_NAME> --query "cluster.identity.oidc.issuer" --output text
   eksctl utils associate-iam-oidc-provider --cluster <CLUSTER_NAME> --approve
   ```

2. **Container images**, either built by this repo's GitHub Actions
   workflows (`.github/workflows/backend-ci.yml` and `frontend-ci.yml`,
   which push to `ghcr.io/<owner>/<repo>-backend` and `-frontend` on every
   push to `main`), or built and pushed to your own registry:
   ```bash
   docker build -t <registry>/cloudwatch-insights-backend:latest ./backend
   docker build -t <registry>/cloudwatch-insights-frontend:latest ./frontend
   docker push <registry>/cloudwatch-insights-backend:latest
   docker push <registry>/cloudwatch-insights-frontend:latest
   ```
   If you use the GHCR images from CI and the repo/packages are private,
   create an `imagePullSecret` in the target namespace and set
   `imagePullSecrets` in `values.yaml`.

3. **The hub IAM role** (the backend's IRSA identity). Decide on the
   namespace and Helm release name you'll deploy with first — they
   determine the ServiceAccount name the trust policy must reference.
   With the defaults (release name `cloudwatch-insights`, namespace
   `cloudwatch-insights`), the ServiceAccount is
   `cloudwatch-insights-backend`. Adjust every path below if you use
   different names.

   ```bash
   export HUB_ACCOUNT_ID=111111111111        # account hosting the EKS cluster
   export OIDC_PROVIDER=$(aws eks describe-cluster --name <CLUSTER_NAME> \
     --query "cluster.identity.oidc.issuer" --output text | sed 's|https://||')
   export NAMESPACE=cloudwatch-insights
   export SERVICE_ACCOUNT=cloudwatch-insights-backend
   export ROLE_NAME=cloudwatch-insights-hub-role
   export TARGET_ROLE_NAME=CloudWatchInsightsReadRole   # the role name you'll set on the Admin group in the app's Settings

   cat > trust-policy.json <<EOF
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Principal": { "Federated": "arn:aws:iam::${HUB_ACCOUNT_ID}:oidc-provider/${OIDC_PROVIDER}" },
         "Action": "sts:AssumeRoleWithWebIdentity",
         "Condition": {
           "StringEquals": {
             "${OIDC_PROVIDER}:aud": "sts.amazonaws.com",
             "${OIDC_PROVIDER}:sub": "system:serviceaccount:${NAMESPACE}:${SERVICE_ACCOUNT}"
           }
         }
       }
     ]
   }
   EOF

   aws iam create-role --role-name "$ROLE_NAME" \
     --assume-role-policy-document file://trust-policy.json

   cat > hub-permissions.json <<EOF
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": "sts:AssumeRole",
         "Resource": "arn:aws:iam::*:role/${TARGET_ROLE_NAME}"
       }
     ]
   }
   EOF

   aws iam put-role-policy --role-name "$ROLE_NAME" \
     --policy-name assume-target-accounts \
     --policy-document file://hub-permissions.json
   ```

   (Equivalently, `eksctl create iamserviceaccount --cluster <CLUSTER_NAME> --namespace $NAMESPACE --name $SERVICE_ACCOUNT --role-name $ROLE_NAME --attach-policy-arn <a managed policy ARN with the same statement> --approve` does the role creation and OIDC trust wiring in one step if you prefer eksctl-managed IAM, then set `serviceAccount.create=false` in Helm and let eksctl own the ServiceAccount instead.)

4. **A role in every target account**, trusting the hub role above —
   this is identical to the non-Kubernetes setup, just with the hub role's
   ARN as the trusted principal instead of a plain server identity:

   ```bash
   cat > spoke-trust-policy.json <<EOF
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Principal": { "AWS": "arn:aws:iam::${HUB_ACCOUNT_ID}:role/${ROLE_NAME}" },
         "Action": "sts:AssumeRole"
       }
     ]
   }
   EOF

   # Run this in EACH target account:
   aws iam create-role --role-name "$TARGET_ROLE_NAME" \
     --assume-role-policy-document file://spoke-trust-policy.json

   cat > spoke-permissions.json <<EOF
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
   EOF

   aws iam put-role-policy --role-name "$TARGET_ROLE_NAME" \
     --policy-name read-logs-and-iot \
     --policy-document file://spoke-permissions.json
   ```

   The IoT tab's **Things** search additionally needs **Fleet Indexing**
   enabled per target account/region
   (`aws iot update-indexing-configuration`) — see the main README's "IoT
   tab prerequisite" section for the exact command. **Certificates** search
   doesn't use Fleet Indexing and needs no extra setup beyond the
   permissions above — see the README's "IoT tab: Certificate search"
   section for how it works and its limitations.

   The Logs tab's **OpenSearch** backend additionally needs each target
   OpenSearch domain's own resource-based access policy to allow
   `$TARGET_ROLE_NAME`, on top of the `es:*` IAM permissions above — the two
   are checked independently. It also needs the domain's endpoint to be
   reachable over HTTPS from inside this cluster (a public endpoint works
   as-is; a VPC-only domain needs routing/peering into that VPC). See the
   README's "Logs tab: OpenSearch backend" section for details.

5. **A Postgres database** the backend can reach from inside the cluster
   (RDS, Cloud SQL, a self-hosted instance, whatever you already run) —
   this chart does not deploy one for you. Create a database and a user
   for the app, then store the connection info as a Secret:

   ```bash
   # Option A: a single DATABASE_URL
   kubectl -n cloudwatch-insights create secret generic cloudwatch-insights-db \
     --from-literal=DATABASE_URL="postgresql+psycopg2://cloudwatch_insights:<PASSWORD>@<DB_HOST>:5432/cloudwatch_insights?sslmode=require"

   # Option B: just the password, paired with discrete values.yaml fields
   # (backend.database.host/user/name/sslMode) -- see values.yaml
   kubectl -n cloudwatch-insights create secret generic cloudwatch-insights-db \
     --from-literal=password="<PASSWORD>"
   ```

6. **Helm 3** installed locally, and (if using the GitOps path) **Argo CD**
   installed on the cluster.

7. **(Optional) A LiteLLM proxy** (or anything else exposing an
   OpenAI-compatible `/chat/completions` endpoint), if you want the platform
   agent (below). Skip this entirely and the agent's panel just says this
   deployment doesn't run one. When you do want it, store the API key as a
   Secret the same way as the database password:

   ```bash
   kubectl -n cloudwatch-insights create secret generic cloudwatch-insights-litellm \
     --from-literal=LITELLM_API_KEY="<LITELLM_API_KEY>"
   ```

8. **(Optional, but recommended) A password for the initial `admin` user**,
   created automatically the first time the backend starts with no users
   yet. Skip this and the backend generates a random one itself, logging it
   once to the pod's startup logs (`kubectl logs` the backend pod) — fine
   for a quick try-out, but for a real deployment set it explicitly so the
   password isn't only ever recoverable from a log line:

   ```bash
   kubectl -n cloudwatch-insights create secret generic cloudwatch-insights-admin \
     --from-literal=ADMIN_PASSWORD="<ADMIN_PASSWORD>"
   ```

## Deploy with Helm directly

```bash
helm upgrade --install cloudwatch-insights ./helm/cloudwatch-insights \
  --namespace cloudwatch-insights --create-namespace \
  --set serviceAccount.annotations."eks\.amazonaws\.com/role-arn"="arn:aws:iam::${HUB_ACCOUNT_ID}:role/${ROLE_NAME}" \
  --set backend.database.existingSecret=cloudwatch-insights-db \
  --set backend.image.repository=ghcr.io/<owner>/cloudwatch-insights-backend \
  --set backend.image.tag=latest \
  --set frontend.image.repository=ghcr.io/<owner>/cloudwatch-insights-frontend \
  --set frontend.image.tag=latest \
  --set ingress.enabled=true \
  --set ingress.host=cloudwatch-insights.example.com
```

(If you went with Option B for the database Secret above, use
`--set backend.database.host=<DB_HOST> --set backend.database.passwordSecret.name=cloudwatch-insights-db`
instead of `backend.database.existingSecret`.)

### The platform agent (optional)

The agent is a third Deployment (`platform-agent/` in the repo, image
`ghcr.io/<owner>/cloudwatch-insights-agent`, built by `agent-ci.yml`). The
browser never talks to it: a chat turn goes to the backend
(`POST /api/agent/chat`), which checks the user's group, mints a short-lived
token for that one turn, and relays the turn to the agent inside the cluster.
The agent calls the model, and acts through the backend's MCP endpoint
(`/mcp`) with that token -- as the user who asked, with exactly their group's
environments, pages and IAM role. The token is revoked when the turn ends.

It needs the LiteLLM proxy from prerequisite 7 -- set under `backend.ai`,
where the retired ✦ assistant read it, so existing values files keep
working -- and a model that is good at **tool calling**:
```bash
  --set backend.ai.baseUrl=https://litellm.example.com \
  --set backend.ai.existingSecret=cloudwatch-insights-litellm \
  --set agent.enabled=true \
  --set agent.image.repository=ghcr.io/<owner>/cloudwatch-insights-agent \
  --set agent.model=<a tool-calling model behind your LiteLLM>   # else backend.ai.model
```
Then, in the app, an admin turns **Platform agent** on for each group that
should have it (Settings → User groups). It is off for every group except
Admin until then.

Things worth knowing:
- The agent pod has no AWS identity (`automountServiceAccountToken: false`,
  no IRSA): everything it does runs in the backend, with the asking user's
  role.
- `/mcp` is on the backend Service but not under `/api`, so the frontend's
  nginx (and so the ingress) never routes a browser to it. Every call there
  needs a live per-turn token anyway.
- Optionally, share a key between the backend and the agent so nothing else
  in the cluster can call the agent and spend the model's budget: create a
  Secret with an `AGENT_SERVICE_KEY` and set
  `agent.serviceKey.existingSecret` to its name.
- A chat turn is a streamed response like the live-sync stream (below), with
  a heartbeat every 15 s, so the same buffering and idle-timeout advice
  applies to `POST /api/agent/chat`.
- The agent keeps nothing between turns (the browser sends the conversation
  so far with each one), so `agent.replicaCount` can be anything.

To set the initial admin password explicitly (recommended), add:
```bash
  --set backend.auth.existingSecret=cloudwatch-insights-admin
```
Leaving `backend.auth.existingSecret`/`backend.auth.adminPassword` both
unset means the backend generates and logs a random password on first
startup instead (see prerequisite 8 above). `backend.auth.cookieSecure`
defaults to `true` (the session cookie requires HTTPS); only set it to
`false` for a deliberately HTTP-only deployment.

Check `helm/cloudwatch-insights/values.yaml` for every other knob (resource
requests/limits, ingress annotations/TLS, extra backend env vars). A few
things worth knowing:

- The backend refuses to render (a `helm template`/`helm install` error,
  not a runtime crash) unless you've set either
  `backend.database.existingSecret` or `backend.database.host`, so a
  forgotten DB config fails fast.
- Because state now lives in Postgres rather than SQLite-on-a-PVC, the
  backend can run multiple replicas too — scale `backend.replicaCount`
  freely, same as `frontend.replicaCount`.
- The frontend container proxies `/api/*` to the backend Service at
  request time via `BACKEND_SERVICE_HOST`/`BACKEND_SERVICE_PORT`, which the
  chart wires up automatically to the backend Service it creates — you
  don't need to set those yourself.
- **Live sync keeps one long-lived request open per browser tab**
  (`GET /api/live-sessions/events`, a server-sent event stream), so changes
  made in another tab, another machine or by the platform agent appear
  without a reload. Anything between the browser and the backend has to let
  it through unbuffered and unhurried:
  - The backend sends `X-Accel-Buffering: no`, which the frontend
    container's nginx and ingress-nginx both honour. For another ingress or
    load balancer, turn response buffering off for that path.
  - It sends a heartbeat every 20 s, so any idle timeout of 60 s or more is
    fine (nginx's and ingress-nginx's defaults are 60 s; AWS ALB's is 60 s).
  - A dropped stream reconnects by itself after 3 s and catches up, so a
    shorter timeout costs extra requests, not missed changes.
- Changes are announced through Postgres `LISTEN/NOTIFY`, so they reach
  browsers on every backend replica. Each replica holds one extra database
  connection for this, outside its connection pool. A connection pooler in
  front of Postgres must be in **session** mode for that connection
  (PgBouncer's transaction mode drops `LISTEN`).

Verify:
```bash
kubectl -n cloudwatch-insights get pods
kubectl -n cloudwatch-insights port-forward svc/cloudwatch-insights-frontend 8080:8080
# open http://localhost:8080
```

## Deploy with Argo CD

An example `Application` is in [`argocd/application.yaml`](./argocd/application.yaml).
Edit it first:

- `spec.source.repoURL` / `targetRevision` — point at your fork/branch.
- `spec.source.helm.valuesObject.serviceAccount.annotations` — the hub role
  ARN from the prerequisites step.
- `spec.source.helm.valuesObject.backend/frontend.image.tag` — pin to an
  immutable tag (e.g. the git SHA the CI workflows also tag images with)
  rather than `latest` for anything beyond a first test, so Argo CD's diffs
  are meaningful and rollbacks are possible.
- `spec.destination.namespace` and the ingress host.

Then:
```bash
kubectl apply -f argocd/application.yaml
argocd app sync cloudwatch-insights   # or let auto-sync pick it up
```

With `syncPolicy.automated` set (as in the example), Argo CD will
reconcile the cluster to match the chart on every push to the tracked
branch — pair this with pinning image tags to the CI-built git-sha tags
(or an image-updater/CD pipeline that bumps the tag in git) rather than
riding `latest`, so a deploy is always traceable back to a commit.

## Credentials: the master key

Stored credentials (Settings → **Credentials**) are encrypted with a master key
that lives outside the database, in a Kubernetes Secret. Without one, the
platform works as before and the Credentials screen says it's off.

**Create it once, and back it up.** Losing the key loses every stored
credential: nothing can decrypt them without it, by design.

```bash
kubectl -n cloudwatch-insights create secret generic cloudwatch-insights-master-key \
  --from-literal=PLATFORM_MASTER_KEYS="k1:$(openssl rand -base64 32)"
# Keep a copy somewhere safe (a password manager, your secrets vault):
kubectl -n cloudwatch-insights get secret cloudwatch-insights-master-key \
  -o jsonpath='{.data.PLATFORM_MASTER_KEYS}' | base64 -d
```

Then point the chart at it:

```bash
--set backend.masterKey.existingSecret=cloudwatch-insights-master-key \
--set backend.masterKey.keyId=k1
```

**Don't let the chart, or anything rendered by Argo CD, generate it.** Argo CD
renders the chart without access to the cluster, so a generated value (e.g.
through `lookup`) would come out different on every sync, and every stored
credential would become unreadable. Create the Secret yourself, as above, or
through whatever already manages your secrets (External Secrets, Sealed
Secrets, SOPS).

**Rotating it.** `PLATFORM_MASTER_KEYS` is a keyring of `id:key` pairs, and
`PLATFORM_MASTER_KEY_ID` (`backend.masterKey.keyId`) names the one new secrets
are written with. To rotate:

1. Add a new key to the Secret, keeping the old one:
   `PLATFORM_MASTER_KEYS="k2:<new key>,k1:<old key>"`. Set
   `backend.masterKey.keyId=k2`, and roll the backend.
2. Re-wrap every credential under the new key. It's safe to run again if it's
   interrupted, and it only touches each credential's small data key, not the
   secrets themselves:
   `kubectl exec deploy/<release>-backend -- python -m app.keys rotate`
3. Check that every credential decrypts without the old key, then remove `k1`
   from the Secret and roll the backend again:
   `kubectl exec deploy/<release>-backend -- python -m app.keys check`

`python -m app.keys generate` prints a new random key, if `openssl` isn't to
hand. The startup log and the Credentials screen say plainly when the keyring
is malformed, or doesn't hold the key a credential was written with. Neither is
ever taken to mean "no credentials".

Local development (`docker-compose.yml`) uses a fixed key that is in the
repository: fine for trying things out, never for anything real.

## After deploying

Sign in as `admin` (the password is whatever you set via `backend.auth` in
Helm — see below — or, if you didn't set one, whatever the backend logged on
first startup; `kubectl logs` the backend pod to find it). Then click your
picture (end of the strip) → **Settings**:
1. Under **Environments**, add an environment for each account/region
   combination you want to query — a name, the 12-digit account ID, and a
   region.
2. Under **User groups**, set the Admin group's **IAM role name** to
   `$TARGET_ROLE_NAME` (default in the examples above:
   `CloudWatchInsightsReadRole`), and create any other groups/users you
   need — each group gets its own role name, its own visible tabs, and its
   own visible environments (the Admin group always sees every
   environment).

Then use the **Logs** tab as described in the main README.
