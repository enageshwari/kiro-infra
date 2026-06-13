#!/bin/bash
# Full teardown — deletes all AWS resources to stop costs.
#
# Usage:
#   bash scripts/teardown.sh           # destroy app stacks + ECR repos
#   bash scripts/teardown.sh --all     # also delete CDKToolkit bootstrap
#                                        (requires cdk bootstrap before next restore)

set -e

DESTROY_BOOTSTRAP=false
if [ "$1" = "--all" ]; then
  DESTROY_BOOTSTRAP=true
fi

echo "=== Tearing down kiro infrastructure ==="

# 1. Destroy CDK stacks (VPC, ECS, ALB, Lambda, API GW, CW logs, OIDC roles)
echo "Destroying CDK stacks..."
npx cdk destroy --all --force

# 2. Delete ECR repos — not managed by CDK stack to avoid import conflicts.
#    Images are deleted along with the repos.
echo "Deleting ECR repositories..."
aws ecr delete-repository --repository-name kiro-app --force 2>/dev/null \
  && echo "  kiro-app ECR deleted" \
  || echo "  kiro-app ECR already gone"

aws ecr delete-repository --repository-name kiro-e2e --force 2>/dev/null \
  && echo "  kiro-e2e ECR deleted" \
  || echo "  kiro-e2e ECR already gone"

# 3. Optionally destroy the CDKToolkit bootstrap (--all flag)
#    This removes the S3 asset bucket, bootstrap ECR repo, and IAM roles.
#    After this, you must run 'cdk bootstrap' before the next restore.
if [ "$DESTROY_BOOTSTRAP" = true ]; then
  echo ""
  echo "Destroying CDKToolkit bootstrap..."

  BUCKET="cdk-hnb659fds-assets-$(aws sts get-caller-identity --query Account --output text)-$(aws configure get region)"

  echo "  Emptying bootstrap S3 bucket: $BUCKET"
  aws s3 rb "s3://${BUCKET}" --force 2>/dev/null \
    && echo "  Bootstrap bucket deleted" \
    || echo "  Bootstrap bucket already gone"

  echo "  Deleting CDKToolkit stack..."
  aws cloudformation delete-stack --stack-name CDKToolkit
  aws cloudformation wait stack-delete-complete --stack-name CDKToolkit
  echo "  CDKToolkit deleted"
else
  echo ""
  echo "Note: CDKToolkit bootstrap stack kept (costs ~\$0, saves 'cdk bootstrap' on restore)."
  echo "      To also delete it: bash scripts/teardown.sh --all"
fi

echo ""
echo "✅ Teardown complete. All billable resources deleted."
