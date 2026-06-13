# kiro-infra

AWS CDK infrastructure for the kiro-app service and E2E test pipeline.

> **This repo should be private.** It contains account-specific ARNs, resource names,
> and infrastructure configuration. No credentials are stored here.

## Architecture

```
kiro-app push to main
  ├── Job 1: vitest unit tests
  ├── Job 2: docker build → push kiro-app image to ECR → update ECS service
  └── Job 3: POST /run-e2e → API Gateway (202 accepted)
                               └── Lambda (async, 15-min timeout)
                                     └── ECS RunTask → Fargate
                                           └── kiro-e2e image
                                                 npx playwright test
                                                 stdout/stderr → CloudWatch /ecs/kiro-e2e
                                     Lambda polls ECS until task STOPPED
                                     Writes { result: PASSED|FAILED } → CloudWatch
             GHA polls CloudWatch every 30s for result
             Pass/fail gates the workflow — failed E2E blocks the deploy signal
```

## Stacks

| Stack | Resources |
|---|---|
| `KiroAppStack` | VPC, ECS cluster, ECR repo (kiro-app), ALB + target group, Fargate service (initially desiredCount=0), CW log group |
| `KiroE2EPipelineStack` | ECR repo (kiro-e2e), Fargate task def for Playwright runner, Lambda (trigger + poll), API Gateway + API key, CW log group |
| `KiroGitHubOidcStack` | IAM OIDC provider + IAM roles for kiro-app and kiro-e2e GitHub Actions |

## Why desiredCount=0 on first deploy

AWS ECS does not allow attaching a load balancer to a service at creation time if
`desiredCount=0`. And the service cannot start tasks until an image exists in ECR.
So the service is created with no tasks and no ALB attachment. GHA handles both:
on the first push to `main`, it pushes the image, registers a new task definition
revision, and calls `aws ecs update-service --desired-count 1 --load-balancers ...`
to wire everything together. Subsequent pushes just update the image.

## Prerequisites

- AWS CLI v2
- Node.js 20+
- CDK CLI: `npm install -g aws-cdk`
- AWS credentials with admin access (for initial bootstrap only)

## One-time bootstrap

```bash
# Configure credentials (replace with your method — OIDC recommended for ongoing use)
aws configure

# Bootstrap CDK in your account/region
cdk bootstrap aws://<ACCOUNT_ID>/us-east-1

cd kiro-infra
npm install
```

## Deploy

Deploy all stacks in dependency order:

```bash
# 1. App infrastructure + OIDC roles
npx cdk deploy KiroAppStack KiroGitHubOidcStack

# 2. E2E pipeline (depends on KiroAppStack outputs)
npx cdk deploy KiroE2EPipelineStack
```

Or all at once:
```bash
npx cdk deploy --all
```

## After deploy — configure GitHub secrets

### kiro-app repo secrets

Run this to get values from stack outputs:
```bash
aws cloudformation describe-stacks --stack-name KiroAppStack \
  --query 'Stacks[0].Outputs' --output table

aws cloudformation describe-stacks --stack-name KiroE2EPipelineStack \
  --query 'Stacks[0].Outputs' --output table

aws cloudformation describe-stacks --stack-name KiroGitHubOidcStack \
  --query 'Stacks[0].Outputs' --output table
```

| GHA Secret | CDK Output key |
|---|---|
| `AWS_ROLE_ARN` | `KiroGitHubOidcStack.KiroAppRoleArn` |
| `APP_URL` | `KiroAppStack.AppUrl` |
| `TARGET_GROUP_ARN` | `KiroAppStack.TargetGroupArn` |
| `E2E_TRIGGER_URL` | `KiroE2EPipelineStack.E2ETriggerUrl` |
| `E2E_API_KEY` | See below |

### kiro-e2e repo secrets

| GHA Secret | CDK Output key |
|---|---|
| `AWS_ROLE_ARN` | `KiroGitHubOidcStack.KiroE2ERoleArn` |
| `ECR_REPOSITORY_E2E` | `KiroE2EPipelineStack.E2EEcrRepo` |

### Retrieve the API Gateway API key value

The key value is not in CDK outputs (AWS doesn't expose it via CloudFormation).
Retrieve it after deploy:

```bash
aws apigateway get-api-keys \
  --include-values \
  --query 'items[?name==`kiro-gha-trigger-key`].value' \
  --output text
```

Set this as `E2E_API_KEY` in kiro-app GHA secrets.

## CloudWatch logs

| Log group | Contents |
|---|---|
| `/ecs/kiro-app` | Express app stdout/stderr |
| `/ecs/kiro-e2e` (stream: `playwright/*`) | Playwright test output |
| `/ecs/kiro-e2e` (stream: `e2e-results/<runId>`) | Structured pass/fail result read by GHA |

## AWS authentication — OIDC (no stored keys)

This infra uses IAM OIDC roles so GitHub Actions never stores long-lived AWS credentials.

How it works:
1. GHA job requests a JWT from GitHub's OIDC provider
2. `aws-actions/configure-aws-credentials` exchanges the JWT for temporary STS credentials
3. The IAM role trust policy is scoped to `repo:enageshwari/kiro-app:ref:refs/heads/main`
   — tokens from any other repo, branch, or actor are rejected by AWS

This means:
- No `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` secrets anywhere
- Credentials expire after 1 hour automatically
- Rotating or revoking access = update the IAM role, no secret rotation needed
