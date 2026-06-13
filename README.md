# kiro-infra

AWS CDK infrastructure for the kiro-app service and E2E test pipeline.

> **Note:** All three repos are public. No credentials are stored in any repo.
> AWS authentication uses OIDC — GitHub Actions exchanges a short-lived JWT
> for temporary AWS credentials. No `AWS_ACCESS_KEY_ID` or `AWS_SECRET_ACCESS_KEY`
> are stored anywhere.

---

## Repositories in this system

| Repo | Purpose |
|---|---|
| [kiro-app](https://github.com/enageshwari/kiro-app) | Express app, unit tests, CI pipeline |
| [kiro-e2e](https://github.com/enageshwari/kiro-e2e) | Playwright E2E tests, runner Dockerfile |
| [kiro-infra](https://github.com/enageshwari/kiro-infra) | CDK infrastructure (this repo) |

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  AWS Account: 080147880517  /  Region: us-east-1                     │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────┐     │
│  │  KiroAppStack                                               │     │
│  │                                                             │     │
│  │  VPC (2 AZs, 1 NAT GW)                                     │     │
│  │  ├── Public subnets  → ALB                                  │     │
│  │  └── Private subnets → ECS Fargate tasks                    │     │
│  │                                                             │     │
│  │  ECR: kiro-app          ECS Cluster: kiro-cluster           │     │
│  │  ALB: kiro-app (port 80)                                    │     │
│  │  ECS Service: kiro-app  (desiredCount managed by GHA)       │     │
│  │  CW Log group: /ecs/kiro-app                                │     │
│  └─────────────────────────────────────────────────────────────┘     │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────┐     │
│  │  KiroE2EPipelineStack                                       │     │
│  │                                                             │     │
│  │  ECR: kiro-e2e                                              │     │
│  │  ECS Task Def: kiro-e2e (2 vCPU / 2GB, Playwright runner)  │     │
│  │  Lambda: kiro-trigger-e2e  (15 min timeout)                 │     │
│  │  API Gateway: POST /run-e2e  (API key protected)            │     │
│  │  CW Log group: /ecs/kiro-e2e                                │     │
│  └─────────────────────────────────────────────────────────────┘     │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────┐     │
│  │  KiroGitHubOidcStack                                        │     │
│  │                                                             │     │
│  │  IAM OIDC Provider: token.actions.githubusercontent.com     │     │
│  │  IAM Role: kiro-app-gha-role  (ECR push, ECS update, CW)   │     │
│  │  IAM Role: kiro-e2e-gha-role  (ECR push for runner image)   │     │
│  └─────────────────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────────────────┘
```

---

## CDK Stacks

| Stack | Key resources |
|---|---|
| `KiroAppStack` | VPC, ECS cluster, ECR (kiro-app), ALB + target group, Fargate service (desiredCount=0 initially), CW log group `/ecs/kiro-app` |
| `KiroE2EPipelineStack` | ECR (kiro-e2e), Fargate task def (2GB for Playwright + browsers), Lambda trigger, API Gateway + API key, CW log group `/ecs/kiro-e2e` |
| `KiroGitHubOidcStack` | IAM OIDC provider, `kiro-app-gha-role`, `kiro-e2e-gha-role` — scoped to specific repos + main branch |

---

## Setup — commands run in order

### 1. Prerequisites

```bash
# Install AWS CLI v2
curl "https://awscli.amazonaws.com/AWSCLIV2.pkg" -o /tmp/AWSCLIV2.pkg
sudo installer -pkg /tmp/AWSCLIV2.pkg -target /

# Install Node.js 20+
# (download from https://nodejs.org or use nvm)

# Install CDK CLI
npm install -g aws-cdk

# Configure AWS credentials (admin access needed for bootstrap only)
aws configure
# Enter: Access Key ID, Secret Access Key, region (us-east-1)

# Verify identity
aws sts get-caller-identity
```

### 2. Bootstrap CDK (one-time per account/region)

```bash
cdk bootstrap aws://<ACCOUNT_ID>/us-east-1
```

### 3. Install dependencies and deploy

```bash
cd kiro-infra
npm install

# Deploy app infra + OIDC roles first
npx cdk deploy KiroAppStack KiroGitHubOidcStack --require-approval never

# Deploy E2E pipeline (depends on KiroAppStack outputs)
npx cdk deploy KiroE2EPipelineStack --require-approval never
```

### 4. Retrieve stack outputs

```bash
# App stack outputs (APP_URL, ECR repo, target group ARN)
aws cloudformation describe-stacks --stack-name KiroAppStack \
  --query 'Stacks[0].Outputs' --output table

# E2E pipeline outputs (trigger URL, ECR repo)
aws cloudformation describe-stacks --stack-name KiroE2EPipelineStack \
  --query 'Stacks[0].Outputs' --output table

# OIDC role ARNs
aws cloudformation describe-stacks --stack-name KiroGitHubOidcStack \
  --query 'Stacks[0].Outputs' --output table

# API Gateway API key (not in CFN outputs — retrieve separately)
aws apigateway get-api-keys \
  --include-values \
  --query 'items[?name==`kiro-gha-trigger-key`].value' \
  --output text
```

### 5. Set GitHub Actions secrets

**kiro-app repo** — `github.com/enageshwari/kiro-app/settings/secrets/actions`

| Secret | CDK output / source |
|---|---|
| `AWS_ROLE_ARN` | `KiroGitHubOidcStack.KiroAppRoleArn` |
| `APP_URL` | `KiroAppStack.AppUrl` |
| `TARGET_GROUP_ARN` | `KiroAppStack.TargetGroupArn` |
| `E2E_TRIGGER_URL` | `KiroE2EPipelineStack.E2ETriggerUrl` |
| `E2E_API_KEY` | `aws apigateway get-api-keys --include-values` |

**kiro-e2e repo** — `github.com/enageshwari/kiro-e2e/settings/secrets/actions`

| Secret | CDK output / source |
|---|---|
| `AWS_ROLE_ARN` | `KiroGitHubOidcStack.KiroE2ERoleArn` |
| `ECR_REPOSITORY_E2E` | `KiroE2EPipelineStack.E2EEcrRepo` |

### 6. Push kiro-e2e runner image (first time)

The Playwright runner image must exist in ECR before kiro-app CI can run E2E tests.
Push to `kiro-e2e` main to trigger the image build:

```bash
cd kiro-e2e
git commit --allow-empty -m "ci: build initial runner image"
git push
# watch: github.com/enageshwari/kiro-e2e/actions
```

### 7. Trigger the full pipeline

Push any change to `kiro-app` main:
```bash
cd kiro-app
git commit --allow-empty -m "ci: trigger first full pipeline run"
git push
# watch: github.com/enageshwari/kiro-app/actions
```

---

## OIDC authentication — how it works

```
GHA job starts
  │
  ├─ requests JWT from GitHub OIDC provider
  │  JWT contains: repo, branch, actor, sha
  │
  ├─ aws-actions/configure-aws-credentials
  │  exchanges JWT for temporary STS credentials
  │  (valid 1 hour, auto-expires)
  │
  └─ IAM role trust policy validates:
     - aud = sts.amazonaws.com
     - sub = repo:enageshwari/kiro-app:ref:refs/heads/main
     Only tokens from this exact repo + branch are accepted
```

**Why OIDC over access keys:**
- Zero stored secrets — nothing to rotate or leak
- Credentials expire automatically after 1 hour
- Trust is scoped to a specific repo and branch
- Revoking access = update the IAM role trust policy, not rotate a key

---

## ECR permissions for docker buildx

Standard `docker push` only needs write permissions. `docker buildx` with registry
cache also reads existing layers for cache resolution, requiring additional permissions:

```
ecr:BatchGetImage           — read existing image manifests for cache hits
ecr:GetDownloadUrlForLayer  — download layer blobs for cache comparison
ecr:DescribeRepositories    — verify repo exists before pushing
ecr:ListImages              — enumerate existing tags
```

All four are granted to both OIDC roles in `KiroGitHubOidcStack`. If you see
`403 Forbidden` on a manifest HEAD request during `docker buildx`, these permissions
are missing from the role.

---

## Security group design

The ALB and Fargate tasks each have their own security group. Traffic flow:

```
Internet → ALB SG (inbound :80 0.0.0.0/0)
         → Task SG (inbound :3000 from ALB SG only)
Task SG  → outbound all (ECR pull, CloudWatch logs, internet)
ALB SG   → outbound :3000 to Task SG (health checks + traffic forwarding)
```

**Key gotcha:** CDK's `ApplicationLoadBalancer` construct creates an ALB SG with
**no outbound rules by default**. This causes ALB health checks to time out silently
even though the task is running and the inbound rule on the task SG is correct.

Fix — use `alb.connections.allowTo()` which sets both directions in one call:
```typescript
alb.connections.allowTo(
  this.appSecurityGroup,
  ec2.Port.tcp(3000),
  'ALB to kiro-app task port 3000',
);
```
This adds ALB SG egress → task SG port 3000, and task SG ingress ← ALB SG port 3000.
Using VPC CIDR (`10.0.0.0/16`) as the inbound source is **not sufficient** — the ALB
sends health checks from its own SG, not from a predictable IP range.

## Why desiredCount=0 on first deploy

AWS ECS does not allow attaching a load balancer to a service at creation time
with `desiredCount=0`, and the service cannot pull an image that doesn't exist yet.

**Solution:** the CDK stack creates the ECS service with `desiredCount=0` and
**no load balancer attachment**. On the first `kiro-app` push to `main`, GHA:
1. Pushes the Docker image to ECR
2. Registers a new task definition revision with the real image
3. Calls `aws ecs update-service --desired-count 1 --load-balancers ...`
   to wire the ALB and start the app

Subsequent pushes just update the image and force a rolling deploy.

---

## CloudWatch logs

| Log group | Stream prefix | Contents |
|---|---|---|
| `/ecs/kiro-app` | `kiro-app/` | Express app stdout/stderr |
| `/ecs/kiro-e2e` | `playwright/` | Playwright test output |
| `/ecs/kiro-e2e` | `e2e-results/<runId>` | Structured `{ result, taskArn, exitCode }` |

```bash
# Tail live Playwright output
aws logs tail /ecs/kiro-e2e --log-stream-name-prefix playwright --follow

# Read structured E2E result for a specific GHA run
aws logs get-log-events \
  --log-group-name /ecs/kiro-e2e \
  --log-stream-name "e2e-results/<github-run-id>" \
  --query 'events[*].message' --output text | jq .
```

---

## Teardown (cost saving)

```bash
cd kiro-infra
npx cdk destroy --all
```

All resources are deleted — ECR repos (and all images), ECS services, ALB, VPC,
Lambda, API Gateway, CloudWatch log groups. Nothing left running, nothing incurring cost.

> The most expensive resources are NAT gateway (~$32/mo) and ALB (~$16/mo).
> Everything else is negligible or free tier.

---

## Restore from scratch

Everything is recreatable from CDK in one sequence of commands:

```bash
# 1. Deploy all infra
cd kiro-infra
npm install
npx cdk deploy --all --require-approval never

# 2. Get the new stack outputs (ALB URL, target group ARN, trigger URL, role ARNs)
aws cloudformation describe-stacks --stack-name KiroAppStack \
  --query 'Stacks[0].Outputs' --output table

aws cloudformation describe-stacks --stack-name KiroE2EPipelineStack \
  --query 'Stacks[0].Outputs' --output table

aws cloudformation describe-stacks --stack-name KiroGitHubOidcStack \
  --query 'Stacks[0].Outputs' --output table

# 3. Retrieve the new API Gateway API key value
aws apigateway get-api-keys \
  --include-values \
  --query 'items[?name==`kiro-gha-trigger-key`].value' \
  --output text

# 4. Update GHA secrets with new values
#    (ALB URL and target group ARN change on every fresh deploy)
gh secret set APP_URL          --repo enageshwari/kiro-app --body "<AppUrl output>"
gh secret set TARGET_GROUP_ARN --repo enageshwari/kiro-app --body "<TargetGroupArn output>"
gh secret set E2E_TRIGGER_URL  --repo enageshwari/kiro-app --body "<E2ETriggerUrl output>"
gh secret set E2E_API_KEY      --repo enageshwari/kiro-app --body "<api key value>"
gh secret set AWS_ROLE_ARN     --repo enageshwari/kiro-app --body "<KiroAppRoleArn output>"
gh secret set AWS_ROLE_ARN     --repo enageshwari/kiro-e2e --body "<KiroE2ERoleArn output>"

# 5. Push kiro-e2e to rebuild and push the runner image to the new ECR repo
cd ../kiro-e2e
git commit --allow-empty -m "ci: rebuild runner image after restore"
git push

# 6. Push kiro-app to trigger the first full pipeline run
cd ../kiro-app
git commit --allow-empty -m "ci: first run after infra restore"
git push
# Watch: github.com/enageshwari/kiro-app/actions
```

> **Why secrets need updating after restore:** ALB and API Gateway are recreated
> with new DNS names and ARNs each time. OIDC role ARNs stay the same (same role name)
> so `AWS_ROLE_ARN` only needs updating if the account changes.
> `E2E_API_KEY` changes because the API Gateway resource is new.
