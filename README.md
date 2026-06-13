# kiro-infra

AWS CDK infrastructure for kiro-app and the E2E test pipeline.
**Fully reproducible** — `cdk destroy --all` tears everything down,
`scripts/restore.sh` brings it all back.

> All three repos are public. No credentials stored anywhere.
> Authentication uses OIDC — temporary STS credentials, scoped to repo + branch.

---

## Repositories

| Repo | Purpose |
|---|---|
| [kiro-app](https://github.com/enageshwari/kiro-app) | Express app, unit tests, CI |
| [kiro-e2e](https://github.com/enageshwari/kiro-e2e) | Playwright E2E tests |
| [kiro-infra](https://github.com/enageshwari/kiro-infra) | CDK infrastructure (this repo) |

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│  AWS  (us-east-1)                                                        │
│                                                                          │
│  ┌─── KiroAppStack ────────────────────────────────────────────────┐     │
│  │                                                                 │     │
│  │  VPC  ┌─ Public subnets ──── ALB (port 80, internet-facing)    │     │
│  │  2 AZ │                       │                                │     │
│  │       └─ Private subnets ─── ECS Fargate  kiro-app             │     │
│  │                                └─ ECR: kiro-app                │     │
│  │                                └─ CW:  /ecs/kiro-app           │     │
│  └─────────────────────────────────────────────────────────────────┘     │
│                                                                          │
│  ┌─── KiroE2EPipelineStack ────────────────────────────────────────┐     │
│  │                                                                 │     │
│  │  API Gateway  POST /run-e2e  (API key required)                 │     │
│  │       │                                                         │     │
│  │       ▼ async invoke                                            │     │
│  │  Lambda  kiro-trigger-e2e  (15 min timeout)                     │     │
│  │       │  - ECS RunTask                                          │     │
│  │       │  - polls until STOPPED                                  │     │
│  │       │  - writes result to CloudWatch                          │     │
│  │       ▼                                                         │     │
│  │  Fargate task  kiro-e2e  (2 vCPU, 2GB)                         │     │
│  │       └─ ECR: kiro-e2e  (Playwright runner image)              │     │
│  │       └─ CW:  /ecs/kiro-e2e                                    │     │
│  └─────────────────────────────────────────────────────────────────┘     │
│                                                                          │
│  ┌─── KiroGitHubOidcStack ─────────────────────────────────────────┐     │
│  │  OIDC Provider: token.actions.githubusercontent.com             │     │
│  │  kiro-app-gha-role  → ECR push, ECS update, CW read            │     │
│  │  kiro-e2e-gha-role  → ECR push (runner image)                  │     │
│  └─────────────────────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Highlights

### Security
- **OIDC authentication** — no long-lived AWS keys stored in GitHub secrets.
  IAM roles are scoped to `repo:enageshwari/<repo>:ref:refs/heads/main` —
  tokens from any other repo or branch are rejected by AWS STS.
- **Least-privilege IAM** — each role grants only what its workflow needs.
  `docker buildx` needs extra ECR read permissions vs plain `docker push` —
  these are explicitly listed (see ECR permissions section below).
- **API key on E2E webhook** — API Gateway requires `x-api-key` header.
  Throttled at 10 req/s, burst 5 — prevents runaway Fargate task costs.
- **Non-root Fargate tasks** — app container runs as a non-root user.

### Reliability
- **`alb.connections.allowTo()`** — sets ALB→task SG rules bidirectionally.
  CDK's ALB construct has no outbound rules by default — this is a common
  gotcha that causes silent health check timeouts.
- **`desiredCount=0` on first deploy** — ECS service created with no tasks,
  no ALB attachment. GHA wires everything on first push. Clean separation
  between infra creation and app deployment.
- **ECS execution role** — explicitly grants ECR pull + CloudWatch log write.
  Many tutorials omit this, causing `CannotPullContainerError` on first run.
- **Lambda CW permissions** — explicitly grants `CreateLogStream` + `PutLogEvents`
  so the result JSON is always written even if the default role is restrictive.

### Reproducibility
- **Full teardown in one command:** `scripts/teardown.sh`
- **Full restore in one command:** `scripts/restore.sh`
- **All resources codified** — no manual AWS console steps after bootstrap.

---

## CDK Stacks

| Stack | Resources |
|---|---|
| `KiroAppStack` | VPC, ECS cluster, ECR (kiro-app), ALB + TG, Fargate service, CW `/ecs/kiro-app` |
| `KiroE2EPipelineStack` | ECR (kiro-e2e), Fargate task def (2GB), Lambda, API GW + key, CW `/ecs/kiro-e2e` |
| `KiroGitHubOidcStack` | IAM OIDC provider, kiro-app-gha-role, kiro-e2e-gha-role |

---

## Setup — first time

### Prerequisites

```bash
# AWS CLI v2
curl "https://awscli.amazonaws.com/AWSCLIV2.pkg" -o /tmp/AWSCLIV2.pkg
sudo installer -pkg /tmp/AWSCLIV2.pkg -target /

# Node.js 20+  — https://nodejs.org

# CDK CLI
npm install -g aws-cdk

# Configure credentials (admin access for bootstrap only)
aws configure
aws sts get-caller-identity  # verify
```

### Bootstrap (one-time per account/region)

```bash
cdk bootstrap aws://<ACCOUNT_ID>/us-east-1
```

### Deploy

```bash
cd kiro-infra
npm install
npx cdk deploy --all --require-approval never
```

### Get outputs and set GHA secrets

```bash
# App stack
aws cloudformation describe-stacks --stack-name KiroAppStack \
  --query 'Stacks[0].Outputs[*].{Key:OutputKey,Value:OutputValue}' --output table

# E2E pipeline
aws cloudformation describe-stacks --stack-name KiroE2EPipelineStack \
  --query 'Stacks[0].Outputs[*].{Key:OutputKey,Value:OutputValue}' --output table

# OIDC roles
aws cloudformation describe-stacks --stack-name KiroGitHubOidcStack \
  --query 'Stacks[0].Outputs[*].{Key:OutputKey,Value:OutputValue}' --output table

# API key (not in CFN outputs)
aws apigateway get-api-keys --include-values \
  --query 'items[?name==`kiro-gha-trigger-key`].value' --output text
```

**kiro-app secrets:**

| Secret | Source |
|---|---|
| `AWS_ROLE_ARN` | `KiroGitHubOidcStack.KiroAppRoleArn` |
| `APP_URL` | `KiroAppStack.AppUrl` |
| `TARGET_GROUP_ARN` | `KiroAppStack.TargetGroupArn` |
| `E2E_TRIGGER_URL` | `KiroE2EPipelineStack.E2ETriggerUrl` |
| `E2E_API_KEY` | `aws apigateway get-api-keys --include-values` |

**kiro-e2e secrets:**

| Secret | Source |
|---|---|
| `AWS_ROLE_ARN` | `KiroGitHubOidcStack.KiroE2ERoleArn` |
| `ECR_REPOSITORY_E2E` | `KiroE2EPipelineStack.E2EEcrRepo` |

---

## Teardown and restore

```bash
# Default teardown — destroys all billable resources, keeps CDKToolkit (~$0)
cd kiro-infra
bash scripts/teardown.sh

# Full teardown — zero AWS footprint (requires cdk bootstrap on next restore)
bash scripts/teardown.sh --all

# Restore — auto-detects if bootstrap is needed, recreates everything,
#            prints all GHA secret update commands
bash scripts/restore.sh
```

### What costs money and what doesn't

| Resource | Monthly cost | Destroyed by teardown? |
|---|---|---|
| NAT Gateway | ~$32 | ✅ Yes |
| ALB | ~$16 | ✅ Yes |
| Fargate tasks | ~$0 (runs only during tests) | ✅ Yes |
| Lambda | Free tier | ✅ Yes |
| API Gateway | Free tier | ✅ Yes |
| ECR images | ~$0.10/GB | ✅ Yes (`teardown.sh`) |
| CloudWatch logs | Minimal | ✅ Yes |
| IAM roles / OIDC | **Free** | ✅ Yes (in `--all` mode) |
| CDKToolkit S3 bucket | **~$0** | ✅ Yes (`teardown.sh --all`) |

**Default teardown** (`bash scripts/teardown.sh`):
Destroys everything billable. Keeps CDKToolkit bootstrap — saves running
`cdk bootstrap` on the next restore. Cost after default teardown: **~$0**.

**Full teardown** (`bash scripts/teardown.sh --all`):
Destroys everything including CDKToolkit. Zero AWS footprint.
Requires `cdk bootstrap` before next `scripts/restore.sh` — the restore
script detects this automatically and bootstraps if needed.

---

## OIDC — how it works

```
GHA job starts
  → requests JWT from GitHub OIDC endpoint
     JWT payload: { repo, branch, actor, sha, ... }
  → aws-actions/configure-aws-credentials
     POST to AWS STS: AssumeRoleWithWebIdentity
     IAM validates:
       aud = sts.amazonaws.com
       sub = repo:enageshwari/kiro-app:ref:refs/heads/main
     Returns: temporary credentials (1 hour TTL)
  → GHA uses credentials for ECR, ECS, CloudWatch
     Credentials expire automatically — nothing to rotate
```

---

## Security group design

```
Internet  →  ALB SG  (inbound :80 open)
                │
                │  alb.connections.allowTo() sets both:
                │  ALB SG egress  → Task SG :3000
                │  Task SG ingress ← ALB SG :3000
                ▼
          Task SG  (outbound all — ECR pull, CW logs)
```

**Gotcha:** CDK's `ApplicationLoadBalancer` creates the ALB SG with no outbound
rules. Using VPC CIDR as the task SG inbound source is not sufficient — the ALB
sends health checks from its own SG, not a predictable IP. `alb.connections.allowTo()`
is the correct CDK pattern for bidirectional SG wiring.

---

## ECR permissions for docker buildx

`docker buildx` needs read permissions beyond what plain `docker push` requires:

```
ecr:BatchGetImage           — read manifests for cache resolution
ecr:GetDownloadUrlForLayer  — download layers for cache comparison
ecr:DescribeRepositories    — verify repo before pushing
ecr:ListImages              — enumerate existing tags
```

Missing these → `403 Forbidden` on manifest HEAD request during buildx push.
All four are granted to both OIDC roles in `KiroGitHubOidcStack`.

---

## Why desiredCount=0 on first deploy

AWS ECS rejects a service creation with `desiredCount=0` if a load balancer is
attached — and the service can't start tasks until an image exists in ECR.

**Solution:** CDK creates the service with `desiredCount=0` and no load balancer.
GHA handles both on first push: pushes the image, registers a new task def revision,
then calls `update-service --desired-count 1 --load-balancers ...`.

---

## CloudWatch logs

```bash
# Live Playwright output
aws logs tail /ecs/kiro-e2e --log-stream-name-prefix playwright --follow

# Structured E2E result for a GHA run
aws logs get-log-events \
  --log-group-name /ecs/kiro-e2e \
  --log-stream-name "e2e-results/<github-run-id>" \
  --query 'events[*].message' --output text | jq .

# App logs
aws logs tail /ecs/kiro-app --follow
```
